import * as vscode from 'vscode';
import * as path from 'node:path';
import { CollectionStore } from './collections/store';
import { SecretsBroker } from './secrets/broker';
import { RunnerClient } from './runner/client';
import { RunService } from './runner/runService';
import { CollectionTreeProvider, type TreeNode } from './tree/provider';
import { EnvironmentTreeProvider, type EnvTreeNode } from './tree/environmentProvider';
import {
  addItem,
  deleteItem,
  duplicateItem,
  newFolderItem,
  newRequestItem,
  renameItem
} from './collections/structure';
import { RequestPanelManager } from './panels/requestPanel';
import { EnvironmentPanelManager } from './panels/environmentPanel';
import { CookieStore } from './runner/cookieStore';
import { CONSOLE_VIEW_ID, ConsoleViewProvider } from './panels/consoleView';
import { CookiePanel } from './panels/cookiePanel';
import { slugify } from './collections/importer';
import { envNodeArg, stringArg, treeNodeArg, uriArgs } from './commandArgs';

const ACTIVE_ENV_KEY = 'restclient.activeEnvironmentId';
/** SecretStorage cannot be listed, so pm.vault key names are tracked here. */
const VAULT_KEYS_KEY = 'restclient.vaultKeys';
const VIEW_ID = 'restclient.collections';
const ENV_VIEW_ID = 'restclient.environments';

/** Surface handed to the integration tests; not a public extension API. */
export interface TestApi {
  store: CollectionStore;
  runService: RunService;
  panels: RequestPanelManager;
  envPanels: EnvironmentPanelManager;
  secrets: SecretsBroker;
  cookies: CookieStore;
  consoleView: ConsoleViewProvider;
  globalStorageUri: vscode.Uri;
  setActiveEnvironment(id: string | undefined): Thenable<void>;
  activeEnvironmentId(): string | undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<TestApi> {
  const log = vscode.window.createOutputChannel('REST Client', { log: true });
  context.subscriptions.push(log);

  const secrets = new SecretsBroker(context.secrets);
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const store = new CollectionStore(workspaceFolder, secrets, log);
  context.subscriptions.push(store);

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

  const treeProvider = new CollectionTreeProvider(store);
  const tree = vscode.window.createTreeView<TreeNode>(VIEW_ID, {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
    dragAndDropController: treeProvider
  });
  context.subscriptions.push(tree);

  const envTreeProvider = new EnvironmentTreeProvider(store, activeEnvironmentId);
  context.subscriptions.push(
    vscode.window.createTreeView<EnvTreeNode>(ENV_VIEW_ID, { treeDataProvider: envTreeProvider })
  );

  const panels = new RequestPanelManager(context, store, runService, activeEnvironmentId);
  context.subscriptions.push(panels);

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
    void vscode.commands.executeCommand('setContext', 'restclient:hasWorkspace', Boolean(workspaceFolder));
    void vscode.commands.executeCommand(
      'setContext',
      'restclient:hasEnvironments',
      store.environments.length > 0
    );
  };

  store.onDidChange(() => {
    // An environment file may have been deleted out from under the selection.
    if (activeEnvironmentId() && !store.environment(activeEnvironmentId()!)) {
      void context.workspaceState.update(ACTIVE_ENV_KEY, undefined);
    }
    refreshEnvStatus();
    refreshContextKeys();
    panels.environmentsChanged();
  });

