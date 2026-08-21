import type { JsonEdit, JsonPath } from './jsonEdit';
import type { SettingValue } from './settings';
import type { KeyValue } from '../panels/protocol';

// Resolved from the shipped node_modules; the same URL parser Postman itself uses.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Url } = require('postman-collection');

export type RequestUpdate =
  | { field: 'name'; value: string }
  | { field: 'method'; value: string }
  | { field: 'url'; value: string }
  | { field: 'query'; rows: KeyValue[] }
  | { field: 'pathVariables'; rows: KeyValue[] }
  | { field: 'headers'; rows: KeyValue[] }
  | { field: 'auth'; authType: string; rows: KeyValue[] }
  | { field: 'body'; mode: string; text?: string; language?: string; rows?: KeyValue[] }
  | { field: 'script'; listen: 'prerequest' | 'test'; source: string }
  /**
   * One `protocolProfileBehavior` key. `undefined` unsets it, which is how the
   * editor says "go back to whatever the folder, the collection or the engine
   * would have done" — there is no third state to store.
   */
  | { field: 'setting'; key: string; value: SettingValue | undefined };

/** Auth types postman-runtime can execute, in the order Postman lists them. */
export const AUTH_TYPES = [
  'inherit',
  'noauth',
  'basic',
  'bearer',
  'jwt',
  'digest',
  'oauth1',
  'oauth2',
  'apikey',
  'awsv4',
  'hawk',
  'ntlm',
  'edgegrid',
  'asap'
] as const;

/** The parameter names Postman writes for each auth type. */
export const AUTH_FIELDS: Record<string, string[]> = {
  basic: ['username', 'password'],
  bearer: ['token'],
  jwt: ['algorithm', 'secret', 'isSecretBase64Encoded', 'payload', 'addTokenTo', 'headerPrefix', 'queryParamKey', 'header'],
  digest: ['username', 'password', 'realm', 'nonce', 'algorithm', 'qop', 'nonceCount', 'clientNonce', 'opaque'],
  oauth1: ['consumerKey', 'consumerSecret', 'token', 'tokenSecret', 'signatureMethod', 'timestamp', 'nonce', 'version', 'realm', 'addParamsToHeader', 'addEmptyParamsToSign'],
  oauth2: ['accessToken', 'addTokenTo', 'headerPrefix', 'tokenType'],
  apikey: ['key', 'value', 'in'],
  awsv4: ['accessKey', 'secretKey', 'sessionToken', 'service', 'region'],
  hawk: ['authId', 'authKey', 'algorithm', 'user', 'nonce', 'extraData', 'app', 'delegation', 'timestamp'],
  ntlm: ['username', 'password', 'domain', 'workstation'],
  edgegrid: ['accessToken', 'clientToken', 'clientSecret', 'baseURL', 'headersToSign', 'timestamp', 'nonce'],
  asap: ['alg', 'kid', 'iss', 'exp', 'aud', 'sub', 'claims', 'privateKey']
};

/** Strip keys Postman omits when empty, so files stay close to a native export. */
function cleanRow(row: KeyValue): Record<string, unknown> {
  const out: Record<string, unknown> = { key: row.key, value: row.value };
  if (row.disabled) { out.disabled = true; }
  if (row.description) { out.description = row.description; }
  return out;
}

function authRows(rows: KeyValue[]): Array<Record<string, unknown>> {
  return rows
    .filter((r) => r.key)
    .map((r) => ({ key: r.key, value: r.value, type: 'string' }));
}

/**
 * Rebuild a Postman `url` object from a raw URL string.
 *
 * Uses postman-collection's own parser so host/path/query/variable decomposition
 * matches what Postman would have written, rather than a hand-rolled split that
 * drifts on edge cases like `:pathVar` and `{{baseUrl}}`.
 */
function urlObject(raw: string, overrides?: { query?: KeyValue[]; variable?: KeyValue[] }): unknown {
  const url = new Url(raw);
  const json: any = url.toJSON();

  if (overrides?.query) {
    json.query = overrides.query.filter((r) => r.key || r.value).map(cleanRow);
  }
  if (overrides?.variable) {
    json.variable = overrides.variable.filter((r) => r.key).map(cleanRow);
  }

  // Keep `raw` in sync — it is what most tools read, and what we show in the UI.
  if (overrides?.query) {
    const search = json.query
      .filter((q: any) => !q.disabled)
      .map((q: any) => (q.value ? `${q.key}=${q.value}` : q.key))
      .join('&');
    const base = raw.split('?')[0];
    json.raw = search ? `${base}?${search}` : base;
  } else {
    json.raw = raw;
  }

  return json;
}

