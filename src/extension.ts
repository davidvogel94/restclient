import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  CollectionStore,
  type CollectionEntry,
  type EntrySource
} from './collections/store';
import { SecretsBroker } from './secrets/broker';
import { RunnerClient } from './runner/client';
import { RunService } from './runner/runService';
import { CollectionTreeProvider, type TreeNode } from './tree/provider';
import { EnvironmentTreeProvider, type EnvTreeNode } from './tree/environmentProvider';
import { CookieTreeProvider, type CookieTreeNode } from './tree/cookieProvider';
import {
  addItem,
  childArrayPath,
  deleteItem,
  duplicateItem,
  locate,
  newFolderItem,
  newRequestItem,
  renameItem
} from './collections/structure';
import { RequestPanelManager } from './panels/requestPanel';
import { CollectionPanelManager } from './panels/collectionPanel';
import { RunResults } from './panels/runResults';
import { EnvironmentPanelManager } from './panels/environmentPanel';
import { CookieStore } from './runner/cookieStore';
import { CONSOLE_VIEW_ID, ConsoleViewProvider } from './panels/consoleView';
import { CookiePanel } from './panels/cookiePanel';
import { FILE_SUFFIX, nameFromFileName } from './collections/importer';
import { isInside } from './collections/paths';
import { ImportTarget } from './collections/importTarget';
import { AUTO_DISCOVER_SETTING } from './collections/scanner';
import { exportFileNames } from './collections/export';
import type { ItemNode } from './collections/model';
import type { JsonPath } from './collections/jsonEdit';
import type { RegistryKind } from './collections/registry';
import {
  brokenNodeArg,
  cookieNodeArg,
  envNodeArg,
  stringArg,
  treeNodeArg,
  missingNodeArg,
  unsupportedNodeArg,
  uriArgs
} from './commandArgs';

/** A Collections row backed by a file that loaded, which is all any command acts on. */
type LoadedNode = Extract<TreeNode, { kind: 'collection' | 'item' }>;

const ACTIVE_ENV_KEY = 'restclient.activeEnvironmentId';
/** SecretStorage cannot be listed, so pm.vault key names are tracked here. */
const VAULT_KEYS_KEY = 'restclient.vaultKeys';
const VIEW_ID = 'restclient.collections';
const ENV_VIEW_ID = 'restclient.environments';
const COOKIE_VIEW_ID = 'restclient.cookies';

/** Surface handed to the integration tests; not a public extension API. */
export interface TestApi {
  store: CollectionStore;
  runService: RunService;
  panels: RequestPanelManager;
  /** Collection and folder overviews, and the Run All behind them. */
  overviews: CollectionPanelManager;
  /** Every request's last run, wherever it was started from. */
  results: RunResults;
  envPanels: EnvironmentPanelManager;
  secrets: SecretsBroker;
  cookies: CookieStore;
  consoleView: ConsoleViewProvider;
  /** The views themselves, so a test can check what a command revealed. */
  collectionsView: vscode.TreeView<TreeNode>;
  environmentsView: vscode.TreeView<EnvTreeNode>;
  cookiesView: vscode.TreeView<CookieTreeNode>;
  /** The providers, so a test can ask what the trees are actually showing. */
  collectionsTree: CollectionTreeProvider;
  environmentsTree: EnvironmentTreeProvider;
  /** Filtering, which is otherwise driven by an input box a test cannot type into. */
  setCollectionFilter(text: string | undefined): void;
  setEnvironmentFilter(text: string | undefined): void;
  globalStorageUri: vscode.Uri;
  /** Where imports land, so a test can drive prompt-and-remember without a dialog. */
  importTarget: ImportTarget;
  setActiveEnvironment(id: string | undefined): Thenable<void>;
  activeEnvironmentId(): string | undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<TestApi> {
  const log = vscode.window.createOutputChannel('REST Client', { log: true });
  context.subscriptions.push(log);

  const secrets = new SecretsBroker(context.secrets);
  /**
   * Every folder in the workspace, read fresh each time.
   *
   * Not captured at activation: "Add Folder to Workspace" is the supported way
   * to work on collections kept outside the repo you opened, and a captured
   * list would make that require a reload. Everything that needs a root takes
   * this function, not a folder.
   */
  const folders = () => vscode.workspace.workspaceFolders ?? [];
  /** The folder a dialog should start in, and the one a new file defaults to. */
  const primaryFolder = () => folders()[0];
  const store = new CollectionStore(folders, secrets, log);
  context.subscriptions.push(store);
  const importTarget = new ImportTarget(folders);

  const runnerPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'runner.js').fsPath;
  const runner = new RunnerClient(runnerPath, (line) => log.debug(line));
  context.subscriptions.push({ dispose: () => runner.dispose() });

  const activeEnvironmentId = () => context.workspaceState.get<string | undefined>(ACTIVE_ENV_KEY);

  const cookies = new CookieStore(context.globalStorageUri, log);
  context.subscriptions.push(cookies);
  const runService = new RunService(
    runner,
    store,
    secrets,
    activeEnvironmentId,
    log,
    cookies,
    () => context.globalState.get<string[]>(VAULT_KEYS_KEY, []),
    (keys) => context.globalState.update(VAULT_KEYS_KEY, keys)
  );

  // Before the tree: the rows show what each request's last run came back with,
  // and this is the one place that is recorded — by a single send, by a quick-run
  // from an overview, and by a Run All alike.
  const results = new RunResults();
  context.subscriptions.push(results);

  const panels = new RequestPanelManager(context, store, runService, activeEnvironmentId, results);
  context.subscriptions.push(panels);

  const overviews = new CollectionPanelManager(
    context,
    store,
    runService,
    activeEnvironmentId,
    results
  );
  context.subscriptions.push(overviews);

  const treeProvider = new CollectionTreeProvider(store, results, runService);
  const tree = vscode.window.createTreeView<TreeNode>(VIEW_ID, {
    treeDataProvider: treeProvider,
    dragAndDropController: treeProvider
  });
  context.subscriptions.push(tree);

  const envTreeProvider = new EnvironmentTreeProvider(store, activeEnvironmentId);
  const envTree = vscode.window.createTreeView<EnvTreeNode>(ENV_VIEW_ID, {
    treeDataProvider: envTreeProvider
  });
  context.subscriptions.push(envTree);

  const cookieTreeProvider = new CookieTreeProvider(cookies);
  const cookieTree = vscode.window.createTreeView<CookieTreeNode>(COOKIE_VIEW_ID, {
    treeDataProvider: cookieTreeProvider
  });
  context.subscriptions.push(cookieTree);

  const envPanels = new EnvironmentPanelManager(context, store);
  context.subscriptions.push(envPanels);

