import * as vscode from 'vscode';
import { parseEntry, rootFor, serializeEntry } from './paths';

/**
 * Which Postman files this workspace has been *told* to work on.
 *
 * One of two sources. The other is the workspace scan (`scanner.ts`), which
 * finds conventionally-named files and writes nothing here — so these lists
 * stay what somebody said explicitly, for files outside the workspace, files
 * with unconventional names, and anything worth recording in the repo.
 *
 * A third list, the exclusions, is how a scan result is refused: a file nobody
 * listed cannot be removed from a list, so saying no to one has to be recorded
 * somewhere of its own.
 *
 * All three live in settings rather than hidden workspace state so they can be
 * read, hand-edited and committed alongside the collections they point at.
 *
 * A multi-root workspace has more than one place to keep them, and the scopes
 * are *unioned* rather than overridden — see `scopes`.
 */

export const COLLECTIONS_SETTING = 'collections';
export const ENVIRONMENTS_SETTING = 'environments';
export const DISCOVER_EXCLUDE_SETTING = 'discoverExclude';
const SECTION = 'restclient';

export type RegistryKind = 'collection' | 'environment';

function settingFor(kind: RegistryKind): string {
  return kind === 'collection' ? COLLECTIONS_SETTING : ENVIRONMENTS_SETTING;
}

/**
 * One place a list can be kept, and the folder its relative entries mean.
 *
 * A multi-root workspace has several — each folder's own
 * `.vscode/settings.json`, the `.code-workspace` file they share, and the
 * user's own settings — and they cannot be collapsed into one list, because a
 * relative entry means something different in each: `api/orders.json` in a
 * folder's settings is that folder's file, while the same string in the shared
 * workspace file has only the first folder to be relative to.
 */
interface Scope {
  target: vscode.ConfigurationTarget;
  /** The folder a write is scoped to; only meaningful for `WorkspaceFolder`. */
  folder: vscode.WorkspaceFolder | undefined;
  /** What relative entries written here resolve against. */
  base: vscode.WorkspaceFolder | undefined;
  entries: string[];
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((e): e is string => typeof e === 'string') : [];
}

/** Where one entry points, read against the folder its scope makes it relative to. */
function resolveIn(entry: string, base: vscode.WorkspaceFolder | undefined): vscode.Uri | undefined {
  const parsed = parseEntry(entry);
  if (parsed.kind === 'absolute') { return vscode.Uri.file(parsed.fsPath); }
  if (parsed.kind === 'relative' && base) {
    // Joined onto the folder Uri, not its fsPath, so a remote workspace keeps
    // its scheme.
    return vscode.Uri.joinPath(base.uri, ...parsed.segments);
  }
  return undefined;
}

export class FileRegistry {
  /**
   * The folders are read through a function, not captured, because
   * `workspace.workspaceFolders` changes under a live extension: adding a
   * folder has to start tracking what is in it without a reload.
   */
  constructor(private readonly folders: () => readonly vscode.WorkspaceFolder[]) {}

  private get primary(): vscode.WorkspaceFolder | undefined {
    return this.folders()[0];
  }

  private roots(): string[] {
    return this.folders().map((f) => f.uri.fsPath);
  }

