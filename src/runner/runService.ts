import * as vscode from 'vscode';
import type { CollectionEntry, CollectionStore } from '../collections/store';
import type { SecretsBroker } from '../secrets/broker';
import type { RunHandle, RunnerClient } from './client';
import type { RunnerMessage } from './protocol';
import type { CookieStore } from './cookieStore';
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

/**
 * Turns "run this item with the currently selected environment" into a runner
 * invocation, applying workspace trust, secrets and user settings.
 *
 * Shared by the request panel and (later) the collection runner so both get
 * identical execution semantics.
 */
export class RunService implements vscode.Disposable {
  private readonly _onDidObserve = new vscode.EventEmitter<ObservedMessage>();
  /** Every message from every run, for the Postman Console. */
  readonly onDidObserve = this._onDidObserve.event;

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
      workspaceRoot: this.store.workspaceRoot,
      followRedirects: config.get<boolean>('followRedirects', true),
      maxRedirects: config.get<number>('maxRedirects', 10),
      strictSSL: readStrictSSL(),
      protocolVersion: config.get<string>('protocolVersion', 'auto'),
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

  dispose(): void {
    this._onDidObserve.dispose();
  }
}
