import * as vscode from 'vscode';
import {
  ALWAYS_EXCLUDED,
  DEFAULT_DISCOVER_PATTERNS,
  combineExcludes,
  combinePatterns,
  enabledKeys,
  importFolderPattern,
  normalizePatterns
} from './discovery';
import { IMPORT_LOCATION_SETTING } from './importTarget';

/**
 * Postman files the workspace already contains.
 *
 * The other half of "which files does this workspace work on": `registry.ts`
 * holds what somebody listed, this finds what is simply there. Nothing found
 * here is written to settings — a repo with collections in it should show them
 * without first being configured to, and a file that is only *there* has
 * nothing to record.
 *
 * `.gitignore` is not consulted; `search.exclude` is VS Code's own lever for
 * that and is honoured. Every folder of a multi-root workspace is scanned, each
 * against its own settings, because "add the folder my collections are in" is
 * the answer VS Code already has for collections kept outside the repo you are
 * working in — and it has to be the answer here too, since the runner will only
 * read files from a folder that is actually in the workspace.
 */

export const AUTO_DISCOVER_SETTING = 'autoDiscover';
export const DISCOVER_PATTERNS_SETTING = 'discoverPatterns';
const SECTION = 'restclient';

/**
 * A ceiling on one scan, so a pattern like `**\/*.json` in a monorepo degrades
 * into a warning rather than into reading ten thousand files.
 *
 * Applied per folder and again to the union: two folders cannot between them
 * smuggle in twice the ceiling.
 */
const MAX_DISCOVERED = 500;