  /**
   * Every place this list is kept, most general first.
   *
   * The scopes are *unioned*, not overridden the way VS Code would merge a
   * plain array setting. Overriding is wrong for a registry: it would mean a
   * repo that lists one collection silently hides the one a user keeps in their
   * own settings, and in a multi-root workspace it would mean only one folder's
   * list ever counted. Every scope contributes, and every scope is written back
   * to individually, so removing an entry removes it from wherever it was
   * written.
   *
   * Per-folder scopes only exist once there is more than one folder: in a
   * single-folder workspace `.vscode/settings.json` *is* the workspace scope,
   * and reading it twice would list every file twice.
   */
  private scopes(setting: string): Scope[] {
    const folders = this.folders();
    const primary = folders[0];
    const shared = vscode.workspace.getConfiguration(SECTION, primary?.uri).inspect<string[]>(setting);

    const out: Scope[] = [
      {
        target: vscode.ConfigurationTarget.Global,
        folder: undefined,
        base: primary,
        entries: stringsOf(shared?.globalValue)
      },
      {
        target: vscode.ConfigurationTarget.Workspace,
        folder: undefined,
        base: primary,
        entries: stringsOf(shared?.workspaceValue)
      }
    ];

    if (folders.length > 1) {
      for (const folder of folders) {
        const scoped = vscode.workspace.getConfiguration(SECTION, folder.uri).inspect<string[]>(setting);
        out.push({
          target: vscode.ConfigurationTarget.WorkspaceFolder,
          folder,
          base: folder,
          entries: stringsOf(scoped?.workspaceFolderValue)
        });
      }
    }

    return out;
  }

  /**
   * Where a newly tracked file should be written down.
   *
   * The folder that contains it, so its entry can be relative and stay correct
   * in somebody else's checkout. A file outside every folder has no such home
   * and goes to the shared list as an absolute path.
   */
  private writeScope(uri: vscode.Uri): Scope {
    const folders = this.folders();
    if (folders.length > 1) {
      const root = rootFor(uri.fsPath, this.roots());
      const owner = folders.find((f) => f.uri.fsPath === root);
      if (owner) {
        return {
          target: vscode.ConfigurationTarget.WorkspaceFolder,
          folder: owner,
          base: owner,
          entries: []
        };
      }
    }
    return {
      // Workspace scope keeps the list next to the collections it names; without
      // a folder open there is nowhere workspace-scoped to put it.
      target: folders.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global,
      folder: undefined,
      base: this.primary,
      entries: []
    };
  }

  /** The entries currently written in one scope, for a read-modify-write. */
  private entriesAt(setting: string, scope: Scope): string[] {
    const match = this.scopes(setting).find(
      (s) => s.target === scope.target && s.folder?.uri.fsPath === scope.folder?.uri.fsPath
    );
    return match ? [...match.entries] : [];
  }

  list(kind: RegistryKind): vscode.Uri[] {
    const seen = new Set<string>();
    const out: vscode.Uri[] = [];
    for (const scope of this.scopes(settingFor(kind))) {
      for (const entry of scope.entries) {
        const uri = resolveIn(entry, scope.base);
        if (!uri || seen.has(uri.fsPath)) { continue; }
        seen.add(uri.fsPath);
        out.push(uri);
      }
    }
    return out;
  }

  has(kind: RegistryKind, uri: vscode.Uri): boolean {
    return this.list(kind).some((u) => u.fsPath === uri.fsPath);
  }

  async add(kind: RegistryKind, uri: vscode.Uri): Promise<void> {
    if (this.has(kind, uri)) { return; }
    const setting = settingFor(kind);
    const scope = this.writeScope(uri);
    const current = this.entriesAt(setting, scope);
    await this.write(setting, scope, [
      ...current,
      serializeEntry(uri.fsPath, scope.base?.uri.fsPath)
    ]);
  }

  /**
   * Stop listing a file, wherever it was listed.
   *
   * Every scope is filtered, not just the first match: an entry can be in a
   * folder's settings and in the shared workspace file at once, and leaving one
   * behind would make untracking appear to fail on the next reload.
   */
  async remove(kind: RegistryKind, uri: vscode.Uri): Promise<void> {
    await this.filterAll(settingFor(kind), uri);
  }

  /**
   * Where a configured entry points, for a caller holding the entry rather
   * than the file — the excluded-files picker, which lists entries verbatim so
   * the user recognises what they wrote.
   *
   * Ambiguous in a multi-root workspace, where the same relative entry could
   * belong to any folder, so the scopes are searched in order and the first
   * folder that actually spells this entry wins.
   */
  resolveEntry(entry: string): vscode.Uri | undefined {
    for (const setting of [COLLECTIONS_SETTING, ENVIRONMENTS_SETTING, DISCOVER_EXCLUDE_SETTING]) {
      for (const scope of this.scopes(setting)) {
        if (scope.entries.includes(entry)) { return resolveIn(entry, scope.base); }
      }
    }
    return resolveIn(entry, this.primary);
  }

