import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { buildGroupView, contentRequests, kv, type GroupView } from '../collections/view';
import { AUTH_FIELDS, AUTH_TYPES, buildGroupEdits, type GroupUpdate } from '../collections/edits';
import type { CollectionEntry, CollectionStore } from '../collections/store';
import type { ItemNode } from '../collections/model';
import type { RunService } from '../runner/runService';
import type { RunHandle } from '../runner/client';
import { ItemResultCollector } from '../runner/itemResults';
import type { EnvironmentSummary, KeyValue } from './protocol';
import type { LastRun, RunResults } from './runResults';

export const GROUP_VIEW_TYPE = 'restclient.collection';

/** One row's run state, as the overview list draws it. */
export type GroupResult = { itemId: string } & LastRun;

/** Extension host -> webview. */
export type ToGroupWebview =
  | {
      type: 'init';
      view: GroupView;
      /** Workspace-relative path of the collection file, for the header. */
      file: string;
      authTypes: readonly string[];
      authFields: Record<string, string[]>;
      environments: EnvironmentSummary[];
      collectionVariables: KeyValue[];
      scriptsAllowed: boolean;
      /**
       * Whether this group's own `variable[]` is resolved during a run. Only a
       * collection's is — see the note in the Variables tab.
       */
      variablesResolve: boolean;
    }
  | {
      type: 'results';
      results: GroupResult[];
      /** A run started from this overview is still going.  */
      running: boolean;
      /** Requests this run will reach but has not started yet. */
      queued: string[];
    }
  | { type: 'saved' }
  | { type: 'saveFailed'; message: string }
  | { type: 'runFailed'; message: string };

/** Webview -> extension host. */
export type FromGroupWebview =
  | { type: 'ready' }
  | { type: 'runAll' }
  | { type: 'runItem'; itemId: string }
  /** Stop the run. `itemId` is the row it was pressed on, if it was a row. */
  | { type: 'cancel'; itemId?: string }
  | { type: 'openRequest'; itemId: string }
  | { type: 'update'; update: GroupUpdate }
  | { type: 'selectEnvironment'; environmentId: string }
  /** From the inline `{{variable}}` editor in the auth and variable tables. */
  | { type: 'setVariable'; scope: 'environment' | 'collection'; key: string; value: string }
  | { type: 'moveSecretToKeychain'; key: string }
  | { type: 'editEnvironment' }
  | { type: 'revealInFile' };

/** Which container an overview tab is for; no `itemId` means the collection. */
export interface GroupTab {
  uri: vscode.Uri;
  itemId?: string;
}

function nonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * The tab identity of one overview: a collection, or a folder inside it.
 *
 * The collection root has no item id, so the empty string stands in for it —
 * ids are hex digests, so nothing can collide with it.
 */
function panelKey(uri: vscode.Uri, itemId: string | undefined): string {
  return `${uri.toString()}::${itemId ?? ''}`;
}

