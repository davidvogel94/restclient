import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  detect,
  normalizeCollection,
  plaintextSecretKeys,
  validateCollection,
  type PostmanJson
} from './importer';
import { environmentExportJson } from './export';
import { jsonProblems, type JsonProblem } from './problems';
import { materialize, type MaterializedCollection } from './model';
import { applyJsonEdits, minimalReplacement, type JsonEdit } from './jsonEdit';
import { FileRegistry, type RegistryKind } from './registry';
import { WorkspaceScanner } from './scanner';
import { kindFromFileName } from './discovery';
import { configuredImportFolder } from './importTarget';
import { isInsideAny, rootFor } from './paths';
import { uniqueFileName } from './importer';
import type { SecretsBroker } from '../secrets/broker';

/**
 * How a file came to be tracked, which is what untracking it has to undo.
 *
 * A `registered` file is named in settings and is removed from that list. A
 * `discovered` one is in no list, so refusing it means recording an exclusion
 * instead — see `untrack`.
 */
export type EntrySource = 'registered' | 'discovered';

export interface CollectionEntry {
  uri: vscode.Uri;
  source: EntrySource;
  id: string;
  name: string;
  /** Exactly what is on disk. */
  json: PostmanJson;
  /** The same collection with item ids filled in, used for the tree and runs. */
  materialized: MaterializedCollection;
}

export interface EnvironmentEntry {
  uri: vscode.Uri;
  source: EntrySource;
  id: string;
  name: string;
  json: PostmanJson;
}

/**
 * A tracked file that could not be loaded.
 *
 * Kept apart from the loaded entries rather than mixed in with a flag: nothing
 * downstream — the runner, the panels, export — can do anything with a file it
 * cannot parse, and they would all have to learn to skip it. The views read
 * this list separately and show the file with its errors, so a broken file
 * stays visible and fixable instead of silently vanishing from the tree.
 */
export interface BrokenEntry {
  kind: RegistryKind;
  uri: vscode.Uri;
  source: EntrySource;
  /** The file name: a file that will not parse cannot be asked its own name. */
  name: string;
  problems: JsonProblem[];
}

/**
 * A tracked file that parsed but cannot be worked on as it stands.
 *
 * Separate from `BrokenEntry` because nothing is wrong with it: an old
 * collection format is a file this extension could work on after a conversion
 * the user has to agree to, so the row says what it is and offers to do it.
 * Loading one anyway is not an option — `materialize` would make nonsense of a
 * v1 collection's flat `requests` array.
 */
export interface UnsupportedEntry {
  kind: RegistryKind;
  uri: vscode.Uri;
  source: EntrySource;
  name: string;
  /** Short enough for a tree row: `Postman v1.0.0 — needs converting`. */
  reason: string;
  /** Set when converting is what would fix it. */
  convertFrom?: '1.0.0' | '2.0.0';
}

/**
 * A tracked file that is not there.
 *
 * Only ever a *registered* one. A list of paths outlives the files it names, so
 * an entry pointing at nothing is a fact about the settings rather than about
 * the workspace, and the only person who can act on it is whoever wrote the
 * entry — which they cannot do if it is reported nowhere. A scan result that
 * vanishes between the glob and the read is a race and says nothing, so that
 * stays silent.
 *
 * Its own list rather than a `BrokenEntry`, because the remedy differs: broken
 * means fix the JSON, unsupported means convert it, missing means fix the path
 * or drop the entry.
 */
export interface MissingEntry {
  kind: RegistryKind;
  uri: vscode.Uri;
  name: string;
  /** Always `registered` — a discovered file that vanished is not reported. */
  source: EntrySource;
  /** The entry as it would be written, so the message can quote what to look for. */
  setting: string;
}

/** A read file, before it becomes an entry. */
interface LoadedFile {
  uri: vscode.Uri;
  json: PostmanJson;
  source: EntrySource;
}

/** One pass of reading tracked files, sorted by what can be done with each. */
interface Classified {
  collections: LoadedFile[];
  environments: LoadedFile[];
  broken: BrokenEntry[];
  unsupported: UnsupportedEntry[];
  missing: MissingEntry[];
}

