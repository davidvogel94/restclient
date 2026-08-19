import type * as vscode from 'vscode';
import type { TreeNode } from './tree/provider';
import type { EnvTreeNode } from './tree/environmentProvider';

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

/** The argument only if it is one of the tree's own nodes. */
export function treeNodeArg(value?: unknown): TreeNode | undefined {
  const candidate = value as TreeNode | undefined;
  if (typeof candidate !== 'object' || candidate === null) { return undefined; }
  if (candidate.kind !== 'collection' && candidate.kind !== 'item') { return undefined; }
  return candidate.entry ? candidate : undefined;
}

/** The argument only if it is one of the Environments view's own nodes. */
export function envNodeArg(value?: unknown): EnvTreeNode | undefined {
  const candidate = value as EnvTreeNode | undefined;
  if (typeof candidate !== 'object' || candidate === null) { return undefined; }
  if (candidate.kind !== 'environment' && candidate.kind !== 'variable') { return undefined; }
  return candidate.entry ? candidate : undefined;
}