export class WorkspaceScanner implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  /** Fires when a matching file appears, changes or goes. Not debounced — the store does that. */
  readonly onDidChange = this._onDidChange.event;

  /** One glob watcher per folder being scanned. */
  private watchers: vscode.FileSystemWatcher[] = [];
  /** The last scan's results, or `undefined` when a fresh scan is owed. */
  private cached: vscode.Uri[] | undefined;
  /**
   * Bumped by every invalidation, so a scan can tell whether it was overtaken.
   *
   * Without it, a scan already in flight when the patterns changed would finish
   * and cache its now-wrong answer *after* the invalidation that was meant to
   * discard it — and the reload waiting behind it would read that cache.
   */
  private generation = 0;

  constructor(
    /** Read, not captured: a folder can be added to a live workspace. */
    private readonly folders: () => readonly vscode.WorkspaceFolder[],
    private readonly excludedPaths: () => Set<string>,
    private readonly excludeGlobs: (folder: vscode.WorkspaceFolder) => string[],
    /** The chosen collections folder for one root, relative to it; see `importFolderPattern`. */
    private readonly importFolder: (folder: vscode.WorkspaceFolder) => string | undefined,
    private readonly log: vscode.LogOutputChannel
  ) {}

  /** The folders the scan actually covers — each one can opt out for itself. */
  private scanned(): vscode.WorkspaceFolder[] {
    return this.folders().filter((folder) =>
      vscode.workspace
        .getConfiguration(SECTION, folder.uri)
        .get<boolean>(AUTO_DISCOVER_SETTING, true)
    );
  }

  /**
   * What the scan found, scanning only when it has to.
   *
   * A reload happens after every edit to a tracked file, and re-globbing the
   * workspace on each of those would make saving a request cost a directory
   * walk. The cache is dropped whenever something could have changed the
   * answer: a watcher event, a relevant setting, or an explicit refresh.
   */
  async uris(): Promise<vscode.Uri[]> {
    if (this.cached) { return this.cached; }

    const startedAt = this.generation;
    const found = await this.scan();
    // Overtaken while scanning: the answer describes a workspace that has
    // already moved on, so hand it back to this caller but do not let the next
    // one inherit it.
    if (this.generation === startedAt) { this.cached = found; }
    return found;
  }

  invalidate(): void {
    this.generation++;
    this.cached = undefined;
  }

  /**
   * Watch for the tracked *set* changing, anywhere in the workspace.
   *
   * Distinct from the store's per-directory watchers, which see edits to files
   * already tracked. Rebuilt whenever the patterns or the folders change, since
   * the globs are built from both. Change events count, not just create and
   * delete: a file the scan skipped can become one it accepts.
   */
  rewatch(): void {
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];

    const onChange = (uri: vscode.Uri) => {
      this.invalidate();
      this._onDidChange.fire(uri);
    };

    for (const folder of this.scanned()) {
      const pattern = combinePatterns(this.patterns(folder));
      if (!pattern) { continue; }
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, pattern)
      );
      watcher.onDidCreate(onChange);
      watcher.onDidChange(onChange);
      watcher.onDidDelete(onChange);
      this.watchers.push(watcher);
    }
  }

  /**
   * What the scan looks for in one folder: Postman's naming anywhere, and
   * anything at all in the folder the user chose to keep collections in.
   *
   * The folder pattern is added to the configured list rather than replacing
   * it — a repo can keep its imports in one place and still have exports
   * committed elsewhere. `normalizePatterns` drops the duplicate for a user who
   * had already widened the list by hand.
   */
  private patterns(folder: vscode.WorkspaceFolder): string[] {
    const configured = normalizePatterns(
      vscode.workspace
        .getConfiguration(SECTION, folder.uri)
        .get<string[]>(DISCOVER_PATTERNS_SETTING)
    );
    const base = configured.length ? configured : [...DEFAULT_DISCOVER_PATTERNS];
    const importFolder = importFolderPattern(this.importFolder(folder));
    return importFolder ? normalizePatterns([...base, importFolder]) : base;
  }

  /**
   * Everything the scan must skip in one folder, from every source that gets a
   * say.
   *
   * Passing an explicit exclude to `findFiles` replaces its own `files.exclude`
   * handling, and `search.exclude` is never applied by it at all — so both have
   * to be read and merged here or a scan would walk straight into `dist`. Both
   * are read against this folder, so a folder that excludes its own `build`
   * does not impose that on the others.
   */
  private excludeGlob(folder: vscode.WorkspaceFolder): string {
    const scoped = vscode.workspace.getConfiguration(undefined, folder.uri);
    return combineExcludes([
      enabledKeys(scoped.get('files.exclude')),
      enabledKeys(scoped.get('search.exclude')),
      normalizePatterns(this.excludeGlobs(folder)),
      [...ALWAYS_EXCLUDED]
    ]);
  }

  private async scan(): Promise<vscode.Uri[]> {
    const folders = this.scanned();
    if (!folders.length) { return []; }

    const perFolder = await Promise.all(folders.map((folder) => this.scanFolder(folder)));

    // Two roots can overlap — a folder and its own subdirectory are both
    // legitimate workspace folders — so the same file can be found twice.
    const seen = new Set<string>();
    const found: vscode.Uri[] = [];
    for (const uris of perFolder) {
      for (const uri of uris) {
        if (seen.has(uri.fsPath)) { continue; }
        seen.add(uri.fsPath);
        found.push(uri);
      }
    }

    // The exact-path pass is what actually guarantees an exclusion: the glob
    // above cannot express a path containing `[` or `{`, and cannot reach out
    // of the folder it was searched in at all.
    const blocked = this.excludedPaths();
    const kept = blocked.size ? found.filter((u) => !blocked.has(u.fsPath)) : found;

    if (kept.length > MAX_DISCOVERED) {
      this.log.warn(
        `The workspace scan stopped at ${MAX_DISCOVERED} files; narrow ${SECTION}.${DISCOVER_PATTERNS_SETTING}.`
      );
      return kept.slice(0, MAX_DISCOVERED);
    }
    return kept;
  }

  private async scanFolder(folder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
    const include = combinePatterns(this.patterns(folder));
    if (!include) { return []; }

    let found: vscode.Uri[];
    try {
      found = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, include),
        this.excludeGlob(folder),
        MAX_DISCOVERED
      );
    } catch (e: any) {
      // A malformed glob is the user's to fix, and it must not take the whole
      // reload with it — the explicit lists, and the other folders, still have
      // to load.
      this.log.error(`Workspace scan of ${folder.uri.fsPath} failed: ${e?.message ?? e}`);
      return [];
    }

    if (found.length >= MAX_DISCOVERED) {
      this.log.warn(
        `The scan of ${folder.name} stopped at ${MAX_DISCOVERED} files; narrow ${SECTION}.${DISCOVER_PATTERNS_SETTING}.`
      );
    }

    this.log.debug(
      `Workspace scan of ${folder.uri.fsPath} found ${found.length} Postman file(s) matching ${include}.`
    );
    return found;
  }

  /** True when a configuration change could have altered what the scan returns. */
  static affects(e: vscode.ConfigurationChangeEvent): boolean {
    return (
      e.affectsConfiguration(`${SECTION}.${AUTO_DISCOVER_SETTING}`) ||
      e.affectsConfiguration(`${SECTION}.${DISCOVER_PATTERNS_SETTING}`) ||
      e.affectsConfiguration(`${SECTION}.${IMPORT_LOCATION_SETTING}`) ||
      e.affectsConfiguration('files.exclude') ||
      e.affectsConfiguration('search.exclude')
    );
  }

  dispose(): void {
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];
    this._onDidChange.dispose();
  }
}