export class CollectionPanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, CollectionPanel>();

  private readonly _onDidActivate = new vscode.EventEmitter<GroupTab>();
  /** Fires when one of these tabs comes to the front; see RequestPanelManager. */
  readonly onDidActivate = this._onDidActivate.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: CollectionStore,
    private readonly runService: RunService,
    private readonly activeEnvironmentId: () => string | undefined,
    private readonly results: RunResults
  ) {
    store.onDidChange(() => {
      for (const panel of this.panels.values()) {
        // The collection may have been dropped, or the folder deleted, while
        // its overview was open.
        if (panel.stillThere()) { void panel.refresh(); }
        else { panel.dispose(); }
      }
    });

    results.onDidChangeResults(() => {
      for (const panel of this.panels.values()) { panel.pushResults(); }
    });
  }

  /** Open the overview for a collection (`node` omitted) or one of its folders. */
  open(entry: CollectionEntry, node?: ItemNode): CollectionPanel {
    const key = panelKey(entry.uri, node?.id);
    const tab: GroupTab = { uri: entry.uri, itemId: node?.id };
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      this._onDidActivate.fire(tab);
      return existing;
    }

    const panel = new CollectionPanel(
      this.context,
      this.store,
      this.runService,
      this.activeEnvironmentId,
      this.results,
      entry.uri,
      node?.id,
      () => this.panels.delete(key)
    );
    this.panels.set(key, panel);
    panel.onDidActivate(() => this._onDidActivate.fire(tab));
    // The tab just created is the front one, and that is not reported as a
    // change of view state.
    this._onDidActivate.fire(tab);
    return panel;
  }

  /** The container whose overview tab is in front, if one of them is. */
  activeTab(): GroupTab | undefined {
    for (const panel of this.panels.values()) {
      if (panel.isActive) { return panel.tab; }
    }
    return undefined;
  }

  /** Push a fresh environment list into every open overview. */
  environmentsChanged(): void {
    for (const panel of this.panels.values()) { void panel.refresh(); }
  }

  dispose(): void {
    for (const panel of this.panels.values()) { panel.dispose(); }
    this.panels.clear();
    this._onDidActivate.dispose();
  }
}