function empty(): Classified {
  return { collections: [], environments: [], broken: [], unsupported: [], missing: [] };
}

/** What `register` found, so the caller can decide before anything is written. */
export interface RegisterResult {
  kind: RegistryKind;
  name: string;
  uri: vscode.Uri;
  /** Set when the file is a v1/v2.0 collection that must be converted to edit. */
  convertFrom?: '1.0.0' | '2.0.0';
  /** Where the file came from, when `uri` is a copy of it rather than it. */
  copiedFrom?: vscode.Uri;
  /** Set when tracking this file *would* copy it — the convert prompt says so differently. */
  willCopy?: boolean;
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
  /** Tracked files that would not parse, in registry order. */
  broken: BrokenEntry[] = [];
  /** Tracked files that parsed but need something done before they can be used. */
  unsupported: UnsupportedEntry[] = [];
  /** Listed files that are not on disk, in registry order. */
  missing: MissingEntry[] = [];

  readonly registry: FileRegistry;
  private readonly scanner: WorkspaceScanner;
  /** One watcher per directory holding a tracked file; rebuilt on every reload. */
  private watchers: vscode.FileSystemWatcher[] = [];
  private configWatcher: vscode.Disposable | undefined;
  private scanSubscription: vscode.Disposable | undefined;
  private folderWatcher: vscode.Disposable | undefined;
  /** Paths this extension is mid-write on, so the watcher does not echo. */
  private readonly selfWrites = new Set<string>();

  /** Coalesce a burst of filesystem events — a branch switch is one reload, not fifty. */
  private static readonly RELOAD_DEBOUNCE_MS = 250;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private reloading: Promise<void> | undefined;
  private reloadPending = false;

  constructor(
    /**
     * Read, not captured. `workspace.workspaceFolders` changes under a live
     * extension — "Add Folder to Workspace" is how collections kept outside the
     * repo become workable — and everything downstream of it has to see that.
     */
    private readonly folders: () => readonly vscode.WorkspaceFolder[],
    private readonly secrets: SecretsBroker,
    private readonly log: vscode.LogOutputChannel
  ) {
    this.registry = new FileRegistry(folders);
    this.scanner = new WorkspaceScanner(
      folders,
      () => this.registry.excludedPaths(),
      (folder) => this.registry.excludeGlobs(folder),
      (folder) => this.importFolder(folder),
      log
    );
  }

  /**
   * One folder's chosen collections directory, relative to it.
   *
   * `path.relative` and not the raw setting, so an absolute entry and a `~/`
   * one land in the same shape the glob needs — and so a folder that is not
   * under this root comes back with a leading `..`, which
   * `importFolderPattern` refuses.
   */
  private importFolder(workspaceFolder: vscode.WorkspaceFolder): string | undefined {
    const folder = configuredImportFolder(workspaceFolder);
    if (!folder) { return undefined; }
    return path.relative(workspaceFolder.uri.fsPath, folder.fsPath);
  }

  /** Every folder in the workspace, as absolute paths. */
  get workspaceRoots(): string[] {
    return this.folders().map((f) => f.uri.fsPath);
  }

  /**
   * The first workspace folder.
   *
   * Still the right answer for the handful of questions that need *a* root
   * rather than the one a given file belongs to — where a dialog should open,
   * whether there is a workspace at all. Anything resolving a path against a
   * root wants `rootFor` instead.
   */
  get workspaceRoot(): string | undefined {
    return this.folders()[0]?.uri.fsPath;
  }

  /** The workspace folder a tracked file lives in, or nothing when it is outside them all. */
  rootFor(uri: vscode.Uri): string | undefined {
    return rootFor(uri.fsPath, this.workspaceRoots);
  }

