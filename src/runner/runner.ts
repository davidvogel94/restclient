/**
 * Forked runner process. Hosts postman-runtime (which in turn boots
 * postman-sandbox in a uvm worker thread) and streams lifecycle events back to
 * the extension host over `process.send`.
 *
 * Runs in its own process so that a runaway or crashing user script cannot take
 * the extension host down, and so a stuck run can be SIGKILLed outright. It must
 * never import 'vscode'.
 */
import { WorkspaceFileResolver } from './fileResolver';
import type {
  CertificateConfig,
  Cursor,
  SerializedCookie,
  HostMessage,
  ProxyConfig,
  RunnerMessage,
  RunOptions,
  SerializedAssertion,
  SerializedRequest,
  SerializedResponse
} from './protocol';

// Not bundled — resolved from the extension's shipped node_modules.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const runtime = require('postman-runtime');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Collection, VariableScope, CertificateList, ProxyConfigList } = require('postman-collection');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CookieJar } = require('@postman/tough-cookie');

const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function send(msg: RunnerMessage): void {
  process.send?.(msg);
}

function toCursor(raw: any): Cursor {
  return { ref: raw?.ref, iteration: raw?.iteration, position: raw?.position };
}

function headerList(list: any): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  list?.each?.((h: any) => {
    if (!h.disabled) { out.push({ key: String(h.key ?? ''), value: String(h.value ?? '') }); }
  });
  return out;
}

function serializeRequest(request: any, maxBytes: number): SerializedRequest {
  let body: string | undefined;
  let bodyTruncated = false;
  try {
    const raw = request?.body?.toString?.();
    if (typeof raw === 'string' && raw.length) {
      body = raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
      bodyTruncated = raw.length > maxBytes;
    }
  } catch {
    // A file/form-data body has no meaningful string form; showing nothing is
    // better than showing a stream handle.
  }
  return {
    method: String(request?.method ?? 'GET'),
    url: request?.url?.toString?.() ?? '',
    headers: headerList(request?.headers),
    body,
    bodyTruncated
  };
}

/**
 * Cookies relevant to a response.
 *
 * `response.cookies` on the SDK Response is always empty — postman-runtime
 * never populates it. The cookies are handed to the trigger as a separate
 * CookieList argument, built from the jar for the final request URL, which is
 * what Postman's own Cookies tab shows. Falling back to parsing `Set-Cookie`
 * headers covers the case where the jar is disabled for the request.
 */
function serializeCookies(cookieList: any, response: any): SerializedCookie[] {
  const out: SerializedCookie[] = [];

  const push = (c: any) => {
    const json = typeof c?.toJSON === 'function' ? c.toJSON() : c;
    if (!json) { return; }
    const name = String(json.name ?? json.key ?? '');
    if (!name) { return; }
    out.push({
      name,
      value: String(json.value ?? ''),
      domain: json.domain,
      path: json.path,
      expires:
        json.expires instanceof Date
          ? json.expires.toISOString()
          : json.expires
            ? String(json.expires)
            : undefined,
      maxAge: typeof json.maxAge === 'number' ? json.maxAge : undefined,
      hostOnly: json.hostOnly,
      httpOnly: json.httpOnly,
      secure: json.secure,
      session: json.session,
      sameSite: json.extensions?.find?.((e: string) => /^samesite=/i.test(e))?.split('=')[1]
    });
  };

  cookieList?.each?.(push);

  if (!out.length) {
    // No jar cookies (disableCookies, or a cross-domain redirect): fall back to
    // what this response literally asked to set.
    response?.headers?.each?.((h: any) => {
      if (!/^set-cookie$/i.test(String(h?.key ?? ''))) { return; }
      const raw = String(h.value ?? '');
      const [pair, ...attrs] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq < 0) { return; }

      const attributes = new Map<string, string>();
      for (const attr of attrs) {
        const [k, ...v] = attr.trim().split('=');
        attributes.set(k.toLowerCase(), v.join('='));
      }

      out.push({
        name: pair.slice(0, eq).trim(),
        value: pair.slice(eq + 1).trim(),
        domain: attributes.get('domain'),
        path: attributes.get('path'),
        expires: attributes.get('expires'),
        maxAge: attributes.has('max-age') ? Number(attributes.get('max-age')) : undefined,
        httpOnly: attributes.has('httponly'),
        secure: attributes.has('secure'),
        sameSite: attributes.get('samesite')
      });
    });
  }

  return out;
}

