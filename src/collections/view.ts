import type { PostmanJson } from './importer';
import type { ItemNode } from './model';
import type { KeyValue, RequestView } from '../panels/protocol';

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
  const ancestry: Array<{ name: string; raw: any }> = [{ name: collectionName, raw: collectionJson }];

  let cursor: any = collectionJson;
  for (const segment of node.path) {
    const items: any[] = cursor?.item ?? [];
    // `path` segments carry a `~n` suffix when siblings share a name.
    const tilde = segment.lastIndexOf('~');
    const name = tilde > 0 && /^\d+$/.test(segment.slice(tilde + 1)) ? segment.slice(0, tilde) : segment;
    const dupeIndex = tilde > 0 && /^\d+$/.test(segment.slice(tilde + 1)) ? Number(segment.slice(tilde + 1)) : 0;

    const matches = items.filter((i) => String(i?.name ?? 'Untitled') === name);
    const next = matches[dupeIndex];
    if (!next) { return undefined; }
    ancestry.push({ name, raw: next });
    cursor = next;
  }

  const raw = cursor;
  if (!raw || Array.isArray(raw.item)) { return undefined; }

  const request = raw.request ?? {};

  // Nearest ancestor (including self) that declares auth wins.
  let auth = authView(request.auth);
  let inheritedFrom: string | undefined;
  if (!auth) {
    for (let i = ancestry.length - 2; i >= 0; i--) {
      const candidate = authView(ancestry[i].raw?.auth);
      if (candidate) {
        auth = candidate;
        inheritedFrom = ancestry[i].name;
        break;
      }
    }
  }

  const inheritedScripts: RequestView['inheritedScripts'] = [];
  for (let i = 0; i < ancestry.length - 1; i++) {
    for (const event of ancestry[i].raw?.event ?? []) {
      const source = scriptSource(event);
      if (source?.trim()) {
        inheritedScripts.push({ from: ancestry[i].name, listen: String(event.listen), source });
      }
    }
  }

  const ownEvents: any[] = raw.event ?? [];
  const own = (listen: string) => scriptSource(ownEvents.find((e) => e?.listen === listen));

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
    scripts: { prerequest: own('prerequest'), test: own('test') },
    inheritedScripts
  };
}
