import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { CookieStore, StoredCookie } from '../runner/cookieStore';

export const COOKIE_VIEW_TYPE = 'restclient.cookies';

export interface CookieDomainGroup {
  domain: string;
  cookies: StoredCookie[];
}

export type ToCookieWebview =
  | { type: 'cookies'; groups: CookieDomainGroup[] }
  | { type: 'error'; message: string };

export type FromCookieWebview =
  | { type: 'ready' }
  | { type: 'save'; cookie: StoredCookie; original?: { domain: string; path: string; key: string } }
  | { type: 'delete'; domain: string; path: string; key: string }
  | { type: 'deleteDomain'; domain: string }
  | { type: 'clearAll' };

function nonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * The cookie manager: view, edit, add and remove cookies in the jar that
 * requests actually use.
 *
 * Postman keeps this behind a "Cookies" link next to the send button; here it is
 * a tab, reachable from the response pane and the command palette.
 */
export class CookiePanel implements vscode.Disposable {
  private static current: CookiePanel | undefined;

  static show(extensionUri: vscode.Uri, cookies: CookieStore): CookiePanel {
    if (CookiePanel.current) {
      CookiePanel.current.panel.reveal();
      void CookiePanel.current.refresh();
      return CookiePanel.current;
    }
    CookiePanel.current = new CookiePanel(extensionUri, cookies);
    return CookiePanel.current;
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private markReady!: () => void;
  readonly whenReady = new Promise<void>((resolve) => { this.markReady = resolve; });

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly cookies: CookieStore
  ) {
    this.panel = vscode.window.createWebviewPanel(
      COOKIE_VIEW_TYPE,
      'Cookies',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')]
      }
    );
    this.panel.iconPath = new vscode.ThemeIcon('symbol-key');
    this.panel.webview.html = this.html();

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: FromCookieWebview) => void this.onMessage(msg)),
      // A run that sets cookies should show up here without a manual refresh.
      this.cookies.onDidChange(() => void this.refresh()),
      this.panel.onDidDispose(() => this.dispose())
    );
  }

  async refresh(): Promise<void> {
    await this.cookies.load();
    void this.panel.webview.postMessage({
      type: 'cookies',
      groups: this.cookies.byDomain()
    } satisfies ToCookieWebview);
  }

  private async onMessage(msg: FromCookieWebview): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          this.markReady();
          return this.refresh();

        case 'save':
          if (!msg.cookie.key.trim() || !msg.cookie.domain.trim()) {
            void this.panel.webview.postMessage({
              type: 'error',
              message: 'A cookie needs both a name and a domain.'
            } satisfies ToCookieWebview);
            return;
          }
          await this.cookies.upsert(msg.cookie, msg.original);
          return this.refresh();

        case 'delete':
          await this.cookies.remove(msg.domain, msg.path, msg.key);
          return this.refresh();

        case 'deleteDomain':
          await this.cookies.removeDomain(msg.domain);
          return this.refresh();

        case 'clearAll':
          await this.cookies.clear();
          return this.refresh();
      }
    } catch (e: any) {
      void this.panel.webview.postMessage({
        type: 'error',
        message: e?.message ?? String(e)
      } satisfies ToCookieWebview);
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const base = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(base, 'cookies.js'));
    const styles = webview.asWebviewUri(vscode.Uri.joinPath(base, 'cookies.css'));
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(base, 'codicons', 'codicon.css'));
    const n = nonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; script-src 'nonce-${n}'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; connect-src 'none';">
<link rel="stylesheet" href="${codicons}">
<link rel="stylesheet" href="${styles}">
<title>Cookies</title>
</head>
<body>
<div id="app"></div>
<script nonce="${n}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (CookiePanel.current === this) { CookiePanel.current = undefined; }
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose();
  }
}