  /**
   * The exclusion entries as written, for one folder's half of the scan.
   *
   * Handed to `findFiles` as-is, so a user can write a glob here and have it
   * work — the price is that an entry naming a file with `[` or `{` in its path
   * would be read as a pattern, which is why `excludedPaths` exists too.
   *
   * A glob is relative to the folder being searched, so only the scopes that
   * folder's entries could have been written in are included: another folder's
   * `api/**` is not this folder's.
   */
  excludeGlobs(folder: vscode.WorkspaceFolder | undefined): string[] {
    const out: string[] = [];
    for (const scope of this.scopes(DISCOVER_EXCLUDE_SETTING)) {
      const applies =
        scope.target !== vscode.ConfigurationTarget.WorkspaceFolder ||
        scope.folder?.uri.fsPath === folder?.uri.fsPath;
      if (applies) { out.push(...scope.entries); }
    }
    return out;
  }

  /** Every exclusion entry as written, across every scope. */
  excludes(): string[] {
    return this.scopes(DISCOVER_EXCLUDE_SETTING).flatMap((s) => s.entries);
  }

  /**
   * Those exclusion entries that name one file, resolved.
   *
   * The reliable half: a path compared exactly cannot be misread as a glob, so
   * this is what actually guarantees an excluded file stays excluded — and the
   * only half that works across folders, since a glob cannot reach out of the
   * folder it is searched in.
   */
  excludedPaths(): Set<string> {
    const out = new Set<string>();
    for (const scope of this.scopes(DISCOVER_EXCLUDE_SETTING)) {
      for (const entry of scope.entries) {
        const uri = resolveIn(entry, scope.base);
        if (uri) { out.add(uri.fsPath); }
      }
    }
    return out;
  }

  /** Record that the scan should skip this file. */
  async exclude(uri: vscode.Uri): Promise<void> {
    if (this.excludedPaths().has(uri.fsPath)) { return; }
    const scope = this.writeScope(uri);
    const current = this.entriesAt(DISCOVER_EXCLUDE_SETTING, scope);
    await this.write(DISCOVER_EXCLUDE_SETTING, scope, [
      ...current,
      serializeEntry(uri.fsPath, scope.base?.uri.fsPath)
    ]);
  }

  /**
   * Withdraw an exclusion.
   *
   * Every entry resolving to this file goes, not just the first: a hand-edited
   * list can name the same file twice, and leaving one behind would make
   * including it again appear to fail.
   */
  async unexclude(uri: vscode.Uri): Promise<void> {
    await this.filterAll(DISCOVER_EXCLUDE_SETTING, uri);
  }

  /** Drop every entry pointing at this file, from every scope that has one. */
  private async filterAll(setting: string, uri: vscode.Uri): Promise<void> {
    for (const scope of this.scopes(setting)) {
      const next = scope.entries.filter((e) => resolveIn(e, scope.base)?.fsPath !== uri.fsPath);
      if (next.length === scope.entries.length) { continue; }
      await this.write(setting, scope, next);
    }
  }

  private async write(setting: string, scope: Scope, value: string[]): Promise<void> {
    await vscode.workspace
      .getConfiguration(SECTION, scope.folder?.uri ?? this.primary?.uri)
      .update(setting, value, scope.target);
  }

  /** True when a configuration change could have altered any of the three lists. */
  static affects(e: vscode.ConfigurationChangeEvent): boolean {
    return (
      e.affectsConfiguration(`${SECTION}.${COLLECTIONS_SETTING}`) ||
      e.affectsConfiguration(`${SECTION}.${ENVIRONMENTS_SETTING}`) ||
      e.affectsConfiguration(`${SECTION}.${DISCOVER_EXCLUDE_SETTING}`)
    );
  }
}