  const consoleView = new ConsoleViewProvider(context.extensionUri, runService);
  context.subscriptions.push(
    consoleView,
    runService,
    vscode.window.registerWebviewViewProvider(CONSOLE_VIEW_ID, consoleView, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // --- status bar environment selector ------------------------------------
  const envStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  envStatus.command = 'restclient.selectEnvironment';
  envStatus.tooltip = 'Select the active REST Client environment';
  context.subscriptions.push(envStatus);

  const refreshEnvStatus = () => {
    const active = store.environment(activeEnvironmentId() ?? '');
    envStatus.text = `$(globe) ${active ? active.name : 'No environment'}`;
    if (store.environments.length || store.collections.length) { envStatus.show(); }
    else { envStatus.hide(); }
    envTreeProvider.refresh();
  };

  const refreshContextKeys = () => {
    void vscode.commands.executeCommand('setContext', 'restclient:hasCollections', store.collections.length > 0);
    void vscode.commands.executeCommand('setContext', 'restclient:hasWorkspace', folders().length > 0);
    void vscode.commands.executeCommand(
      'setContext',
      'restclient:hasEnvironments',
      store.environments.length > 0
    );
    // The empty-view copy has to explain either the scan or its absence, and
    // they are different explanations. Any folder still scanning counts as on:
    // the copy would otherwise claim nothing is being scanned while one folder
    // still is.
    void vscode.commands.executeCommand(
      'setContext',
      'restclient:autoDiscover',
      folders().some((folder) =>
        vscode.workspace
          .getConfiguration('restclient', folder.uri)
          .get<boolean>(AUTO_DISCOVER_SETTING, true)
      )
    );
    // Multi-root changes what the empty-view copy should suggest: with one
    // folder open, adding another is the answer to "my collections are
    // elsewhere"; with several, that advice has already been taken.
    void vscode.commands.executeCommand('setContext', 'restclient:multiRoot', folders().length > 1);
  };

  // --- filtering ----------------------------------------------------------

  /**
   * What a filter shows of itself outside the rows it kept.
   *
   * A tree that is quietly hiding things is a tree that lies, so an active
   * filter says so in two places: the message above the rows, with the count of
   * what survived, and the pane title, which stays visible when the view is
   * scrolled or collapsed. The context keys are what put the clear button in the
   * title bar. Re-run whenever the store changes, since the counts are of what
   * is loaded now.
   */
  const refreshFilterState = () => {
    tree.message = treeProvider.filterSummary();
    tree.description = treeProvider.filterText ? `filter: ${treeProvider.filterText}` : undefined;
    envTree.message = envTreeProvider.filterSummary();
    envTree.description = envTreeProvider.filterText ? `filter: ${envTreeProvider.filterText}` : undefined;
    void vscode.commands.executeCommand(
      'setContext',
      'restclient:collectionsFiltered',
      Boolean(treeProvider.filterText)
    );
    void vscode.commands.executeCommand(
      'setContext',
      'restclient:environmentsFiltered',
      Boolean(envTreeProvider.filterText)
    );
  };

  const setCollectionFilter = (text: string | undefined) => {
    treeProvider.setFilter(text);
    refreshFilterState();
  };

  const setEnvironmentFilter = (text: string | undefined) => {
    envTreeProvider.setFilter(text);
    refreshFilterState();
  };

  /**
   * The filter box, which narrows the tree as it is typed.
   *
   * An input box rather than a QuickPick of matches: the answer to "which
   * requests match" is a shape in the tree — which collection, which folder,
   * what else is next to it — and a flat list of labels throws that away. So the
   * tree behind the box is the result list, and it updates on every keystroke.
   *
   * Enter keeps what you typed; Escape puts back what was there before, because
   * live narrowing has already changed the view and cancelling has to mean
   * cancelling. The view is focused first so the command is not a no-op when it
   * comes from the palette with the pane hidden.
   */
  const promptForFilter = async (options: {
    viewId: string;
    title: string;
    placeholder: string;
    current: string | undefined;
    apply: (text: string | undefined) => void;
  }): Promise<void> => {
    await vscode.commands.executeCommand(`${options.viewId}.focus`);

    const box = vscode.window.createInputBox();
    box.title = options.title;
    box.placeholder = options.placeholder;
    box.value = options.current ?? '';
    let accepted = false;

    box.onDidChangeValue((value) => options.apply(value));
    box.onDidAccept(() => {
      accepted = true;
      box.hide();
    });
    box.onDidHide(() => {
      if (!accepted) { options.apply(options.current); }
      box.dispose();
    });
    box.show();
  };

  store.onDidChange(() => {
    // An environment file may have been deleted out from under the selection.
    if (activeEnvironmentId() && !store.environment(activeEnvironmentId()!)) {
      void context.workspaceState.update(ACTIVE_ENV_KEY, undefined);
    }
    refreshEnvStatus();
    refreshContextKeys();
    refreshFilterState();
    panels.environmentsChanged();
    overviews.environmentsChanged();
  });

  // --- clicking a container row -------------------------------------------

  type ContainerNode = Extract<TreeNode, { kind: 'collection' | 'item' }>;

  /** One container row, told apart from every other across all collections. */
  const containerKey = (node: ContainerNode): string =>
    `${node.entry.uri.toString()}${node.kind === 'item' ? `#${node.node.id}` : ''}`;

  /**
   * The container row the tree has selected, as clicks see it.
   *
   * VS Code will not say what is selected at the moment a command runs — by
   * then the click has already made its own row the selection — so what is kept
   * here is the row a *previous* click or reveal left standing. That is exactly
   * the question a click needs answered: was this row already mine?
   */
  let selectedRow: string | undefined;

  /**
   * What a click on a collection or folder row does.
   *
   * A click opens: the row's overview, which is the answer to "what is this?",
   * and the row itself, so the tab and the tree are describing the same thing.
   * Shutting it again is the one thing that waits for a second click — a click
   * on the row that was already the selected one. Clicking your way down into a
   * folder never puts away the folder you just came from, and a click that lands
   * on a row to select it, or to aim a menu at it, is not read as a click to
   * dismiss what it just opened.
   *
   * How much of this the tree does by itself is not something an extension can
   * pin down — it turns on the build and on the user's tree settings — so
   * nothing here assumes either way. The click and whatever the tree did to the
   * row are both recorded, and once the click is over the row is made to agree
   * with the state the click called for. That is worked out from the state
   * before the click, which survives either order of arrival: a toggle says what
   * it moved the row from, and if no toggle came, the provider's own answer is
   * still the one from before.
   */
  let clicked: { node: ContainerNode; key: string; wasSelected: boolean; wasOpen: boolean } | undefined;
  let toggled: { key: string; open: boolean } | undefined;
  let settling: ReturnType<typeof setTimeout> | undefined;

  const settleClick = async (): Promise<void> => {
    const click = clicked;
    const toggle = toggled;
    clicked = undefined;
    toggled = undefined;
    if (!click) { return; }

    // A toggle of some other row is nothing to do with this click.
    const sameRow = toggle?.key === click.key;
    const before = sameRow ? !toggle!.open : click.wasOpen;
    const now = sameRow ? toggle!.open : click.wasOpen;
    // Open on any click; shut only when the click found the row already open
    // and already selected.
    const wanted = !(before && click.wasSelected);
    if (wanted === now) { return; }

    try {
      if (wanted) {
        // Opening a row needs no redraw: the tree will expand the row it is
        // already drawing, which keeps its id, and with it the selection the
        // click just made. Not focused — that would pull focus off the tab the
        // same click opened.
        await tree.reveal(click.node, { select: false, focus: false, expand: true });
        treeProvider.noteExpansion(click.node, true);
      } else {
        // Shutting one has to come from a redraw, there being no API for it and
        // no collapsed state honoured for a row already on screen. A redrawn
        // row is a new row, so the selection goes back on with it — a click
        // that left nothing selected would be a click that had not selected.
        treeProvider.setRowExpansion(click.node, false);
        await tree.reveal(click.node, { select: true, focus: false });
      }
    } catch (e: any) {
      // The row's state is a courtesy; the overview is open either way.
      log.debug(`Could not settle the row in Collections: ${e?.message ?? e}`);
    }
  };

  /**
   * Settle once the click and any toggle it caused have both arrived.
   *
   * A short wait rather than the next tick: a toggle is reported to an
   * extension somewhere behind the click that caused it, and a settle that ran
   * first would take the row's old state for its new one. Short enough that the
   * row is never seen in a state the click did not ask for.
   */
  const SETTLE_MS = 60;
  const scheduleSettle = (): void => {
    if (settling) { return; }
    settling = setTimeout(() => {
      settling = undefined;
      void settleClick();
    }, SETTLE_MS);
  };

  const noteContainerClick = (node: ContainerNode): void => {
    const key = containerKey(node);
    clicked = {
      node,
      key,
      wasSelected: selectedRow === key,
      wasOpen: treeProvider.isExpanded(node)
    };
    selectedRow = key;
    scheduleSettle();
  };

  /** Record a toggle the tree made, and keep the click's own record honest. */
  const scheduleToggle = (element: TreeNode, open: boolean): void => {
    // Expanding is the tree's own business until it changes which of the two
    // buttons a row should be offering, and only the view knows when that is.
    treeProvider.noteExpansion(element, open);
    if (element.kind !== 'collection' && element.kind !== 'item') { return; }
    toggled = { key: containerKey(element), open };
    scheduleSettle();
  };

  /** The tab a container's row stands for: its own auth, variables and scripts. */
  const openOverview = (node: ContainerNode): void => {
    if (node.kind === 'collection') { overviews.open(node.entry); }
    else { overviews.open(node.entry, node.node); }
  };

  /** A row the selection has left has to be picked again before it will shut. */
  const noteSelection = (selection: readonly TreeNode[]): void => {
    const holds = selection.some(
      (node) =>
        (node.kind === 'collection' || node.kind === 'item') && containerKey(node) === selectedRow
    );
    if (!holds) { selectedRow = undefined; }
  };

  context.subscriptions.push(
    tree.onDidChangeSelection((e) => noteSelection(e.selection)),
    // What the tree did of its own accord, which the click it belongs to is
    // about to be reconciled with.
    tree.onDidExpandElement((e) => scheduleToggle(e.element, true)),
    tree.onDidCollapseElement((e) => scheduleToggle(e.element, false))
  );

  /**
   * Select a row in the Collections pane, expanding whatever it is nested in.
   *
   * Anything that creates an item used to leave the user looking for it: the
   * tree redraws but nothing moves, and a request added to a collapsed folder
   * three levels down gave no sign of having been created at all.
   */
  const revealItem = async (node: TreeNode): Promise<void> => {
    // A filter gives way rather than swallow the row: a request named nothing
    // like the filter is the normal case for one just created, and "created,
    // then hidden" is indistinguishable from "not created".
    if (treeProvider.hides(node)) { setCollectionFilter(undefined); }
    try {
      await tree.reveal(node, { select: true, focus: true });
      // Selected without a click, and a row that is selected is a row the next
      // click on it may shut.
      if (node.kind === 'collection' || node.kind === 'item') { selectedRow = containerKey(node); }
    } catch (e: any) {
      // Revealing is a courtesy — the item was still created.
      log.debug(`Could not reveal the row in Collections: ${e?.message ?? e}`);
    }
  };

  /** The argument only if it is a row with things under it. */
  const containerArg = (arg?: unknown): ReturnType<typeof treeNodeArg> => {
    const node = treeNodeArg(arg);
    if (!node || (node.kind === 'item' && !node.node.isFolder)) { return undefined; }
    return node;
  };

  const revealEnvRow = async (node: EnvTreeNode): Promise<void> => {
    if (envTreeProvider.hides(node)) { setEnvironmentFilter(undefined); }
    try {
      await envTree.reveal(node, { select: true, focus: true });
    } catch (e: any) {
      log.debug(`Could not reveal the row in Environments: ${e?.message ?? e}`);
    }
  };

  // --- following the tab in front -----------------------------------------

  /**
   * The row for a request, folder or collection editor tab.
   *
   * Resolved from ids at the moment it is needed, never held: every edit
   * reloads the store and rebuilds every node object, and the row a tab wants
   * may be asked for long after the tab came to the front — when the pane is
   * shown again, say.
   */
  const tabRow = (tab: { uri: vscode.Uri; itemId?: string }): ContainerNode | undefined => {
    const entry = store.collection(tab.uri);
    if (!entry) { return undefined; }
    if (!tab.itemId) { return { kind: 'collection', entry }; }
    const node = entry.materialized.index.get(tab.itemId);
    return node ? { kind: 'item', entry, node } : undefined;
  };

  /** Whether a row is one of the pane's current selection. */
  const isSelectedRow = (key: string): boolean =>
    tree.selection.some(
      (node) => (node.kind === 'collection' || node.kind === 'item') && containerKey(node) === key
    );

  /**
   * Point the Collections pane at the tab the user is now looking at.
   *
   * The pane and the tabs are two views of one tree, and only one of them used
   * to lead: opening a request from anywhere but its row — an overview's list,
   * a reopened tab, the next tab along — left the pane still pointing at
   * whatever was clicked last, which is the wrong answer to "where am I?".
   *
   * `tab` is passed when a tab announced itself and left out when the pane is
   * catching up, in which case the panels are asked which of them is in front.
   */
  const followActiveTab = async (tab?: { uri: vscode.Uri; itemId?: string }): Promise<void> => {
    // `reveal` on a hidden view opens the pane, which would take the sidebar
    // off whatever the user had there. So this waits: switching tabs is not a
    // request to be shown the tree, and the pane catches up when next shown.
    if (!tree.visible) { return; }

    const target = tab ?? panels.activeTab() ?? overviews.activeTab();
    const node = target && tabRow(target);
    if (!node) { return; }

    // Already there, which is the common case — the tab was opened by clicking
    // its row. Revealing again would only be another selection event.
    const key = containerKey(node);
    if (isSelectedRow(key)) { return; }

    // A filter the user typed stands. They are looking for something, and
    // emptying the pane of their matches to point at a tab is not what a filter
    // was asked to do — unlike a reveal of something just created, where the
    // row appearing is the whole point.
    if (treeProvider.hides(node)) { return; }

    try {
      // Not focused: the tab the user just switched to is where they are
      // working, and this is the pane agreeing with them, not interrupting.
      await tree.reveal(node, { select: true, focus: false });
      // Selected without a click, and a selected container is one the next
      // click on it may shut.
      selectedRow = key;
    } catch (e: any) {
      log.debug(`Could not follow the active tab in Collections: ${e?.message ?? e}`);
    }
  };

  context.subscriptions.push(
    panels.onDidActivate((tab) => void followActiveTab(tab)),
    overviews.onDidActivate((tab) => void followActiveTab(tab)),
    // Shown again, perhaps long after: every tab that came to the front while
    // the pane was hidden went unanswered, so it catches up on the last of them.
    tree.onDidChangeVisibility((e) => { if (e.visible) { void followActiveTab(); } })
  );

  /**
   * The nodes of one `item` array in a reloaded collection.
   *
   * Every edit reloads the store, which rebuilds the tree from scratch, so the
   * node objects an edit was computed from are stale by the time it returns.
   * The JSON path is not: the numbers in it index into sibling lists that an
   * append or an insert further down leaves undisturbed.
   */
  const nodesAt = (entry: CollectionEntry, arrayPath: JsonPath): ItemNode[] => {
    let nodes = entry.materialized.tree;
    for (const segment of arrayPath) {
      if (typeof segment === 'number') { nodes = nodes[segment]?.children ?? []; }
    }
    return nodes;
  };

  /** Select a freshly created item, and open it when it is a request. */
  const goToNewItem = async (uri: vscode.Uri, arrayPath: JsonPath, index: number): Promise<void> => {
    const entry = store.collection(uri);
    const node = entry && nodesAt(entry, arrayPath)[index];
    if (!entry || !node) { return; }

    await revealItem({ kind: 'item', entry, node });
    // Focus ends up in the editor, which is where the work continues.
    if (!node.isFolder) { panels.open(entry, node); }
  };

  /** Select a variable row, expanding its environment if it was collapsed. */
  const goToVariable = async (environmentId: string, key: string): Promise<void> => {
    const entry = store.environment(environmentId);
    if (!entry) { return; }
    const node = await envTreeProvider.variableNode(entry, key);
    if (node) { await revealEnvRow(node); }
  };

  /**
   * Create a request or folder under the given node.
   *
   * Invoked from a tree item the parent is obvious; from the view title bar it
   * is not, so ask when there is more than one collection.
   */
  const createChild = async (node: LoadedNode | undefined, kind: 'request' | 'folder') => {
    let entry = node?.entry;
    if (!entry) {
      if (!store.collections.length) {
        void vscode.window.showInformationMessage('Import a collection first.', 'Import Collection').then((choice) => {
          if (choice) { void vscode.commands.executeCommand('restclient.importCollection'); }
        });
        return;
      }
      if (store.collections.length === 1) {
        entry = store.collections[0];
      } else {
        const picked = await vscode.window.showQuickPick(
          store.collections.map((c) => ({ label: c.name, entry: c })),
          { title: `Add ${kind} to which collection?` }
        );
        if (!picked) { return; }
        entry = picked.entry;
      }
    }

    const name = await vscode.window.showInputBox({
      title: kind === 'request' ? 'New request name' : 'New folder name',
      value: kind === 'request' ? 'New Request' : 'New Folder',
      validateInput: (v) => (v.trim() ? undefined : 'A name is required.')
    });
    if (!name) { return; }

    // Only a folder can contain children; dropping onto a request adds a sibling.
    const parent = node?.kind === 'item' && node.node.isFolder ? node.node : undefined;
    const item = kind === 'request' ? newRequestItem(name.trim()) : newFolderItem(name.trim());
    const container = childArrayPath(parent);
    const index = nodesAt(entry, container).length;

    await store.editCollection(entry.uri, addItem(parent, item));
    // `addItem` appends, so the new item is the last of its siblings.
    await goToNewItem(entry.uri, container, index);
  };

  /**
   * Run one environment edit, surfacing failures rather than losing them to an
   * unhandled rejection — every one of these is triggered from a tree action
   * with no other feedback channel.
   */
  const runOnEnvironment = async (action: () => Promise<void>) => {
    try {
      await action();
      panels.environmentsChanged();
    } catch (e: any) {
      void vscode.window.showErrorMessage(e?.message ?? String(e));
    }
  };

  /**
   * Ask where a new collection or environment should live, then what to call it.
   *
   * The save dialog comes first because the file is the artefact: everything
   * here is tracked by path and edited in place, so where it lands matters more
   * than the display name — which is then prefilled from the file name, making
   * the second prompt usually a single keypress.
   */
  const promptForNewFile = async (
    kind: 'collection' | 'environment'
  ): Promise<{ uri: vscode.Uri; name: string } | undefined> => {
    const folder = primaryFolder();
    if (!folder) {
      void vscode.window.showErrorMessage(
        `Open a folder first — the new ${kind} needs somewhere to live.`
      );
      return undefined;
    }

    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(folder.uri, `new-${kind}${FILE_SUFFIX[kind]}`),
      saveLabel: 'Create',
      filters: { 'Postman export': ['json'] },
      title: `New Postman ${kind}`
    });
    if (!target) { return undefined; }

    // The save dialog asks before replacing a file, but its generic prompt says
    // nothing about losing a collection this workspace is working on.
    if (isTracked(target)) {
      void vscode.window.showErrorMessage(
        `REST Client is already working on ${path.basename(target.fsPath)}. Choose another name.`
      );
      return undefined;
    }

    const fileName = path.basename(target.fsPath);
    const name = await vscode.window.showInputBox({
      title: `Name for ${fileName}`,
      value: nameFromFileName(fileName),
      prompt: `Shown in the tree and stored inside the file.`,
      validateInput: (v) => (v.trim() ? undefined : 'A name is required.')
    });
    if (!name) { return undefined; }

    return { uri: target, name: name.trim() };
  };

