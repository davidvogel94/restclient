import * as vscode from 'vscode';
import type { CookieStore, StoredCookie } from '../runner/cookieStore';

/**
 * The Cookies view.
 *
 * The jar is state that decides whether a request is authorised, so it belongs
 * next to the other things a run resolves against rather than behind a menu
 * item two panes away. Domains are the rows that matter — "am I still logged
 * in to this host" — with the cookies themselves underneath, the same shape the
 * Environments pane uses for its variables.
 *
 * Editing anything beyond a value — the path, the flags, the expiry — stays in
 * the cookie manager panel, which has room for a form.
 */

export type CookieTreeNode =
  | { kind: 'domain'; domain: string; cookies: StoredCookie[] }
  | { kind: 'cookie'; domain: string; cookie: StoredCookie };

/** Long values are unreadable in a tree row and hide the start of the value. */
const MAX_VALUE = 40;

function summarize(value: string): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length > MAX_VALUE ? `${single.slice(0, MAX_VALUE - 1)}…` : single;
}

/** Session cookies have no expiry; tough-cookie writes 'Infinity'. */
export function expiryLabel(cookie: StoredCookie): string {
  if (cookie.maxAge !== undefined) { return `max-age ${cookie.maxAge}s`; }
  if (!cookie.expires || cookie.expires === 'Infinity') { return 'session'; }
  const date = new Date(cookie.expires);
  return Number.isNaN(date.getTime()) ? cookie.expires : date.toLocaleString();
}

/**
 * Whether the jar would refuse to send this cookie.
 *
 * A cookie past its expiry is dropped on the next request that would have used
 * it, so showing it as live is a lie the user only finds out about through a
 * 401. `maxAge` is relative to when the cookie was set, which the serialized
 * form does not carry, so those are left alone.
 */
export function isExpired(cookie: StoredCookie, now = Date.now()): boolean {
  if (cookie.maxAge !== undefined) { return false; }
  if (!cookie.expires || cookie.expires === 'Infinity') { return false; }
  const at = new Date(cookie.expires).getTime();
  return !Number.isNaN(at) && at <= now;
}

/**
 * Stable identities for the rows, so the tree can be told to reveal one.
 *
 * `getChildren` rebuilds its nodes on every refresh; the id is what lets VS
 * Code recognise a rebuilt row as the one it already has open. A cookie is
 * identified by the domain/path/key triple tough-cookie keys its store on.
 */
function domainRowId(domain: string): string {
  return `cookieDomain:${domain}`;
}

function cookieRowId(cookie: StoredCookie): string {
  return `cookie:${cookie.domain}:${cookie.path}:${cookie.key}`;
}

export class CookieTreeProvider implements vscode.TreeDataProvider<CookieTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<CookieTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly cookies: CookieStore) {
    // A run that sets a cookie should show up here without a manual refresh.
    cookies.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: CookieTreeNode): vscode.TreeItem {
    return element.kind === 'domain' ? this.domainItem(element) : this.cookieItem(element);
  }

  private domainItem(element: CookieTreeNode & { kind: 'domain' }): vscode.TreeItem {
    const count = element.cookies.length;
    const item = new vscode.TreeItem(element.domain, vscode.TreeItemCollapsibleState.Expanded);
    item.id = domainRowId(element.domain);
    item.contextValue = 'cookieDomain';
    item.iconPath = new vscode.ThemeIcon('globe');
    item.description = `${count} cookie${count === 1 ? '' : 's'}`;
    item.tooltip = new vscode.MarkdownString(
      `**${element.domain}**\n\n` +
        element.cookies
          .map((c) => `- \`${c.key}\` — ${c.path} · ${expiryLabel(c)}`)
          .join('\n')
    );
    return item;
  }

  private cookieItem(element: CookieTreeNode & { kind: 'cookie' }): vscode.TreeItem {
    const { cookie } = element;
    const expired = isExpired(cookie);

    const item = new vscode.TreeItem(cookie.key, vscode.TreeItemCollapsibleState.None);
    item.id = cookieRowId(cookie);
    item.contextValue = 'cookie';
    item.iconPath = expired
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'))
      : new vscode.ThemeIcon('symbol-key');

    // The path only earns room in the row when it narrows what the cookie
    // applies to; almost every cookie is on '/'.
    const parts = [summarize(cookie.value) || '(empty)'];
    if (cookie.path && cookie.path !== '/') { parts.push(cookie.path); }
    if (expired) { parts.push('expired'); }
    item.description = parts.join(' · ');

    const flags = [
      cookie.httpOnly ? 'HttpOnly' : undefined,
      cookie.secure ? 'Secure' : undefined,
      cookie.sameSite ? `SameSite=${cookie.sameSite}` : undefined
    ].filter(Boolean);

    item.tooltip = new vscode.MarkdownString(
      `\`${cookie.key}\` — ${cookie.domain}${cookie.path}\n\n` +
        `\`\`\`\n${cookie.value || '(empty)'}\n\`\`\`\n\n` +
        `Expires: ${expiryLabel(cookie)}${expired ? ' — expired, and will not be sent' : ''}` +
        (flags.length ? `\n\n${flags.join(' · ')}` : '')
    );

    item.command = {
      command: 'restclient.editCookie',
      title: 'Edit Cookie Value',
      arguments: [element]
    };
    return item;
  }

  /** Required for `reveal`: a cookie row only exists once its domain is expanded. */
  getParent(element: CookieTreeNode): CookieTreeNode | undefined {
    if (element.kind !== 'cookie') { return undefined; }
    return this.domainNode(element.domain);
  }

  /** The row for one domain, exactly as `getChildren` builds it. */
  domainNode(domain: string): CookieTreeNode | undefined {
    const group = this.cookies.byDomain().find((g) => g.domain === domain);
    return group ? { kind: 'domain', domain: group.domain, cookies: group.cookies } : undefined;
  }

  async getChildren(element?: CookieTreeNode): Promise<CookieTreeNode[]> {
    if (!element) {
      // The jar is read from global storage lazily; the pane is often what
      // first asks for it.
      await this.cookies.load();
      return this.cookies
        .byDomain()
        .map((group) => ({ kind: 'domain' as const, domain: group.domain, cookies: group.cookies }));
    }
    if (element.kind !== 'domain') { return []; }
    return element.cookies.map((cookie) => ({
      kind: 'cookie' as const,
      domain: element.domain,
      cookie
    }));
  }
}
