import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildRequestView, kv } from '../collections/view';
import { AUTH_FIELDS, AUTH_TYPES, buildRequestEdits } from '../collections/edits';
import type { CollectionEntry, CollectionStore } from '../collections/store';
import type { ItemNode } from '../collections/model';
import { readSettingDefaults } from '../runner/networkSettings';
import type { RunService } from '../runner/runService';
import type { RunHandle } from '../runner/client';
import type {
  ConsoleLine,
  EnvironmentSummary,
  FromWebview,
  ResponseViewState,
  ToWebview
} from './protocol';
import type { CachedResponse } from './responseCache';
import type { RunResults } from './runResults';
import { responseFileName, responseHead, type SaveResponseKind } from './saveResponse';
import { VisualizerPanel } from './visualizerPanel';

export const VIEW_TYPE = 'restclient.request';

/** Where the last-used response tab and body view is kept between sessions. */
export const RESPONSE_VIEW_KEY = 'restclient.responseView';

/** What a first-ever editor opens on: the body, formatted and wrapped. */
export const DEFAULT_RESPONSE_VIEW: ResponseViewState = { tab: 'body', view: 'pretty', wrap: true };

/** Which request an editor tab is for, as the Collections pane identifies it. */
export interface RequestTab {
  uri: vscode.Uri;
  itemId: string;
}

function nonce(): string {
  return randomBytes(16).toString('base64');
}

export class RequestPanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, RequestPanel>();

  private readonly _onDidActivate = new vscode.EventEmitter<RequestTab>();
  /**
   * Fires when one of these tabs comes to the front, first opened included.
   *
   * The Collections pane listens: the row and the tab in front should be
   * describing the same request, whichever of the two the user moved.
   */
  readonly onDidActivate = this._onDidActivate.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: CollectionStore,
    private readonly runService: RunService,
    private readonly activeEnvironmentId: () => string | undefined,
    /** Where every run's result is filed, whoever started it. */
    private readonly results: RunResults
  ) {
    store.onDidChange(() => {
      for (const panel of this.panels.values()) { void panel.refresh(); }
    });
    // A folder run, or a quick-run from the overview, writes results for
    // requests this manager may have open. Those editors should show them.
    results.onDidChangeResults(() => {
      for (const panel of this.panels.values()) { panel.syncExternalResult(); }
    });
  }

  open(entry: CollectionEntry, node: ItemNode): RequestPanel {
    const key = this.results.key(entry.uri, node.id);
    const tab: RequestTab = { uri: entry.uri, itemId: node.id };
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      this._onDidActivate.fire(tab);
      return existing;
    }

    const panel = new RequestPanel(
      this.context,
      this.store,
      this.runService,
      this.activeEnvironmentId,
      entry.uri,
      node.id,
      this.results,
      key,
      () => this.panels.delete(key)
    );
    this.panels.set(key, panel);
    panel.onDidActivate(() => this._onDidActivate.fire(tab));
    // Fired for the tab just created as well: a panel is made in front of
    // whatever was there, and no view state *change* is reported for the state
    // a panel was born in.
    this._onDidActivate.fire(tab);
    return panel;
  }

  /** The request whose tab is in front, if one of them is. */
  activeTab(): RequestTab | undefined {
    for (const panel of this.panels.values()) {
      if (panel.isActive) { return panel.tab; }
    }
    return undefined;
  }

  /** Push a fresh environment list into every open panel. */
  environmentsChanged(): void {
    for (const panel of this.panels.values()) { void panel.pushEnvironments(); }
  }

  dispose(): void {
    for (const panel of this.panels.values()) { panel.dispose(); }
    this.panels.clear();
    this._onDidActivate.dispose();
  }
}