function serializeResponse(response: any, maxBytes: number, cookieList?: any): SerializedResponse {
  const stream: Buffer | undefined = response?.stream && Buffer.from(response.stream);
  const full = stream ?? Buffer.alloc(0);
  const truncated = full.length > maxBytes;
  const cookies = serializeCookies(cookieList, response);
  return {
    code: Number(response?.code ?? 0),
    status: String(response?.status ?? response?.reason?.() ?? ''),
    responseTime: Number(response?.responseTime ?? 0),
    responseSize: Number(response?.responseSize ?? full.length),
    headers: headerList(response?.headers),
    bodyBase64: (truncated ? full.subarray(0, maxBytes) : full).toString('base64'),
    bodyTruncated: truncated,
    cookies
  };
}

function serializeAssertions(raw: any[]): SerializedAssertion[] {
  return (raw ?? []).map((a) => ({
    name: String(a?.name ?? ''),
    // postman-sandbox reports `passed`; treat a present error as authoritative.
    passed: Boolean(a?.passed) && !a?.error,
    skipped: Boolean(a?.skipped),
    index: a?.index,
    error: a?.error
      ? { name: a.error.name, message: String(a.error.message ?? a.error), stack: a.error.stack }
      : undefined
  }));
}

function scopeValues(scope: any): Array<{ key: string; value: unknown; type?: string }> {
  const json = scope?.toJSON?.() ?? scope;
  return (json?.values ?? []).map((v: any) => ({ key: v.key, value: v.value, type: v.type }));
}

/**
 * Strip every pre-request/test script from a collection, in place.
 * Used when the workspace is untrusted.
 */
function stripScripts(node: any): void {
  if (!node || typeof node !== 'object') { return; }
  if (Array.isArray(node.event)) { node.event = []; }
  if (Array.isArray(node.item)) { node.item.forEach(stripScripts); }
}

/** Build a postman-collection CertificateList from plain config. */
function buildCertificates(configs: CertificateConfig[] | undefined): any {
  if (!configs?.length) { return undefined; }
  return new CertificateList(
    null,
    configs.map((c) => ({
      name: c.name,
      matches: c.matches,
      ...(c.key ? { key: { src: c.key } } : {}),
      ...(c.cert ? { cert: { src: c.cert } } : {}),
      ...(c.pfx ? { pfx: { src: c.pfx } } : {}),
      ...(c.passphrase ? { passphrase: c.passphrase } : {})
    }))
  );
}

function buildProxies(configs: ProxyConfig[] | undefined): any {
  if (!configs?.length) { return undefined; }
  return new ProxyConfigList(
    null,
    configs.map((p) => ({
      match: p.match ?? 'http+https://*/*',
      host: p.host,
      port: p.port ?? 8080,
      tunnel: p.tunnel ?? false,
      disabled: p.disabled ?? false,
      ...(p.username ? { authenticate: true, username: p.username, password: p.password ?? '' } : {}),
      ...(p.bypass?.length ? { bypass: p.bypass } : {})
    }))
  );
}

class RunController {
  private current: { runId: string; run: any } | undefined;

  abort(runId: string): void {
    if (this.current?.runId === runId) {
      try { this.current.run?.abort?.(); } catch { /* already finished */ }
    }
  }