  /**
   * Create a request or folder under the given node.
   *
   * Invoked from a tree item the parent is obvious; from the view title bar it
   * is not, so ask when there is more than one collection.
   */
  const createChild = async (node: TreeNode | undefined, kind: 'request' | 'folder') => {
    let entry = node?.entry;
    if (!entry) {
      if (!store.collections.length) {
        void vscode.window.showInformationMessage('Import a collection first.');
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
    await store.editCollection(entry.uri, addItem(parent, item));
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

  // --- commands -----------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('restclient.refresh', () => store.reload()),

    // `a`/`b` are deliberately untyped: the explorer passes (uri, uris[]) and the
    // view-title button passes the tree's focused node, not a Uri at all.
    vscode.commands.registerCommand('restclient.import', async (a?: unknown, b?: unknown) => {
      if (!workspaceFolder) {
        void vscode.window.showErrorMessage('Open a folder first — collections are stored in the workspace.');
        return;
      }

      let sources: vscode.Uri[] | undefined = uriArgs(a, b);
      if (!sources.length) {
        sources = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: 'Import',
          filters: { 'Postman export': ['json'] },
          title: 'Import Postman collections or environments'
        });
      }
      if (!sources?.length) { return; }

      const added: string[] = [];
      const warnings: string[] = [];
      for (const source of sources) {
        try {
          const result = await store.register(source);

          if (result.convertFrom) {
            // Editing needs v2.1.0, and converting rewrites a file we do not
            // own — so ask before touching it.
            const choice = await vscode.window.showWarningMessage(
              `${path.basename(source.fsPath)} is a Postman v${result.convertFrom} collection.`,
              { modal: true, detail: 'Editing requires the v2.1.0 format. Convert this file in place?' },
              'Convert'
            );
            if (choice !== 'Convert') { continue; }
            await store.convert(source, result.convertFrom);
            warnings.push(`Converted ${path.basename(source.fsPath)} from v${result.convertFrom} to v2.1.0.`);
          }

          added.push(`${result.name} (${result.kind})`);
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
        void vscode.window.showInformationMessage(
          `Now working on ${added.join(', ')}.${detail}`
        );
      }
    }),

    vscode.commands.registerCommand('restclient.removeFromWorkspace', async (arg?: unknown) => {
      const node = treeNodeArg(arg);
      if (!node) { return; }
      const confirmed = await vscode.window.showWarningMessage(
        `Stop working on "${node.entry.name}"?`,
        { modal: true, detail: `${node.entry.uri.fsPath} stays exactly where it is — only this workspace's list changes.` },
        'Remove'
      );
      if (confirmed !== 'Remove') { return; }
      await store.unregister('collection', node.entry.uri);
    }),

    vscode.commands.registerCommand('restclient.openRequest', (arg?: unknown) => {
      const node = treeNodeArg(arg);
      if (node?.kind !== 'item' || node.node.isFolder) { return; }
      panels.open(node.entry, node.node);
    }),

    vscode.commands.registerCommand('restclient.openCollectionFile', async (arg?: unknown) => {
      const node = treeNodeArg(arg);
      if (!node) { return; }
      const doc = await vscode.workspace.openTextDocument(node.entry.uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    vscode.commands.registerCommand('restclient.showConsole', () =>
      vscode.commands.executeCommand(`${CONSOLE_VIEW_ID}.focus`)),

    vscode.commands.registerCommand('restclient.clearConsole', () => consoleView.clear()),

    vscode.commands.registerCommand('restclient.manageCookies', () =>
      CookiePanel.show(context.extensionUri, cookies)),

    vscode.commands.registerCommand('restclient.clearResponses', () => {
      // Responses are only ever held in memory, so this is the whole of it.
      panels.clearResponses();
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
      await store.editCollection(
        node.entry.uri,
        duplicateItem(node.entry.materialized.json, node.node)
      );
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

    vscode.commands.registerCommand('restclient.newEnvironment', async () => {
      if (!workspaceFolder) {
        void vscode.window.showErrorMessage('Open a folder first — the new environment needs somewhere to live.');
        return;
      }
      const name = await vscode.window.showInputBox({
        title: 'New environment name',
        value: 'New Environment',
        validateInput: (v) => (v.trim() ? undefined : 'A name is required.')
      });
      if (!name) { return; }

      const file = `${slugify(name.trim())}.postman_environment.json`;
      const uri = vscode.Uri.joinPath(workspaceFolder.uri, file);
      try {
        const entry = await store.createEnvironment(uri, name.trim());
        await vscode.commands.executeCommand('restclient.selectEnvironment', entry.id);
        envPanels.open(entry);
      } catch (e: any) {
        void vscode.window.showErrorMessage(`Could not create the environment: ${e?.message ?? e}`);
      }
    }),

    vscode.commands.registerCommand('restclient.removeEnvironment', async (arg?: unknown) => {
      const node = envNodeArg(arg);
      if (node?.kind !== 'environment') { return; }
      const confirmed = await vscode.window.showWarningMessage(
        `Stop working on "${node.entry.name}"?`,
        {
          modal: true,
          detail: `${node.entry.uri.fsPath} stays exactly where it is — only this workspace's list changes.`
        },
        'Remove'
      );
      if (confirmed !== 'Remove') { return; }
      if (activeEnvironmentId() === node.entry.id) {
        await context.workspaceState.update(ACTIVE_ENV_KEY, undefined);
      }
      await store.unregister('environment', node.entry.uri);
      refreshEnvStatus();
      panels.environmentsChanged();
    }),

    vscode.commands.registerCommand('restclient.openEnvironmentFile', async (arg?: unknown) => {
      const node = envNodeArg(arg);
      if (!node) { return; }
      const doc = await vscode.workspace.openTextDocument(node.entry.uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

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

    vscode.commands.registerCommand('restclient.selectEnvironment', async (arg?: unknown) => {
      // Only a genuine string is a preselection. The view-title button hands us
      // the tree's focused node, which must fall through to the picker.
      const preselectedId = stringArg(arg);
      if (preselectedId !== undefined) {
        await context.workspaceState.update(ACTIVE_ENV_KEY, preselectedId || undefined);
        refreshEnvStatus();
        panels.environmentsChanged();
        return;
      }

      if (!store.environments.length) {
        const choice = await vscode.window.showInformationMessage(
          'No environments imported yet.',
          'Import environment'
        );
        if (choice) { await vscode.commands.executeCommand('restclient.import'); }
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

      await context.workspaceState.update(ACTIVE_ENV_KEY, picked.id);
      refreshEnvStatus();
      panels.environmentsChanged();
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
    envPanels,
    secrets,
    cookies,
    consoleView,
    globalStorageUri: context.globalStorageUri,
    setActiveEnvironment: (id) => context.workspaceState.update(ACTIVE_ENV_KEY, id),
    activeEnvironmentId
  };
}

export function deactivate(): void {
  // Disposables registered on the context handle teardown, including killing
  // the runner process.
}