function bodyObject(update: Extract<RequestUpdate, { field: 'body' }>): unknown {
  switch (update.mode) {
    case 'none':
      return undefined;
    case 'raw':
      return {
        mode: 'raw',
        raw: update.text ?? '',
        ...(update.language ? { options: { raw: { language: update.language } } } : {})
      };
    case 'graphql':
      return {
        mode: 'graphql',
        graphql: { query: update.text ?? '', variables: update.rows?.[0]?.value ?? '' }
      };
    case 'urlencoded':
      return { mode: 'urlencoded', urlencoded: (update.rows ?? []).filter((r) => r.key).map(cleanRow) };
    case 'formdata':
      return {
        mode: 'formdata',
        formdata: (update.rows ?? [])
          .filter((r) => r.key)
          .map((r) =>
            r.description === 'file'
              ? { key: r.key, src: r.value, type: 'file', ...(r.disabled ? { disabled: true } : {}) }
              : { key: r.key, value: r.value, type: 'text', ...(r.disabled ? { disabled: true } : {}) }
          )
      };
    case 'file':
      return { mode: 'file', file: { src: update.text ?? '' } };
    default:
      return undefined;
  }
}

/**
 * Rebuild the `event` array with one listener replaced.
 *
 * Replacing the whole array rather than editing in place keeps ordering stable
 * and avoids index arithmetic when the listener does not exist yet.
 */
function eventArray(existing: any[], listen: string, source: string): unknown[] {
  const others = (existing ?? []).filter((e) => e?.listen !== listen);
  if (!source.trim()) { return others; }

  const previous = (existing ?? []).find((e) => e?.listen === listen);
  const rebuilt = {
    ...(previous ?? {}),
    listen,
    script: {
      ...(previous?.script ?? {}),
      type: previous?.script?.type ?? 'text/javascript',
      exec: source.split('\n')
    }
  };

  // Postman writes prerequest before test; keep that order for clean diffs.
  return listen === 'prerequest' ? [rebuilt, ...others] : [...others, rebuilt];
}

/**
 * Set or unset one `protocolProfileBehavior` key on an item.
 *
 * `undefined` is the only thing that unsets — an empty list or an all-clear
 * header set is written as-is, because that is the only way a request can
 * override a folder that disables something. Deciding which of the two an
 * emptied control means needs the inheritance, so the editor decides and this
 * only carries it out.
 *
 * Unsetting the last key removes the whole object rather than leaving `{}`:
 * jsonc-parser would keep the empty braces, and Postman omits the property
 * entirely, so a request whose settings are all back to default ends up
 * byte-identical to one that never had any.
 */
function settingEdits(
  itemPath: JsonPath,
  rawItem: any,
  key: string,
  value: SettingValue | undefined
): JsonEdit[] {
  const behaviorPath = [...itemPath, 'protocolProfileBehavior'];

  if (value !== undefined) {
    return [{ path: [...behaviorPath, key], value }];
  }

  const existing = rawItem?.protocolProfileBehavior;
  const others =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? Object.keys(existing).filter((k) => k !== key)
      : [];

  return others.length
    ? [{ path: [...behaviorPath, key], value: undefined }]
    : [{ path: behaviorPath, value: undefined }];
}

/**
 * Translate one semantic edit from the request editor into JSON edits against
 * the collection file.
 *
 * `rawItem` is the item as it exists on disk, so untouched sibling keys and any
 * fields this extension does not model survive the write.
 */
export function buildRequestEdits(
  itemPath: JsonPath,
  rawItem: any,
  update: RequestUpdate
): JsonEdit[] {
  const requestPath = [...itemPath, 'request'];
  const rawUrl = rawItem?.request?.url;
  const currentRaw =
    typeof rawUrl === 'string' ? rawUrl : typeof rawUrl?.raw === 'string' ? rawUrl.raw : '';

  switch (update.field) {
    case 'name':
      return [{ path: [...itemPath, 'name'], value: update.value }];

    case 'method':
      return [{ path: [...requestPath, 'method'], value: update.value.toUpperCase() }];

    case 'url':
      return [{ path: [...requestPath, 'url'], value: urlObject(update.value) }];

    case 'query':
      return [{ path: [...requestPath, 'url'], value: urlObject(currentRaw, { query: update.rows }) }];

    case 'pathVariables':
      return [{ path: [...requestPath, 'url'], value: urlObject(currentRaw, { variable: update.rows }) }];

    case 'headers':
      return [
        { path: [...requestPath, 'header'], value: update.rows.filter((r) => r.key).map(cleanRow) }
      ];

    case 'auth':
      // `inherit` means "no auth block at all" — the parent's applies.
      if (update.authType === 'inherit') {
        return [{ path: [...requestPath, 'auth'], value: undefined }];
      }
      if (update.authType === 'noauth') {
        return [{ path: [...requestPath, 'auth'], value: { type: 'noauth' } }];
      }
      return [
        {
          path: [...requestPath, 'auth'],
          value: { type: update.authType, [update.authType]: authRows(update.rows) }
        }
      ];

    case 'body':
      return [{ path: [...requestPath, 'body'], value: bodyObject(update) }];

    case 'script':
      return [{ path: [...itemPath, 'event'], value: eventArray(rawItem?.event ?? [], update.listen, update.source) }];

    case 'setting':
      // Beside `request`, not inside it — the format puts behaviour on the item.
      return settingEdits(itemPath, rawItem, update.key, update.value);
  }
}

