import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { buildRequestView, kv } from '../collections/view';
import { AUTH_FIELDS, AUTH_TYPES, buildRequestEdits } from '../collections/edits';
import type { CollectionEntry, CollectionStore } from '../collections/store';
import type { ItemNode } from '../collections/model';
import type { RunService } from '../runner/runService';
import type { RunHandle } from '../runner/client';
import type { ConsoleLine, EnvironmentSummary, FromWebview, ToWebview } from './protocol';
import { ResponseCache, type CachedResponse } from './responseCache';
import { VisualizerPanel } from './visualizerPanel';

export const VIEW_TYPE = 'restclient.request';

function nonce(): string {
  return randomBytes(16).toString('base64');
}

export class RequestPanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, RequestPanel>();
  /**
   * Survives panel disposal so closing and reopening a request keeps its last
   * response. In memory only — see ResponseCache.
   */
  private readonly responses = new ResponseCache();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: CollectionStore,
    private readonly runService: RunService,
    private readonly activeEnvironmentId: () => string | undefined
  ) {
    store.onDidChange(() => {
      for (const panel of this.panels.values()) { void panel.refresh(); }
    });
  }

  private key(entry: CollectionEntry, node: ItemNode): string {
    return `${entry.uri.toString()}::${node.id}`;
  }

  open(entry: CollectionEntry, node: ItemNode): RequestPanel {
    const key = this.key(entry, node);
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      return existing;
    }

    const panel = new RequestPanel(
      this.context,
      this.store,
      this.runService,
      this.activeEnvironmentId,
      entry.uri,
      node.id,
      this.responses,
      key,
      () => this.panels.delete(key)
    );
    this.panels.set(key, panel);
    return panel;
  }

  /** Push a fresh environment list into every open panel. */
  environmentsChanged(): void {
    for (const panel of this.panels.values()) { void panel.pushEnvironments(); }
  }

  /** Drop every cached response. Nothing was persisted, so this is the lot. */
  clearResponses(): void {
    this.responses.clear();
  }

  dispose(): void {
    for (const panel of this.panels.values()) { panel.dispose(); }
    this.panels.clear();
    this.responses.clear();
  }
}