  start(runId: string, collectionJson: any, options: RunOptions): void {
    const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

    if (!options.allowScripts) { stripScripts(collectionJson); }

    const collection = new Collection(collectionJson);

    // Secrets live in SecretStorage, never in the committed JSON, so they are
    // merged back into the environment scope only at send time.
    const envJson: any = options.environment ? { ...options.environment } : { values: [] };
    if (options.secrets && Object.keys(options.secrets).length) {
      const values = Array.isArray(envJson.values) ? [...envJson.values] : [];
      for (const [key, value] of Object.entries(options.secrets)) {
        const existing = values.findIndex((v: any) => v?.key === key);
        const entry = { key, value, type: 'secret', enabled: true };
        if (existing >= 0) { values[existing] = { ...values[existing], ...entry }; }
        else { values.push(entry); }
      }
      envJson.values = values;
    }

    const environment = new VariableScope(envJson);
    const globals = new VariableScope(options.globals ?? { values: [] });

    // pm.vault reads from this scope; values come from the OS keychain and are
    // never persisted into the collection or environment files.
    const vaultSecrets = new VariableScope({
      values: Object.entries(options.vault ?? {}).map(([key, value]) => ({ key, value, type: 'secret' }))
    });

    // postman-runtime asks this hook whether a collection's scripts may touch
    // the vault — the Postman app prompts the user per collection. Here the
    // equivalent consent is workspace trust, which already gates scripts at all.
    (vaultSecrets as any)._ = {
      ...((vaultSecrets as any)._ ?? {}),
      allowScriptAccess: async () => options.allowScripts
    };

    // Restoring the jar is what makes a login in one request authorise the next.
    const cookieJar = options.cookieJar
      ? CookieJar.deserializeSync(options.cookieJar as any)
      : new CookieJar();

    const runOptions: Record<string, unknown> = {
      environment,
      globals,
      fileResolver: new WorkspaceFileResolver(options.workspaceRoot),
      timeout: {
        global: options.timeout?.global ?? 0,
        request: options.timeout?.request ?? 0,
        script: options.timeout?.script ?? 60000
      },
      stopOnError: options.stopOnError ?? false,
      stopOnFailure: options.stopOnFailure ?? false,
      vaultSecrets,
      requester: {
        followRedirects: options.followRedirects ?? true,
        maxRedirects: options.maxRedirects ?? 10,
        strictSSL: options.strictSSL ?? false,
        disableCookies: options.disableCookies ?? false,
        maxResponseSize: maxBytes,
        cookieJar,
        ...(options.protocolVersion ? { protocolVersion: options.protocolVersion } : {})
      }
    };

    const certificates = buildCertificates(options.certificates);
    if (certificates) { runOptions.certificates = certificates; }

    const proxies = buildProxies(options.proxies);
    if (proxies) { runOptions.proxies = proxies; }
    if (options.entrypoint) { runOptions.entrypoint = options.entrypoint; }
    if (options.data?.length) { runOptions.data = options.data; }
    if (options.iterationCount) { runOptions.iterationCount = options.iterationCount; }
    if (options.delay) { runOptions.delay = options.delay; }

    new runtime.Runner().run(collection, runOptions, (err: Error | null, run: any) => {
      if (err) { return send({ type: 'runDone', runId, error: err.message }); }
      this.current = { runId, run };

      run.start({
        start: () => send({ type: 'runStarted', runId }),

        beforeItem: (_e: any, cursor: any, item: any) =>
          send({ type: 'beforeItem', runId, cursor: toCursor(cursor), itemId: item?.id, itemName: item?.name }),

        beforeRequest: (_e: any, cursor: any, request: any) =>
          send({ type: 'beforeRequest', runId, cursor: toCursor(cursor), request: serializeRequest(request, maxBytes) }),

        // `request` fires for every HTTP call the run makes, nested
        // pm.sendRequest ones included. The console shows all of it; the
        // response pane only shows collection-level items (see `response`).
        request: (e: any, cursor: any, response: any, request: any, _item: any, cookies: any) => {
          send({
            type: 'httpTraffic',
            runId,
            cursor: toCursor(cursor),
            request: serializeRequest(request, maxBytes),
            response: e ? undefined : serializeResponse(response, Math.min(maxBytes, 64 * 1024), cookies),
            error: e ? (e.message ?? String(e)) : undefined,
            nested: false
          });
        },

        // `request` fires for EVERY http call, including nested pm.sendRequest
        // ones; `response` fires only for collection-level items. The UI wants
        // the latter, so nested traffic stays out of the response pane.
        // Signature is (err, cursor, response, request, item, cookies, history).
        // `cookies` is a CookieList built from the jar for the final URL — the
        // Response object's own `cookies` property is always empty.
        response: (e: any, cursor: any, response: any, request: any, _item: any, cookies: any) => {
          if (e) {
            return send({ type: 'requestError', runId, cursor: toCursor(cursor), message: e.message ?? String(e) });
          }
          send({
            type: 'response',
            runId,
            cursor: toCursor(cursor),
            request: serializeRequest(request, maxBytes),
            response: serializeResponse(response, maxBytes, cookies)
          });
        },

        assertion: (cursor: any, assertions: any[]) =>
          send({ type: 'assertion', runId, cursor: toCursor(cursor), assertions: serializeAssertions(assertions) }),

        console: (cursor: any, level: string, ...messages: unknown[]) =>
          send({
            type: 'console',
            runId,
            cursor: toCursor(cursor),
            level: String(level),
            messages: messages.map((m) => {
              if (typeof m === 'string') { return m; }
              try { return JSON.stringify(m); } catch { return String(m); }
            })
          }),

        exception: (cursor: any, e: any) =>
          send({
            type: 'exception',
            runId,
            cursor: toCursor(cursor),
            message: e?.message ?? String(e),
            stack: e?.stack
          }),

        item: (_e: any, cursor: any, item: any, visualizerResult: any) => {
          // postman-runtime has already rendered the handlebars template.
          if (visualizerResult?.processedTemplate) {
            send({ type: 'visualizer', runId, cursor: toCursor(cursor), html: String(visualizerResult.processedTemplate) });
          }
          send({ type: 'itemDone', runId, cursor: toCursor(cursor), itemId: item?.id });
        },

        done: (doneErr: any) => {
          // Scripts may have mutated these; the extension persists the result.
          send({ type: 'scopeChanged', runId, scope: 'environment', values: scopeValues(environment) });
          send({ type: 'scopeChanged', runId, scope: 'globals', values: scopeValues(globals) });

          try {
            send({ type: 'cookieJarChanged', runId, jar: cookieJar.serializeSync() as any });
          } catch (e: any) {
            send({ type: 'console', runId, cursor: {}, level: 'warn', messages: [`Could not save cookies: ${e?.message ?? e}`] });
          }

          // pm.vault.set writes into this scope; mirror it back to the keychain.
          const vaultOut: Record<string, string> = {};
          for (const v of scopeValues(vaultSecrets)) { vaultOut[v.key] = String(v.value ?? ''); }
          send({ type: 'vaultChanged', runId, values: vaultOut });
          send({ type: 'runDone', runId, error: doneErr ? (doneErr.message ?? String(doneErr)) : undefined });
          this.current = undefined;
        }
      });
    });
  }
}

const controller = new RunController();

process.on('message', (msg: HostMessage) => {
  try {
    switch (msg.type) {
      case 'run':
        return controller.start(msg.runId, msg.collection, msg.options);
      case 'abort':
        return controller.abort(msg.runId);
      case 'shutdown':
        return process.exit(0);
    }
  } catch (e: any) {
    send({ type: 'fatal', message: e?.message ?? String(e), stack: e?.stack });
  }
});

process.on('uncaughtException', (e: any) => {
  send({ type: 'fatal', message: e?.message ?? String(e), stack: e?.stack });
});

send({ type: 'ready', pid: process.pid });
