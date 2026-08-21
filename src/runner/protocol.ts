/**
 * Message protocol between the extension host and the forked runner process.
 *
 * The runner cannot `require('vscode')` (microsoft/vscode#213521 — closed
 * won't-do), so everything crosses this boundary as plain JSON.
 */

/** A Postman v2.1 collection object, verbatim. */
export type CollectionJson = Record<string, unknown>;
/** A Postman environment/globals export, verbatim (`{ values: [...] }`). */
export type VariableScopeJson = Record<string, unknown>;

/** A `@postman/tough-cookie` jar as produced by `serializeSync()`. */
export type SerializedCookieJar = Record<string, unknown>;

export interface CertificateConfig {
  name?: string;
  /** URL match patterns, e.g. `https://api.example.com/*`. */
  matches: string[];
  key?: string;
  cert?: string;
  pfx?: string;
  passphrase?: string;
}

export interface ProxyConfig {
  /** Postman match pattern, e.g. `http+https://*\/*`. */
  match?: string;
  host: string;
  port?: number;
  tunnel?: boolean;
  disabled?: boolean;
  username?: string;
  password?: string;
  /** Hosts that bypass the proxy, from VS Code's `http.noProxy`. */
  bypass?: string[];
}

export interface RunOptions {
  /** Item ids or names to execute; omitted means the whole collection. */
  entrypoint?: { execute: string; lookupStrategy?: 'idOrName' | 'path' | 'multipleIdOrName' };
  environment?: VariableScopeJson;
  globals?: VariableScopeJson;
  /** Iteration data rows (already parsed from CSV/JSON by the extension). */
  data?: Array<Record<string, unknown>>;
  iterationCount?: number;
  delay?: { item?: number; iteration?: number };
  stopOnError?: boolean;
  stopOnFailure?: boolean;
  timeout?: { global?: number; request?: number; script?: number };
  /** The folder relative file paths in this collection resolve against. */
  workspaceRoot?: string;
  /** Every workspace folder; a request may read from any of them, nothing else. */
  workspaceRoots?: string[];
  /** When false, pre-request/test scripts are stripped before running. */
  allowScripts: boolean;
  /** Resolved `secret`-typed variables, injected as environment values. */
  secrets?: Record<string, string>;
  followRedirects?: boolean;
  maxRedirects?: number;
  strictSSL?: boolean;
  disableCookies?: boolean;
  /** 'http1' | 'http2' | 'auto' */
  protocolVersion?: string;
  /**
   * Use postman-runtime's WHATWG URL parser instead of the legacy one.
   *
   * Only that parser honours the `disableUrlEncoding` request setting, and it
   * differs from the legacy parser on enough edge cases that it is switched on
   * per run — when the collection actually uses the setting — rather than for
   * everything.
   */
  useWhatWGUrlParser?: boolean;
  /** Bytes of response body to ship back to the UI. */
  maxResponseBytes?: number;
  /** Cookie jar carried over from previous runs. */
  cookieJar?: SerializedCookieJar;
  certificates?: CertificateConfig[];
  proxies?: ProxyConfig[];
  /** Values backing `pm.vault.get`, resolved from SecretStorage. */
  vault?: Record<string, string>;
}

export type HostMessage =
  | { type: 'run'; runId: string; collection: CollectionJson; options: RunOptions }
  | { type: 'abort'; runId: string }
  | { type: 'shutdown' };

export interface SerializedRequest {
  method: string;
  url: string;
  headers: Array<{ key: string; value: string }>;
  body?: string;
  bodyTruncated?: boolean;
}

export interface SerializedResponse {
  code: number;
  status: string;
  responseTime: number;
  responseSize: number;
  headers: Array<{ key: string; value: string }>;
  /** base64; may be truncated per `maxResponseBytes`. */
  bodyBase64: string;
  bodyTruncated: boolean;
  cookies: SerializedCookie[];
}

export interface SerializedCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: string;
  maxAge?: number;
  hostOnly?: boolean;
  httpOnly?: boolean;
  secure?: boolean;
  session?: boolean;
  sameSite?: string;
}

export interface SerializedAssertion {
  name: string;
  passed: boolean;
  skipped: boolean;
  index?: number;
  error?: { name?: string; message: string; stack?: string };
}

export interface Cursor {
  ref?: string;
  iteration?: number;
  position?: number;
}

export type RunnerMessage =
  | { type: 'ready'; pid: number }
  | { type: 'runStarted'; runId: string }
  | { type: 'beforeItem'; runId: string; cursor: Cursor; itemId?: string; itemName?: string }
  | { type: 'beforeRequest'; runId: string; cursor: Cursor; request: SerializedRequest }
  | { type: 'response'; runId: string; cursor: Cursor; request: SerializedRequest; response: SerializedResponse }
  | { type: 'requestError'; runId: string; cursor: Cursor; message: string }
  | { type: 'assertion'; runId: string; cursor: Cursor; assertions: SerializedAssertion[] }
  | { type: 'console'; runId: string; cursor: Cursor; level: string; messages: string[] }
  | { type: 'exception'; runId: string; cursor: Cursor; message: string; stack?: string }
  | { type: 'visualizer'; runId: string; cursor: Cursor; html: string }
  | { type: 'scopeChanged'; runId: string; scope: 'environment' | 'globals'; values: Array<{ key: string; value: unknown; type?: string }> }
  | { type: 'cookieJarChanged'; runId: string; jar: SerializedCookieJar }
  | { type: 'vaultChanged'; runId: string; values: Record<string, string> }
  | { type: 'httpTraffic'; runId: string; cursor: Cursor; request: SerializedRequest; response?: SerializedResponse; error?: string; nested: boolean }
  | { type: 'itemDone'; runId: string; cursor: Cursor; itemId?: string }
  | { type: 'runDone'; runId: string; error?: string }
  | { type: 'fatal'; message: string; stack?: string };
