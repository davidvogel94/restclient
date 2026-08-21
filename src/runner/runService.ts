import * as vscode from 'vscode';
import type { CollectionEntry, CollectionStore } from '../collections/store';
import type { SecretsBroker } from '../secrets/broker';
import type { JsonPath } from '../collections/jsonEdit';
import type { RunHandle, RunnerClient } from './client';
import type { RunnerMessage } from './protocol';
import type { CookieStore } from './cookieStore';
import { usesUrlEncodingBehavior } from '../collections/settings';
import { readCertificates, readProxies, readStrictSSL } from './networkSettings';

/** Keychain namespace for `pm.vault`, shared across workspaces like Postman's. */
const VAULT_SCOPE = 'vault';

/** A runner message tagged with where it came from, for the console. */
export interface ObservedMessage {
  message: RunnerMessage;
  collectionName: string;
  itemName?: string;
}

export interface RunRequest {
  entry: CollectionEntry;
  /** Omit to run the whole collection. */
  itemId?: string;
}

/** A run in flight, and what it was pointed at. */
interface LiveRun {
  handle: RunHandle;
  collection: string;
  /** The entrypoint's item id; absent for a whole-collection run. */
  entrypointId?: string;
}

/** Is `a` the same position as `b`, or above it? */
function coversPath(a: JsonPath, b: JsonPath): boolean {
  return a.length <= b.length && a.every((segment, i) => segment === b[i]);
}

/**
 * What the Collections tree needs to know about runs in flight.
 *
 * Stated as an interface so the tree depends on the question, not on the run
 * service — the same way it takes its results.
 */
export interface ActiveRuns {
  readonly onDidChangeRuns: vscode.Event<void>;
  /** Is something running here — this request, or anything under this container? */
  runningIn(collectionUri: vscode.Uri, itemId?: string): boolean;
}

/**
 * Turns "run this item with the currently selected environment" into a runner
 * invocation, applying workspace trust, secrets and user settings.
 *
 * Shared by the request panel and (later) the collection runner so both get
 * identical execution semantics.
 */
export class RunService implements vscode.Disposable, ActiveRuns {
  private readonly _onDidObserve = new vscode.EventEmitter<ObservedMessage>();
  /** Every message from every run, for the Postman Console. */
  readonly onDidObserve = this._onDidObserve.event;

  private readonly _onDidChangeRuns = new vscode.EventEmitter<void>();
  /** Fires when a run starts or ends, so the views can offer Stop or Run. */
  readonly onDidChangeRuns = this._onDidChangeRuns.event;

  /**
   * Every run this service has started and not yet seen finish.
   *
   * The panels each hold the handle for the run they started, which is enough
   * to stop it from their own toolbar and nothing else. A row in the tree has
   * no panel — and the run it wants to stop may belong to another one anyway, a
   * Run All of the collection above it — so the one place that makes every
   * handle keeps them all, and answers both questions a row asks: is anything
   * running here, and stop it.
   */
  private readonly live = new Set<LiveRun>();

  constructor(
    private readonly client: RunnerClient,
    private readonly store: CollectionStore,
    private readonly secrets: SecretsBroker,
    private readonly activeEnvironmentId: () => string | undefined,
    private readonly log: vscode.LogOutputChannel,
    private readonly cookies: CookieStore,
    /** Keys currently held in the vault, so they can be reloaded next run. */
    private readonly vaultKeys: () => string[],
    private readonly rememberVaultKeys: (keys: string[]) => Thenable<void>
  ) {}

  get scriptsAllowed(): boolean {
    return vscode.workspace.isTrusted;
  }

  /** Read every known `pm.vault` key back out of the OS keychain. */
  private async loadVault(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    await Promise.all(
      this.vaultKeys().map(async (key) => {
        const value = await this.secrets.get(VAULT_SCOPE, key);
        if (value !== undefined) { out[key] = value; }
      })
    );
    return out;
  }

  /**
   * Mirror `pm.vault.set` back into the keychain.
   *
   * SecretStorage cannot be enumerated, so the key names are tracked separately
   * in workspace state — without them a stored value could never be read again.
   */
  private async saveVault(values: Record<string, string>): Promise<void> {
    const keys = Object.keys(values);
    await Promise.all(keys.map((key) => this.secrets.set(VAULT_SCOPE, key, values[key])));

    const removed = this.vaultKeys().filter((key) => !keys.includes(key));
    await Promise.all(removed.map((key) => this.secrets.delete(VAULT_SCOPE, key)));

    await this.rememberVaultKeys(keys);
  }

