import type { ItemNode } from '../collections/model';
import type { GroupEntry } from '../collections/view';

/**
 * Filtering for the two trees, and for the collection overviews' contents.
 *
 * A real collection outgrows a sidebar quickly — a few hundred requests across
 * nested folders — and the built-in list find only searches rows that happen to
 * be expanded, which for a lazily-loaded tree is most of them missing. That is
 * also why Ctrl/Cmd+F is rebound in these two views: the find widget looks like
 * it answered the question and did not. So the pruning happens here, in the
 * providers' own data, and a collapsed folder full of matches still shows up.
 *
 * The matcher is deliberately dumb: whitespace-separated terms, all of which
 * must appear somewhere in the row's text, case-insensitively. No globs, no
 * fuzzy scoring — `post user` finding the POST under Users is the whole job, and
 * a predictable filter is worth more than a clever one.
 *
 * Kept free of `vscode` imports so it can be unit tested without the editor.
 */

export interface Filter {
  /** Exactly what the user typed, for showing back to them. */
  readonly text: string;
  /** Lowercased terms, all of which must match. */
  readonly terms: readonly string[];
}

/** `undefined` for anything blank, which is what "no filter" is spelled as. */
export function parseFilter(text: string | undefined): Filter | undefined {
  const trimmed = (text ?? '').trim();
  if (!trimmed) { return undefined; }
  return { text: trimmed, terms: trimmed.toLowerCase().split(/\s+/) };
}

/** Does every term appear somewhere in these fields? */
export function matches(filter: Filter, ...fields: Array<string | undefined>): boolean {
  const haystack = fields.filter(Boolean).join(' ').toLowerCase();
  return filter.terms.every((term) => haystack.includes(term));
}

/**
 * The items a filter leaves visible.
 *
 * A folder whose own name matches keeps its whole subtree: naming a folder is
 * how you narrow to the requests inside it, and hiding all of them because they
 * do not repeat the folder's name would defeat that. A folder that does not
 * match itself survives only for the descendants that do, and then carries just
 * those — the returned node is a shallow copy, so the store's tree is untouched.
 *
 * Copies keep `id`, `path` and `jsonPath`, which is all any edit works from; the
 * only thing that differs is which children are listed. Anything that needs the
 * real sibling list — the drop handler working out an insertion index — must go
 * back to `materialized.index` rather than read a node it got from the tree.
 */
export function filterItems(nodes: ItemNode[], filter: Filter): ItemNode[] {
  const kept: ItemNode[] = [];
  for (const node of nodes) {
    if (matches(filter, node.name, node.method, node.url)) {
      kept.push(node);
      continue;
    }
    if (!node.isFolder) { continue; }
    const children = filterItems(node.children, filter);
    if (children.length) { kept.push({ ...node, children }); }
  }
  return kept;
}

/** Requests, not folders: the count a user is actually asking about. */
export function countRequests(nodes: ItemNode[]): number {
  return nodes.reduce(
    (total, node) => total + (node.isFolder ? countRequests(node.children) : 1),
    0
  );
}

/** The fields of an environment variable a filter can see. */
export interface FilterableVariable {
  key: string;
  value: string;
  secret: boolean;
}

/**
 * The variables a filter leaves visible.
 *
 * Values are searched too — "which environment points at staging?" is the
 * question — but never a secret's value: the tree refuses to display those, so
 * matching one would answer a question about it that the view will not.
 */
export function filterVariables<T extends FilterableVariable>(variables: T[], filter: Filter): T[] {
  return variables.filter((v) => matches(filter, v.key, v.secret ? undefined : v.value));
}

/**
 * The same pruning, over an overview's contents tree.
 *
 * The collection and folder overviews draw `GroupEntry` rows rather than
 * `ItemNode`s, but a filter has to mean the same thing wherever it is typed —
 * `post users` narrowing the sidebar one way and the overview another is a bug
 * you cannot see, only trip over — so the rule is shared rather than written
 * twice. A folder whose own name matches keeps everything under it; one that
 * does not survives only for the descendants that do.
 *
 * The entries handed back are shallow copies, so the panel's own view object is
 * left alone: run state and roll-ups are still read from the full tree.
 */
export function filterEntries(entries: GroupEntry[], filter: Filter): GroupEntry[] {
  const kept: GroupEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === 'request') {
      if (matches(filter, entry.name, entry.method, entry.url)) { kept.push(entry); }
      continue;
    }
    if (matches(filter, entry.name)) { kept.push(entry); continue; }
    const children = filterEntries(entry.children, filter);
    if (children.length) { kept.push({ ...entry, children }); }
  }
  return kept;
}