  /**
   * What stopping work on a file actually does, which depends on how it got here.
   *
   * A listed file leaves its list. A file the scan found is in no list to leave,
   * so the only way to say no to it is to record an exclusion — and since that
   * writes a setting the user did not ask about, the modal is where it has to
   * be said.
   */
  const untrackDetail = (entry: { uri: vscode.Uri; source: EntrySource }): string => {
    // A row for a file that is not on disk has nothing to leave in place, and
    // saying it does would be the one sentence the user could check and find
    // false.
    if (store.missing.some((m) => m.uri.fsPath === entry.uri.fsPath)) {
      return `${entry.uri.fsPath} is not on disk — only this workspace's list changes.`;
    }
    const where = `${entry.uri.fsPath} stays exactly where it is`;
    return entry.source === 'discovered'
      ? `Found by the workspace scan. ${where} — its path is added to ` +
          `restclient.discoverExclude so the scan skips it.`
      : `${where} — only this workspace's list changes.`;
  };

  /** Make `id` (or nothing, for `undefined`) the environment requests resolve against. */
  const applyEnvironment = async (id: string | undefined) => {
    await context.workspaceState.update(ACTIVE_ENV_KEY, id);
    refreshEnvStatus();
    panels.environmentsChanged();
    overviews.environmentsChanged();
  };

