import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { CollectionStore, EnvironmentEntry } from '../collections/store';

export const ENV_VIEW_TYPE = 'restclient.environment';

export interface EnvVariableView {
  key: string;
  /** Always empty for secrets — never send a stored secret to the webview. */
  value: string;
  type: string;
  enabled: boolean;
  /** True when the OS keychain already holds a value for this secret. */
  hasStoredSecret: boolean;
  /** True when the secret is still sitting in the file as plaintext. */
  plaintextInFile: boolean;
}

export type ToEnvWebview =
  | { type: 'init'; name: string; file: string; variables: EnvVariableView[] }
  | { type: 'saved' }
  | { type: 'saveFailed'; message: string };

export type FromEnvWebview =
  | { type: 'ready' }
  | {
      type: 'save';
      variables: Array<{ key: string; value?: string; type: string; enabled: boolean }>;
    }
  | { type: 'moveSecret'; key: string }
  | { type: 'revealInFile' };

function nonce(): string {
  return randomBytes(16).toString('base64');
}

export class EnvironmentPanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, EnvironmentPanel>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: CollectionStore
  ) {
    store.onDidChange(() => {
      for (const [id, panel] of this.panels) {
        // The file may have been deleted while its editor was open.
        if (!store.environment(id)) { panel.dispose(); }
        else { void panel.refresh(); }
      }
    });
  }

  open(entry: EnvironmentEntry): EnvironmentPanel {
    const existing = this.panels.get(entry.id);
    if (existing) {
      existing.reveal();
      return existing;
    }
    const panel = new EnvironmentPanel(this.context, this.store, entry.id, () =>
      this.panels.delete(entry.id)
    );
    this.panels.set(entry.id, panel);
    return panel;
  }

  dispose(): void {
    for (const panel of this.panels.values()) { panel.dispose(); }
    this.panels.clear();
  }
}

export class EnvironmentPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  /** `refresh` awaits the keychain, so the panel can go away mid-flight. */
  private disposed = false;

  private markReady!: () => void;
  readonly whenReady = new Promise<void>((resolve) => { this.markReady = resolve; });

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: CollectionStore,
    private readonly environmentId: string,
    private readonly onDisposed: () => void
  ) {
    const entry = this.entry();
    this.panel = vscode.window.createWebviewPanel(
      ENV_VIEW_TYPE,
      entry ? `Env: ${entry.name}` : 'Environment',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')]
      }
    );
    this.panel.iconPath = new vscode.ThemeIcon('globe');
    this.panel.webview.html = this.html();

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: FromEnvWebview) => void this.onMessage(msg)),
      this.panel.onDidDispose(() => this.dispose())
    );
  }

  private entry(): EnvironmentEntry | undefined {
    return this.store.environment(this.environmentId);
  }

  reveal(): void {
    this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active);
  }

  async refresh(): Promise<void> {
    const entry = this.entry();
    if (!entry) { return; }
    this.panel.title = `Env: ${entry.name}`;
    // Ask the keychain rather than assuming: a secret can be marked in the file
    // and have nothing stored, which is exactly what the UI needs to point out.
    const stored = await this.store.storedSecretKeys(entry.id);
    if (this.disposed) { return; }
    void this.panel.webview.postMessage({
      type: 'init',
      name: entry.name,
      file: vscode.workspace.asRelativePath(entry.uri),
      variables: (entry.json.values ?? []).map((v: any) => {
        const secret = v?.type === 'secret';
        const raw = typeof v?.value === 'string' ? v.value : '';
        return {
          key: String(v?.key ?? ''),
          value: secret ? '' : String(v?.value ?? ''),
          type: String(v?.type ?? 'default'),
          enabled: v?.enabled !== false,
          hasStoredSecret: secret && stored.has(String(v?.key ?? '')),
          plaintextInFile: secret && raw !== ''
        };
      })
    } satisfies ToEnvWebview);
  }

  private async onMessage(msg: FromEnvWebview): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.markReady();
        return this.refresh();

      case 'moveSecret': {
        const entry = this.entry();
        if (!entry) { return; }
        try {
          await this.store.moveSecretToKeychain(entry.id, msg.key);
          void this.panel.webview.postMessage({ type: 'saved' } satisfies ToEnvWebview);
        } catch (e: any) {
          void this.panel.webview.postMessage({
            type: 'saveFailed',
            message: e?.message ?? String(e)
          } satisfies ToEnvWebview);
        }
        return;
      }

      case 'revealInFile': {
        const entry = this.entry();
        if (!entry) { return; }
        const doc = await vscode.workspace.openTextDocument(entry.uri);
        await vscode.window.showTextDocument(doc, { preview: false });
        return;
      }

      case 'save': {
        const entry = this.entry();
        if (!entry) { return; }
        try {
          await this.store.editEnvironment(entry.uri, msg.variables);
          void this.panel.webview.postMessage({ type: 'saved' } satisfies ToEnvWebview);
        } catch (e: any) {
          void this.panel.webview.postMessage({
            type: 'saveFailed',
            message: e?.message ?? String(e)
          } satisfies ToEnvWebview);
        }
        return;
      }
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const base = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(base, 'environment.js'));
    const styles = webview.asWebviewUri(vscode.Uri.joinPath(base, 'environment.css'));
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
<title>Environment</title>
</head>
<body>
<div id="app"></div>
<script nonce="${n}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose();
    this.onDisposed();
  }
}