  async start(request: RunRequest, onMessage: (msg: RunnerMessage) => void): Promise<RunHandle> {
    const config = vscode.workspace.getConfiguration('restclient');
    const envEntry = this.store.environment(this.activeEnvironmentId() ?? '');

    const secrets = envEntry
      ? await this.secrets.resolveFor(envEntry.id, envEntry.json.values ?? [])
      : {};

    if (!this.scriptsAllowed) {
      this.log.warn('Workspace is not trusted — pre-request and test scripts will not run.');
    }

    const [cookieJar, vault] = await Promise.all([this.cookies.load(), this.loadVault()]);

    const handle = this.client.run(request.entry.materialized.json, {
      entrypoint: request.itemId ? { execute: request.itemId } : undefined,
      environment: envEntry ? { values: envEntry.json.values ?? [] } : { values: [] },
      globals: { values: [] },
      secrets,
      allowScripts: this.scriptsAllowed,
      // The collection's own folder, so a relative attachment path means what
      // its author meant; every folder, so a sibling root stays readable.
      workspaceRoot: this.store.rootFor(request.entry.uri) ?? this.store.workspaceRoot,
      workspaceRoots: this.store.workspaceRoots,
      followRedirects: config.get<boolean>('followRedirects', true),
      maxRedirects: config.get<number>('maxRedirects', 10),
      strictSSL: readStrictSSL(),
      protocolVersion: config.get<string>('protocolVersion', 'auto'),
      useWhatWGUrlParser: usesUrlEncodingBehavior(request.entry.materialized.json),
      cookieJar,
      certificates: readCertificates(),
      proxies: readProxies(),
      vault,
      maxResponseBytes: config.get<number>('maxResponseSizeMb', 5) * 1024 * 1024,
      timeout: {
        request: config.get<number>('requestTimeoutMs', 0),
        script: config.get<number>('scriptTimeoutMs', 60000)
      }
    });

    const itemName = request.itemId
      ? request.entry.materialized.index.get(request.itemId)?.name
      : undefined;

    const live: LiveRun = {
      handle,
      collection: request.entry.uri.toString(),
      entrypointId: request.itemId
    };
    this.live.add(live);
    this._onDidChangeRuns.fire();
    handle.on('done', () => {
      this.live.delete(live);
      this._onDidChangeRuns.fire();
    });

    handle.on('message', (msg) => {
      this._onDidObserve.fire({ message: msg, collectionName: request.entry.name, itemName });

      // Scripts routinely mutate the environment; persist that the way Postman does.
      if (msg.type === 'scopeChanged' && msg.scope === 'environment' && envEntry) {
        void this.store.applyEnvironmentValues(envEntry.id, msg.values);
      }
      if (msg.type === 'cookieJarChanged') {
        void this.cookies.save(msg.jar);
      }
      if (msg.type === 'vaultChanged') {
        void this.saveVault(msg.values);
      }
      onMessage(msg);
    });

    return handle;
  }

  /**
   * Does this run have anything to do with this row?
   *
   * Either direction counts. A run pointed at the collection is running the
   * request you are looking at, and a run pointed at one request inside a
   * folder is a run happening in that folder — so Stop on either row is asking
   * about the same run, and means the same thing.
   */
  private intersects(run: LiveRun, collectionUri: vscode.Uri, itemId?: string): boolean {
    if (run.collection !== collectionUri.toString()) { return false; }
    // Whole-collection on either side takes in everything in that collection.
    if (!itemId || !run.entrypointId) { return true; }
    if (run.entrypointId === itemId) { return true; }

    const entry = this.store.collection(collectionUri);
    const from = entry?.materialized.index.get(run.entrypointId)?.jsonPath;
    const here = entry?.materialized.index.get(itemId)?.jsonPath;
    if (!from || !here) { return false; }
    return coversPath(from, here) || coversPath(here, from);
  }

  runningIn(collectionUri: vscode.Uri, itemId?: string): boolean {
    for (const run of this.live) {
      if (this.intersects(run, collectionUri, itemId)) { return true; }
    }
    return false;
  }

  /**
   * Stop whatever is running here.
   *
   * Aborting is per run, not per request: postman-runtime is executing one
   * ordered sequence, and there is no way to drop a single item out of it. So
   * Stop on a request that a Run All happens to be in the middle of ends that
   * Run All — which is what the button on that row can honestly offer.
   */
  stop(collectionUri: vscode.Uri, itemId?: string): void {
    for (const run of [...this.live]) {
      if (this.intersects(run, collectionUri, itemId)) { run.handle.abort(); }
    }
  }

  dispose(): void {
    this._onDidObserve.dispose();
    this._onDidChangeRuns.dispose();
  }
}