/** An edit to a collection's or a folder's own settings, rather than a request's. */
export type GroupUpdate =
  | { field: 'name'; value: string }
  | { field: 'description'; value: string }
  | { field: 'auth'; authType: string; rows: KeyValue[] }
  | { field: 'variables'; rows: KeyValue[] }
  | { field: 'script'; listen: 'prerequest' | 'test'; source: string };

/**
 * Rebuild a `variable[]`, keeping whatever Postman wrote alongside each entry.
 *
 * A variable carries a `type`, and often a `description` the overview has no
 * control for; matching on key and spreading the existing entry keeps both
 * rather than quietly dropping something the user cannot see to restore.
 *
 * `disabled` is the exception, rebuilt from the row rather than spread: it is
 * the one field the table does toggle, and a variable just re-enabled must not
 * keep the old `disabled: true`.
 */
function variableRows(existing: any[], rows: KeyValue[]): Array<Record<string, unknown>> {
  const before = new Map<string, any>(
    (existing ?? []).map((v: any) => [String(v?.key ?? ''), v])
  );

  return rows
    .filter((r) => r.key)
    .map((r) => {
      const { disabled: _disabled, ...rest } = before.get(r.key) ?? {};
      return {
        ...rest,
        key: r.key,
        value: r.value,
        type: typeof rest.type === 'string' ? rest.type : 'default',
        ...(r.description ? { description: r.description } : {}),
        ...(r.disabled ? { disabled: true } : {})
      };
    });
}

/**
 * Translate one edit from the collection/folder overview into JSON edits.
 *
 * `groupPath` is the item's index path, or `[]` for the collection root. The
 * root is the awkward case: it keeps its name and description inside `info`,
 * while `auth`, `variable` and `event` sit at the top level exactly as they do
 * on a folder — so only the first two need telling apart.
 *
 * `raw` is the container as it exists on disk, so untouched sibling keys and
 * anything this extension does not model survive the write.
 */
export function buildGroupEdits(
  groupPath: JsonPath,
  raw: any,
  update: GroupUpdate
): JsonEdit[] {
  const isCollection = groupPath.length === 0;
  const at = (...keys: Array<string>) => [...groupPath, ...keys];

  switch (update.field) {
    case 'name':
      return [{ path: isCollection ? ['info', 'name'] : at('name'), value: update.value }];

    case 'description':
      return [
        {
          path: isCollection ? ['info', 'description'] : at('description'),
          // Postman omits the key rather than writing an empty description.
          value: update.value.trim() ? update.value : undefined
        }
      ];

    case 'auth':
      // A container has nothing above it to inherit from when it is the
      // collection, but the shape is the same either way: no `auth` block at all
      // means "whatever the parent says".
      if (update.authType === 'inherit') {
        return [{ path: at('auth'), value: undefined }];
      }
      if (update.authType === 'noauth') {
        return [{ path: at('auth'), value: { type: 'noauth' } }];
      }
      return [
        {
          path: at('auth'),
          value: { type: update.authType, [update.authType]: authRows(update.rows) }
        }
      ];

    // Both drop the key when the last entry goes, rather than leaving an empty
    // array behind: Postman omits them, so a file that never had one stays
    // exactly as it was.
    case 'variables': {
      const rebuilt = variableRows(raw?.variable ?? [], update.rows);
      return [{ path: at('variable'), value: rebuilt.length ? rebuilt : undefined }];
    }

    case 'script': {
      const rebuilt = eventArray(raw?.event ?? [], update.listen, update.source);
      return [{ path: at('event'), value: rebuilt.length ? rebuilt : undefined }];
    }
  }
}
