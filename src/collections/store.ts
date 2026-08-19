import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  detect,
  normalizeCollection,
  plaintextSecretKeys,
  validateCollection,
  type PostmanJson
} from './importer';
import { materialize, type MaterializedCollection } from './model';
import { applyJsonEdits, minimalReplacement, type JsonEdit } from './jsonEdit';
import { FileRegistry, type RegistryKind } from './registry';
import type { SecretsBroker } from '../secrets/broker';

export interface CollectionEntry {
  uri: vscode.Uri;
  id: string;
  name: string;
  /** Exactly what is on disk. */
  json: PostmanJson;
  /** The same collection with item ids filled in, used for the tree and runs. */
  materialized: MaterializedCollection;
}

export interface EnvironmentEntry {
  uri: vscode.Uri;
  id: string;
  name: string;
  json: PostmanJson;
}

/** What `register` found, so the caller can decide before anything is written. */
export interface RegisterResult {
  kind: RegistryKind;
  name: string;
  uri: vscode.Uri;
  /** Set when the file is a v1/v2.0 collection that must be converted to edit. */
  convertFrom?: '1.0.0' | '2.0.0';
  warnings: string[];
}

/** A request or folder located inside a collection, addressed by item id. */
export interface ItemRef {
  collectionUri: vscode.Uri;
  itemId: string;
}

