import * as vscode from 'vscode';
import type { SerializedCookieJar } from './protocol';

const FILE = 'cookies.json';

/** One cookie as the UI edits it. */
export interface StoredCookie {
  key: string;
  value: string;
  domain: string;
  path: string;
  /** ISO date, or 'Infinity' for a session cookie. */
  expires?: string;
  maxAge?: number;
  hostOnly?: boolean;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

/**
 * The shape `@postman/tough-cookie` produces from `serializeSync()` and accepts
 * in `CookieJar.deserializeSync()`.
 */
function emptyJar(): SerializedCookieJar {
  return {
    version: 'tough-cookie@4.0.0',
    storeType: 'MemoryCookieStore',
    rejectPublicSuffixes: true,
    cookies: []
  };
}

/**
 * Persists the cookie jar between runs and between sessions, and backs the
 * cookie manager UI.
 *
 * Kept in the extension's global storage rather than the workspace: cookies are
 * session credentials, not project configuration, and must never end up in a
 * commit. They are shared across workspaces the same way a browser profile is.
 *
 * The jar is manipulated as plain JSON rather than through a live CookieJar.
 * The serialized form is the contract with the runner, and going through
 * tough-cookie here would add a dependency edge on a package we only ship
 * transitively.
 */
export class CookieStore {
  private cache: SerializedCookieJar | undefined;
  private loaded = false;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly storageUri: vscode.Uri,
    private readonly log: vscode.LogOutputChannel
  ) {}

  private get file(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri, FILE);
  }

  async load(): Promise<SerializedCookieJar | undefined> {
    if (this.loaded) { return this.cache; }
    this.loaded = true;
    try {
      const bytes = await vscode.workspace.fs.readFile(this.file);
      this.cache = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
      this.cache = undefined; // no cookies stored yet
    }
    return this.cache;
  }

  async save(jar: SerializedCookieJar): Promise<void> {
    this.cache = jar;
    this.loaded = true;
    try {
      await vscode.workspace.fs.createDirectory(this.storageUri);
      await vscode.workspace.fs.writeFile(this.file, Buffer.from(JSON.stringify(jar), 'utf8'));
    } catch (e: any) {
      // Losing cookies is recoverable; failing the run over it is not worth it.
      this.log.warn(`Could not persist cookies: ${e?.message ?? e}`);
    }
    this._onDidChange.fire();
  }

  /** Number of cookies currently stored, for the UI. */
  count(): number {
    return this.list().length;
  }

  list(): StoredCookie[] {
    const cookies = (this.cache as any)?.cookies;
    if (!Array.isArray(cookies)) { return []; }
    return cookies.map((c: any) => ({
      key: String(c.key ?? ''),
      value: String(c.value ?? ''),
      domain: String(c.domain ?? ''),
      path: String(c.path ?? '/'),
      expires: c.expires ? String(c.expires) : undefined,
      maxAge: typeof c.maxAge === 'number' ? c.maxAge : undefined,
      hostOnly: c.hostOnly,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite
    }));
  }

  /** Cookies grouped by domain, each group sorted by name. */
  byDomain(): Array<{ domain: string; cookies: StoredCookie[] }> {
    const groups = new Map<string, StoredCookie[]>();
    for (const cookie of this.list()) {
      const list = groups.get(cookie.domain) ?? [];
      list.push(cookie);
      groups.set(cookie.domain, list);
    }
    return [...groups.entries()]
      .map(([domain, cookies]) => ({
        domain,
        cookies: cookies.sort((a, b) => a.key.localeCompare(b.key))
      }))
      .sort((a, b) => a.domain.localeCompare(b.domain));
  }

  /** A cookie is identified by the triple tough-cookie uses as its key. */
  private static same(a: StoredCookie, domain: string, path: string, key: string): boolean {
    return a.domain === domain && a.path === path && a.key === key;
  }

  private async mutate(fn: (cookies: any[]) => any[]): Promise<void> {
    await this.load();
    const jar = (this.cache as any) ?? emptyJar();
    const cookies = Array.isArray(jar.cookies) ? jar.cookies : [];
    await this.save({ ...jar, cookies: fn(cookies) });
  }

  /**
   * Add or replace a cookie.
   *
   * `creation` is preserved on an update so ordering stays stable; tough-cookie
   * sorts by path length then creation time when building a Cookie header.
   */
  async upsert(cookie: StoredCookie, original?: { domain: string; path: string; key: string }): Promise<void> {
    const target = original ?? { domain: cookie.domain, path: cookie.path, key: cookie.key };

    await this.mutate((cookies) => {
      const now = new Date().toISOString();
      const existing = cookies.find((c: any) =>
        CookieStore.same(
          { ...c, key: String(c.key ?? ''), domain: String(c.domain ?? ''), path: String(c.path ?? '/') } as StoredCookie,
          target.domain,
          target.path,
          target.key
        )
      );

      const next: Record<string, unknown> = {
        key: cookie.key,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        creation: existing?.creation ?? now,
        lastAccessed: now
      };
      if (cookie.expires) { next.expires = cookie.expires; }
      if (typeof cookie.maxAge === 'number' && !Number.isNaN(cookie.maxAge)) { next.maxAge = cookie.maxAge; }
      if (cookie.hostOnly !== undefined) { next.hostOnly = cookie.hostOnly; }
      if (cookie.httpOnly) { next.httpOnly = true; }
      if (cookie.secure) { next.secure = true; }
      if (cookie.sameSite) { next.sameSite = cookie.sameSite; }

      const without = cookies.filter((c: any) => c !== existing);
      return [...without, next];
    });
  }

  async remove(domain: string, path: string, key: string): Promise<void> {
    await this.mutate((cookies) =>
      cookies.filter(
        (c: any) =>
          !(String(c.domain ?? '') === domain && String(c.path ?? '/') === path && String(c.key ?? '') === key)
      )
    );
  }

  /** Drop every cookie for one domain, leaving the rest of the jar intact. */
  async removeDomain(domain: string): Promise<void> {
    await this.mutate((cookies) => cookies.filter((c: any) => String(c.domain ?? '') !== domain));
  }

  async clear(): Promise<void> {
    this.loaded = true;
    await this.save(emptyJar());
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
