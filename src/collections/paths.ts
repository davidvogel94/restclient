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
 * Is this path inside the workspace folder?
 *
 * Asked by two features with the same stake in the answer: import copies a file
 * in only when it is outside, and the runner refuses to read one that is not.
 * The folder itself counts as inside, so it can be an import destination.
 *
 * `..` is compared as a whole segment — a sibling directory called `..foo` is
 * not an escape, and treating it as one would push a legitimate path out.
 */
export function isInside(fsPath: string, workspaceFsPath: string | undefined): boolean {
  if (!workspaceFsPath) { return false; }
  const relative = path.relative(workspaceFsPath, fsPath);
  if (path.isAbsolute(relative)) { return false; }
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/**
 * How a location should be written back: workspace-relative with forward
 * slashes when it is inside the workspace, absolute when it is not.
 *
 * The workspace folder itself serializes absolute: an entry naming a file
 * cannot be the empty string.
 */
export function serializeEntry(fsPath: string, workspaceFsPath: string | undefined): string {
  if (!isInside(fsPath, workspaceFsPath)) { return fsPath; }
  const relative = path.relative(workspaceFsPath!, fsPath);
  return relative ? relative.split(path.sep).join('/') : fsPath;
}

/**
 * The workspace folder a path belongs to, or nothing when it is outside all of
 * them.
 *
 * The longest match wins. A multi-root workspace can legitimately hold a folder
 * and one of its own subdirectories as two separate roots, and a file in the
 * subdirectory belongs to the nearer of the two — that is the folder whose
 * `.vscode/settings.json` the user wrote with that file in mind, so it is the
 * one its relative entries are relative to.
 */
export function rootFor(fsPath: string, roots: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const root of roots) {
    if (!isInside(fsPath, root)) { continue; }
    if (best === undefined || root.length > best.length) { best = root; }
  }
  return best;
}

/**
 * Is this path inside any of the workspace folders?
 *
 * The multi-root form of `isInside`, and the question the runner's file jail
 * and the import path both actually mean to ask: a workspace is a set of roots,
 * and a file in the second one is no less in the workspace than a file in the
 * first.
 */
export function isInsideAny(fsPath: string, roots: readonly string[]): boolean {
  return roots.some((root) => isInside(fsPath, root));
}