export class RequestPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private running: RunHandle | undefined;
  private consoleBuffer: ConsoleLine[] = [];
  private current: CachedResponse | undefined;
  /**
   * True from the moment Send is pressed until the result is filed.
   *
   * `running` only holds once the runner has handed back a handle, which leaves
   * a window in which this panel's own start looks, to `syncExternalResult`,
   * like somebody else's — and would replay the *previous* result over the run
   * just begun.
   */
  private sending = false;
  /** A run this panel did not start, so its end can be reported once. */
  private watchingExternal = false;
  /** `refresh` awaits the keychain, so the panel can go away mid-flight. */
  private disposed = false;

  private readonly _onDidActivate = new vscode.EventEmitter<void>();
  /** Fires whenever this tab becomes the front one. */
  readonly onDidActivate = this._onDidActivate.event;

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
    private readonly results: RunResults,
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
      this.panel.onDidChangeViewState((e) => { if (e.webviewPanel.active) { this._onDidActivate.fire(); } }),
      this.panel.onDidDispose(() => this.dispose()),
      this._onDidActivate
    );
  }

  /** Which request this tab is for. */
  get tab(): RequestTab {
    return { uri: this.collectionUri, itemId: this.itemId };
  }

  /**
   * Whether this is the tab in front.
   *
   * Guarded on `disposed`: a panel that has gone answers nothing, and one is
   * disposed a moment before its manager drops it.
   */
  get isActive(): boolean {
    return !this.disposed && this.panel.active;
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

  /**
   * The response view every editor opens on.
   *
   * Held per workspace rather than per request: it is a reading preference, and
   * one that reset itself whenever you opened a different request would be no
   * preference at all. Merged over the defaults so a state written by an older
   * version, or one hand-edited, cannot leave a field undefined.
   */
  private responseView(): ResponseViewState {
    const stored = this.context.workspaceState.get<Partial<ResponseViewState>>(RESPONSE_VIEW_KEY);
    return { ...DEFAULT_RESPONSE_VIEW, ...stored };
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
      authFields: AUTH_FIELDS,
      settingDefaults: readSettingDefaults(),
      responseView: this.responseView()
    });
  }

  private async onMessage(msg: FromWebview): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.markReady();
        await this.refresh();
        // A reopened editor should still show what came back last time.
        this.replay(this.current ?? this.results.get(this.cacheKey));
        return;

      case 'selectEnvironment':
        await vscode.commands.executeCommand('restclient.selectEnvironment', msg.environmentId);
        return;

      case 'revealInFile': {
        const doc = await vscode.workspace.openTextDocument(this.collectionUri);
        await vscode.window.showTextDocument(doc, { preview: false });
        return;
      }

      /**
       * Stop the run being shown, which may not be this panel's own: Run All
       * lights up every editor it reaches, and the editor is where you are
       * watching it from. The run service knows every handle; this panel only
       * knows the one it started.
       */
      case 'cancel':
        if (this.running) { this.running.abort(); }
        else { this.runService.stop(this.collectionUri, this.itemId); }
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

      case 'pickFile':
        return this.pickFile(msg.token);

      case 'saveResponse':
        return this.saveResponse(msg.kind);

      case 'responseView':
        await this.context.workspaceState.update(RESPONSE_VIEW_KEY, msg.state);
        return;

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

  /**
   * Let the user browse for a file to upload, as a path the runner can read.
   *
   * Uploads are read through WorkspaceFileResolver, which is jailed to the
   * workspace, so the path is stored relative to a folder in it and a file from
   * outside every folder is rejected here — while the dialog is still on screen
   * — rather than as a request error at send time. Postman writes these paths
   * with forward slashes, so the separator is normalised too.
   *
   * Relative to *this collection's* folder, which is the base the runner will
   * resolve it against and the only one that survives someone else opening the
   * folders in a different order.
   */
  private async pickFile(token: string): Promise<void> {
    const root = this.store.rootFor(this.collectionUri) ?? this.store.workspaceRoot;
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Attach',
      title: 'Select a file to upload',
      defaultUri: root ? vscode.Uri.file(root) : undefined
    });
    const chosen = picked?.[0];
    if (!chosen) { return this.post({ type: 'filePicked', token }); }

    if (!root) {
      void vscode.window.showWarningMessage(
        'Open a workspace folder first: files are uploaded from paths relative to it.'
      );
      return this.post({ type: 'filePicked', token });
    }

    const relative = path.relative(root, chosen.fsPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      void vscode.window.showWarningMessage(
        `${path.basename(chosen.fsPath)} is outside ${path.basename(root)}, so the request could not ` +
          'read it. Add its folder to the workspace, or move the file in.'
      );
      return this.post({ type: 'filePicked', token });
    }

    this.post({ type: 'filePicked', token, path: relative.split(path.sep).join('/') });
  }

  /**
   * Write the response on screen out to a file.
   *
   * The only path that puts a response on disk: everything else about them is
   * memory-only, so this happens when asked for by name and nowhere else. The
   * bytes come from the host's own copy of the result rather than back out of
   * the webview — the body is already here, and a megabyte of base64 should not
   * make the round trip to be handed straight back.
   */
  private async saveResponse(kind: SaveResponseKind): Promise<void> {
    const response = (this.current ?? this.results.get(this.cacheKey))?.response;
    if (!response) {
      void vscode.window.showWarningMessage('There is no response to save yet.');
      return;
    }

    const name = this.node()?.name ?? 'response';
    const contentType =
      response.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? '';
    const root = this.store.rootFor(this.collectionUri) ?? this.store.workspaceRoot;
    const fileName = responseFileName(name, contentType, kind);

    const target = await vscode.window.showSaveDialog({
      defaultUri: root ? vscode.Uri.file(path.join(root, fileName)) : undefined,
      saveLabel: 'Save',
      title:
        kind === 'full' ? `Save "${name}" response with headers` : `Save "${name}" response body`
    });
    if (!target) { return; }

    const body = Buffer.from(response.bodyBase64, 'base64');
    const bytes =
      kind === 'full' ? Buffer.concat([Buffer.from(responseHead(response), 'utf8'), body]) : body;

    try {
      await vscode.workspace.fs.writeFile(target, bytes);
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Could not save the response: ${e?.message ?? e}`);
      return;
    }

    // A body over `restclient.maxResponseSizeMb` was cut short on the way in, so the file
    // is short too — said plainly rather than handing over a partial file that
    // looks whole.
    const partial = response.bodyTruncated
      ? ' The body was truncated when it came back, so the file is incomplete.'
      : '';
    const chosen = await vscode.window.showInformationMessage(
      `Saved to ${vscode.workspace.asRelativePath(target)}.${partial}`,
      'Open'
    );
    if (chosen === 'Open') { await vscode.commands.executeCommand('vscode.open', target); }
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

  /** Run this request as if Send had been pressed in the webview. */
  run(): Promise<void> {
    return this.send();
  }

  /** Test seam: what a freshly reopened panel would replay, if anything. */
  restoredForTest(): CachedResponse | undefined {
    return this.current ?? this.results.get(this.cacheKey);
  }

  /** Test seam: the response view this editor told its webview to open on. */
  responseViewForTest(): ResponseViewState {
    return this.responseView();
  }

  /** Test seam: the webview reporting where the user is reading, as it does on every change. */
  rememberViewForTest(state: ResponseViewState): Promise<void> {
    return this.onMessage({ type: 'responseView', state });
  }

  /**
   * Show a result this panel did not produce.
   *
   * Run All and the overview's quick-run both file their results in the same
   * store, so an editor left open on one of those requests would otherwise sit
   * showing the run before it. `runStarted` is what clears the webview, so it
   * is posted first and the remembered result replayed onto the clean slate.
   */
  syncExternalResult(): void {
    if (this.sending) { return; }

    if (this.results.isRunning(this.cacheKey)) {
      if (!this.watchingExternal) {
        this.watchingExternal = true;
        this.post({ type: 'runStarted' });
      }
      return;
    }

    const cached = this.results.get(this.cacheKey);
    if (!this.watchingExternal && cached === this.current) { return; }
    this.watchingExternal = false;
    this.current = cached;
    this.post({ type: 'runStarted' });
    this.replay(cached);
    this.post({ type: 'runFinished' });
  }

  private async send(): Promise<void> {
    if (this.sending) { return; }
    const entry = this.entry();
    if (!entry) { return; }

    this.sending = true;
    this.consoleBuffer = [];
    // Rebuilt as the run progresses, then remembered so reopening the editor
    // shows the same thing. Never leaves memory.
    const result: CachedResponse = { assertions: [], console: [] };
    this.current = result;
    this.results.setRunning(this.cacheKey, true);
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
      this.results.record(this.cacheKey, result);
      this.post({ type: 'runFinished' });
      // After the result is filed, so a listener reading it sees this run.
      this.sending = false;
      this.results.setRunning(this.cacheKey, false);
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
    //
    // The rest of this policy is what a response preview costs, and each part
    // is bounded:
    //
    //  - `blob:` on img/media/frame is how a body already in memory is handed
    //    to an <img>, a player or the preview frame. Nothing else can mint one:
    //    a blob URL is same-origin to this document and unguessable.
    //  - `style-src 'unsafe-inline'` lets a previewed HTML response keep its own
    //    <style>, which is most of what makes the preview worth looking at. It
    //    buys an attacker nothing: script-src stays nonce-only, so no inline
    //    script runs, and with `default-src 'none'` no stylesheet can reach a
    //    URL — which is also what rules out CSS-based exfiltration.
    //  - The preview frame is `sandbox=""`: opaque origin, no scripts, no forms,
    //    no navigation. It inherits this policy on top of that, so a response
    //    body cannot load a remote image or fetch anything either. A response is
    //    someone else's HTML, and previewing it must not phone home.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; media-src blob: data:; frame-src blob:; script-src 'nonce-${n}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; connect-src 'none'; form-action 'none';">
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
