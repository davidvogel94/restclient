/**
 * Postman's per-request settings — the "Settings" tab in Postman's own request
 * editor, and `protocolProfileBehavior` in the collection format.
 *
 * The catalogue below is not a guess at Postman's UI: it is every behaviour the
 * embedded engine actually acts on, read off `PPB_OPTS` and the surrounding
 * special cases in `postman-runtime/lib/requester/core.js`. Anything Postman's
 * GUI can write is in here, because Postman's GUI is writing for this engine.
 *
 * `protocolProfileBehavior` sits on the item, beside `request` and `event` —
 * not inside `request` — and the engine resolves it up the tree, so a folder or
 * the collection root can set a default that a request then overrides
 * key-by-key (`Item#getProtocolProfileBehaviorResolved`).
 */

/** A value as it appears in the JSON. */
export type SettingValue = boolean | number | string | string[] | Record<string, boolean>;

/** How the editor renders one setting, and what shape its value takes. */
export type SettingKind = 'boolean' | 'number' | 'enum' | 'headers' | 'protocols' | 'ciphers';

export interface RequestSettingSpec {
  /** The `protocolProfileBehavior` key, spelled as Postman writes it. */
  key: string;
  /** Postman's own label for the control. */
  label: string;
  /** What it does, and what it costs — shown under the control. */
  help: string;
  kind: SettingKind;
  /**
   * The label reads as the negation of the JSON key.
   *
   * Postman words several of these positively ("Encode URL automatically")
   * while the format stores the opposite (`disableUrlEncoding`). Keeping the
   * inversion here means the file stays a byte-for-byte plausible Postman
   * export and only the presentation flips.
   */
  inverted?: boolean;
  /** Choices for `enum`, or the fixed membership list for `headers`/`protocols`. */
  options?: readonly string[];
  /**
   * The `restclient.*` setting that supplies the default when neither the
   * request nor any ancestor sets the key. Absent means the engine's own
   * built-in is the only fallback.
   */
  fallback?: 'strictSSL' | 'followRedirects' | 'maxRedirects' | 'protocolVersion';
  /** What postman-runtime does when nothing sets the key at all. */
  builtin: SettingValue;
  group: 'general' | 'redirects' | 'headers' | 'tls';
}

/**
 * System headers the engine adds on your behalf, and which of them can be
 * suppressed.
 *
 * The first seven come from `addSystemHeaders`; `content-type` and
 * `content-length` are added by the body helper and suppressed through
 * postman-request's `blacklistHeaders`. Nothing else in the list the engine
 * maintains is switchable, so nothing else is offered.
 */
export const SYSTEM_HEADERS = [
  'user-agent',
  'accept',
  'cache-control',
  'postman-token',
  'host',
  'accept-encoding',
  'connection',
  'content-type',
  'content-length'
] as const;

/** TLS/SSL versions that can be refused during negotiation. */
export const TLS_PROTOCOLS = ['TLSv1', 'TLSv1_1', 'TLSv1_2', 'TLSv1_3'] as const;

/** HTTP versions the engine will negotiate. */
export const PROTOCOL_VERSIONS = ['auto', 'http1', 'http2'] as const;

/** Methods the engine drops a body from unless `disableBodyPruning` says not to. */
export const METHODS_WITHOUT_BODY = ['GET', 'COPY', 'HEAD', 'PURGE', 'UNLOCK'] as const;

