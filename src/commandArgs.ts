import type * as vscode from 'vscode';
import type { TreeNode } from './tree/provider';
import type { EnvTreeNode } from './tree/environmentProvider';
import type { CookieTreeNode } from './tree/cookieProvider';
import type { BrokenEntry, MissingEntry, UnsupportedEntry } from './collections/store';

/**
 * Normalisation of the arguments VS Code hands a command.
 *
 * A `view/title` button does not invoke its command with no arguments: VS Code
 * passes the tree's `focusedElement`, so every title-bar command receives a
 * `TreeNode` as soon as the user has clicked anything in the tree. A handler
 * that trusts its declared parameter type therefore gets an object where it
 * expected a `Uri` or a `string`. Explorer context menus are the mirror image —
 * they invoke `(uri, uris[])` and a handler reading only the first parameter
 * silently drops a multi-selection.
 *
 * These guards are kept free of runtime `vscode` imports so they can be unit
 * tested without booting the editor.
 */

/** Duck-typed: a serialised or proposed-API Uri fails `instanceof vscode.Uri`. */
function isUri(value: unknown): value is vscode.Uri {
  const candidate = value as vscode.Uri | undefined;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.scheme === 'string' &&
    typeof candidate.path === 'string' &&
    typeof candidate.fsPath === 'string'
  );
}

/**
 * Collect the Uris a command was invoked with, in selection order and
 * de-duplicated. Returns `[]` for anything that is not a Uri — including the
 * `TreeNode` a view-title button supplies — so callers can fall back to asking.
 */
export function uriArgs(first?: unknown, second?: unknown): vscode.Uri[] {
  const out: vscode.Uri[] = [];
  const seen = new Set<string>();

  const add = (value: unknown) => {
    if (!isUri(value)) { return; }
    const key = value.toString ? value.toString() : `${value.scheme}:${value.path}`;
    if (seen.has(key)) { return; }
    seen.add(key);
    out.push(value);
  };

  add(first);
  // The explorer passes the whole selection as the second argument; it already
  // includes `first`, which the de-duplication above absorbs.
  if (Array.isArray(second)) { second.forEach(add); }
  else { add(second); }

  return out;
}

/** The argument only if it really is a string; `undefined` for a TreeNode. */
export function stringArg(value?: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * The rows backed by a file that actually loaded.
 *
 * Both trees also carry rows for tracked files that would not parse. Those
 * have no collection, no environment and no id behind them, so the guards
 * below exclude them by type as well as at runtime: a command written against
 * a loaded entry then cannot compile against a broken row.
 */
type LoadedTreeNode = Extract<TreeNode, { kind: 'collection' | 'item' }>;
type LoadedEnvNode = Extract<EnvTreeNode, { kind: 'environment' | 'variable' }>;
/** Either view's row for a file that would not parse. */
type BrokenNode = { kind: 'broken'; entry: BrokenEntry };
/** Either view's row for a file in a format too old to work on. */
type UnsupportedNode = { kind: 'unsupported'; entry: UnsupportedEntry };
/** Either view's row for a listed file that is not on disk. */
type MissingNode = { kind: 'missing'; entry: MissingEntry };

/** The argument only if it is one of the tree's own loaded nodes. */
export function treeNodeArg(value?: unknown): LoadedTreeNode | undefined {
  const candidate = value as LoadedTreeNode | undefined;
  if (typeof candidate !== 'object' || candidate === null) { return undefined; }
  if (candidate.kind !== 'collection' && candidate.kind !== 'item') { return undefined; }
  return candidate.entry ? candidate : undefined;
}

/** The argument only if it is one of the Environments view's own loaded nodes. */
export function envNodeArg(value?: unknown): LoadedEnvNode | undefined {
  const candidate = value as LoadedEnvNode | undefined;
  if (typeof candidate !== 'object' || candidate === null) { return undefined; }
  if (candidate.kind !== 'environment' && candidate.kind !== 'variable') { return undefined; }
  return candidate.entry ? candidate : undefined;
}

/**
 * The argument only if it is a row for a file that would not parse.
 *
 * The two things still worth doing to such a file — opening it and dropping it
 * from the workspace — need its Uri and nothing else, which is all a broken
 * row has. Both views produce the same shape, so one guard serves both.
 */
export function brokenNodeArg(value?: unknown): BrokenNode | undefined {
  const candidate = value as BrokenNode | undefined;
  if (typeof candidate !== 'object' || candidate === null) { return undefined; }
  if (candidate.kind !== 'broken') { return undefined; }
  return Array.isArray(candidate.entry?.problems) ? candidate : undefined;
}

/**
 * The argument only if it is a row for a file that needs converting first.
 *
 * Distinct from a broken row because the useful action is different: this file
 * parses, so there is something to convert rather than something to fix. Both
 * views produce the same shape, so one guard serves both.
 */
export function unsupportedNodeArg(value?: unknown): UnsupportedNode | undefined {
  const candidate = value as UnsupportedNode | undefined;
  if (typeof candidate !== 'object' || candidate === null) { return undefined; }
  if (candidate.kind !== 'unsupported') { return undefined; }
  return candidate.entry?.uri ? candidate : undefined;
}

/**
 * The argument only if it is a row for a listed file that is not on disk.
 *
 * Distinct again because there is no file to act on: the only thing to be done
 * with one is to drop the entry that names it, or go and fix that entry. Both
 * views produce the same shape, so one guard serves both.
 */
export function missingNodeArg(value?: unknown): MissingNode | undefined {
  const candidate = value as MissingNode | undefined;
  if (typeof candidate !== 'object' || candidate === null) { return undefined; }
  if (candidate.kind !== 'missing') { return undefined; }
  return candidate.entry?.uri ? candidate : undefined;
}

/**
 * The argument only if it is one of the Cookies view's own rows.
 *
 * The pane's commands act on a cookie or on a whole domain, and both are told
 * apart by `kind` alone — a cookie row always carries the cookie it draws, so
 * a row that reached here is enough to act on without going back to the jar.
 */
export function cookieNodeArg(value?: unknown): CookieTreeNode | undefined {
  const candidate = value as CookieTreeNode | undefined;
  if (typeof candidate !== 'object' || candidate === null) { return undefined; }
  if (candidate.kind === 'domain') { return typeof candidate.domain === 'string' ? candidate : undefined; }
  if (candidate.kind !== 'cookie') { return undefined; }
  return typeof candidate.cookie?.key === 'string' ? candidate : undefined;
}
