import type { PostmanJson } from './importer';
import type { ItemNode, MaterializedCollection } from './model';
import { ownSettings, type SettingValue } from './settings';
import type { KeyValue, RequestView, SettingsView } from '../panels/protocol';

export function kv(list: any[] | undefined, keyName = 'key', valueName = 'value'): KeyValue[] {
  if (!Array.isArray(list)) { return []; }
  return list.map((e) => ({
    key: String(e?.[keyName] ?? ''),
    value: e?.[valueName] === undefined ? '' : String(e[valueName]),
    disabled: Boolean(e?.disabled),
    description: typeof e?.description === 'string' ? e.description : undefined
  }));
}

function scriptSource(event: any): string | undefined {
  const exec = event?.script?.exec;
  if (Array.isArray(exec)) { return exec.join('\n'); }
  if (typeof exec === 'string') { return exec; }
  return undefined;
}

function urlToString(url: any): string {
  if (typeof url === 'string') { return url; }
  if (typeof url?.raw === 'string') { return url.raw; }
  if (!url) { return ''; }
  // Reconstruct from parts for the rare export with no `raw`.
  const host = Array.isArray(url.host) ? url.host.join('.') : String(url.host ?? '');
  const path = Array.isArray(url.path) ? '/' + url.path.join('/') : String(url.path ?? '');
  return `${url.protocol ? url.protocol + '://' : ''}${host}${path}`;
}

function bodyView(body: any): RequestView['body'] {
  const mode = String(body?.mode ?? 'none');
  switch (mode) {
    case 'raw':
      return { mode, text: String(body?.raw ?? ''), language: body?.options?.raw?.language ?? 'text' };
    case 'graphql':
      return {
        mode,
        text: String(body?.graphql?.query ?? ''),
        language: 'graphql',
        entries: [{ key: 'variables', value: String(body?.graphql?.variables ?? '') }]
      };
    case 'urlencoded':
      return { mode, entries: kv(body?.urlencoded) };
    case 'formdata':
      return {
        mode,
        entries: (body?.formdata ?? []).map((e: any) => ({
          key: String(e?.key ?? ''),
          value: e?.type === 'file' ? String(e?.src ?? '') : String(e?.value ?? ''),
          disabled: Boolean(e?.disabled),
          description: e?.type === 'file' ? 'file' : undefined
        }))
      };
    case 'file':
      return { mode, text: String(body?.file?.src ?? '') };
    default:
      return { mode: 'none' };
  }
}

function authView(auth: any): { type: string; params: KeyValue[] } | undefined {
  if (!auth?.type) { return undefined; }
  const type = String(auth.type);
  return { type, params: kv(auth[type]) };
}

/** One container on the way down to an item: the collection, then each folder. */
interface Ancestor {
  name: string;
  raw: any;
}

/**
 * Walk a node's `path` down the collection JSON, collecting what it passes.
 *
 * The collection itself is the first entry and the target the last, so both
 * "who did this inherit from" and "what is this" read off the same array.
 * Returns `undefined` when a segment does not resolve, which is what a stale
 * node looks like after the file changed underneath it.
 */
function ancestryFor(
  collectionJson: PostmanJson,
  collectionName: string,
  path: string[]
): Ancestor[] | undefined {
  const ancestry: Ancestor[] = [{ name: collectionName, raw: collectionJson }];

  let cursor: any = collectionJson;
  for (const segment of path) {
    const items: any[] = cursor?.item ?? [];
    // `path` segments carry a `~n` suffix when siblings share a name.
    const tilde = segment.lastIndexOf('~');
    const numbered = tilde > 0 && /^\d+$/.test(segment.slice(tilde + 1));
    const name = numbered ? segment.slice(0, tilde) : segment;
    const dupeIndex = numbered ? Number(segment.slice(tilde + 1)) : 0;

    const matches = items.filter((i) => String(i?.name ?? 'Untitled') === name);
    const next = matches[dupeIndex];
    if (!next) { return undefined; }
    ancestry.push({ name, raw: next });
    cursor = next;
  }

  return ancestry;
}

/** The nearest ancestor above `index` that declares auth, if any. */
function inheritedAuth(
  ancestry: Ancestor[],
  index: number
): { auth: { type: string; params: KeyValue[] }; from: string } | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const candidate = authView(ancestry[i].raw?.auth);
    if (candidate) { return { auth: candidate, from: ancestry[i].name }; }
  }
  return undefined;
}

