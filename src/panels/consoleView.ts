import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { ObservedMessage, RunService } from '../runner/runService';

export const CONSOLE_VIEW_ID = 'restclient.console';

export interface ConsoleEntry {
  id: number;
  kind: 'request' | 'log' | 'error';
  time: string;
  collection: string;
  item?: string;
  /** For `request`: "GET https://…". For logs: the message. */
  title: string;
  level?: string;
  status?: number;
  statusText?: string;
  durationMs?: number;
  sizeBytes?: number;
  detail?: {
    requestHeaders?: Array<{ key: string; value: string }>;
    requestBody?: string;
    responseHeaders?: Array<{ key: string; value: string }>;
    responseBody?: string;
  };
}

export type ToConsole =
  | { type: 'entries'; entries: ConsoleEntry[] }
  | { type: 'append'; entries: ConsoleEntry[] }
  | { type: 'cleared' };

export type FromConsole = { type: 'ready' } | { type: 'clear' };

/** Keep memory bounded — a long-running collection can log a great deal. */
const MAX_ENTRIES = 500;

function nonce(): string {
  return randomBytes(16).toString('base64');
}

function decode(base64: string, limit = 8000): string {
  const text = Buffer.from(base64, 'base64').toString('utf8');
  return text.length > limit ? `${text.slice(0, limit)}\n… truncated` : text;
}

/**
 * The Postman Console, as a bottom-panel view next to Terminal and Problems.
 *
 * It shows every HTTP call a run makes — including nested `pm.sendRequest`
 * ones that never appear in the response pane — plus script `console.log`
 * output and uncaught script errors.
 */
export class ConsoleViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private entries: ConsoleEntry[] = [];
  private queued: ConsoleEntry[] = [];
  private seq = 0;
  private readonly disposables: vscode.Disposable[] = [];

  private markReady!: () => void;
  /** Settles once the console webview has run and posted back. */
  readonly whenReady = new Promise<void>((resolve) => { this.markReady = resolve; });

  constructor(
    private readonly extensionUri: vscode.Uri,
    runService: RunService
  ) {
    this.disposables.push(runService.onDidObserve((observed) => this.observe(observed)));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')]
    };
    view.webview.html = this.html(view.webview);

    this.disposables.push(
      view.webview.onDidReceiveMessage((msg: FromConsole) => {
        if (msg.type === 'ready') {
          this.markReady();
          this.post({ type: 'entries', entries: this.entries });
        }
        if (msg.type === 'clear') {
          this.entries = [];
          this.post({ type: 'cleared' });
        }
      }),
      view.onDidChangeVisibility(() => {
        // Messages cannot reach a hidden webview, so flush what piled up.
        if (view.visible && this.queued.length) {
          this.post({ type: 'append', entries: this.queued });
          this.queued = [];
        }
      })
    );
  }

  private post(msg: ToConsole): void {
    void this.view?.webview.postMessage(msg);
  }

  private add(entry: Omit<ConsoleEntry, 'id' | 'time'>): void {
    const full: ConsoleEntry = {
      ...entry,
      id: ++this.seq,
      time: new Date().toISOString().slice(11, 23)
    };

    this.entries.push(full);
    if (this.entries.length > MAX_ENTRIES) { this.entries = this.entries.slice(-MAX_ENTRIES); }

    if (this.view?.visible) { this.post({ type: 'append', entries: [full] }); }
    else { this.queued.push(full); }
  }

  private observe({ message, collectionName, itemName }: ObservedMessage): void {
    switch (message.type) {
      case 'httpTraffic': {
        const { request, response, error } = message;
        this.add({
          kind: error ? 'error' : 'request',
          collection: collectionName,
          item: itemName,
          title: `${request.method} ${request.url}`,
          status: response?.code,
          statusText: error ?? response?.status,
          durationMs: response?.responseTime,
          sizeBytes: response?.responseSize,
          detail: {
            requestHeaders: request.headers,
            requestBody: request.body,
            responseHeaders: response?.headers,
            responseBody: response ? decode(response.bodyBase64) : undefined
          }
        });
        return;
      }

      case 'console':
        this.add({
          kind: 'log',
          level: message.level,
          collection: collectionName,
          item: itemName,
          title: message.messages.join(' ')
        });
        return;

      case 'exception':
        this.add({
          kind: 'error',
          collection: collectionName,
          item: itemName,
          title: message.message,
          detail: message.stack ? { responseBody: message.stack } : undefined
        });
        return;

      case 'requestError':
        this.add({
          kind: 'error',
          collection: collectionName,
          item: itemName,
          title: message.message
        });
        return;
    }
  }

  clear(): void {
    this.entries = [];
    this.queued = [];
    this.post({ type: 'cleared' });
  }

  /** Entry count, for tests and the view badge. */
  get size(): number {
    return this.entries.length;
  }

  private html(webview: vscode.Webview): string {
    const base = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(base, 'console.js'));
    const styles = webview.asWebviewUri(vscode.Uri.joinPath(base, 'console.css'));
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
<title>Postman Console</title>
</head>
<body>
<div id="app"></div>
<script nonce="${n}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