  /**
   * Adopt Postman files into this workspace.
   *
   * A file from outside the workspace is *copied* in and the copy is what gets
   * worked on — the original is never listed, moved or rewritten. A file already
   * inside the workspace is worked on where it is; copying a file that is
   * already committed here would serve nobody.
   *
   * `expect` only shapes the prompt and the confirmation: a file is tracked as
   * whatever it actually is, so importing an environment from the Collections
   * pane still works — it just says where the thing landed.
   */
  const importFiles = async (
    expect: 'collection' | 'environment' | undefined,
    a?: unknown,
    b?: unknown
  ) => {
    if (!folders().length) {
      void vscode.window.showErrorMessage('Open a folder first — collections are stored in the workspace.');
      return;
    }

    const what =
      expect === 'collection' ? 'collections' : expect === 'environment' ? 'environments' : 'collections or environments';

    let sources: vscode.Uri[] | undefined = uriArgs(a, b);
    if (!sources.length) {
      sources = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Import',
        filters: { 'Postman export': ['json'] },
        title: `Import Postman ${what}`
      });
    }
    if (!sources?.length) { return; }

    // Only ask if something is actually going to be copied. Every source
    // already inside the workspace is worked on where it is, so a folder
    // prompt there would be a question with no consequence.
    const anyFromOutside = sources.some((s) => !isInside(s.fsPath, store.workspaceRoot));
    let copyInto: vscode.Uri | undefined;
    if (anyFromOutside) {
      // Asked once, before the loop, so importing six files is still one
      // question — and remembered, so the next import is none.
      copyInto = await importTarget.resolve();
      if (!copyInto) { return; }
    }

    const added: string[] = [];
    const landed: Array<{ kind: RegistryKind; uri: vscode.Uri }> = [];
    const warnings: string[] = [];
    let copiedAny = false;
    for (const source of sources) {
      try {
        let result = await store.register(source, { copyInto });

        if (result.convertFrom) {
          // Editing needs v2.1.0, and converting rewrites a file. Which file
          // that is decides what there is to warn about: a copy is ours to
          // rewrite, the user's own file is not.
          const choice = await vscode.window.showWarningMessage(
            `${path.basename(source.fsPath)} is a Postman v${result.convertFrom} collection.`,
            {
              modal: true,
              detail: result.willCopy
                ? 'Editing requires the v2.1.0 format. Import a converted v2.1.0 copy? ' +
                  'Your original is left exactly as it is.'
                : 'Editing requires the v2.1.0 format. Convert this file in place?'
            },
            'Convert'
          );
          if (choice !== 'Convert') { continue; }
          const converted = await store.convert(source, result.convertFrom, { copyInto });
          warnings.push(`Converted ${path.basename(source.fsPath)} from v${result.convertFrom} to v2.1.0.`);
          result = { ...result, uri: converted, copiedFrom: result.willCopy ? source : undefined };
        }

        if (expect && result.kind !== expect) {
          warnings.push(
            `${path.basename(source.fsPath)} is an ${result.kind}, so it was added to ` +
              `${result.kind === 'collection' ? 'Collections' : 'Environments'}.`
          );
        }

        if (result.copiedFrom) {
          copiedAny = true;
          // A clash was settled by renaming rather than by overwriting, and
          // the user has to be told which file they now have.
          const landedName = path.basename(result.uri.fsPath);
          if (landedName !== path.basename(result.copiedFrom.fsPath)) {
            warnings.push(`Copied in as ${landedName}, since that folder already had one.`);
          }
        }

        added.push(`${result.name} (${result.kind})`);
        landed.push({ kind: result.kind, uri: result.uri });
        warnings.push(...result.warnings);
      } catch (e: any) {
        log.error(`Could not add ${source.fsPath}: ${e?.message ?? e}`);
        void vscode.window.showErrorMessage(
          `Could not add ${path.basename(source.fsPath)}: ${e?.message ?? e}`
        );
      }
    }

    if (added.length) {
      const detail = warnings.length ? ` ${warnings.join(' ')}` : '';
      const message = `Now working on ${added.join(', ')}.${detail}`;
      // A copy is a new file on disk, so offer to go and look at it, the way
      // export does. Nothing copied means nothing new to find.
      if (copiedAny && copyInto) {
        reveal(`${message} Copied into ${vscode.workspace.asRelativePath(copyInto)}.`, copyInto);
      }
      else { void vscode.window.showInformationMessage(message); }
    }

    // Land on what arrived rather than on a message about it. With several
    // files it is the first, which is the one at the top of the selection.
    const first = landed[0];
    if (!first) { return; }
    if (first.kind === 'collection') {
      const entry = store.collection(first.uri);
      if (entry) { await revealItem({ kind: 'collection', entry }); }
    } else {
      const entry = store.environments.find((e) => e.uri.toString() === first.uri.toString());
      if (entry) { await revealEnvRow(envTreeProvider.environmentNode(entry)); }
    }
  };

  /**
   * A file this workspace is already working on.
   *
   * Writing over one is silently destructive in a way neither a save dialog's
   * generic "replace?" nor a bulk export's own confirmation conveys, so both
   * the new-file and the export paths refuse it outright.
   */
  const isTracked = (uri: vscode.Uri): boolean =>
    [...store.collections, ...store.environments].some((e) => e.uri.fsPath === uri.fsPath);

  /** Everything export needs of a collection or an environment. */
  type Exportable = { uri: vscode.Uri; id: string; name: string };

  const revealLabel = process.platform === 'darwin' ? 'Reveal in Finder' : 'Reveal in File Explorer';

  const reveal = (message: string, target: vscode.Uri) => {
    void vscode.window.showInformationMessage(message, revealLabel).then((choice) => {
      if (choice) { void vscode.commands.executeCommand('revealFileInOS', target); }
    });
  };

  const exists = async (uri: vscode.Uri): Promise<boolean> => {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Offer to put keychain-held secrets back into an exported environment.
   *
   * An environment file keeps its `secret` values empty so it stays safe to
   * commit, which also makes a plain copy useless to whoever receives it. This
   * is the one place those values are allowed out, and only on a deliberate
   * answer — the modal's Cancel, and Escape, both mean "leave them empty".
   *
   * Nothing is asked when the keychain holds nothing to include.
   */
  const askIncludeSecrets = async (entries: Exportable[]): Promise<boolean> => {
    const counts = await Promise.all(
      entries.map(async (e) => (await store.storedSecretKeys(e.id)).size)
    );
    const total = counts.reduce((a, b) => a + b, 0);
    if (!total) { return false; }

    const subject =
      entries.length === 1 ? `"${entries[0].name}" has` : `${entries.length} environments hold`;
    const choice = await vscode.window.showWarningMessage(
      `${subject} ${total} secret value${total === 1 ? '' : 's'} in your keychain.`,
      {
        modal: true,
        detail: 'Include them in the exported file? Left out, they export empty, exactly as the file on disk has them.'
      },
      'Include Values'
    );
    return choice === 'Include Values';
  };

  /**
   * Write one export.
   *
   * A collection on disk already *is* a Postman export, so the default is a
   * byte-for-byte copy: same formatting, same ids, no re-serialisation to diff
   * against. Only an environment whose secrets are being included has to be
   * rebuilt, and then it is written the way the store writes everything else.
   */
  const writeExport = async (
    kind: RegistryKind,
    entry: Exportable,
    dest: vscode.Uri,
    includeSecrets: boolean
  ): Promise<void> => {
    if (kind === 'environment' && includeSecrets) {
      const json = await store.exportEnvironmentJson(entry.id);
      const text = JSON.stringify(json, null, '\t') + '\n';
      await vscode.workspace.fs.writeFile(dest, Buffer.from(text, 'utf8'));
      return;
    }
    await vscode.workspace.fs.copy(entry.uri, dest, { overwrite: true });
  };

  /**
   * Export a single collection or environment to a file the user picks.
   *
   * The copy is not registered: unlike New Collection, this hands a file to
   * someone else rather than starting work on one. `dest` is for callers that
   * already know where it goes, and skips the dialog.
   */
  const exportOne = async (
    kind: RegistryKind,
    entry: Exportable,
    dest?: vscode.Uri
  ): Promise<void> => {
    let target = dest;
    if (!target) {
      const home = primaryFolder();
      const defaultUri = home
        ? vscode.Uri.joinPath(home.uri, path.basename(entry.uri.fsPath))
        : entry.uri;
      target = await vscode.window.showSaveDialog({
        defaultUri,
        saveLabel: 'Export',
        filters: { 'Postman export': ['json'] },
        title: `Export "${entry.name}"`
      });
    }
    if (!target) { return; }

    if (isTracked(target)) {
      void vscode.window.showErrorMessage(
        `REST Client is working on ${path.basename(target.fsPath)}. Export somewhere else.`
      );
      return;
    }

    const includeSecrets = kind === 'environment' && (await askIncludeSecrets([entry]));
    try {
      await writeExport(kind, entry, target, includeSecrets);
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Could not export ${entry.name}: ${e?.message ?? e}`);
      return;
    }
    reveal(`Exported ${entry.name} to ${vscode.workspace.asRelativePath(target)}.`, target);
  };

  /**
   * Export every collection, or every environment, into one folder.
   *
   * File names come from the display names rather than the originals, so a
   * bulk export is readable and stable even where the files on disk are not;
   * `exportFileNames` keeps two identically-named collections apart.
   */
  const exportAll = async (kind: RegistryKind, folder?: vscode.Uri): Promise<void> => {
    const entries: Exportable[] = kind === 'collection' ? store.collections : store.environments;
    const what = kind === 'collection' ? 'collections' : 'environments';
    if (!entries.length) {
      void vscode.window.showInformationMessage(`No ${what} to export.`);
      return;
    }

    let target = folder;
    if (!target) {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: primaryFolder()?.uri,
        openLabel: 'Export Here',
        title: `Export all ${what} to`
      });
      target = picked?.[0];
    }
    if (!target) { return; }

    const names = exportFileNames(entries.map((e) => e.name), kind);
    const planned = entries.map((entry, i) => ({
      entry,
      dest: vscode.Uri.joinPath(target as vscode.Uri, names[i])
    }));

    // Exporting into the folder the originals live in would have the export
    // overwrite its own source. Skip those rather than destroying the file.
    const writable = planned.filter((p) => !isTracked(p.dest));
    const skipped = planned.length - writable.length;
    if (!writable.length) {
      void vscode.window.showErrorMessage(
        `That folder holds the ${what} this workspace is working on. Export somewhere else.`
      );
      return;
    }

    const clashes: string[] = [];
    for (const p of writable) {
      if (await exists(p.dest)) { clashes.push(path.basename(p.dest.fsPath)); }
    }
    if (clashes.length) {
      const confirmed = await vscode.window.showWarningMessage(
        `Replace ${clashes.length} file${clashes.length === 1 ? '' : 's'} in that folder?`,
        { modal: true, detail: clashes.join('\n') },
        'Replace'
      );
      if (confirmed !== 'Replace') { return; }
    }

    const includeSecrets =
      kind === 'environment' && (await askIncludeSecrets(writable.map((p) => p.entry)));

    const failed: string[] = [];
    for (const p of writable) {
      try {
        await writeExport(kind, p.entry, p.dest, includeSecrets);
      } catch (e: any) {
        log.error(`Could not export ${p.entry.name}: ${e?.message ?? e}`);
        failed.push(p.entry.name);
      }
    }

    const written = writable.length - failed.length;
    const notes = [
      skipped ? `${skipped} already live there and were left alone.` : '',
      failed.length ? `Could not write ${failed.join(', ')}.` : ''
    ].filter(Boolean);
    reveal(
      `Exported ${written} ${written === 1 ? what.replace(/s$/, '') : what} to ` +
        `${vscode.workspace.asRelativePath(target)}.${notes.length ? ` ${notes.join(' ')}` : ''}`,
      target
    );
  };

  // --- commands -----------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('restclient.filterCollections', () =>
      promptForFilter({
        viewId: VIEW_ID,
        title: 'Filter Collections',
        placeholder: 'Request, folder or collection name, method, or URL',
        current: treeProvider.filterText,
        apply: setCollectionFilter
      })),

    vscode.commands.registerCommand('restclient.clearCollectionsFilter', () =>
      setCollectionFilter(undefined)),

    vscode.commands.registerCommand('restclient.filterEnvironments', () =>
      promptForFilter({
        viewId: ENV_VIEW_ID,
        title: 'Filter Environments',
        placeholder: 'Environment name, variable name, or value',
        current: envTreeProvider.filterText,
        apply: setEnvironmentFilter
      })),

    vscode.commands.registerCommand('restclient.clearEnvironmentsFilter', () =>
      setEnvironmentFilter(undefined)),

    // `a`/`b` are deliberately untyped: the explorer passes (uri, uris[]) and the
    // view-title button passes the tree's focused node, not a Uri at all.
    //
    // The kind-agnostic command stays for the drop target and for anything
    // holding a Uri already; the two named ones are what the panes offer, so
    // "New" and "Import" never collapse into one ambiguous button.
    vscode.commands.registerCommand('restclient.import', (a?: unknown, b?: unknown) =>
      importFiles(undefined, a, b)),

    vscode.commands.registerCommand('restclient.importCollection', (a?: unknown, b?: unknown) =>
      importFiles('collection', a, b)),

    vscode.commands.registerCommand('restclient.importEnvironment', (a?: unknown, b?: unknown) =>
      importFiles('environment', a, b)),

    /**
     * The settings behind the two panes, one click from the panes themselves.
     *
     * Autodiscovery is the setting people actually need to reach — it decides
     * whether a pane is empty because there is nothing to find or because
     * nothing is looking — and the only route to it was knowing its name. The
     * argument narrows the search box: a row for a missing file sends the name
     * of the list it is missing from, a title-bar button sends nothing and gets
     * the extension's whole section.
     *
     * Guarded, because a `view/title` button is invoked with the tree's focused
     * element rather than with nothing at all — see `commandArgs`.
     */
    vscode.commands.registerCommand('restclient.openSettings', async (arg?: unknown) => {
      const query = stringArg(arg) ?? '@ext:davidvogel94.restclient';
      await vscode.commands.executeCommand('workbench.action.openSettings', query);
    }),

    vscode.commands.registerCommand('restclient.setImportLocation', async () => {
      if (!folders().length) {
        void vscode.window.showErrorMessage('Open a folder first — imports are copied into the workspace.');
        return;
      }
      const picked = await importTarget.resolve({ reask: true });
      if (!picked) { return; }
      void vscode.window.showInformationMessage(
        `Imports will be copied into ${vscode.workspace.asRelativePath(picked)}.`
      );
    }),

    /**
     * Convert a collection whose format is too old to edit.
     *
     * Invoked by the row itself, so the file is already in the workspace and
     * the conversion happens in place — which is what the confirmation says.
     * The import path converts a copy instead, and says so differently.
     */
    vscode.commands.registerCommand('restclient.convertCollection', async (a?: unknown, b?: unknown) => {
      const node = unsupportedNodeArg(a);
      const uri = node?.entry.uri ?? uriArgs(a)[0];
      const from = node?.entry.convertFrom ?? (stringArg(b) as '1.0.0' | '2.0.0' | undefined);
      if (!uri || (from !== '1.0.0' && from !== '2.0.0')) { return; }

      const confirmed = await vscode.window.showWarningMessage(
        `Convert "${path.basename(uri.fsPath)}" to the v2.1.0 format?`,
        {
          modal: true,
          detail:
            `This rewrites ${uri.fsPath}. Postman reads v2.1.0, so the converted file ` +
            'stays usable there.'
        },
        'Convert'
      );
      if (confirmed !== 'Convert') { return; }

      try {
        const converted = await store.convert(uri, from);
        const entry = store.collection(converted);
        if (entry) { await revealItem({ kind: 'collection', entry }); }
      } catch (e: any) {
        log.error(`Could not convert ${uri.fsPath}: ${e?.message ?? e}`);
        void vscode.window.showErrorMessage(
          `Could not convert ${path.basename(uri.fsPath)}: ${e?.message ?? e}`
        );
      }
    }),

    /**
     * The files the scan has been told to skip, and the way back.
     *
     * Without this the only route back is remembering a setting's name, which
     * is the same argument that put broken files in the tree rather than in a
     * log line.
     */
    vscode.commands.registerCommand('restclient.showExcluded', async () => {
      const excluded = store.registry.excludes();
      if (!excluded.length) {
        void vscode.window.showInformationMessage('Nothing is excluded from the workspace scan.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        excluded.map((entry) => ({ label: entry })),
        {
          canPickMany: true,
          title: 'Excluded from Workspace Scan',
          placeHolder: 'Select what to include again'
        }
      );
      if (!picked?.length) { return; }
      for (const { label } of picked) {
        const uri = store.registry.resolveEntry(label);
        if (uri) { await store.registry.unexclude(uri); }
      }
      await store.rescan();
      void vscode.window.showInformationMessage(
        `Included ${picked.length} file(s) again; the scan will pick them up.`
      );
    }),

    vscode.commands.registerCommand('restclient.removeFromWorkspace', async (arg?: unknown) => {
      // Also offered on a file that would not parse or needs converting:
      // dropping it is one of the ways out of both states, and it needs
      // nothing but the path.
      const entry =
        treeNodeArg(arg)?.entry ??
        brokenNodeArg(arg)?.entry ??
        unsupportedNodeArg(arg)?.entry ??
        missingNodeArg(arg)?.entry;
      if (!entry) { return; }
      const confirmed = await vscode.window.showWarningMessage(
        `Stop working on "${entry.name}"?`,
        { modal: true, detail: untrackDetail(entry) },
        entry.source === 'discovered' ? 'Exclude' : 'Remove'
      );
      if (!confirmed) { return; }
      await store.untrack('collection', entry.uri, entry.source);
    }),

    vscode.commands.registerCommand('restclient.openRequest', (arg?: unknown) => {
      const node = treeNodeArg(arg);
      if (node?.kind !== 'item' || node.node.isFolder) { return; }
      panels.open(node.entry, node.node);
    }),

    /**
     * Run one request straight from its row.
     *
     * The editor is opened rather than bypassed: the response, its tests and
     * the console all live there, and a run whose result you cannot see is not
     * worth much. Awaiting `whenReady` matters — a webview that has not mounted
     * yet drops the messages the run posts at it.
     */
    vscode.commands.registerCommand('restclient.runRequest', async (arg?: unknown) => {
      const node = treeNodeArg(arg);
      if (node?.kind !== 'item' || node.node.isFolder) { return; }
      const panel = panels.open(node.entry, node.node);
      await panel.whenReady;
      await panel.run();
    }),

    /**
     * Stop what is running on this row — the other face of Run and Run All.
     *
     * The row is the only place a long run is visible without going and finding
     * the tab that started it, so it is where stopping one belongs. It goes
     * through the run service rather than a panel because the run to stop may
     * not be the row's own: a request in the middle of a Run All is stopped by
     * ending that Run All, and there is nothing else it could mean.
     */
    vscode.commands.registerCommand('restclient.stopRun', (arg?: unknown) => {
      const node = treeNodeArg(arg);
      if (!node) { return; }
      runService.stop(node.entry.uri, node.kind === 'item' ? node.node.id : undefined);
    }),

    /**
     * Open a collection's or a folder's own tab.
     *
     * A container is not just somewhere requests live: it carries the auth,
     * variables and scripts every request under it inherits, and until now
     * there was nowhere to see or edit any of that — nor to see, in one place,
     * what the last run made of its contents.
     */
    vscode.commands.registerCommand('restclient.openOverview', (arg?: unknown) => {
      const node = containerArg(arg);
      if (node) { openOverview(node); }
    }),

    /**
     * A click on a container row: its overview, and then the row's own state.
     *
     * Separate from Open Overview, which the row menu carries: picking an entry
     * off a menu is not the gesture that opens and shuts a row.
     */
    vscode.commands.registerCommand('restclient.clickRow', (arg?: unknown) => {
      const node = containerArg(arg);
      if (!node) { return; }
      openOverview(node);
      noteContainerClick(node);
    }),

    /**
     * Open or shut a container row, and everything under it, from its own
     * button.
     *
     * The twistie is a three-pixel target that only appears once a row has
     * something in it, and nothing else in the pane says whether a folder is
     * hiding anything — so the row carries the toggle as an action, the way it
     * carries Run All. It goes all the way down, because a twistie is what you
     * use when you want one level: a button worth crossing the row for is the
     * one that opens or puts away the whole subtree at once.
     */
    vscode.commands.registerCommand('restclient.expandRow', (arg?: unknown) => {
      const node = containerArg(arg);
      if (node) { treeProvider.setExpansion(node, true); }
    }),

    vscode.commands.registerCommand('restclient.collapseRow', (arg?: unknown) => {
      const node = containerArg(arg);
      if (node) { treeProvider.setExpansion(node, false); }
    }),

    /**
     * Run everything in a collection or folder, in order.
     *
     * Routed through the overview rather than run headlessly: it is where the
     * per-request results land, and a run whose outcome you cannot see is not
     * worth much. `whenReady` matters — a webview that has not mounted yet
     * drops the messages the run posts at it.
     */
    vscode.commands.registerCommand('restclient.runAll', async (arg?: unknown) => {
      const node = treeNodeArg(arg);
      if (!node) { return; }
      if (node.kind === 'item' && !node.node.isFolder) { return; }
      const panel = overviews.open(node.entry, node.kind === 'item' ? node.node : undefined);
      await panel.whenReady;
      await panel.runAll();
    }),

    vscode.commands.registerCommand('restclient.openCollectionFile', async (arg?: unknown) => {
      const entry = treeNodeArg(arg)?.entry ?? brokenNodeArg(arg)?.entry;
      if (!entry) { return; }
      const doc = await vscode.workspace.openTextDocument(entry.uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    // `a` is a tree node from the context menu, or a collection Uri; `b` is an
    // optional destination that skips the save dialog.
    vscode.commands.registerCommand('restclient.exportCollection', async (a?: unknown, b?: unknown) => {
      const source = treeNodeArg(a)?.entry.uri ?? uriArgs(a)[0];
      if (source) {
        const entry = store.collection(source);
        if (!entry) {
          void vscode.window.showErrorMessage(
            `${path.basename(source.fsPath)} is not a collection this workspace is working on.`
          );
          return;
        }
        await exportOne('collection', entry, uriArgs(b)[0]);
        return;
      }

      // Nothing to go on: the command palette, or a title bar with an empty tree.
      if (!store.collections.length) {
        void vscode.window.showInformationMessage('No collections to export.');
        return;
      }
      if (store.collections.length === 1) {
        await exportOne('collection', store.collections[0]);
        return;
      }
      const picked = await vscode.window.showQuickPick(
        store.collections.map((c) => ({ label: c.name, entry: c })),
        { title: 'Export which collection?' }
      );
      if (picked) { await exportOne('collection', picked.entry); }
    }),

    // A view-title button is handed the tree's focused node, not nothing at
    // all, so the destination is read through `uriArgs` — a node yields none
    // and the folder dialog opens.
    vscode.commands.registerCommand('restclient.exportAllCollections', (a?: unknown, b?: unknown) =>
      exportAll('collection', uriArgs(a, b)[0])),

    vscode.commands.registerCommand('restclient.showConsole', () =>
      vscode.commands.executeCommand(`${CONSOLE_VIEW_ID}.focus`)),

    vscode.commands.registerCommand('restclient.clearConsole', () => consoleView.clear()),

    vscode.commands.registerCommand('restclient.manageCookies', () =>
      CookiePanel.show(context.extensionUri, cookies)),

    // The pane edits the one thing a cookie is usually wrong about. Everything
    // else about it — path, flags, expiry — is a form, and stays in the panel.
    vscode.commands.registerCommand('restclient.editCookie', async (arg?: unknown) => {
      const node = cookieNodeArg(arg);
      if (node?.kind !== 'cookie') { return; }
      const { cookie } = node;

      const value = await vscode.window.showInputBox({
        title: `${cookie.key} — ${cookie.domain}`,
        value: cookie.value,
        prompt: 'Sent on the next request to this domain.'
      });
      if (value === undefined || value === cookie.value) { return; }

      await cookies.upsert({ ...cookie, value });
    }),

    vscode.commands.registerCommand('restclient.deleteCookie', async (arg?: unknown) => {
      const node = cookieNodeArg(arg);
      if (node?.kind !== 'cookie') { return; }
      const { cookie } = node;
      // Deleting one cookie is a click away from being redone by the next run
      // that sets it, so it does not ask; dropping a domain or the jar does.
      await cookies.remove(cookie.domain, cookie.path, cookie.key);
    }),

    vscode.commands.registerCommand('restclient.deleteCookieDomain', async (arg?: unknown) => {
      const node = cookieNodeArg(arg);
      if (node?.kind !== 'domain') { return; }
      const count = node.cookies.length;
      const confirmed = await vscode.window.showWarningMessage(
        `Delete ${count} cookie${count === 1 ? '' : 's'} for ${node.domain}?`,
        { modal: true },
        'Delete'
      );
      if (confirmed !== 'Delete') { return; }
      await cookies.removeDomain(node.domain);
    }),

    vscode.commands.registerCommand('restclient.clearResponses', () => {
      // Responses are only ever held in memory, so this is the whole of it.
      results.clear();
      void vscode.window.showInformationMessage('Cached responses cleared.');
    }),

    vscode.commands.registerCommand('restclient.clearCookies', async () => {
      await cookies.load();
      const count = cookies.count();
      if (!count) {
        void vscode.window.showInformationMessage('No cookies stored.');
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        `Clear ${count} stored cookie${count === 1 ? '' : 's'}?`,
        { modal: true },
        'Clear'
      );
      if (confirmed !== 'Clear') { return; }
      await cookies.clear();
      void vscode.window.showInformationMessage('Cookies cleared.');
    }),

    vscode.commands.registerCommand('restclient.editEnvironment', async (arg?: unknown) => {
      // Invoked three ways: with an id, from an Environments tree row, or bare
      // from the view title bar (where VS Code supplies the focused node).
      let id = stringArg(arg) ?? envNodeArg(arg)?.entry.id ?? activeEnvironmentId();
      if (!id || !store.environment(id)) {
        if (!store.environments.length) {
          void vscode.window.showInformationMessage('No environments imported yet.');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          store.environments.map((e) => ({ label: e.name, id: e.id })),
          { title: 'Edit which environment?' }
        );
        if (!picked) { return; }
        id = picked.id;
      }
      const entry = store.environment(id);
      if (entry) { envPanels.open(entry); }
    }),

    vscode.commands.registerCommand('restclient.newRequest', (arg?: unknown) =>
      createChild(treeNodeArg(arg), 'request')),

    vscode.commands.registerCommand('restclient.newFolder', (arg?: unknown) =>
      createChild(treeNodeArg(arg), 'folder')),

    vscode.commands.registerCommand('restclient.rename', async (arg?: unknown) => {
      const node = treeNodeArg(arg);
      if (node?.kind !== 'item') { return; }
      const name = await vscode.window.showInputBox({
        title: `Rename ${node.node.isFolder ? 'folder' : 'request'}`,
        value: node.node.name,
        validateInput: (v) => (v.trim() ? undefined : 'A name is required.')
      });
      if (!name || name === node.node.name) { return; }
      await store.editCollection(node.entry.uri, renameItem(node.node, name.trim()));
    }),

    vscode.commands.registerCommand('restclient.duplicate', async (arg?: unknown) => {
      const node = treeNodeArg(arg);
      if (node?.kind !== 'item') { return; }
      const edits = duplicateItem(node.entry.materialized.json, node.node);
      if (!edits.length) { return; }

      await store.editCollection(node.entry.uri, edits);
      // The copy lands directly after the original.
      const { arrayPath, index } = locate(node.node);
      await goToNewItem(node.entry.uri, arrayPath, index + 1);
    }),

    vscode.commands.registerCommand('restclient.delete', async (arg?: unknown) => {
      const node = treeNodeArg(arg);
      if (node?.kind !== 'item') { return; }
      const what = node.node.isFolder
        ? `folder "${node.node.name}" and everything in it`
        : `request "${node.node.name}"`;
      const confirmed = await vscode.window.showWarningMessage(
        `Delete the ${what}?`,
        { modal: true, detail: 'This edits the collection file. Undo is available in the editor.' },
        'Delete'
      );
      if (confirmed !== 'Delete') { return; }
      await store.editCollection(node.entry.uri, deleteItem(node.node));
    }),

    vscode.commands.registerCommand('restclient.newCollection', async () => {
      const chosen = await promptForNewFile('collection');
      if (!chosen) { return; }
      try {
        // `overwrite`: the save dialog already got consent for any replacement,
        // and a file this workspace tracks was refused before we got here.
        const entry = await store.createCollection(chosen.uri, chosen.name, { overwrite: true });
        await revealItem({ kind: 'collection', entry });
        // An empty collection does nothing until it holds a request, so offer
        // that rather than leaving the user looking at an empty folder.
        const choice = await vscode.window.showInformationMessage(
          `Created ${entry.name} at ${vscode.workspace.asRelativePath(entry.uri)}.`,
          'New Request'
        );
        if (choice === 'New Request') { await createChild({ kind: 'collection', entry }, 'request'); }
      } catch (e: any) {
        void vscode.window.showErrorMessage(`Could not create the collection: ${e?.message ?? e}`);
      }
    }),

    vscode.commands.registerCommand('restclient.newEnvironment', async () => {
      const chosen = await promptForNewFile('environment');
      if (!chosen) { return; }
      try {
        const entry = await store.createEnvironment(chosen.uri, chosen.name, { overwrite: true });
        await applyEnvironment(entry.id);
        await revealEnvRow(envTreeProvider.environmentNode(entry));
        envPanels.open(entry);
      } catch (e: any) {
        void vscode.window.showErrorMessage(`Could not create the environment: ${e?.message ?? e}`);
      }
    }),

    vscode.commands.registerCommand('restclient.removeEnvironment', async (arg?: unknown) => {
      const node = envNodeArg(arg);
      // A file that would not parse or needs converting has no id and cannot be
      // the active one, so it only ever contributes a name and a path.
      const entry =
        node?.kind === 'environment'
          ? node.entry
          : (brokenNodeArg(arg)?.entry ??
             unsupportedNodeArg(arg)?.entry ??
             missingNodeArg(arg)?.entry);
      if (!entry) { return; }
      const confirmed = await vscode.window.showWarningMessage(
        `Stop working on "${entry.name}"?`,
        { modal: true, detail: untrackDetail(entry) },
        entry.source === 'discovered' ? 'Exclude' : 'Remove'
      );
      if (!confirmed) { return; }
      if ('id' in entry && activeEnvironmentId() === entry.id) {
        await context.workspaceState.update(ACTIVE_ENV_KEY, undefined);
      }
      await store.untrack('environment', entry.uri, entry.source);
      refreshEnvStatus();
      panels.environmentsChanged();
    }),

    vscode.commands.registerCommand('restclient.openEnvironmentFile', async (arg?: unknown) => {
      const entry = envNodeArg(arg)?.entry ?? brokenNodeArg(arg)?.entry;
      if (!entry) { return; }
      const doc = await vscode.workspace.openTextDocument(entry.uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    vscode.commands.registerCommand('restclient.exportEnvironment', async (a?: unknown, b?: unknown) => {
      const id = stringArg(a) ?? envNodeArg(a)?.entry.id;
      if (id) {
        const entry = store.environment(id);
        if (!entry) {
          void vscode.window.showErrorMessage(`Environment "${id}" is no longer available.`);
          return;
        }
        await exportOne('environment', entry, uriArgs(b)[0]);
        return;
      }

      if (!store.environments.length) {
        void vscode.window.showInformationMessage('No environments to export.');
        return;
      }
      if (store.environments.length === 1) {
        await exportOne('environment', store.environments[0]);
        return;
      }
      const picked = await vscode.window.showQuickPick(
        store.environments.map((e) => ({ label: e.name, entry: e })),
        { title: 'Export which environment?' }
      );
      if (picked) { await exportOne('environment', picked.entry); }
    }),

    vscode.commands.registerCommand('restclient.exportAllEnvironments', (a?: unknown, b?: unknown) =>
      exportAll('environment', uriArgs(a, b)[0])),

    vscode.commands.registerCommand('restclient.addVariable', async (arg?: unknown) => {
      const node = envNodeArg(arg);
      if (node?.kind !== 'environment') { return; }

      const existing = new Set(
        (node.entry.json.values ?? []).map((v: any) => String(v?.key ?? ''))
      );
      const key = await vscode.window.showInputBox({
        title: `New variable in ${node.entry.name}`,
        placeHolder: 'baseUrl',
        validateInput: (v) =>
          !v.trim() ? 'A name is required.' : existing.has(v.trim()) ? 'That variable already exists.' : undefined
      });
      if (!key) { return; }

      const value = await vscode.window.showInputBox({
        title: `Value for {{${key.trim()}}}`,
        placeHolder: 'leave empty to fill in later'
      });
      if (value === undefined) { return; }

      await runOnEnvironment(() => store.setEnvironmentVariable(node.entry.id, key.trim(), value));
      await goToVariable(node.entry.id, key.trim());
    }),

    vscode.commands.registerCommand('restclient.editVariable', async (arg?: unknown) => {
      const node = envNodeArg(arg);
      if (node?.kind !== 'variable') { return; }
      const { entry, variable } = node;

      const value = await vscode.window.showInputBox({
        title: `${variable.key} — ${entry.name}`,
        // A stored secret is never echoed back into the box.
        value: variable.secret ? '' : variable.value,
        password: variable.secret,
        placeHolder: variable.secret
          ? variable.hasStoredSecret
            ? 'stored in the keychain — type to replace'
            : 'enter a secret value'
          : undefined,
        prompt: variable.secret ? 'Saved to the OS keychain, not to the file.' : undefined
      });
      if (value === undefined) { return; }

      await runOnEnvironment(() => store.setEnvironmentVariable(entry.id, variable.key, value));
    }),

    vscode.commands.registerCommand('restclient.toggleVariable', async (arg?: unknown) => {
      const node = envNodeArg(arg);
      if (node?.kind !== 'variable') { return; }
      await runOnEnvironment(() =>
        store.setEnvironmentVariableEnabled(node.entry.id, node.variable.key, !node.variable.enabled)
      );
    }),

    vscode.commands.registerCommand('restclient.toggleVariableSecret', async (arg?: unknown) => {
      const node = envNodeArg(arg);
      if (node?.kind !== 'variable') { return; }
      await runOnEnvironment(() =>
        store.setEnvironmentVariableSecret(node.entry.id, node.variable.key, !node.variable.secret)
      );
    }),

    vscode.commands.registerCommand('restclient.moveSecretToKeychain', async (arg?: unknown) => {
      const node = envNodeArg(arg);
      if (node?.kind !== 'variable') { return; }
      await runOnEnvironment(async () => {
        await store.moveSecretToKeychain(node.entry.id, node.variable.key);
        void vscode.window.showInformationMessage(
          `${node.variable.key} moved into the OS keychain and blanked in the file.`
        );
      });
    }),

    vscode.commands.registerCommand('restclient.deleteVariable', async (arg?: unknown) => {
      const node = envNodeArg(arg);
      if (node?.kind !== 'variable') { return; }
      const confirmed = await vscode.window.showWarningMessage(
        `Delete {{${node.variable.key}}} from "${node.entry.name}"?`,
        { modal: true, detail: 'This edits the environment file. Undo is available in the editor.' },
        'Delete'
      );
      if (confirmed !== 'Delete') { return; }
      await runOnEnvironment(() => store.deleteEnvironmentVariable(node.entry.id, node.variable.key));
    }),

    // Activation from the Environments pane, where the row already names the
    // environment — no picker involved.
    vscode.commands.registerCommand('restclient.setActiveEnvironment', async (arg?: unknown) => {
      const id = stringArg(arg) ?? envNodeArg(arg)?.entry.id;
      if (!id || !store.environment(id)) { return; }
      await applyEnvironment(id);
    }),

    vscode.commands.registerCommand('restclient.clearActiveEnvironment', () => applyEnvironment(undefined)),

    // Kept for the status bar, the request editor and the command palette, where
    // there is no list of environments on screen to click.
    vscode.commands.registerCommand('restclient.selectEnvironment', async (arg?: unknown) => {
      // Only a genuine string is a preselection. A view-title button would hand
      // us the tree's focused node, which must fall through to the picker.
      const preselectedId = stringArg(arg);
      if (preselectedId !== undefined) {
        await applyEnvironment(preselectedId || undefined);
        return;
      }

      if (!store.environments.length) {
        const choice = await vscode.window.showInformationMessage(
          'No environments in this workspace yet.',
          'New Environment',
          'Import Environment'
        );
        if (choice === 'New Environment') {
          await vscode.commands.executeCommand('restclient.newEnvironment');
        } else if (choice === 'Import Environment') {
          await vscode.commands.executeCommand('restclient.importEnvironment');
        }
        return;
      }

      const current = activeEnvironmentId();
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'No environment', description: 'Run without environment variables', id: undefined as string | undefined },
          ...store.environments.map((e) => ({
            label: e.name,
            description: e.id === current ? 'current' : `${(e.json.values ?? []).length} variable(s)`,
            id: e.id as string | undefined
          }))
        ],
        { title: 'Select active environment', placeHolder: 'Environment used for variable resolution' }
      );
      if (!picked) { return; }

      await applyEnvironment(picked.id);
    })
  );

  await store.initialize();
  refreshEnvStatus();
  refreshContextKeys();
  log.info('REST Client activated.');

  return {
    store,
    runService,
    panels,
    overviews,
    results,
    envPanels,
    secrets,
    cookies,
    consoleView,
    collectionsView: tree,
    environmentsView: envTree,
    cookiesView: cookieTree,
    collectionsTree: treeProvider,
    environmentsTree: envTreeProvider,
    setCollectionFilter,
    setEnvironmentFilter,
    globalStorageUri: context.globalStorageUri,
    importTarget,
    setActiveEnvironment: (id) => context.workspaceState.update(ACTIVE_ENV_KEY, id),
    activeEnvironmentId
  };
}

export function deactivate(): void {
  // Disposables registered on the context handle teardown, including killing
  // the runner process.
}