/** Every script declared above `index`, which all run in addition to its own. */
function inheritedScripts(ancestry: Ancestor[], index: number): RequestView['inheritedScripts'] {
  const out: RequestView['inheritedScripts'] = [];
  for (let i = 0; i < index; i++) {
    for (const event of ancestry[i].raw?.event ?? []) {
      const source = scriptSource(event);
      if (source?.trim()) {
        out.push({ from: ancestry[i].name, listen: String(event.listen), source });
      }
    }
  }
  return out;
}

/**
 * Resolve `protocolProfileBehavior` for one entry in the ancestry.
 *
 * Postman merges these key by key rather than all-or-nothing: a request that
 * sets only `followRedirects` still takes a folder's `strictSSL`. The nearest
 * ancestor wins, matching `Item#getProtocolProfileBehaviorResolved`, which
 * walks parents outwards letting what it already has shadow what it finds.
 *
 * `own` and `inherited` are kept apart because the editor has to say which is
 * which — a toggle showing an inherited value must not look like one the
 * request set itself.
 */
function settingsView(ancestry: Ancestor[], index: number): SettingsView {
  const own = ownSettings(ancestry[index].raw);
  const inherited: Record<string, SettingValue> = {};
  const inheritedFrom: Record<string, string> = {};

  for (let i = index - 1; i >= 0; i--) {
    for (const [key, value] of Object.entries(ownSettings(ancestry[i].raw))) {
      // Nearest wins, so the first sighting on the way up is the one that holds.
      if (key in own || key in inherited) { continue; }
      inherited[key] = value;
      inheritedFrom[key] = ancestry[i].name;
    }
  }

  return { own, inherited, inheritedFrom };
}

/** Postman writes a description either as a string or as `{ content, type }`. */
function descriptionText(description: any): string {
  if (typeof description === 'string') { return description; }
  if (typeof description?.content === 'string') { return description.content; }
  return '';
}

/**
 * Flatten one collection item into everything the request editor shows,
 * resolving auth and scripts inherited from parent folders and the collection.
 *
 * Postman's rule is that an item without its own `auth` inherits the nearest
 * ancestor's, while `prerequest`/`test` scripts from every ancestor run in
 * addition to the item's own.
 */
export function buildRequestView(
  collectionJson: PostmanJson,
  collectionName: string,
  node: ItemNode
): RequestView | undefined {
  const ancestry = ancestryFor(collectionJson, collectionName, node.path);
  if (!ancestry) { return undefined; }

  const raw = ancestry[ancestry.length - 1].raw;
  if (!raw || Array.isArray(raw.item)) { return undefined; }

  const request = raw.request ?? {};

  // Nearest ancestor (including self) that declares auth wins.
  const own = authView(request.auth);
  const handed = own ? undefined : inheritedAuth(ancestry, ancestry.length - 1);
  const auth = own ?? handed?.auth;
  const inheritedFrom = handed?.from;

  const ownEvents: any[] = raw.event ?? [];
  const ownScript = (listen: string) => scriptSource(ownEvents.find((e) => e?.listen === listen));

  return {
    collectionName,
    itemId: node.id,
    name: node.name,
    path: node.path,
    method: String(request.method ?? 'GET').toUpperCase(),
    url: urlToString(request.url),
    query: kv(request.url?.query),
    pathVariables: kv(request.url?.variable),
    headers: kv(request.header),
    auth: auth
      ? { type: auth.type, params: auth.params, inheritedFrom }
      : { type: 'none', params: [], inheritedFrom },
    body: bodyView(request.body),
    scripts: { prerequest: ownScript('prerequest'), test: ownScript('test') },
    inheritedScripts: inheritedScripts(ancestry, ancestry.length - 1),
    settings: settingsView(ancestry, ancestry.length - 1)
  };
}

/**
 * One row of a group's contents: a request, or a folder holding more.
 *
 * A tree rather than a flat list with a folder column, because a folder in
 * Postman is a category — the thing auth, scripts and ordering are declared on —
 * and flattening it away turns "what is in Orders" into a string to read off
 * every row.
 */
export type GroupEntry =
  | {
      kind: 'request';
      itemId: string;
      name: string;
      method: string;
      /** As written, unresolved — the same string the tree filter searches on. */
      url: string;
    }
  | { kind: 'folder'; itemId: string; name: string; children: GroupEntry[] };