export class RequestPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private running: RunHandle | undefined;
  private consoleBuffer: ConsoleLine[] = [];
  private current: CachedResponse | undefined;
  /** `refresh` awaits the keychain, so the panel can go away mid-flight. */
  private disposed = false;

  private markReady!: () => void;
  /**
   * Resolves when the webview has posted `ready`, which only happens once the
   * bundle has actually executed — so awaiting it proves the script loaded past
   * the CSP and the UI mounted.
   */
  readonly whenReady = new Promise<void>((resolve) => { this.markReady = resolve; });

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: CollectionStore,
    private readonly runService: RunService,
    private readonly activeEnvironmentId: () => string | undefined,
    private readonly collectionUri: vscode.Uri,
    private readonly itemId: string,
    private readonly responses: ResponseCache,
    private readonly cacheKey: string,
    private readonly onDisposed: () => void
  ) {
    const node = this.node();
    this.panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      node ? `${node.method ?? ''} ${node.name}`.trim() : 'Request',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // The editor holds unsent state and a mounted editor component, which is
        // not cheap to rebuild — but messages still cannot reach it while hidden,
        // so sends are queued and flushed on visibility.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')]
      }
    );
    this.panel.iconPath = new vscode.ThemeIcon('arrow-right');
    this.panel.webview.html = this.html();

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: FromWebview) => void this.onMessage(msg)),
      this.panel.onDidDispose(() => this.dispose())
    );
  }

  private entry(): CollectionEntry | undefined {
    return this.store.collection(this.collectionUri);
  }

  private node(): ItemNode | undefined {
    return this.entry()?.materialized.index.get(this.itemId);
  }

  reveal(): void {
    this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active);
  }

  private post(msg: ToWebview): void {
    if (this.disposed) { return; }
    void this.panel.webview.postMessage(msg);
  }

  private async environments(): Promise<EnvironmentSummary[]> {
    const activeId = this.activeEnvironmentId();
    return Promise.all(
      this.store.environments.map(async (e) => {
        // Only the active environment's keychain is probed: the inline editor
        // only ever shows that one, and a lookup per environment per refresh
        // would hit the OS keychain far too often.
        const stored = e.id === activeId ? await this.store.storedSecretKeys(e.id) : new Set<string>();
        return {
          id: e.id,
          name: e.name,
          active: e.id === activeId,
          variables: (e.json.values ?? []).map((v: any) => ({
            key: String(v?.key ?? ''),
            value: v?.type === 'secret' ? '' : String(v?.value ?? ''),
            type: String(v?.type ?? 'default'),
            enabled: v?.enabled !== false,
            secret: v?.type === 'secret',
            hasStoredSecret: v?.type === 'secret' && stored.has(String(v?.key ?? '')),
            plaintextInFile: v?.type === 'secret' && typeof v?.value === 'string' && v.value !== ''
          }))
        };
      })
    );
  }

  async pushEnvironments(): Promise<void> {
    this.post({ type: 'environments', environments: await this.environments() });
  }

  async refresh(): Promise<void> {
    const entry = this.entry();
    const node = this.node();
    if (!entry || !node) { return; }
    const view = buildRequestView(entry.materialized.json, entry.name, node);
    if (!view) { return; }
    this.panel.title = `${view.method} ${view.name}`;
    this.post({
      type: 'init',
      request: view,
      environments: await this.environments(),
      collectionVariables: kv(entry.materialized.json.variable),
      scriptsAllowed: this.runService.scriptsAllowed,
      authTypes: AUTH_TYPES,
      authFields: AUTH_FIELDS
    });
  }

  private async onMessage(msg: FromWebview): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.markReady();
        await this.refresh();
        // A reopened editor should still show what came back last time.
        this.replay(this.current ?? this.responses.get(this.cacheKey));
        return;

      case 'selectEnvironment':
        await vscode.commands.executeCommand('restclient.selectEnvironment', msg.environmentId);
        return;

      case 'revealInFile': {
        const doc = await vscode.workspace.openTextDocument(this.collectionUri);
        await vscode.window.showTextDocument(doc, { preview: false });
        return;
      }

      case 'cancel':
        this.running?.abort();
        return;

      case 'manageCookies':
        await vscode.commands.executeCommand('restclient.manageCookies');
        return;

      case 'update':
        return this.applyUpdate(msg.update);

      case 'setVariable':
        return this.setVariable(msg.scope, msg.key, msg.value);

      case 'moveSecretToKeychain':
        return this.moveSecret(msg.key);

      case 'editEnvironment':
        await vscode.commands.executeCommand('restclient.editEnvironment');
        return;

      case 'send':
        return this.send();
    }
  }

  /**
   * Persist one variable edit from the inline popover.
   *
   * Nothing needs pushing back: the store reloads after every write, which
   * fires `onDidChange` and pushes a fresh environment list into every panel.
   */
  private async setVariable(
    scope: 'environment' | 'collection',
    key: string,
    value: string
  ): Promise<void> {
    try {
      if (scope === 'collection') {
        await this.store.setCollectionVariable(this.collectionUri, key, value);
      } else {
        const id = this.activeEnvironmentId();
        if (!id) { throw new Error('Select an environment before setting a variable.'); }
        await this.store.setEnvironmentVariable(id, key, value);
      }
      this.post({ type: 'saved' });
    } catch (e: any) {
      this.post({ type: 'saveFailed', message: e?.message ?? String(e) });
    }
  }

  /**
   * Push a remembered result back into a freshly mounted webview.
   *
   * The same messages a live run produces, so the webview needs no notion of
   * whether a response is new or restored.
   */
  private replay(cached: CachedResponse | undefined): void {
    if (!cached) { return; }
    if (cached.request && cached.response) {
      this.post({ type: 'response', request: cached.request, response: cached.response });
    } else if (cached.request) {
      this.post({ type: 'sent', request: cached.request });
    }
    if (cached.assertions.length) { this.post({ type: 'assertions', assertions: cached.assertions }); }
    if (cached.console.length) { this.post({ type: 'console', lines: cached.console }); }
    if (cached.visualizerHtml) { this.post({ type: 'visualizer', html: cached.visualizerHtml }); }
    if (cached.failure) { this.post({ type: 'runFailed', message: cached.failure }); }
  }

  /** Move one plaintext secret out of the environment file, on request. */
  private async moveSecret(key: string): Promise<void> {
    try {
      const id = this.activeEnvironmentId();
      if (!id) { throw new Error('No environment is selected.'); }
      await this.store.moveSecretToKeychain(id, key);
      this.post({ type: 'saved' });
    } catch (e: any) {
      this.post({ type: 'saveFailed', message: e?.message ?? String(e) });
    }
  }

  /** Persist one field change from the editor into the collection file. */
  private async applyUpdate(update: Parameters<typeof buildRequestEdits>[2]): Promise<void> {
    const entry = this.entry();
    const node = this.node();
    if (!entry || !node) { return; }

    // Navigate the on-disk JSON by index path so unmodelled sibling keys survive.
    let raw: any = entry.materialized.json;
    for (const segment of node.jsonPath) { raw = raw?.[segment as any]; }
    if (!raw) { return; }

    try {
      await this.store.editCollection(entry.uri, buildRequestEdits(node.jsonPath, raw, update));
      this.post({ type: 'saved' });
    } catch (e: any) {
      this.post({ type: 'saveFailed', message: e?.message ?? String(e) });
    }
  }

  /** Test seam: run this request as if Send had been pressed in the webview. */
  sendForTest(): Promise<void> {
    return this.send();
  }

  /** Test seam: what a freshly reopened panel would replay, if anything. */
  restoredForTest(): CachedResponse | undefined {
    return this.current ?? this.responses.get(this.cacheKey);
  }

  private async send(): Promise<void> {
    if (this.running) { return; }
    const entry = this.entry();
    if (!entry) { return; }

    this.consoleBuffer = [];
    // Rebuilt as the run progresses, then remembered so reopening the editor
    // shows the same thing. Never leaves memory.
    const result: CachedResponse = { assertions: [], console: [] };
    this.current = result;
    this.post({ type: 'runStarted' });

    try {
      const handle = await this.runService.start({ entry, itemId: this.itemId }, (m) => {
        switch (m.type) {
          case 'beforeRequest':
            result.request = m.request;
            return this.post({ type: 'sent', request: m.request });
          case 'response':
            result.request = m.request;
            result.response = m.response;
            return this.post({ type: 'response', request: m.request, response: m.response });
          case 'requestError':
            result.failure = m.message;
            return this.post({ type: 'runFailed', message: m.message });
          case 'assertion':
            result.assertions.push(...m.assertions);
            return this.post({ type: 'assertions', assertions: m.assertions });
          case 'visualizer':
            // Rendered in its own webview: the template is arbitrary author HTML
            // and needs inline scripts, which this panel's CSP must keep denying.
            result.visualizerHtml = m.html;
            VisualizerPanel.show(this.node()?.name ?? 'Response', m.html);
            return this.post({ type: 'visualizer', html: m.html });
          case 'console':
            this.consoleBuffer.push({ level: m.level, message: m.messages.join(' ') });
            result.console = [...this.consoleBuffer];
            return this.post({ type: 'console', lines: this.consoleBuffer });
          case 'exception':
            this.consoleBuffer.push({ level: 'error', message: m.message });
            result.console = [...this.consoleBuffer];
            return this.post({ type: 'console', lines: this.consoleBuffer });
        }
      });

      this.running = handle;
      await handle.completion;
    } catch (e: any) {
      const message = e?.message ?? String(e);
      result.failure = message;
      this.post({ type: 'runFailed', message });
    } finally {
      this.running = undefined;
      this.responses.set(this.cacheKey, result);
      this.post({ type: 'runFinished' });
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const base = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(base, 'request.js'));
    const styles = webview.asWebviewUri(vscode.Uri.joinPath(base, 'request.css'));
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(base, 'codicons', 'codicon.css'));
    const n = nonce();

    // connect-src 'none': the webview never makes network calls. Every request
    // goes through the runner process, which is the only way proxy, client
    // certificate and cookie handling can be correct.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; script-src 'nonce-${n}'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; connect-src 'none';">
<link rel="stylesheet" href="${codicons}">
<link rel="stylesheet" href="${styles}">
<title>Request</title>
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
    this.running?.abort();
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose();
    this.onDisposed();
  }
}
