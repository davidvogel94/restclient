import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Turning configured path entries into locations, and back.
 *
 * Deliberately free of any `vscode` import: this is the part with the awkward
 * cases (`~`, mixed separators, files outside the workspace) and it should be
 * testable without booting an editor.
 */

/** How one configured entry should be turned into a location. */
export type ParsedEntry =
  | { kind: 'absolute'; fsPath: string }
  | { kind: 'relative'; segments: string[] }
  | { kind: 'invalid' };

/**
 * Classify a configured path without resolving it.
 *
 * Kept free of `vscode` so it can be tested directly, and so the relative case
 * can still be joined onto the workspace *Uri* — which may be a remote scheme
 * that `path.join` would silently turn into a local `file://`.
 */
export function parseEntry(entry: string): ParsedEntry {
  const raw = entry.trim();
  if (!raw) { return { kind: 'invalid' }; }

  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    return { kind: 'absolute', fsPath: path.join(os.homedir(), raw.slice(1)) };
  }
  if (path.isAbsolute(raw)) { return { kind: 'absolute', fsPath: raw }; }
  return { kind: 'relative', segments: raw.split(/[\\/]+/).filter((s) => s && s !== '.') };
}

/**
 * How a location should be written back: workspace-relative with forward
 * slashes when it is inside the workspace, absolute when it is not.
 */
export function serializeEntry(fsPath: string, workspaceFsPath: string | undefined): string {
  if (!workspaceFsPath) { return fsPath; }
  const relative = path.relative(workspaceFsPath, fsPath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/');
  }
  return fsPath;
}