export class CollectionPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private running: RunHandle | undefined;
  /** True from the moment a run is asked for until its result is filed. */
  private starting = false;
  /** Requests the current run will reach but has not started yet. */
  private queued = new Set<string>();

  /** `refresh` awaits the keychain, so the panel can go away mid-flight. */
  private disposed = false;

  private readonly _onDidActivate = new vscode.EventEmitter<void>();
  /** Fires whenever this tab becomes the front one. */
  readonly onDidActivate = this._onDidActivate.event;

  private markReady!: () => void;
  /** Resolves once the webview has posted `ready`, so a run can reach it. */
  readonly whenReady = new Promise<void>((resolve) => { this.markReady = resolve; });

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: CollectionStore,
    private readonly runService: RunService,
    private readonly activeEnvironmentId: () => string | undefined,
    private readonly results: RunResults,
    private readonly collectionUri: vscode.Uri,
    /** Absent for the collection itself, which is not an item. */
    private readonly itemId: string | undefined,
    private readonly onDisposed: () => void
  ) {
    const view = this.view();
    this.panel = vscode.window.createWebviewPanel(
      GROUP_VIEW_TYPE,
      view?.name ?? 'Collection',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // Holds a mounted editor and half-typed config; rebuilding it on every
        // tab switch would lose both.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')]
      }
    );
    this.panel.iconPath = new vscode.ThemeIcon(this.itemId ? 'folder' : 'folder-library');
    this.panel.webview.html = this.html();

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: FromGroupWebview) => void this.onMessage(msg)),
      this.panel.onDidChangeViewState((e) => { if (e.webviewPanel.active) { this._onDidActivate.fire(); } }),
      this.panel.onDidDispose(() => this.dispose()),
      this._onDidActivate
    );
  }

  /** Which container this tab is for. */
  get tab(): GroupTab {
    return { uri: this.collectionUri, itemId: this.itemId };
  }

  /** Whether this is the tab in front; see RequestPanel. */
  get isActive(): boolean {
    return !this.disposed && this.panel.active;
  }

  private entry(): CollectionEntry | undefined {
    return this.store.collection(this.collectionUri);
  }

  /** The folder this overview is for, or `undefined` for the collection root. */
  private node(): ItemNode | undefined {
    if (!this.itemId) { return undefined; }
    return this.entry()?.materialized.index.get(this.itemId);
  }

  private view(): GroupView | undefined {
    const entry = this.entry();
    if (!entry) { return undefined; }
    // A folder overview needs its folder; the collection's needs only the file.
    if (this.itemId && !this.node()) { return undefined; }
    return buildGroupView(entry.materialized, entry.name, this.node());
  }

  /** False once the collection is untracked, or the folder deleted or renamed. */
  stillThere(): boolean {
    return Boolean(this.view());
  }

  reveal(): void {
    this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active);
  }

  private post(msg: ToGroupWebview): void {
    if (this.disposed) { return; }
    void this.panel.webview.postMessage(msg);
  }

  private async environments(): Promise<EnvironmentSummary[]> {
    const activeId = this.activeEnvironmentId();
    return Promise.all(
      this.store.environments.map(async (e) => {
        // Only the active environment's keychain is probed; see RequestPanel.
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

  async refresh(): Promise<void> {
    const entry = this.entry();
    const view = this.view();
    if (!entry || !view) { return; }

    this.panel.title = view.name;
    this.post({
      type: 'init',
      view,
      file: vscode.workspace.asRelativePath(entry.uri),
      // Nothing sits above a collection, so it has no parent to inherit from.
      authTypes: this.itemId ? AUTH_TYPES : AUTH_TYPES.filter((t) => t !== 'inherit'),
      authFields: AUTH_FIELDS,
      environments: await this.environments(),
      collectionVariables: kv(entry.materialized.json.variable),
      scriptsAllowed: this.runService.scriptsAllowed,
      variablesResolve: !this.itemId
    });
    this.pushResults();
  }

  /** The run state of every request in this group, for the contents list. */
  pushResults(): void {
    const view = this.view();
    if (!view) { return; }
    this.post({
      type: 'results',
      results: contentRequests(view.contents).map((request) => ({
        itemId: request.itemId,
        ...(this.results.lastRun(this.collectionUri, request.itemId) ?? {
          running: false,
          failures: []
        })
      })),
      running: this.starting || Boolean(this.running),
      queued: [...this.queued]
    });
  }

  private async onMessage(msg: FromGroupWebview): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.markReady();
        return this.refresh();

      case 'runAll':
        return this.runAll();

      // The row may be a folder, in which case the entrypoint is that folder
      // and the scope everything under it.
      case 'runItem':
        return this.run(msg.itemId, this.scopeFor(msg.itemId));

      /**
       * Stop the run — this tab's own, or whichever one owns the row.
       *
       * A row can be in flight for a reason that has nothing to do with this
       * tab: an editor's Send, or a Run All of the collection above it. There
       * is no handle here to abort in that case, and the run service is the
       * only thing that knows which run the row belongs to.
       */
      case 'cancel':
        if (this.running) { this.running.abort(); }
        else { this.runService.stop(this.collectionUri, msg.itemId ?? this.itemId); }
        return;

      case 'openRequest': {
        const entry = this.entry();
        const node = entry?.materialized.index.get(msg.itemId);
        if (!entry || !node) { return; }
        await vscode.commands.executeCommand('restclient.openRequest', { kind: 'item', entry, node });
        return;
      }

      case 'selectEnvironment':
        await vscode.commands.executeCommand('restclient.selectEnvironment', msg.environmentId);
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

      case 'revealInFile': {
        const doc = await vscode.workspace.openTextDocument(this.collectionUri);
        await vscode.window.showTextDocument(doc, { preview: false });
        return;
      }
    }
  }

  /**
   * Persist one variable edit from the inline popover.
   *
   * Nothing needs pushing back: the store reloads after every write, which
   * fires `onDidChange` and refreshes this panel.
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

  /** Persist one setting from the Auth, Variables or Scripts tab. */
  private async applyUpdate(update: GroupUpdate): Promise<void> {
    const entry = this.entry();
    const node = this.node();
    if (!entry || (this.itemId && !node)) { return; }

    const groupPath = node?.jsonPath ?? [];
    // Navigate the on-disk JSON by index path so unmodelled sibling keys survive.
    let raw: any = entry.materialized.json;
    for (const segment of groupPath) { raw = raw?.[segment as any]; }
    if (!raw) { return; }

    try {
      await this.store.editCollection(entry.uri, buildGroupEdits(groupPath, raw, update));
      this.post({ type: 'saved' });
    } catch (e: any) {
      this.post({ type: 'saveFailed', message: e?.message ?? String(e) });
    }
  }

  /** Run every request in this group, as if Run All had been pressed. */
  runAll(): Promise<void> {
    const view = this.view();
    return this.run(this.itemId, view ? contentRequests(view.contents).map((r) => r.itemId) : []);
  }

  /**
   * The requests one entrypoint will reach: a folder's contents, or itself.
   *
   * postman-runtime resolves a folder entrypoint to every request beneath it,
   * so the overview has to agree about that up front — those are the rows that
   * go `queued` the moment the run starts.
   */
  private scopeFor(itemId: string): string[] {
    const entry = this.entry();
    const node = entry?.materialized.index.get(itemId);
    if (!entry || !node) { return [itemId]; }
    if (!node.isFolder) { return [itemId]; }
    const view = buildGroupView(entry.materialized, entry.name, node);
    return view ? contentRequests(view.contents).map((r) => r.itemId) : [];
  }

  /**
   * Run one entrypoint — this group, or a single request inside it.
   *
   * postman-runtime does the ordering, the scripts and the cookie jar; all this
   * adds is splitting the narration back out into one result per request, which
   * is what makes a Run All light up the tree and the request editors as it goes.
   */
  private async run(entrypoint: string | undefined, scope: string[]): Promise<void> {
    if (this.starting || this.running) { return; }
    const entry = this.entry();
    if (!entry) { return; }

    this.starting = true;
    // Everything in scope is pending until the runner reaches it, so the list
    // says what is about to happen rather than showing stale results as if new.
    this.queued = new Set(scope);
    const touched = new Set<string>();
    this.pushResults();

    // Whether the user has already been told why the run went wrong, so the
    // catch-all below does not overwrite the actual reason.
    let reported = false;

    const collector = new ItemResultCollector({
      onStarted: (itemId) => {
        touched.add(itemId);
        this.queued.delete(itemId);
        this.results.setRunning(this.results.key(this.collectionUri, itemId), true);
      },
      onFinished: (itemId, result) => {
        const key = this.results.key(this.collectionUri, itemId);
        this.results.record(key, result);
        // After the result is filed, so a listener reading it sees this run.
        this.results.setRunning(key, false);
      }
    });

    try {
      const handle = await this.runService.start({ entry, itemId: entrypoint }, (m) =>
        collector.handle(m)
      );
      this.running = handle;

      // A run can fail without narrating anything — an entrypoint the runtime
      // could not resolve, or a runner process that died — and `completion`
      // resolves either way. Without this the overview would simply go quiet.
      let failure: string | undefined;
      handle.on('done', (error) => { failure = error; });

      await handle.completion;
      collector.finish(failure);
      if (failure) {
        reported = true;
        this.post({ type: 'runFailed', message: failure });
      }
    } catch (e: any) {
      const message = e?.message ?? String(e);
      collector.finish(message);
      reported = true;
      this.post({ type: 'runFailed', message });
    } finally {
      this.running = undefined;
      this.starting = false;
      // A request the run never reached — filtered out, or cut short by an
      // abort — must not be left claiming to be in flight.
      for (const itemId of this.queued) {
        this.results.setRunning(this.results.key(this.collectionUri, itemId), false);
      }
      this.queued.clear();
      this.pushResults();
      if (!touched.size && !reported) {
        this.post({
          type: 'runFailed',
          message: 'The run finished without reaching any request in this group.'
        });
      }
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const base = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(base, 'collection.js'));
    const styles = webview.asWebviewUri(vscode.Uri.joinPath(base, 'collection.css'));
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(base, 'codicons', 'codicon.css'));
    const n = nonce();

    // connect-src 'none': every request goes through the runner process, which
    // is the only place proxy, certificate and cookie handling can be correct.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; script-src 'nonce-${n}'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; connect-src 'none';">
<link rel="stylesheet" href="${codicons}">
<link rel="stylesheet" href="${styles}">
<title>Collection</title>
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