export const REQUEST_SETTINGS: readonly RequestSettingSpec[] = [
  // --- general ----------------------------------------------------------
  {
    key: 'disableUrlEncoding',
    label: 'Encode URL automatically',
    help: 'Percent-encode characters the URL cannot carry literally. Turn it off when the server expects the path or query exactly as typed.',
    kind: 'boolean',
    inverted: true,
    builtin: false,
    group: 'general'
  },
  {
    key: 'disableBodyPruning',
    label: 'Send the body on methods that normally have none',
    help: `The engine drops the body from ${METHODS_WITHOUT_BODY.join(', ')}. Postman sets this for you the moment you give one of those a body.`,
    kind: 'boolean',
    builtin: false,
    group: 'general'
  },
  {
    key: 'insecureHTTPParser',
    label: 'Enable strict HTTP parser',
    help: 'Reject responses with malformed headers or invalid framing. Turn it off to accept output from a non-conforming server.',
    kind: 'boolean',
    inverted: true,
    builtin: true,
    group: 'general'
  },
  {
    key: 'disableCookies',
    label: 'Send and store cookies',
    help: 'Use the shared cookie jar for this request. Turn it off to send nothing stored and keep nothing this response sets.',
    kind: 'boolean',
    inverted: true,
    builtin: false,
    group: 'general'
  },
  {
    key: 'protocolVersion',
    label: 'Protocol version',
    help: 'HTTP version to negotiate. `auto` takes HTTP/2 when the server offers it over TLS.',
    kind: 'enum',
    options: PROTOCOL_VERSIONS,
    fallback: 'protocolVersion',
    builtin: 'auto',
    group: 'general'
  },

  // --- redirects --------------------------------------------------------
  {
    key: 'followRedirects',
    label: 'Automatically follow redirects',
    help: 'Follow 3xx responses. Turn it off to see the redirect itself.',
    kind: 'boolean',
    fallback: 'followRedirects',
    builtin: true,
    group: 'redirects'
  },
  {
    key: 'maxRedirects',
    label: 'Maximum number of redirects',
    help: 'How many hops to follow before giving up.',
    kind: 'number',
    fallback: 'maxRedirects',
    builtin: 10,
    group: 'redirects'
  },
  {
    key: 'followOriginalHttpMethod',
    label: 'Follow original HTTP method',
    help: 'Redirect with the method that was sent. Off, a 301/302 is followed with GET, as browsers do.',
    kind: 'boolean',
    builtin: false,
    group: 'redirects'
  },
  {
    key: 'followAuthorizationHeader',
    label: 'Follow authorization header',
    help: 'Keep the `Authorization` header when a redirect crosses to another host. Off, it is dropped so credentials do not leak.',
    kind: 'boolean',
    builtin: false,
    group: 'redirects'
  },
  {
    key: 'removeRefererHeaderOnRedirect',
    label: 'Remove referer header on redirect',
    help: 'Drop the `Referer` the redirect chain adds. A `Referer` set on the request itself is kept either way.',
    kind: 'boolean',
    builtin: false,
    group: 'redirects'
  },

  // --- headers ----------------------------------------------------------
  {
    key: 'disabledSystemHeaders',
    label: 'System headers',
    help: 'Headers the engine adds unless you say otherwise. Unticking one leaves it off the wire entirely; a header of the same name that you set yourself is always sent.',
    kind: 'headers',
    options: SYSTEM_HEADERS,
    builtin: {},
    group: 'headers'
  },

  // --- tls --------------------------------------------------------------
  {
    key: 'strictSSL',
    label: 'Enable SSL certificate verification',
    help: 'Verify the server certificate chain and hostname. Postman ships with this off, and so does this extension.',
    kind: 'boolean',
    fallback: 'strictSSL',
    builtin: false,
    group: 'tls'
  },
  {
    key: 'tlsPreferServerCiphers',
    label: 'Use server cipher suite during handshake',
    help: "Let the server pick the cipher from its own order of preference rather than the client's.",
    kind: 'boolean',
    builtin: false,
    group: 'tls'
  },
  {
    key: 'tlsDisabledProtocols',
    label: 'Disabled TLS protocols',
    help: 'Versions to refuse during negotiation. Ticking one takes it off the table.',
    kind: 'protocols',
    options: TLS_PROTOCOLS,
    builtin: [],
    group: 'tls'
  },
  {
    key: 'tlsCipherSelection',
    label: 'TLS cipher suites',
    help: 'Ciphers to offer, most preferred first — one per line, in OpenSSL names. Empty leaves the default suite alone.',
    kind: 'ciphers',
    builtin: [],
    group: 'tls'
  }
];