export class CollectionStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  collections: CollectionEntry[] = [];
  environments: EnvironmentEntry[] = [];

  readonly registry: FileRegistry;
  /** One watcher per directory holding a tracked file; rebuilt on every reload. */
  private watchers: vscode.FileSystemWatcher[] = [];
  private configWatcher: vscode.Disposable | undefined;
  /** Paths this extension is mid-write on, so the watcher does not echo. */
  private readonly selfWrites = new Set<string>();

  constructor(
    private readonly workspaceFolder: vscode.WorkspaceFolder | undefined,
    private readonly secrets: SecretsBroker,
    private readonly log: vscode.LogOutputChannel
  ) {
    this.registry = new FileRegistry(workspaceFolder);
  }

  get workspaceRoot(): string | undefined {
    return this.workspaceFolder?.uri.fsPath;
  }

  async initialize(): Promise<void> {
    await this.reload();
    this.configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (FileRegistry.affects(e)) { void this.reload(); }
    });
  }

  /**
   * Watch exactly the files being tracked.
   *
   * A tracked file can live anywhere — including outside the workspace — so
   * there is no single glob to watch. One watcher per containing directory,
   * rebuilt whenever the tracked set changes.
   */
  private rewatch(uris: vscode.Uri[]): void {
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];

    const onChange = (uri: vscode.Uri) => {
      if (this.selfWrites.has(uri.fsPath)) { return; }
      void this.reload();
    };

    const directories = new Set(uris.map((u) => path.dirname(u.fsPath)));
    for (const dir of directories) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), '*.json')
      );
      watcher.onDidCreate(onChange);
      watcher.onDidChange(onChange);
      watcher.onDidDelete(onChange);
      this.watchers.push(watcher);
    }
  }

  private async readJsonFiles(
    uris: vscode.Uri[]
  ): Promise<Array<{ uri: vscode.Uri; json: PostmanJson }>> {
    const results = await Promise.all(
      uris.map(async (uri) => {
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          return { uri, json: JSON.parse(Buffer.from(bytes).toString('utf8')) as PostmanJson };
        } catch (e: any) {
          // A tracked file can be renamed or deleted outside the editor. Carry
          // on rather than losing every other collection with it, and keep a
          // merely-absent file out of the error log — that is a normal state
          // for a list that outlives the files it names.
          const missing = e?.code === 'FileNotFound' || e?.code === 'ENOENT';
          const message = `Could not read tracked file ${uri.fsPath}: ${e?.message ?? e}`;
          if (missing) { this.log.debug(message); } else { this.log.error(message); }
          return undefined;
        }
      })
    );
    return results.filter((r): r is { uri: vscode.Uri; json: PostmanJson } => r !== undefined);
  }

  async reload(): Promise<void> {
    const collectionUris = this.registry.list('collection');
    const environmentUris = this.registry.list('environment');
    this.rewatch([...collectionUris, ...environmentUris]);

    const [collections, environments] = await Promise.all([
      this.readJsonFiles(collectionUris),
      this.readJsonFiles(environmentUris)
    ]);

    this.collections = collections.map(({ uri, json }) => ({
      uri,
      id: String(json.info?._postman_id ?? path.basename(uri.fsPath)),
      name: String(json.info?.name ?? path.basename(uri.fsPath)),
      json,
      materialized: materialize(json)
    }));

    this.environments = environments.map(({ uri, json }) => ({
      uri,
      id: String(json.id ?? path.basename(uri.fsPath)),
      name: String(json.name ?? path.basename(uri.fsPath)),
      json
    }));

    this.log.info(`Loaded ${this.collections.length} collection(s), ${this.environments.length} environment(s).`);
    this._onDidChange.fire();
  }

  private async writeJson(uri: vscode.Uri, json: PostmanJson): Promise<void> {
    this.selfWrites.add(uri.fsPath);
    try {
      // Postman exports use tab indentation; match it so a re-export diffs cleanly.
      const text = JSON.stringify(json, null, '\t') + '\n';
      await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
    } finally {
      setTimeout(() => this.selfWrites.delete(uri.fsPath), 500);
    }
  }

  /**
   * Start working on a Postman file, in place.
   *
   * Nothing is copied and nothing is rewritten: the file is inspected, added to
   * the workspace's tracked list and then edited where it already lives. A v1 or
   * v2.0 collection cannot be edited without converting it, so that is reported
   * back rather than done silently — see `convert`.
   */
  async register(source: vscode.Uri): Promise<RegisterResult> {
    const json = await this.readJson(source);
    const detected = detect(json);
    if (detected.kind === 'unknown') { throw new Error(detected.reason); }

    if (detected.kind === 'environment') {
      const name = String(json.name ?? path.basename(source.fsPath));
      const plaintext = plaintextSecretKeys(json);
      await this.registry.add('environment', source);
      await this.reload();
      return {
        kind: 'environment',
        name,
        uri: source,
        warnings: plaintext.length
          ? [`${plaintext.length} secret value(s) are stored in plaintext in this file.`]
          : []
      };
    }

    const name = String(json.info?.name ?? path.basename(source.fsPath));
    const warnings: string[] = [];
    if (detected.version === '2.1.0') {
      const schemaErrors = validateCollection(json);
      if (schemaErrors.length) {
        warnings.push(`Loaded with ${schemaErrors.length} schema warning(s); it will still run.`);
        this.log.warn(`Schema warnings for ${source.fsPath}:\n  ${schemaErrors.join('\n  ')}`);
      }
      await this.registry.add('collection', source);
      await this.reload();
      return { kind: 'collection', name, uri: source, warnings };
    }

    // Older formats are reported, not converted: rewriting a file the user owns
    // is their decision to make.
    return { kind: 'collection', name, uri: source, convertFrom: detected.version, warnings };
  }

  /** Rewrite a v1/v2.0 collection as v2.1.0 in place, then track it. */
  async convert(source: vscode.Uri, from: '1.0.0' | '2.0.0'): Promise<void> {
    const normalized = await normalizeCollection(await this.readJson(source), from);
    await this.writeJson(source, normalized);
    await this.registry.add('collection', source);
    await this.reload();
  }

  /** Stop tracking a file. The file itself is left exactly where it is. */
  async unregister(kind: RegistryKind, uri: vscode.Uri): Promise<void> {
    await this.registry.remove(kind, uri);
    await this.reload();
  }

  private async readJson(uri: vscode.Uri): Promise<PostmanJson> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    try {
      return JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch (e: any) {
      throw new Error(`${path.basename(uri.fsPath)} is not valid JSON: ${e?.message ?? e}`);
    }
  }

  /**
   * Move one plaintext secret out of the file and into the OS keychain.
   *
   * Only ever on request: the file belongs to the user, so blanking a value in
   * it is something they opt into rather than something registering does.
   */
  async moveSecretToKeychain(environmentId: string, key: string): Promise<void> {
    const entry = this.environment(environmentId);
    if (!entry) { throw new Error(`Environment "${environmentId}" is no longer available.`); }

    const current = (entry.json.values ?? []).find((v: any) => String(v?.key ?? '') === key);
    const value = typeof current?.value === 'string' ? current.value : '';
    if (!value) { throw new Error(`${key} has no value in the file to move.`); }

    await this.secrets.set(environmentId, key, value);
    await this.editJsonFile(entry.uri, [
      {
        path: ['values'],
        value: (entry.json.values ?? []).map((v: any) =>
          String(v?.key ?? '') === key ? { ...v, value: '', type: 'secret' } : v
        )
      }
    ]);
  }

  /**
   * Apply edits to a collection file, preserving formatting everywhere else.
   *
   * Routed through a WorkspaceEdit against the TextDocument rather than a raw
   * filesystem write, so undo, dirty state, hot exit and file watching all come
   * from VS Code instead of being reimplemented.
   */
  async editCollection(uri: vscode.Uri, edits: JsonEdit[]): Promise<void> {
    await this.editJsonFile(uri, edits);
  }

  /**
   * Rewrite an environment's variable list.
   *
   * `secret` values never reach the file: they are routed to the OS keychain and
   * the JSON keeps an empty string, so the environment stays safe to commit. A
   * secret whose value comes back as `undefined` is left alone rather than
   * cleared, which is how the editor sends "unchanged" for a masked field.
   */
  async editEnvironment(
    uri: vscode.Uri,
    values: Array<{ key: string; value?: string; type: string; enabled: boolean }>
  ): Promise<void> {
    const entry = this.environments.find((e) => e.uri.toString() === uri.toString());
    if (!entry) { return; }

    const previous = new Map<string, any>((entry.json.values ?? []).map((v: any) => [String(v.key), v]));
    const written: Array<Record<string, unknown>> = [];

    for (const row of values) {
      if (!row.key.trim()) { continue; }
      const before = previous.get(row.key);

      if (row.type === 'secret') {
        if (row.value !== undefined) { await this.secrets.set(entry.id, row.key, row.value); }
        // Blank the file only once the keychain holds the value. A secret still
        // sitting in plaintext keeps whatever the user's file already had, so
        // registering a file never quietly empties it.
        const inKeychain =
          row.value !== undefined || (await this.secrets.get(entry.id, row.key)) !== undefined;
        written.push({
          ...(before ?? {}),
          key: row.key,
          value: inKeychain ? '' : String(before?.value ?? ''),
          type: 'secret',
          enabled: row.enabled
        });
      } else {
        // Demoting a secret to a plain value must not leave the old one behind.
        if (before?.type === 'secret') { await this.secrets.delete(entry.id, row.key); }
        written.push({
          ...(before ?? {}),
          key: row.key,
          value: row.value ?? before?.value ?? '',
          type: row.type || 'default',
          enabled: row.enabled
        });
      }
    }

    // Variables removed in the editor should not linger in the keychain.
    const kept = new Set(values.map((v) => v.key));
    for (const [key, before] of previous) {
      if (!kept.has(key) && before?.type === 'secret') { await this.secrets.delete(entry.id, key); }
    }

    await this.editJsonFile(uri, [{ path: ['values'], value: written }]);
  }

  /**
   * Set one environment variable, leaving every other row untouched.
   *
   * Backs the inline variable editor in the request panel. Every other row is
   * replayed with `value: undefined` when it is a secret, which is
   * `editEnvironment`'s established "unchanged" signal — otherwise editing one
   * plain variable would wipe every secret in the keychain.
   */
  async setEnvironmentVariable(id: string, key: string, value: string): Promise<void> {
    const entry = this.environment(id);
    if (!entry) { throw new Error(`Environment "${id}" is no longer available.`); }

    const rows = (entry.json.values ?? []).map((v: any) => ({
      key: String(v?.key ?? ''),
      value: v?.type === 'secret' ? undefined : String(v?.value ?? ''),
      type: String(v?.type ?? 'default'),
      enabled: v?.enabled !== false
    }));

    const existing = rows.find((r: { key: string }) => r.key === key);
    if (existing) { existing.value = value; }
    else { rows.push({ key, value, type: 'default', enabled: true }); }

    await this.editEnvironment(entry.uri, rows);
  }

  /** Set one collection-level variable in the collection's `variable[]`. */
  async setCollectionVariable(uri: vscode.Uri, key: string, value: string): Promise<void> {
    const entry = this.collection(uri);
    if (!entry) { throw new Error('That collection is no longer available.'); }

    const current: any[] = entry.materialized.json.variable ?? [];
    const index = current.findIndex((v: any) => String(v?.key ?? '') === key);
    // Spread the existing entry so unmodelled Postman keys (description, type)
    // survive the edit.
    const next =
      index >= 0
        ? current.map((v: any, i: number) => (i === index ? { ...v, key, value } : v))
        : [...current, { key, value, type: 'default' }];

    await this.editCollection(uri, [{ path: ['variable'], value: next }]);
  }

  /**
   * Create a new, empty environment file and start working on it.
   *
   * There was previously no way to make an environment at all — only to add one
   * exported from Postman.
   */
  async createEnvironment(uri: vscode.Uri, name: string): Promise<EnvironmentEntry> {
    try {
      await vscode.workspace.fs.stat(uri);
      throw new Error(`${path.basename(uri.fsPath)} already exists.`);
    } catch (e: any) {
      // Anything other than "not found" is a real problem worth surfacing.
      if (e instanceof Error && e.message.endsWith('already exists.')) { throw e; }
    }

    const id = `env-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    await this.writeJson(uri, {
      id,
      name,
      values: [],
      _postman_variable_scope: 'environment',
      _postman_exported_at: new Date().toISOString()
    });
    await this.registry.add('environment', uri);
    await this.reload();

    const entry = this.environment(id);
    if (!entry) { throw new Error(`Could not load the new environment at ${uri.fsPath}.`); }
    return entry;
  }

  /** Remove one variable from an environment, and its keychain entry if any. */
  async deleteEnvironmentVariable(environmentId: string, key: string): Promise<void> {
    const entry = this.environment(environmentId);
    if (!entry) { throw new Error(`Environment "${environmentId}" is no longer available.`); }

    const before = (entry.json.values ?? []).find((v: any) => String(v?.key ?? '') === key);
    if (before?.type === 'secret') { await this.secrets.delete(environmentId, key); }

    await this.editJsonFile(entry.uri, [
      {
        path: ['values'],
        value: (entry.json.values ?? []).filter((v: any) => String(v?.key ?? '') !== key)
      }
    ]);
  }

  /** Tick or untick one variable, which is how Postman disables it for a run. */
  async setEnvironmentVariableEnabled(
    environmentId: string,
    key: string,
    enabled: boolean
  ): Promise<void> {
    const entry = this.environment(environmentId);
    if (!entry) { throw new Error(`Environment "${environmentId}" is no longer available.`); }

    await this.editJsonFile(entry.uri, [
      {
        path: ['values'],
        value: (entry.json.values ?? []).map((v: any) =>
          String(v?.key ?? '') === key ? { ...v, enabled } : v
        )
      }
    ]);
  }

  /** Turn a plain variable into a secret, or a secret back into a plain one. */
  async setEnvironmentVariableSecret(
    environmentId: string,
    key: string,
    secret: boolean
  ): Promise<void> {
    const entry = this.environment(environmentId);
    if (!entry) { throw new Error(`Environment "${environmentId}" is no longer available.`); }

    const before = (entry.json.values ?? []).find((v: any) => String(v?.key ?? '') === key);
    if (!before) { throw new Error(`${key} is not defined in ${entry.name}.`); }

    if (secret) {
      // Promoting moves the value straight out of the file, which is the point.
      const value = typeof before.value === 'string' ? before.value : '';
      if (value) { await this.secrets.set(environmentId, key, value); }
      await this.editJsonFile(entry.uri, [
        {
          path: ['values'],
          value: (entry.json.values ?? []).map((v: any) =>
            String(v?.key ?? '') === key ? { ...v, type: 'secret', value: '' } : v
          )
        }
      ]);
      return;
    }

    // Demoting writes the keychain value back into the file, then forgets it —
    // otherwise the value would simply vanish.
    const stored = await this.secrets.get(environmentId, key);
    await this.secrets.delete(environmentId, key);
    await this.editJsonFile(entry.uri, [
      {
        path: ['values'],
        value: (entry.json.values ?? []).map((v: any) =>
          String(v?.key ?? '') === key
            ? { ...v, type: 'default', value: stored ?? String(v?.value ?? '') }
            : v
        )
      }
    ]);
  }

  /**
   * Which of an environment's `secret` variables actually have a value in the
   * keychain, so the UI can distinguish "hidden" from "never set".
   */
  async storedSecretKeys(id: string): Promise<Set<string>> {
    const entry = this.environment(id);
    if (!entry) { return new Set(); }
    return new Set(Object.keys(await this.secrets.resolveFor(id, entry.json.values ?? [])));
  }

  /**
   * Shared implementation behind collection and environment edits.
   *
   * When the file is open in the editor the change goes through a WorkspaceEdit
   * so the user's undo stack, dirty state and hot exit all behave. When it is
   * not open, the file is written directly: opening a TextDocument purely to
   * save it adds nothing, and leaves a stale in-memory copy that later fails
   * with "File Modified Since" if anything else touches the file.
   */
  private async editJsonFile(uri: vscode.Uri, edits: JsonEdit[]): Promise<void> {
    if (!edits.length) { return; }

    const open = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === uri.toString() && !d.isClosed
    );

    const before = open
      ? open.getText()
      : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    const after = applyJsonEdits(before, edits);

    const replacement = minimalReplacement(before, after);
    if (!replacement) { return; }

    if (open) {
      const workspaceEdit = new vscode.WorkspaceEdit();
      workspaceEdit.replace(
        uri,
        new vscode.Range(
          open.positionAt(replacement.startOffset),
          open.positionAt(replacement.endOffset)
        ),
        replacement.text
      );

      const applied = await vscode.workspace.applyEdit(workspaceEdit);
      if (!applied) { throw new Error(`Could not edit ${path.basename(uri.fsPath)}.`); }

      // The runner reads from disk, so an unsaved edit would not take effect.
      if (open.isDirty) { await open.save(); }
    } else {
      this.selfWrites.add(uri.fsPath);
      try {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(after, 'utf8'));
      } finally {
        setTimeout(() => this.selfWrites.delete(uri.fsPath), 500);
      }
    }

    await this.reload();
  }

  collection(uri: vscode.Uri): CollectionEntry | undefined {
    return this.collections.find((c) => c.uri.toString() === uri.toString());
  }

  environment(id: string): EnvironmentEntry | undefined {
    return this.environments.find((e) => e.id === id);
  }

  /** Persist scope mutations a script made (`pm.environment.set`). */
  async applyEnvironmentValues(
    id: string,
    values: Array<{ key: string; value: unknown; type?: string }>
  ): Promise<void> {
    const entry = this.environment(id);
    if (!entry) { return; }

    const secretKeys = new Set(
      (entry.json.values ?? []).filter((v: any) => v?.type === 'secret').map((v: any) => String(v.key))
    );

    const next = values.map((v) => {
      const existing = (entry.json.values ?? []).find((e: any) => e?.key === v.key);
      // Never write a secret back into the committed file; route it to the keychain.
      if (secretKeys.has(v.key)) {
        void this.secrets.set(id, v.key, String(v.value ?? ''));
        // Now in the keychain, so the file can safely hold nothing.
        return { ...(existing ?? { key: v.key, enabled: true }), type: 'secret', value: '' };
      }
      return { ...(existing ?? { enabled: true }), key: v.key, value: v.value, type: v.type ?? existing?.type ?? 'default' };
    });

    await this.writeJson(entry.uri, { ...entry.json, values: next });
    await this.reload();
  }

  dispose(): void {
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];
    this.configWatcher?.dispose();
    this._onDidChange.dispose();
  }
}