  async initialize(): Promise<void> {
    await this.reload();
    this.scanner.rewatch();

    // Adding a folder is how a collection kept outside this repo becomes
    // workable, so it has to take effect immediately: new settings to read, a
    // new tree to scan, and a new root the runner will read files from.
    this.folderWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.scanner.rewatch();
      void this.rescan();
    });

    this.scanSubscription = this.scanner.onDidChange((uri) => {
      if (this.selfWrites.has(uri.fsPath)) { return; }
      this.scheduleReload();
    });

    this.configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      const listsChanged = FileRegistry.affects(e);
      const scanChanged = WorkspaceScanner.affects(e);
      if (!listsChanged && !scanChanged) { return; }
      // The exclusions are one of the lists *and* an input to the scan, so
      // either kind of change can have staled its results.
      this.scanner.invalidate();
      // The watcher's own glob is built from the patterns.
      if (scanChanged) { this.scanner.rewatch(); }
      void this.reload();
    });
  }

  /**
   * Reload soon, and once, however many events say to.
   *
   * Only the watchers use this. Everything that acts on the user's behalf —
   * registering, converting, editing, Refresh — awaits `reload` directly,
   * because it has to see the result.
   */
  private scheduleReload(): void {
    if (this.reloadTimer) { clearTimeout(this.reloadTimer); }
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.reload();
    }, CollectionStore.RELOAD_DEBOUNCE_MS);
  }

  /** Rescan the workspace, then reload. What Refresh means now. */
  async rescan(): Promise<void> {
    this.scanner.invalidate();
    await this.reload();
  }

  /**
   * Watch exactly the files being tracked.
   *
   * One of two watchers, with two different jobs. This one sees a *tracked*
   * file change, and a tracked file can live anywhere — including outside the
   * workspace, where no workspace-relative glob reaches — so it is one watcher
   * per containing directory, rebuilt whenever the tracked set changes. The
   * scanner's single glob watcher sees the tracked *set* change instead.
   */
  private rewatch(uris: vscode.Uri[]): void {
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];

    const onChange = (uri: vscode.Uri) => {
      if (this.selfWrites.has(uri.fsPath)) { return; }
      this.scheduleReload();
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

  /**
   * Read a set of tracked files, sorting them into what can be worked on and
   * what cannot.
   *
   * Four outcomes, and the reasoning differs for each. A *missing* file is not
   * an error: a list of paths outlives the files it names, and a scan result
   * can be deleted between the glob and the read. A file that will not *parse*
   * is reported, because that is a state the user can see and fix — and one
   * they would otherwise experience as a collection that disappeared for no
   * stated reason. A file in an *old* Postman format is reported separately,
   * since converting it would rewrite it and that is the user's call. Anything
   * left loads.
   *
   * `expect` is the kind the caller already knows, from the list the path came
   * out of. Without it — the scan, which matched on a file name — the kind is
   * read from the contents instead.
   */
  private async readFiles(
    uris: vscode.Uri[],
    source: EntrySource,
    expect?: RegistryKind
  ): Promise<Classified> {
    const out: Classified = empty();

    const results = await Promise.all(
      uris.map(async (uri): Promise<Classified | undefined> => {
        let text: string;
        try {
          text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        } catch (e: any) {
          const absent = e?.code === 'FileNotFound' || e?.code === 'ENOENT';
          const message = `Could not read tracked file ${uri.fsPath}: ${e?.message ?? e}`;
          if (absent) { this.log.debug(message); } else { this.log.error(message); }
          if (absent) {
            // Listed and not there: somebody wrote that path down and it no
            // longer resolves, which is worth a row. Found by the scan and
            // gone: a file deleted between the glob and the read, which is
            // worth nothing.
            if (source !== 'registered' || !expect) { return undefined; }
            this.log.warn(`Tracked file is missing: ${uri.fsPath}`);
            return { ...empty(), missing: [this.missingEntry(expect, uri)] };
          }
          const kind = expect ?? this.discoveredKind(uri);
          // Nothing was read, so there is no position to point at.
          return kind
            ? { ...empty(), broken: [this.brokenEntry(kind, uri, source, [{ message: String(e?.message ?? e) }])] }
            : undefined;
        }

        let json: PostmanJson;
        try {
          json = JSON.parse(text) as PostmanJson;
        } catch (e: any) {
          // A file the scan turned up that nothing marks as ours is not worth a
          // row: nobody asked for it, and a widened pattern should not fill the
          // tree with every unparseable JSON file in the repo.
          const kind = expect ?? this.discoveredKind(uri);
          if (!kind) {
            this.log.debug(`Skipping unparseable ${uri.fsPath}: ${e?.message ?? e}`);
            return undefined;
          }
          this.log.error(`Could not parse tracked file ${uri.fsPath}: ${e?.message ?? e}`);
          // `JSON.parse` reports one error and an awkward offset; jsonc-parser
          // recovers and reports them all, with a range for each. Its silence
          // on a file `JSON.parse` rejected would leave nothing to show, so
          // keep the thrown message as the fallback.
          const problems = jsonProblems(text);
          return {
            ...empty(),
            broken: [
              this.brokenEntry(
                kind,
                uri,
                source,
                problems.length ? problems : [{ message: String(e?.message ?? e) }]
              )
            ]
          };
        }

        return this.classify(uri, json, source, expect);
      })
    );

    for (const result of results) {
      if (!result) { continue; }
      out.collections.push(...result.collections);
      out.environments.push(...result.environments);
      out.broken.push(...result.broken);
      out.unsupported.push(...result.unsupported);
      out.missing.push(...result.missing);
    }
    return out;
  }

  /**
   * Decide what a parsed file is, and whether it can be used.
   *
   * `detect` is the same function the import path uses, so a file found by the
   * scan is judged exactly as one the user pointed at would be. Running it over
   * listed files too is deliberate: a v1 collection someone put in
   * `restclient.collections` by hand used to load and come out as nonsense.
   */
  private classify(
    uri: vscode.Uri,
    json: PostmanJson,
    source: EntrySource,
    expect?: RegistryKind
  ): Classified {
    const detected = detect(json);
    const name = path.basename(uri.fsPath);

    if (detected.kind === 'unknown') {
      // Listed explicitly, so somebody believes it belongs here and deserves
      // to be told why it does not. Merely found, so it is simply not ours.
      if (!expect) {
        this.log.debug(`Skipping ${uri.fsPath}: ${detected.reason}`);
        return empty();
      }
      return {
        ...empty(),
        unsupported: [{ kind: expect, uri, source, name, reason: 'not a Postman export' }]
      };
    }

    const kind: RegistryKind = expect ?? (detected.kind === 'collection' ? 'collection' : 'environment');

    if (detected.kind === 'collection' && detected.version !== '2.1.0') {
      return {
        ...empty(),
        unsupported: [
          {
            kind,
            uri,
            source,
            name,
            reason: `Postman v${detected.version} — needs converting`,
            convertFrom: detected.version
          }
        ]
      };
    }

    return kind === 'collection'
      ? { ...empty(), collections: [{ uri, json, source }] }
      : { ...empty(), environments: [{ uri, json, source }] };
  }

  /**
   * Which pane a *discovered* file that will not load belongs in, or nothing
   * when it is not ours to report.
   *
   * Only reached for a file the scan turned up that could not be read or
   * parsed; anything loadable is classified by what it contains. Two things
   * mark such a file as ours: Postman's own naming, anywhere in the workspace,
   * and sitting in the folder the user chose to keep collections in — where the
   * name says nothing because the whole point of that folder is that every JSON
   * file in it is this extension's. A collection broken by a hand-edit has to
   * show up somewhere, and silently vanishing from the tree is the one outcome
   * that leaves the user nothing to act on.
   *
   * `collection` is the fallback kind in that folder: environments are the ones
   * Postman names distinctively, so `kindFromFileName` has already had its say.
   */
  private discoveredKind(uri: vscode.Uri): RegistryKind | undefined {
    // Both questions of the file name are the same question, so `kindFromFileName`
    // answering at all is the naming test passing.
    const byName = kindFromFileName(uri.fsPath);
    if (byName) { return byName; }
    const importFolders = this.folders()
      .map((f) => configuredImportFolder(f))
      .filter((f): f is vscode.Uri => Boolean(f))
      .map((f) => f.fsPath);
    return isInsideAny(uri.fsPath, importFolders) ? 'collection' : undefined;
  }

  private brokenEntry(
    kind: RegistryKind,
    uri: vscode.Uri,
    source: EntrySource,
    problems: JsonProblem[]
  ): BrokenEntry {
    return { kind, uri, source, name: path.basename(uri.fsPath), problems };
  }

  /**
   * A row for a listed file that is not on disk.
   *
   * The path is quoted the way it would be written in settings — relative to
   * its own workspace folder — because that, not the absolute path, is the
   * string the user has to find and fix.
   */
  private missingEntry(kind: RegistryKind, uri: vscode.Uri): MissingEntry {
    const root = this.rootFor(uri);
    return {
      kind,
      uri,
      source: 'registered',
      name: path.basename(uri.fsPath),
      setting: root ? path.relative(root, uri.fsPath).split(path.sep).join('/') : uri.fsPath
    };
  }

  async reload(): Promise<void> {
    // Reloading is no longer cheap enough to let two runs interleave: the
    // slower one would publish its stale results over the fresher ones.
    if (this.reloading) {
      this.reloadPending = true;
      return this.reloading;
    }
    this.reloading = (async () => {
      try {
        do {
          this.reloadPending = false;
          await this.reloadOnce();
        } while (this.reloadPending);
      } finally {
        this.reloading = undefined;
      }
    })();
    return this.reloading;
  }

  private async reloadOnce(): Promise<void> {
    const registeredCollections = this.registry.list('collection');
    const registeredEnvironments = this.registry.list('environment');

    // Explicit beats implicit: a file named in settings is registered, never
    // discovered, so untracking it is unambiguously "remove the entry".
    const listed = new Set(
      [...registeredCollections, ...registeredEnvironments].map((u) => u.fsPath)
    );
    const discovered = (await this.scanner.uris()).filter((u) => !listed.has(u.fsPath));

    this.rewatch([...registeredCollections, ...registeredEnvironments, ...discovered]);

    const [collections, environments, found] = await Promise.all([
      this.readFiles(registeredCollections, 'registered', 'collection'),
      this.readFiles(registeredEnvironments, 'registered', 'environment'),
      this.readFiles(discovered, 'discovered')
    ]);

    this.broken = [...collections.broken, ...environments.broken, ...found.broken];
    this.unsupported = [
      ...collections.unsupported,
      ...environments.unsupported,
      ...found.unsupported
    ];
    this.missing = [...collections.missing, ...environments.missing, ...found.missing];

    this.collections = [...collections.collections, ...found.collections].map(
      ({ uri, json, source }) => ({
        uri,
        source,
        id: String(json.info?._postman_id ?? path.basename(uri.fsPath)),
        name: String(json.info?.name ?? path.basename(uri.fsPath)),
        json,
        materialized: materialize(json)
      })
    );

    this.environments = [...environments.environments, ...found.environments].map(
      ({ uri, json, source }) => ({
        uri,
        source,
        id: String(json.id ?? path.basename(uri.fsPath)),
        name: String(json.name ?? path.basename(uri.fsPath)),
        json
      })
    );

    const unusable = this.broken.length ? `, ${this.broken.length} unreadable` : '';
    const needsWork = this.unsupported.length ? `, ${this.unsupported.length} needing conversion` : '';
    const absent = this.missing.length ? `, ${this.missing.length} missing` : '';
    this.log.info(
      `Loaded ${this.collections.length} collection(s), ` +
        `${this.environments.length} environment(s)${unusable}${needsWork}${absent}.`
    );
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
   * Start working on a Postman file.
   *
   * The file is read and identified *first*, so a file that turns out not to be
   * a Postman export throws before anything has been written — no stray copy is
   * left behind in the user's import folder.
   *
   * With `copyInto`, a file from outside the workspace is copied there and it is
   * the copy that gets tracked; the original is never listed, moved or
   * rewritten. A file already inside the workspace is worked on where it is.
   * Without `copyInto` — the Explorer menu, where the file is in the workspace
   * by definition — nothing is copied at all.
   *
   * A v1 or v2.0 collection cannot be edited without converting it, so that is
   * reported back rather than done silently — see `convert`.
   */
  async register(
    source: vscode.Uri,
    options: { copyInto?: vscode.Uri } = {}
  ): Promise<RegisterResult> {
    const json = await this.readJson(source);
    const detected = detect(json);
    if (detected.kind === 'unknown') { throw new Error(detected.reason); }

    const willCopy = this.wouldCopy(source, options.copyInto);

    if (detected.kind === 'environment') {
      const name = String(json.name ?? path.basename(source.fsPath));
      const plaintext = plaintextSecretKeys(json);
      const placed = await this.placeCopy(source, options.copyInto);
      await this.track('environment', placed.uri);
      return {
        kind: 'environment',
        name,
        uri: placed.uri,
        copiedFrom: placed.copied ? source : undefined,
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
      const placed = await this.placeCopy(source, options.copyInto);
      await this.track('collection', placed.uri);
      return {
        kind: 'collection',
        name,
        uri: placed.uri,
        copiedFrom: placed.copied ? source : undefined,
        warnings
      };
    }

    // Older formats are reported, not converted: rewriting a file the user owns
    // is their decision to make. Nothing has been copied yet either, so
    // declining leaves the import folder as it was.
    return { kind: 'collection', name, uri: source, convertFrom: detected.version, willCopy, warnings };
  }

  /**
   * Rewrite a v1/v2.0 collection as v2.1.0, then start working on it.
   *
   * With `copyInto`, the conversion lands in a copy and the original is left
   * untouched — a file from outside the workspace is not ours to rewrite.
   * Without it the file is converted where it lies, which is what the prompt
   * for an in-workspace file says will happen.
   *
   * Returns the file now being worked on, which is not necessarily the one
   * passed in.
   */
  async convert(
    source: vscode.Uri,
    from: '1.0.0' | '2.0.0',
    options: { copyInto?: vscode.Uri } = {}
  ): Promise<vscode.Uri> {
    const normalized = await normalizeCollection(await this.readJson(source), from);
    const placed = await this.placeCopy(source, options.copyInto);
    await this.writeJson(placed.uri, normalized);
    await this.track('collection', placed.uri);
    return placed.uri;
  }

  /** Would tracking this file copy it? Asked before anything is written, for the prompt's wording. */
  private wouldCopy(source: vscode.Uri, copyInto: vscode.Uri | undefined): boolean {
    return Boolean(copyInto) && !isInsideAny(source.fsPath, this.workspaceRoots);
  }

  /**
   * The file this workspace will actually work on.
   *
   * An import copies, so what gets tracked is the copy and the original is left
   * alone — including left un-rewritten by a conversion. A source already
   * inside the workspace is worked on where it is: a second copy of a file
   * already committed here serves nobody.
   *
   * A name clash keeps both files rather than overwriting one. Every other
   * write path in this extension refuses to clobber a file, and an import is
   * the last place to make an exception.
   */
  private async placeCopy(
    source: vscode.Uri,
    copyInto: vscode.Uri | undefined
  ): Promise<{ uri: vscode.Uri; copied: boolean }> {
    if (!this.wouldCopy(source, copyInto)) { return { uri: source, copied: false }; }

    const existing = new Set<string>();
    try {
      for (const [name] of await vscode.workspace.fs.readDirectory(copyInto!)) { existing.add(name); }
    } catch {
      // Not there yet, so nothing in it can clash.
    }

    const fileName = uniqueFileName(path.basename(source.fsPath), (n) => existing.has(n));
    const dest = vscode.Uri.joinPath(copyInto!, fileName);

    this.selfWrites.add(dest.fsPath);
    try {
      await vscode.workspace.fs.copy(source, dest, { overwrite: false });
    } finally {
      setTimeout(() => this.selfWrites.delete(dest.fsPath), 500);
    }
    this.log.info(`Copied ${source.fsPath} to ${dest.fsPath}.`);
    return { uri: dest, copied: true };
  }

  /**
   * List a file explicitly, and withdraw any standing refusal of it.
   *
   * Saying yes has to outrank a previous no, or importing a file someone had
   * excluded would silently do nothing.
   */
  private async track(kind: RegistryKind, uri: vscode.Uri): Promise<void> {
    await this.registry.add(kind, uri);
    await this.registry.unexclude(uri);
    await this.rescan();
  }

  /** Stop tracking a listed file. The file itself is left exactly where it is. */
  async unregister(kind: RegistryKind, uri: vscode.Uri): Promise<void> {
    await this.registry.remove(kind, uri);
    await this.reload();
  }

  /**
   * Stop working on a file, whichever way it came to be tracked.
   *
   * A listed file is removed from its list. A file the scan found is in no list
   * to be removed from, so its path is added to the exclusions instead — the
   * only way to say no to something nobody said yes to. A file that is both is
   * removed *and* excluded, or the next scan would put it straight back and
   * the command would appear to have done nothing.
   */
  async untrack(kind: RegistryKind, uri: vscode.Uri, source: EntrySource): Promise<void> {
    if (source === 'registered') { await this.registry.remove(kind, uri); }
    this.scanner.invalidate();
    const stillFound = (await this.scanner.uris()).some((u) => u.fsPath === uri.fsPath);
    if (stillFound) { await this.registry.exclude(uri); }
    await this.rescan();
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
   * Refuse to write over a file that is already there.
   *
   * `overwrite` is for callers that have already asked — a save dialog's own
   * "replace?" prompt counts — and is never the default.
   */
  private async assertWritable(uri: vscode.Uri, overwrite: boolean): Promise<void> {
    if (overwrite) { return; }
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      return; // Not there, which is what we want.
    }
    throw new Error(`${path.basename(uri.fsPath)} already exists.`);
  }

  /**
   * Create a new, empty collection file and start working on it.
   *
   * The file is written where the caller says, in the v2.1.0 shape, so it is
   * indistinguishable from a Postman export of an empty collection.
   */
  async createCollection(
    uri: vscode.Uri,
    name: string,
    options: { overwrite?: boolean } = {}
  ): Promise<CollectionEntry> {
    await this.assertWritable(uri, options.overwrite === true);

    const id = randomUUID();
    await this.writeJson(uri, {
      info: {
        _postman_id: id,
        name,
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
      },
      item: []
    });
    await this.track('collection', uri);

    const entry = this.collections.find((c) => c.id === id);
    if (!entry) { throw new Error(`Could not load the new collection at ${uri.fsPath}.`); }
    return entry;
  }

  /**
   * Create a new, empty environment file and start working on it.
   *
   * There was previously no way to make an environment at all — only to add one
   * exported from Postman.
   */
  async createEnvironment(
    uri: vscode.Uri,
    name: string,
    options: { overwrite?: boolean } = {}
  ): Promise<EnvironmentEntry> {
    await this.assertWritable(uri, options.overwrite === true);

    const id = `env-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    await this.writeJson(uri, {
      id,
      name,
      values: [],
      _postman_variable_scope: 'environment',
      _postman_exported_at: new Date().toISOString()
    });
    await this.track('environment', uri);

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
   * The environment as Postman itself would export it, keychain secrets and all.
   *
   * Only for the export path, where the user has said they want the values in
   * the file. Everywhere else an environment is handled as the bytes on disk,
   * which keep secrets empty.
   */
  async exportEnvironmentJson(id: string): Promise<PostmanJson> {
    const entry = this.environment(id);
    if (!entry) { throw new Error(`Environment "${id}" is no longer available.`); }

    const resolved = await this.secrets.resolveFor(id, entry.json.values ?? []);
    return environmentExportJson(entry.json, resolved, new Date().toISOString());
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

  /** Unloadable files of one kind, for the view that would otherwise list them. */
  brokenFiles(kind: RegistryKind): BrokenEntry[] {
    return this.broken.filter((b) => b.kind === kind);
  }

  /** Files of one kind that need something done before they can be used. */
  unsupportedFiles(kind: RegistryKind): UnsupportedEntry[] {
    return this.unsupported.filter((u) => u.kind === kind);
  }

  /** Listed files of one kind that are not on disk. */
  missingFiles(kind: RegistryKind): MissingEntry[] {
    return this.missing.filter((m) => m.kind === kind);
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
    if (this.reloadTimer) { clearTimeout(this.reloadTimer); }
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];
    this.scanSubscription?.dispose();
    this.configWatcher?.dispose();
    this.folderWatcher?.dispose();
    this.scanner.dispose();
    this._onDidChange.dispose();
  }
}