/**
 * Everything the collection/folder overview shows, already flattened.
 *
 * A collection and a folder are the same thing to Postman — a container with
 * auth, variables, scripts and children — so they are one view here, told apart
 * by `kind` where the wording has to differ.
 */
export interface GroupView {
  kind: 'collection' | 'folder';
  collectionName: string;
  /** Absent for the collection root, which is not an item. */
  itemId?: string;
  name: string;
  /** Names from the collection down to this group, exclusive of it. */
  path: string[];
  description: string;
  auth: { type: string; params: KeyValue[]; inheritedFrom?: string };
  variables: KeyValue[];
  scripts: { prerequest?: string; test?: string };
  /** Scripts on ancestors, which also run for everything in this group. */
  inheritedScripts: Array<{ from: string; listen: string; source: string }>;
  settings: SettingsView;
  /** This group's children, folders intact, in collection order. */
  contents: GroupEntry[];
  /** Requests at any depth — what Run All will reach. */
  requests: number;
  /** Folders at any depth. */
  folders: number;
}

/** Turn a slice of the item tree into contents rows, folders and all. */
function toEntries(nodes: ItemNode[]): GroupEntry[] {
  return nodes.map((node) =>
    node.isFolder
      ? { kind: 'folder', itemId: node.id, name: node.name, children: toEntries(node.children) }
      : {
          kind: 'request',
          itemId: node.id,
          name: node.name,
          method: node.method ?? 'GET',
          url: node.url ?? ''
        }
  );
}

/**
 * Every request in a contents tree, depth-first, in collection order.
 *
 * Which is the order a run visits them in, so this doubles as "what Run All is
 * about to do" — the overview's queue, and the scope a folder's own run covers.
 */
export function contentRequests(
  entries: GroupEntry[]
): Array<Extract<GroupEntry, { kind: 'request' }>> {
  const out: Array<Extract<GroupEntry, { kind: 'request' }>> = [];
  const walk = (list: GroupEntry[]) => {
    for (const entry of list) {
      if (entry.kind === 'request') { out.push(entry); }
      else { walk(entry.children); }
    }
  };
  walk(entries);
  return out;
}

/** Folders in a contents tree, at any depth. */
function countFolders(entries: GroupEntry[]): number {
  return entries.reduce(
    (total, entry) => (entry.kind === 'folder' ? total + 1 + countFolders(entry.children) : total),
    0
  );
}

/**
 * Flatten a collection or a folder into its overview.
 *
 * `node` is the folder; omit it for the collection itself. The two differ in
 * only two places — the collection keeps its name and description under `info`,
 * and has no ancestor to inherit auth from — so both are built here rather than
 * left to the caller to reconcile.
 */
export function buildGroupView(
  materialized: MaterializedCollection,
  collectionName: string,
  node?: ItemNode
): GroupView | undefined {
  const collectionJson = materialized.json;
  const ancestry = ancestryFor(collectionJson, collectionName, node?.path ?? []);
  if (!ancestry) { return undefined; }

  const index = ancestry.length - 1;
  const raw = ancestry[index].raw;
  // A folder is a container; an id that now points at a request is stale.
  if (!raw || (node && !Array.isArray(raw.item))) { return undefined; }

  const own = authView(raw.auth);
  const handed = own ? undefined : inheritedAuth(ancestry, index);
  const auth = own ?? handed?.auth;

  const events: any[] = raw.event ?? [];
  const script = (listen: string) => scriptSource(events.find((e) => e?.listen === listen));

  const contents = toEntries(node ? node.children : materialized.tree);

  return {
    kind: node ? 'folder' : 'collection',
    collectionName,
    itemId: node?.id,
    name: node ? node.name : collectionName,
    // From the ancestry rather than `node.path`, whose segments carry the `~n`
    // suffix that keeps identically named siblings apart in an id.
    path: ancestry.slice(1, index).map((a) => a.name),
    description: descriptionText(node ? raw.description : collectionJson.info?.description),
    auth: auth
      ? { type: auth.type, params: auth.params, inheritedFrom: handed?.from }
      : { type: 'none', params: [], inheritedFrom: undefined },
    variables: kv(raw.variable),
    scripts: { prerequest: script('prerequest'), test: script('test') },
    inheritedScripts: inheritedScripts(ancestry, index),
    settings: settingsView(ancestry, index),
    contents,
    requests: contentRequests(contents).length,
    folders: countFolders(contents)
  };
}