export const SETTING_GROUPS: ReadonlyArray<{ id: RequestSettingSpec['group']; title: string }> = [
  { id: 'general', title: 'General' },
  { id: 'redirects', title: 'Redirects' },
  { id: 'headers', title: 'Headers' },
  { id: 'tls', title: 'TLS' }
];

const BY_KEY = new Map(REQUEST_SETTINGS.map((s) => [s.key, s]));

export function settingSpec(key: string): RequestSettingSpec | undefined {
  return BY_KEY.get(key);
}

/**
 * Narrow an arbitrary JSON value to the shape its setting expects.
 *
 * Collections are hand-edited and come from other tools, so a key can hold
 * anything. Returning `undefined` for a value the engine would not act on keeps
 * the editor from presenting nonsense as if it were in force — while leaving
 * the key itself untouched in the file.
 */
export function coerceSetting(key: string, value: unknown): SettingValue | undefined {
  const spec = BY_KEY.get(key);
  if (!spec || value === undefined || value === null) { return undefined; }

  switch (spec.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;

    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
    }

    case 'enum':
      return typeof value === 'string' && spec.options?.includes(value) ? value : undefined;

    case 'protocols':
      return Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string' && !!spec.options?.includes(v))
        : undefined;

    case 'ciphers':
      return Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
        : undefined;

    case 'headers': {
      if (typeof value !== 'object' || Array.isArray(value)) { return undefined; }
      const out: Record<string, boolean> = {};
      for (const [name, on] of Object.entries(value as Record<string, unknown>)) {
        // Only the headers the engine can actually suppress; anything else in
        // the object is inert and would read as a setting that does nothing.
        if (on === true && (SYSTEM_HEADERS as readonly string[]).includes(name.toLowerCase())) {
          out[name.toLowerCase()] = true;
        }
      }
      return out;
    }
  }
}

/** Read one item's own `protocolProfileBehavior`, keeping only usable values. */
export function ownSettings(raw: any): Record<string, SettingValue> {
  const behavior = raw?.protocolProfileBehavior;
  if (!behavior || typeof behavior !== 'object' || Array.isArray(behavior)) { return {}; }

  const out: Record<string, SettingValue> = {};
  for (const spec of REQUEST_SETTINGS) {
    if (!Object.prototype.hasOwnProperty.call(behavior, spec.key)) { continue; }
    const value = coerceSetting(spec.key, behavior[spec.key]);
    if (value !== undefined) { out[spec.key] = value; }
  }
  return out;
}

/**
 * Whether a setting value has nothing to say.
 *
 * An emptied list or header set usually means "put it back how it was", which
 * is a reset — Postman omits the key rather than writing `[]`. The exception is
 * a request that has to shadow a folder which disables something: there, the
 * empty value is the whole point and must be written. The editor tells the two
 * apart because only it knows what is inherited.
 */
export function isEmptySetting(value: SettingValue): boolean {
  if (Array.isArray(value)) { return value.length === 0; }
  if (value !== null && typeof value === 'object') { return Object.keys(value).length === 0; }
  return false;
}

/**
 * Whether anything in this collection has an opinion on URL encoding.
 *
 * `disableUrlEncoding` only reaches the wire through postman-runtime's WHATWG
 * URL parser, which is opt-in (`requester.useWhatWGUrlParser`, default off) and
 * differs from the legacy parser on enough edge cases that switching every
 * collection over would change requests nobody asked about. So the newer parser
 * is turned on exactly when the collection uses the setting that needs it.
 */
export function usesUrlEncodingBehavior(node: any): boolean {
  if (!node || typeof node !== 'object') { return false; }

  const behavior = node.protocolProfileBehavior;
  if (behavior && typeof behavior === 'object' &&
      typeof behavior.disableUrlEncoding === 'boolean') {
    return true;
  }

  return Array.isArray(node.item) && node.item.some(usesUrlEncodingBehavior);
}
