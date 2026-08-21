import * as assert from 'node:assert';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import type { RunnerMessage } from '../../src/runner/protocol';
import type { ItemNode } from '../../src/collections/model';
import { CookiePanel } from '../../src/panels/cookiePanel';
import { EnvironmentTreeProvider } from '../../src/tree/environmentProvider';
import { CookieTreeProvider } from '../../src/tree/cookieProvider';
import { CollectionTreeProvider } from '../../src/tree/provider';
import { buildRequestEdits } from '../../src/collections/edits';
import { exportFileNames } from '../../src/collections/export';
import { ImportTarget } from '../../src/collections/importTarget';
import {
  addItem,
  deleteItem,
  duplicateItem,
  newFolderItem,
  newRequestItem,
  renameItem
} from '../../src/collections/structure';

const EXTENSION_ID = 'davidvogel94.restclient';
const TEST_ENV_FILE = 'test-local.postman_environment.json';

function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = req.headers.authorization ?? null;
    res.setHeader('Content-Type', 'application/json');

    if (url.pathname === '/login') {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () =>
        res.end(JSON.stringify({ token: 'tok-' + Buffer.byteLength(body), sawAuth: auth })));
    }
    if (url.pathname === '/me') {
      return res.end(
        JSON.stringify({
          sawAuth: auth,
          cookie: req.headers.cookie ?? null,
          query: Object.fromEntries(url.searchParams)
        })
      );
    }
    if (url.pathname === '/ping') { return res.end(JSON.stringify({ pong: true })); }
    // Long enough that a run against it is reliably still in flight when the
    // test presses Stop, and unref'd so it can never hold the suite open.
    if (url.pathname === '/slow') {
      const timer = setTimeout(() => res.end(JSON.stringify({ slow: true })), 10000);
      timer.unref?.();
      return req.on('close', () => clearTimeout(timer));
    }
    res.statusCode = 404;
    res.end('{}');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r()))
      });
    });
  });
}

/**
 * Put a file back, then make sure VS Code is not holding a stale copy of it.
 * Writing behind an open TextDocument leaves the editor out of sync and the
 * next save fails with "File Modified Since".
 */
/**
 * Ad-hoc fixture files these tests create and delete as they go.
 *
 * Files are worked on in place now, so the store only sees what the workspace's
 * `restclient.*` settings list. Rather than registering and unregistering
 * around every individual test, the whole set is tracked for the duration of
 * the suite — a tracked path that does not exist is simply skipped on reload.
 */
const SCRATCH_COLLECTIONS = [
  'api/unopened.postman_collection.json',
  'api/cookie-send.postman_collection.json',
  'api/broken.postman_collection.json',
  'api/never-written.postman_collection.json'
];
const SCRATCH_ENVIRONMENTS = [
  `api/${TEST_ENV_FILE}`,
  'api/secret-test.postman_environment.json',
  'api/mount-test.postman_environment.json',
  'api/broken.postman_environment.json'
];

const BASE_COLLECTIONS = ['api/smoke.postman_collection.json'];
const BASE_ENVIRONMENTS = ['api/local.postman_environment.json'];

async function setRegistry(collections: string[], environments: string[]): Promise<void> {
  const folder = vscode.workspace.workspaceFolders![0];
  const config = vscode.workspace.getConfiguration('restclient', folder.uri);
  await config.update('collections', collections, vscode.ConfigurationTarget.Workspace);
  await config.update('environments', environments, vscode.ConfigurationTarget.Workspace);
}

/** Put the fixture workspace's tracked-file settings back to their committed state. */
async function resetRegistry(): Promise<void> {
  await setRegistry(BASE_COLLECTIONS, BASE_ENVIRONMENTS);
}

/**
 * Put back the registry the suite runs on, scratch files included.
 *
 * Not `resetRegistry`, which strips the scratch paths and is only for teardown:
 * a test that borrows the setting has to hand back what it borrowed, or every
 * test after it loses its fixture.
 */
async function restoreSuiteRegistry(): Promise<void> {
  await setRegistry(
    [...BASE_COLLECTIONS, ...SCRATCH_COLLECTIONS],
    [...BASE_ENVIRONMENTS, ...SCRATCH_ENVIRONMENTS]
  );
}

/**
 * Run a body with the workspace scan on.
 *
 * The fixture keeps it off, because `setRegistry([], [])` has to keep meaning
 * "nothing is tracked" for every other test in this suite — with the scan on,
 * the fixture's own `api/*.postman_*.json` files would be picked up and every
 * count here would be measuring something else. Discovery tests opt in.
 */
async function withDiscovery(
  api: TestApi,
  patterns: string[] | undefined,
  body: () => Promise<void>
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders![0];
  const config = vscode.workspace.getConfiguration('restclient', folder.uri);
  await config.update('autoDiscover', true, vscode.ConfigurationTarget.Workspace);
  if (patterns) {
    await config.update('discoverPatterns', patterns, vscode.ConfigurationTarget.Workspace);
  }
  await api.store.rescan();
  try {
    await body();
  } finally {
    const reset = vscode.workspace.getConfiguration('restclient', folder.uri);
    await reset.update('autoDiscover', false, vscode.ConfigurationTarget.Workspace);
    await reset.update('discoverPatterns', undefined, vscode.ConfigurationTarget.Workspace);
    await reset.update('discoverExclude', undefined, vscode.ConfigurationTarget.Workspace);
    await api.store.rescan();
  }
}

/** A minimal but genuine v2.1.0 collection, so `detect` accepts it. */
function collectionJson(id: string, name: string): string {
  return JSON.stringify({
    info: {
      _postman_id: id,
      name,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
    },
    item: []
  });
}

/** A v1 collection: a flat `requests` array and an `order` list, no `info.schema`. */
function v1CollectionJson(name: string): string {
  return JSON.stringify({
    id: 'v1-collection',
    name,
    order: ['req-1'],
    requests: [{ id: 'req-1', name: 'Ping', method: 'GET', url: 'https://example.com/ping' }]
  });
}

async function write(uri: vscode.Uri, text: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
}

async function read(uri: vscode.Uri): Promise<string> {
  return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function remove(uri: vscode.Uri): Promise<void> {
  await vscode.workspace.fs.delete(uri, { useTrash: false, recursive: true }).then(
    undefined,
    () => undefined
  );
}

function configured(setting: string): string[] {
  const folder = vscode.workspace.workspaceFolders![0];
  return vscode.workspace.getConfiguration('restclient', folder.uri).get<string[]>(setting, []);
}

/**
 * Wait for something a run does on its own schedule.
 *
 * Mid-run assertions have nothing to await: the run is a promise that resolves
 * when it is over, which is exactly the state being tested against.
 */
async function waitFor(
  condition: () => boolean,
  what: string,
  timeoutMs = 15000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) { throw new Error(`Timed out waiting: ${what}`); }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function restore(api: TestApi, uri: vscode.Uri, text: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
  const open = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === uri.toString() && !d.isClosed
  );
  if (open) {
    await vscode.window.showTextDocument(open, { preview: false });
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  }
  await api.store.reload();
}

suite('REST Client extension', () => {
  let api: TestApi;
  let envUri: vscode.Uri;

  suiteSetup(async function () {
    this.timeout(60000);
    const extension = vscode.extensions.getExtension<TestApi>(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} should be present`);
    api = await extension.activate();

    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'the fixture workspace should be open');
    envUri = vscode.Uri.joinPath(folder.uri, 'api', TEST_ENV_FILE);

    await setRegistry(
      [...BASE_COLLECTIONS, ...SCRATCH_COLLECTIONS],
      [...BASE_ENVIRONMENTS, ...SCRATCH_ENVIRONMENTS]
    );
    await api.store.reload();
  });

  suiteTeardown(async () => {
    await vscode.workspace.fs.delete(envUri, { useTrash: false }).then(undefined, () => undefined);
    await resetRegistry();
  });

  test('activates and loads the fixture collection from the workspace', () => {
    assert.equal(api.store.collections.length, 1, 'one collection should be discovered');
    const collection = api.store.collections[0];
    assert.equal(collection.name, 'Smoke');
    assert.deepEqual(
      collection.materialized.tree.map((n) => n.name),
      ['Login', 'Me']
    );
    assert.deepEqual(
      collection.materialized.tree.map((n) => n.method),
      ['POST', 'GET']
    );
  });

  test('every command the manifest declares is actually registered', async () => {
    // Checking the manifest rather than a hand-kept list: a menu entry pointing
    // at a command nobody registered fails silently at runtime.
    const extension = vscode.extensions.getExtension<TestApi>(EXTENSION_ID)!;
    const declared: string[] = (extension.packageJSON.contributes?.commands ?? []).map(
      (c: { command: string }) => c.command
    );
    assert.ok(declared.length > 10, 'the manifest should declare commands');

    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = declared.filter((id) => !registered.has(id));
    assert.deepEqual(missing, [], `declared but not registered: ${missing.join(', ')}`);
  });

  test('runs a request end to end, with scripts, and persists env mutations', async function () {
    this.timeout(60000);
    const server = await startServer();
    try {
      // A dedicated environment pointing at the test server; removed in teardown.
      await vscode.workspace.fs.writeFile(
        envUri,
        Buffer.from(
          JSON.stringify(
            {
              id: 'env-test-local',
              name: 'Test Local',
              values: [
                { key: 'baseUrl', value: server.url, type: 'default', enabled: true },
                { key: 'user', value: 'alice', type: 'default', enabled: true },
                { key: 'pass', value: 's3cr3t', type: 'default', enabled: true }
              ],
              _postman_variable_scope: 'environment'
            },
            null,
            '\t'
          ),
          'utf8'
        )
      );

      await api.store.reload();
      await api.setActiveEnvironment('env-test-local');

      const entry = api.store.collections[0];
      const login = entry.materialized.tree.find((n) => n.name === 'Login');
      assert.ok(login, 'the Login request should exist');

      const messages: RunnerMessage[] = [];
      const handle = await api.runService.start({ entry, itemId: login.id }, (m) => messages.push(m));
      await handle.completion;

      const responses = messages.filter((m) => m.type === 'response');
      assert.equal(responses.length, 1, 'exactly one collection-level response');
      assert.equal(responses[0].type === 'response' && responses[0].response.code, 200);

      const assertions = messages
        .filter((m) => m.type === 'assertion')
        .flatMap((m) => (m.type === 'assertion' ? m.assertions : []));
      assert.ok(assertions.length >= 4, `expected the Login tests to run, got ${assertions.length}`);
      assert.deepEqual(
        assertions.filter((a) => !a.passed).map((a) => `${a.name}: ${a.error?.message}`),
        [],
        'every test in the Login request should pass'
      );

      // `pm.environment.set('token', ...)` must survive back into the file.
      await new Promise((r) => setTimeout(r, 500));
      await api.store.reload();
      const env = api.store.environment('env-test-local');
      const token = (env?.json.values ?? []).find((v: any) => v.key === 'token');
      assert.ok(token, 'the script-set token should be persisted to the environment file');
      assert.ok(String(token.value).startsWith('tok-'), `unexpected token: ${token.value}`);
    } finally {
      await server.close();
    }
  });

  test('running a request from its row leaves the outcome on the row', async function () {
    this.timeout(60000);
    const server = await startServer();
    api.results.clear();

    try {
      await vscode.workspace.fs.writeFile(
        envUri,
        Buffer.from(
          JSON.stringify({
            id: 'env-test-local',
            name: 'Test Local',
            values: [
              { key: 'baseUrl', value: server.url, type: 'default', enabled: true },
              { key: 'user', value: 'alice', type: 'default', enabled: true },
              { key: 'pass', value: 's3cr3t', type: 'default', enabled: true }
            ],
            _postman_variable_scope: 'environment'
          }),
          'utf8'
        )
      );
      await api.store.reload();
      await api.setActiveEnvironment('env-test-local');

      const entry = api.store.collections[0];
      const login = entry.materialized.tree.find((n) => n.name === 'Login')!;
      const node = { kind: 'item' as const, entry, node: login };
      const provider = new CollectionTreeProvider(api.store, api.results);

      // Until it has been run there is nothing to report, and the row says only
      // what the request is.
      assert.equal(provider.getTreeItem(node).description, 'POST');

      await vscode.commands.executeCommand('restclient.runRequest', node);

      const item = provider.getTreeItem(node);
      assert.match(
        String(item.description),
        /^POST · 200 · ✓ \d+$/,
        `the row should carry the status and the tests, got "${item.description}"`
      );

      const tooltip = item.tooltip as vscode.MarkdownString;
      assert.match(tooltip.value, /200 OK/, 'the tooltip spells the status out');
      assert.match(tooltip.value, /\d+ passed/, 'and says how the tests went');

      // Clearing the cached responses takes the hint with it — the run is not
      // recorded anywhere else, which is the point.
      api.results.clear();
      assert.equal(provider.getTreeItem(node).description, 'POST');
    } finally {
      const reopened = api.store.collections[0];
      const login = reopened.materialized.tree.find((n) => n.name === 'Login');
      if (login) { api.panels.open(reopened, login).dispose(); }
      await server.close();
    }
  });

  test('the collection overview webview mounts and is one tab per container', async function () {
    this.timeout(30000);
    const entry = api.store.collections[0];

    const panel = api.overviews.open(entry);
    try {
      // whenReady only settles once the bundled Svelte app has run and posted
      // back, so this fails if the CSP blocks the script or the app throws.
      await Promise.race([
        panel.whenReady,
        new Promise((_r, reject) =>
          setTimeout(() => reject(new Error('overview never reported ready — check CSP and bundle')), 15000)
        )
      ]);
      assert.equal(
        api.overviews.open(api.store.collections[0]),
        panel,
        'asking again reveals the tab that is already open rather than stacking another'
      );
    } finally {
      panel.dispose();
    }
  });

  test('clicking a collection or folder row opens its overview', async function () {
    this.timeout(30000);
    const entry = api.store.collections[0];
    const original = Buffer.from(await vscode.workspace.fs.readFile(entry.uri)).toString('utf8');
    const provider = new CollectionTreeProvider(api.store);

    try {
      await api.store.editCollection(entry.uri, addItem(undefined, newFolderItem('Admin')));
      const reloaded = api.store.collections[0];
      const folder = reloaded.materialized.tree.find((n) => n.name === 'Admin')!;

      // A click goes through its own command, not the menu's Open Overview: only
      // a click decides whether the row it landed on should open or shut.
      const collectionRow = provider.getTreeItem({ kind: 'collection', entry: reloaded });
      assert.equal(collectionRow.command?.command, 'restclient.clickRow');
      const folderRow = provider.getTreeItem({ kind: 'item', entry: reloaded, node: folder });
      assert.equal(folderRow.command?.command, 'restclient.clickRow');

      // The row hands the command its own node, which is what tells a folder
      // overview apart from its collection's.
      await vscode.commands.executeCommand('restclient.clickRow', folderRow.command!.arguments![0]);
      const opened = api.overviews.open(api.store.collections[0], folder);
      try {
        assert.ok(opened, 'the folder has a tab of its own');
      } finally {
        opened.dispose();
      }
      api.overviews.open(api.store.collections[0]).dispose();
    } finally {
      await restore(api, entry.uri, original);
    }
  });

  test('a container row carries the toggle its own state calls for', async function () {
    this.timeout(30000);
    const entry = api.store.collections[0];
    const original = Buffer.from(await vscode.workspace.fs.readFile(entry.uri)).toString('utf8');
    const provider = new CollectionTreeProvider(api.store);

    try {
      await api.store.editCollection(entry.uri, addItem(undefined, newFolderItem('Admin')));
      const reloaded = api.store.collections[0];
      const collection = { kind: 'collection' as const, entry: reloaded };
      const admin = reloaded.materialized.tree.find((n) => n.name === 'Admin')!;

      const open = provider.getTreeItem(collection);
      assert.equal(open.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
      assert.equal(open.contextValue, 'collectionExpanded', 'so the row offers Collapse');

      provider.setExpansion(collection, false);
      const shut = provider.getTreeItem(collection);
      assert.equal(shut.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
      assert.equal(shut.contextValue, 'collectionCollapsed', 'and now offers Expand');
      assert.notEqual(shut.id, open.id, 'a row VS Code has not drawn, or it keeps the old state');

      // Whatever the tree does of its own accord is what the button follows.
      provider.noteExpansion(collection, true);
      assert.equal(provider.getTreeItem(collection).contextValue, 'collectionExpanded');

      // An empty folder has nothing to open, so it is offered neither button.
      const emptyRow = provider.getTreeItem({ kind: 'item', entry: reloaded, node: admin });
      assert.equal(emptyRow.contextValue, 'folder');

      // Nor does a folder of nothing but requests: Expand All there is the one
      // level the twistie already does, so the buttons stay off the row.
      await api.store.editCollection(reloaded.uri, addItem(admin, newRequestItem('Ping')));
      const filled = api.store.collections[0];
      const withRequest = filled.materialized.tree.find((n) => n.name === 'Admin')!;
      assert.equal(
        provider.getTreeItem({ kind: 'item', entry: filled, node: withRequest }).contextValue,
        'folder'
      );

      await api.store.editCollection(filled.uri, addItem(withRequest, newFolderItem('Keys')));
      const nested = api.store.collections[0];
      const withFolder = nested.materialized.tree.find((n) => n.name === 'Admin')!;
      assert.equal(
        provider.getTreeItem({ kind: 'item', entry: nested, node: withFolder }).contextValue,
        'folderCollapsed',
        'a folder with a folder in it has something to open, starts shut, and says so'
      );
    } finally {
      await restore(api, entry.uri, original);
    }
  });

  test('the toggle takes every folder under the row with it', async function () {
    this.timeout(30000);
    const entry = api.store.collections[0];
    const original = Buffer.from(await vscode.workspace.fs.readFile(entry.uri)).toString('utf8');
    const provider = new CollectionTreeProvider(api.store);

    const find = (nodes: ItemNode[], name: string): ItemNode | undefined => {
      for (const node of nodes) {
        if (node.name === name) { return node; }
        const deeper = find(node.children, name);
        if (deeper) { return deeper; }
      }
      return undefined;
    };

    try {
      // Admin > Keys > Ping: two levels of folder, so "all the way down" is a
      // claim the tree can actually contradict.
      await api.store.editCollection(entry.uri, addItem(undefined, newFolderItem('Admin')));
      await api.store.editCollection(
        entry.uri,
        addItem(find(api.store.collections[0].materialized.tree, 'Admin')!, newFolderItem('Keys'))
      );
      await api.store.editCollection(
        entry.uri,
        addItem(find(api.store.collections[0].materialized.tree, 'Keys')!, newRequestItem('Ping'))
      );

      const reloaded = api.store.collections[0];
      const collection = { kind: 'collection' as const, entry: reloaded };
      const row = (name: string) =>
        provider.getTreeItem({ kind: 'item', entry: reloaded, node: find(reloaded.materialized.tree, name)! });

      // Keys holds only a request, so it carries no buttons of its own — its
      // collapsible state is what says whether the toggle reached it.
      provider.setExpansion(collection, true);
      assert.equal(row('Admin').contextValue, 'folderExpanded', 'the folder on the row came open');
      assert.equal(
        row('Keys').collapsibleState,
        vscode.TreeItemCollapsibleState.Expanded,
        'and so did the one inside it'
      );

      const openKeys = row('Keys').id;
      provider.setExpansion(collection, false);
      assert.equal(provider.getTreeItem(collection).contextValue, 'collectionCollapsed');
      assert.equal(row('Admin').contextValue, 'folderCollapsed', 'the whole subtree went away');
      assert.equal(row('Keys').collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
      assert.notEqual(row('Keys').id, openKeys, 'a nested row VS Code has not drawn, or it keeps the old state');

      // Pressed on a folder rather than a collection, which is the case that
      // used to do nothing: the redraw was aimed at the parent, and a parent
      // rebuilt from the store is never the node object VS Code is holding, so
      // the event went nowhere. It has to come from the root.
      const admin = { kind: 'item' as const, entry: reloaded, node: find(reloaded.materialized.tree, 'Admin')! };
      const fired: unknown[] = [];
      const listener = provider.onDidChangeTreeData((arg) => fired.push(arg));
      try {
        provider.setExpansion(admin, true);
      } finally {
        listener.dispose();
      }
      assert.deepEqual(fired, [undefined], 'the root redraws, so the new ids are actually drawn');
      assert.equal(row('Admin').contextValue, 'folderExpanded');
      assert.equal(
        row('Keys').collapsibleState,
        vscode.TreeItemCollapsibleState.Expanded,
        'and the folder inside it came with it'
      );
    } finally {
      await restore(api, entry.uri, original);
    }
  });

  test('a click shuts one row and leaves what is under it as it was', async function () {
    this.timeout(30000);
    const entry = api.store.collections[0];
    const original = Buffer.from(await vscode.workspace.fs.readFile(entry.uri)).toString('utf8');
    const provider = new CollectionTreeProvider(api.store);

    const find = (nodes: ItemNode[], name: string): ItemNode | undefined => {
      for (const node of nodes) {
        if (node.name === name) { return node; }
        const deeper = find(node.children, name);
        if (deeper) { return deeper; }
      }
      return undefined;
    };

    try {
      await api.store.editCollection(entry.uri, addItem(undefined, newFolderItem('Admin')));
      await api.store.editCollection(
        entry.uri,
        addItem(find(api.store.collections[0].materialized.tree, 'Admin')!, newFolderItem('Keys'))
      );

      const reloaded = api.store.collections[0];
      const collection = { kind: 'collection' as const, entry: reloaded };
      const node = (name: string) => ({
        kind: 'item' as const,
        entry: reloaded,
        node: find(reloaded.materialized.tree, name)!
      });

      provider.setExpansion(collection, true);
      assert.ok(provider.isExpanded(node('Keys')), 'the whole subtree is open to start with');

      // What a click on a row that is already open and already selected does,
      // and it is the twistie's one level: the folder inside keeps the state the
      // user left it in, so opening Admin again does not present it as freshly
      // tidied.
      const openKeys = provider.getTreeItem(node('Keys')).id;
      provider.setRowExpansion(node('Admin'), false);
      assert.equal(provider.getTreeItem(node('Admin')).contextValue, 'folderCollapsed');
      assert.ok(!provider.isExpanded(node('Admin')));
      assert.ok(provider.isExpanded(node('Keys')), 'the folder inside was not touched');
      assert.equal(provider.getTreeItem(node('Keys')).id, openKeys, 'nor was it redrawn');

      // Asking for the state a row is already in changes nothing — no redraw,
      // so no row is replaced under a selection for no reason.
      const fired: unknown[] = [];
      const listener = provider.onDidChangeTreeData((arg) => fired.push(arg));
      try {
        provider.setRowExpansion(node('Admin'), false);
      } finally {
        listener.dispose();
      }
      assert.deepEqual(fired, [], 'a row already shut is left alone');
    } finally {
      await restore(api, entry.uri, original);
    }
  });

  test('Run All from an overview records every request it reached', async function () {
    this.timeout(60000);
    const server = await startServer();
    api.results.clear();

    try {
      await vscode.workspace.fs.writeFile(
        envUri,
        Buffer.from(
          JSON.stringify({
            id: 'env-test-local',
            name: 'Test Local',
            values: [
              { key: 'baseUrl', value: server.url, type: 'default', enabled: true },
              { key: 'user', value: 'alice', type: 'default', enabled: true },
              { key: 'pass', value: 's3cr3t', type: 'default', enabled: true }
            ],
            _postman_variable_scope: 'environment'
          }),
          'utf8'
        )
      );
      await api.store.reload();
      await api.setActiveEnvironment('env-test-local');

      const entry = api.store.collections[0];
      const provider = new CollectionTreeProvider(api.store, api.results);
      const panel = api.overviews.open(entry);
      try {
        await panel.whenReady;
        await panel.runAll();

        const reloaded = api.store.collections[0];
        for (const name of ['Login', 'Me']) {
          const node = reloaded.materialized.tree.find((n) => n.name === name)!;
          const last = api.results.lastRun(reloaded.uri, node.id);
          assert.ok(last, `${name} should have a result after Run All`);
          assert.equal(last.running, false, `${name} should not be left claiming to run`);
          assert.equal(last.summary?.code, 200, `${name} should have come back 200`);
          // The same record the tree and the request editor read, so one run
          // lights up all three.
          assert.match(
            String(provider.getTreeItem({ kind: 'item', entry: reloaded, node }).description),
            /· 200/,
            `the ${name} row should carry the status Run All got`
          );
        }
      } finally {
        panel.dispose();
      }
    } finally {
      api.results.clear();
      await server.close();
    }
  });

  test('a run in flight turns the row buttons into Stop, and Stop ends it', async function () {
    this.timeout(60000);
    const server = await startServer();
    const entry = api.store.collections[0];
    const original = Buffer.from(await vscode.workspace.fs.readFile(entry.uri)).toString('utf8');
    const provider = new CollectionTreeProvider(api.store, api.results, api.runService);
    api.results.clear();

    try {
      await vscode.workspace.fs.writeFile(
        envUri,
        Buffer.from(
          JSON.stringify({
            id: 'env-test-local',
            name: 'Test Local',
            values: [{ key: 'baseUrl', value: server.url, type: 'default', enabled: true }],
            _postman_variable_scope: 'environment'
          }),
          'utf8'
        )
      );
      await api.store.reload();
      await api.setActiveEnvironment('env-test-local');

      // A request that will not answer for ten seconds, so the run is still
      // going while the assertions look at it.
      await api.store.editCollection(
        entry.uri,
        addItem(undefined, {
          name: 'Slow',
          request: { method: 'GET', header: [], url: '{{baseUrl}}/slow' }
        })
      );

      const loaded = api.store.collections[0];
      const slow = loaded.materialized.tree.find((n) => n.name === 'Slow')!;
      const panel = api.overviews.open(loaded, undefined);
      try {
        await panel.whenReady;
        // Not awaited: the point is what everything looks like mid-run. Slow
        // sits last in the collection, so the two quick requests ahead of it
        // are done by the time it is the one in flight.
        const run = panel.runAll();

        await waitFor(
          () => api.results.lastRun(loaded.uri, slow.id)?.running === true,
          'the slow request never started'
        );

        const running = api.store.collections[0];
        const node = running.materialized.tree.find((n) => n.name === 'Slow')!;
        assert.equal(
          provider.getTreeItem({ kind: 'item', entry: running, node }).contextValue,
          'requestRunning',
          'so the row offers Stop where Run was'
        );
        assert.match(
          String(provider.getTreeItem({ kind: 'collection', entry: running }).contextValue),
          /Running$/,
          'and the collection above it offers Stop instead of Run All'
        );
        assert.ok(
          api.runService.runningIn(running.uri, node.id),
          'the run service places the run on that request'
        );

        // Exactly what the red button on the row is wired to.
        await vscode.commands.executeCommand('restclient.stopRun', { kind: 'item', entry: running, node });
        await run;

        const after = api.store.collections[0];
        const stopped = after.materialized.tree.find((n) => n.name === 'Slow')!;
        assert.equal(
          api.results.lastRun(after.uri, stopped.id)?.running,
          false,
          'a stopped request must not be left claiming to run'
        );
        assert.equal(api.runService.runningIn(after.uri), false, 'and the run itself is over');
        assert.equal(
          provider.getTreeItem({ kind: 'item', entry: after, node: stopped }).contextValue,
          'request',
          'so the row offers Run again'
        );
      } finally {
        panel.dispose();
      }
    } finally {
      api.results.clear();
      await restore(api, entry.uri, original);
      await server.close();
    }
  });

  test('Stop belongs to the row that is running, and Run to the row that is not', () => {
    const extension = vscode.extensions.getExtension<TestApi>(EXTENSION_ID)!;
    const items: Array<{ command: string; when: string; group: string }> =
      extension.packageJSON.contributes.menus['view/item/context'];

    const stop = items.filter((e) => e.command === 'restclient.stopRun');
    assert.ok(
      stop.some((e) => e.group.startsWith('inline')),
      'Stop should be an inline button, where Run and Run All are'
    );
    // One for a request, one for a container: the two buttons it stands in for.
    assert.ok(
      stop.some((e) => e.when.includes('viewItem == requestRunning')),
      'a running request should offer Stop'
    );
    assert.ok(
      stop.some((e) => /\(collection\|folder\)\(Expanded\|Collapsed\)\?Running\$/.test(e.when)),
      'a container with a run in it should offer Stop'
    );
    for (const entry of stop) {
      assert.match(entry.when, /Running/, 'Stop is only ever offered while something is running');
    }

    // And the row menu does not empty out for the duration of a run: every
    // other entry has to still match a row wearing the Running marker.
    const matchers = ['collectionExpandedRunning', 'folderRunning', 'requestRunning'];
    for (const entry of items) {
      if (!entry.when.includes('restclient.collections')) { continue; }
      // Run and Run All are the two that are meant to go: Stop takes their
      // place, which is the whole point of the marker.
      if (['restclient.stopRun', 'restclient.runRequest', 'restclient.runAll'].includes(entry.command)) {
        continue;
      }
      const pattern = /viewItem =~ \/(\S+)\//.exec(entry.when)?.[1];
      if (!pattern) { continue; }
      const bare = matchers
        .map((value) => value.replace('Running', ''))
        .filter((value) => new RegExp(pattern).test(value));
      for (const value of bare) {
        assert.ok(
          new RegExp(pattern).test(`${value}Running`),
          `${entry.command} should still be offered on ${value} while it runs`
        );
      }
    }
  });

  test('Run All on a folder runs that folder and nothing else', async function () {
    this.timeout(60000);
    const server = await startServer();
    const entry = api.store.collections[0];
    const original = Buffer.from(await vscode.workspace.fs.readFile(entry.uri)).toString('utf8');
    api.results.clear();

    try {
      await vscode.workspace.fs.writeFile(
        envUri,
        Buffer.from(
          JSON.stringify({
            id: 'env-test-local',
            name: 'Test Local',
            values: [{ key: 'baseUrl', value: server.url, type: 'default', enabled: true }],
            _postman_variable_scope: 'environment'
          }),
          'utf8'
        )
      );
      await api.store.reload();
      await api.setActiveEnvironment('env-test-local');

      await api.store.editCollection(entry.uri, addItem(undefined, newFolderItem('Admin')));
      const folder = api.store.collections[0].materialized.tree.find((n) => n.name === 'Admin')!;
      await api.store.editCollection(
        entry.uri,
        addItem(folder, {
          name: 'Ping',
          // A string URL, which is what postman-collection parses into parts.
          request: { method: 'GET', header: [], url: '{{baseUrl}}/ping' }
        })
      );

      const reloaded = api.store.collections[0];
      const withChild = reloaded.materialized.tree.find((n) => n.name === 'Admin')!;
      const panel = api.overviews.open(reloaded, withChild);
      try {
        await panel.whenReady;
        await panel.runAll();

        const after = api.store.collections[0];
        const ping = after.materialized.tree
          .find((n) => n.name === 'Admin')!
          .children.find((c) => c.name === 'Ping')!;
        assert.equal(api.results.lastRun(after.uri, ping.id)?.summary?.code, 200);

        // A folder entrypoint is the folder's contents, not the collection's:
        // the two requests outside it must not have been sent.
        for (const name of ['Login', 'Me']) {
          const node = after.materialized.tree.find((n) => n.name === name)!;
          assert.equal(
            api.results.lastRun(after.uri, node.id),
            undefined,
            `${name} sits outside the folder and should not have run`
          );
        }
      } finally {
        panel.dispose();
      }
    } finally {
      api.results.clear();
      await restore(api, entry.uri, original);
      await server.close();
    }
  });

  test('a container row offers Run All inline, and only a container', () => {
    const extension = vscode.extensions.getExtension<TestApi>(EXTENSION_ID)!;
    const items: Array<{ command: string; when: string; group: string }> =
      extension.packageJSON.contributes.menus['view/item/context'];

    const runAll = items.filter((e) => e.command === 'restclient.runAll');
    assert.ok(runAll.length, 'Run All should be on the row menu');
    assert.ok(
      runAll.some((e) => e.group.startsWith('inline')),
      'Run All should be an inline button, next to New Request'
    );
    for (const entry of runAll) {
      assert.match(
        entry.when,
        /viewItem =~ \/\^\(collection\|folder\)\(Expanded\|Collapsed\)\?\$\//,
        'Run All belongs to containers, open or shut; a request has Run of its own'
      );
    }
  });

  test('a container row offers whichever of Expand and Collapse it is not', () => {
    const extension = vscode.extensions.getExtension<TestApi>(EXTENSION_ID)!;
    const items: Array<{ command: string; when: string; group: string }> =
      extension.packageJSON.contributes.menus['view/item/context'];

    const button = (command: string) => {
      const entries = items.filter((e) => e.command === command);
      assert.equal(entries.length, 1, `${command} should be on the row menu once`);
      assert.ok(entries[0].group.startsWith('inline'), `${command} should be an inline button`);
      return entries[0].when;
    };

    // The row that is shut is offered Expand and only that, and the other way
    // round — two buttons, but never both on one row.
    assert.match(button('restclient.expandRow'), /\(collection\|folder\)Collapsed\(Running\)\?\$/);
    assert.match(button('restclient.collapseRow'), /\(collection\|folder\)Expanded\(Running\)\?\$/);

    // Refresh went with them: it was a button whose effect nothing showed.
    const titles: Array<{ command: string }> = extension.packageJSON.contributes.menus['view/title'];
    const commands: Array<{ command: string }> = extension.packageJSON.contributes.commands;
    assert.ok(!titles.some((e) => e.command === 'restclient.refresh'), 'no Refresh in a title bar');
    assert.ok(!commands.some((c) => c.command === 'restclient.refresh'), 'and no command behind it');
  });

  test('a request row offers Run inline, and only a request', () => {
    const extension = vscode.extensions.getExtension<TestApi>(EXTENSION_ID)!;
    const items: Array<{ command: string; when: string; group: string }> =
      extension.packageJSON.contributes.menus['view/item/context'];

    const run = items.filter((e) => e.command === 'restclient.runRequest');
    assert.ok(run.length, 'Run should be on the row menu');
    assert.ok(
      run.some((e) => e.group.startsWith('inline')),
      'Run should be an inline button, not buried in the context menu'
    );
    for (const entry of run) {
      assert.match(entry.when, /viewItem == request/, 'only a request can be run on its own');
    }

    // New Folder belongs anywhere a folder can go, which is not on a request.
    const newFolder = items.filter((e) => e.command === 'restclient.newFolder');
    assert.ok(
      newFolder.some((e) => e.group.startsWith('inline')),
      'New Folder should be an inline button on the rows that can hold one'
    );
    for (const entry of newFolder) {
      assert.match(entry.when, /\(collection\|folder\)/, 'collections and sub-folders both take folders');
    }
  });

  test('request panel webview mounts and reports ready', async function () {
    this.timeout(30000);
    const entry = api.store.collections[0];
    const login = entry.materialized.tree.find((n) => n.name === 'Login')!;

    const panel = api.panels.open(entry, login);
    try {
      // whenReady only settles once the bundled Svelte app has run and posted
      // back, so this fails if the CSP blocks the script or the app throws.
      await Promise.race([
        panel.whenReady,
        new Promise((_r, reject) =>
          setTimeout(() => reject(new Error('webview never reported ready — check CSP and bundle')), 15000)
        )
      ]);
    } finally {
      panel.dispose();
    }
  });

  test('edits the collection file through a real WorkspaceEdit, preserving format', async function () {
    this.timeout(30000);
    const entry = api.store.collections[0];
    const original = Buffer.from(await vscode.workspace.fs.readFile(entry.uri)).toString('utf8');

    try {
      // Open the document so the edit takes the WorkspaceEdit path (undo-able)
      // rather than the direct-write path used for files nobody has open.
      const doc = await vscode.workspace.openTextDocument(entry.uri);
      await vscode.window.showTextDocument(doc, { preview: false });

      const login = entry.materialized.tree.find((n) => n.name === 'Login')!;
      let raw: any = entry.materialized.json;
      for (const segment of login.jsonPath) { raw = raw[segment as any]; }

      await api.store.editCollection(
        entry.uri,
        buildRequestEdits(login.jsonPath, raw, { field: 'method', value: 'PUT' })
      );

      const after = Buffer.from(await vscode.workspace.fs.readFile(entry.uri)).toString('utf8');
      assert.equal(
        after,
        original.replace('"method": "POST"', '"method": "PUT"'),
        'only the method token may change on disk'
      );
      assert.ok(after.includes('\t'), 'tab indentation is preserved');

      // The store must have reloaded and re-materialized.
      const reloaded = api.store.collections[0].materialized.tree.find((n) => n.name === 'Login')!;
      assert.equal(reloaded.method, 'PUT');

      // Header edits go through the same path and keep sibling keys intact.
      let raw2: any = api.store.collections[0].materialized.json;
      for (const segment of reloaded.jsonPath) { raw2 = raw2[segment as any]; }
      await api.store.editCollection(
        entry.uri,
        buildRequestEdits(reloaded.jsonPath, raw2, {
          field: 'headers',
          rows: [
            { key: 'Content-Type', value: 'application/json' },
            { key: 'X-Trace', value: 'abc' }
          ]
        })
      );

      const withHeader = JSON.parse(
        Buffer.from(await vscode.workspace.fs.readFile(entry.uri)).toString('utf8')
      );
      assert.deepEqual(withHeader.item[0].request.header, [
        { key: 'Content-Type', value: 'application/json' },
        { key: 'X-Trace', value: 'abc' }
      ]);
      assert.equal(withHeader.item[0].request.body.mode, 'raw', 'the body survived the header edit');
      assert.equal(withHeader.item[1].name, 'Me', 'the sibling request is untouched');

      // The edit went through the editor, so it must be undoable.
      assert.ok(
        vscode.workspace.textDocuments.some((d) => d.uri.toString() === entry.uri.toString()),
        'the document stayed open for undo'
      );
    } finally {
      await restore(api, entry.uri, original);
    }
  });

  test('edits a collection that VS Code has never opened, writing straight to disk', async function () {
    this.timeout(30000);
    const folder = vscode.workspace.workspaceFolders![0];
    // A file no other test has touched, so VS Code holds no TextDocument for it.
    const uri = vscode.Uri.joinPath(
      folder.uri,
      'api',
      'unopened.postman_collection.json'
    );
    const original =
      JSON.stringify(
        {
          info: { _postman_id: 'unopened-1', name: 'Unopened', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
          item: [{ name: 'Ping', request: { method: 'GET', url: 'https://example.com/ping' } }]
        },
        null,
        '\t'
      ) + '\n';

    await vscode.workspace.fs.writeFile(uri, Buffer.from(original, 'utf8'));

    try {
      await api.store.reload();
      assert.ok(
        !vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString() && !d.isClosed),
        'precondition: VS Code holds no document for this file'
      );

      const entry = api.store.collections.find((c) => c.name === 'Unopened')!;
      const ping = entry.materialized.tree.find((n) => n.name === 'Ping')!;
      await api.store.editCollection(entry.uri, renameItem(ping, 'Healthcheck'));

      const after = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      assert.equal(after, original.replace('"name": "Ping"', '"name": "Healthcheck"'));
      assert.ok(after.includes('\t'), 'tab indentation preserved on the direct-write path');

      const reloaded = api.store.collections.find((c) => c.name === 'Unopened')!;
      assert.deepEqual(reloaded.materialized.tree.map((n) => n.name), ['Healthcheck']);
    } finally {
      await vscode.workspace.fs.delete(uri, { useTrash: false }).then(undefined, () => undefined);
      await api.store.reload();
    }
  });

  test('creates, renames, duplicates and deletes tree items', async function () {
    this.timeout(30000);
    const entry = api.store.collections[0];
    const original = Buffer.from(await vscode.workspace.fs.readFile(entry.uri)).toString('utf8');
    const names = () => api.store.collections[0].materialized.tree.map((n) => n.name);

    try {
      await api.store.editCollection(entry.uri, addItem(undefined, newFolderItem('Admin')));
      assert.deepEqual(names(), ['Login', 'Me', 'Admin']);

      const folder = api.store.collections[0].materialized.tree.find((n) => n.name === 'Admin')!;
      await api.store.editCollection(entry.uri, addItem(folder, newRequestItem('Purge')));
      const withChild = api.store.collections[0].materialized.tree.find((n) => n.name === 'Admin')!;
      assert.deepEqual(withChild.children.map((c) => c.name), ['Purge']);
      assert.equal(withChild.children[0].method, 'GET');

      await api.store.editCollection(entry.uri, renameItem(withChild, 'Administration'));
      assert.deepEqual(names(), ['Login', 'Me', 'Administration']);

      const renamed = api.store.collections[0].materialized.tree.find((n) => n.name === 'Administration')!;
      await api.store.editCollection(
        entry.uri,
        duplicateItem(api.store.collections[0].materialized.json, renamed)
      );
      assert.deepEqual(names(), ['Login', 'Me', 'Administration', 'Administration copy']);

      const copy = api.store.collections[0].materialized.tree.find((n) => n.name === 'Administration copy')!;
      assert.notEqual(copy.id, renamed.id, 'the duplicate gets its own id');
      assert.deepEqual(copy.children.map((c) => c.name), ['Purge'], 'children came along');

      await api.store.editCollection(entry.uri, deleteItem(copy));
      const afterDelete = api.store.collections[0].materialized.tree.find((n) => n.name === 'Administration')!;
      await api.store.editCollection(entry.uri, deleteItem(afterDelete));
      assert.deepEqual(names(), ['Login', 'Me'], 'back to the original two requests');

      // The original requests must be untouched by all of that.
      const parsed = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(entry.uri)).toString('utf8'));
      assert.equal(parsed.item[0].request.body.mode, 'raw');
      assert.equal(parsed.item[1].event.length, 2);
    } finally {
      await restore(api, entry.uri, original);
    }
  });

  test('a newly created item is revealed and selected in the Collections pane', async function () {
    this.timeout(30000);
    const entry = api.store.collections[0];
    const original = Buffer.from(await vscode.workspace.fs.readFile(entry.uri)).toString('utf8');
    const provider = new CollectionTreeProvider(api.store);

    try {
      // A request inside a folder is the case that matters: the folder starts
      // collapsed, so without a reveal there is nothing on screen to notice.
      await api.store.editCollection(entry.uri, addItem(undefined, newFolderItem('Admin')));
      const folder = api.store.collections[0].materialized.tree.find((n) => n.name === 'Admin')!;
      await api.store.editCollection(entry.uri, addItem(folder, newRequestItem('Purge')));

      const fresh = api.store.collections[0];
      const parent = fresh.materialized.tree.find((n) => n.name === 'Admin')!;
      const created = { kind: 'item' as const, entry: fresh, node: parent.children[0] };

      // Revealing walks up through getParent, so the whole chain has to answer.
      const folderNode = provider.getParent(created);
      assert.equal(folderNode?.kind === 'item' && folderNode.node.id, parent.id);
      const collectionNode = provider.getParent(folderNode!);
      assert.equal(collectionNode?.kind, 'collection');
      assert.equal(provider.getParent(collectionNode!), undefined, 'a collection is a root');

      // And the row id is what ties the node the store just rebuilt to the one
      // the tree is already rendering.
      assert.equal(
        provider.getTreeItem(created).id,
        `item:${fresh.uri.toString()}:${created.node.id}`
      );

      await vscode.commands.executeCommand('restclient.collections.focus');
      await api.collectionsView.reveal(created, { select: true });
      assert.deepEqual(
        api.collectionsView.selection.map((n) => (n.kind === 'item' ? n.node.name : n.kind)),
        ['Purge'],
        'the new request should be the selection, not merely present'
      );
    } finally {
      await restore(api, entry.uri, original);
    }
  });

  test('the Collections pane selects the row of the tab in front', async function () {
    this.timeout(30000);
    const entry = api.store.collections[0];
    const original = Buffer.from(await vscode.workspace.fs.readFile(entry.uri)).toString('utf8');

    // The pane has to be on screen: revealing into a hidden view would open it,
    // and bringing a tab forward is not a request to be shown the sidebar.
    await vscode.commands.executeCommand('restclient.collections.focus');

    const selected = () =>
      api.collectionsView.selection.map((n) =>
        n.kind === 'item' ? n.node.name : n.kind === 'collection' ? n.entry.name : n.kind
      );

    try {
      // A request inside a folder is the case that matters: its row is two
      // levels down and the folder starts shut, so the pane has to expand its
      // way there rather than merely move the highlight.
      await api.store.editCollection(entry.uri, addItem(undefined, newFolderItem('Admin')));
      const folder = api.store.collections[0].materialized.tree.find((n) => n.name === 'Admin')!;
      await api.store.editCollection(entry.uri, addItem(folder, newRequestItem('Purge')));

      const withChild = api.store.collections[0].materialized.tree.find((n) => n.name === 'Admin')!;
      const request = withChild.children[0];

      const overview = api.overviews.open(api.store.collections[0], withChild);
      try {
        await waitFor(
          () => selected().join() === 'Admin',
          "the folder's own row to be selected for its overview tab"
        );

        // Opened without touching the tree, which is the whole point: an
        // overview's list, a reopened tab and the next tab along all get here.
        const panel = api.panels.open(api.store.collections[0], request);
        try {
          await waitFor(() => selected().join() === 'Purge', "the request's row to follow its tab");

          // Switching back to a tab already open moves the selection too.
          api.overviews.open(api.store.collections[0], withChild);
          await waitFor(() => selected().join() === 'Admin', 'the selection to follow the tab back');
        } finally {
          panel.dispose();
        }
      } finally {
        overview.dispose();
      }
    } finally {
      await restore(api, entry.uri, original);
    }
  });

  test('a newly added variable is revealed and selected in the Environments pane', async function () {
    this.timeout(30000);
    const folder = vscode.workspace.workspaceFolders![0];
    const uri = vscode.Uri.joinPath(folder.uri, 'api', 'mount-test.postman_environment.json');
    await vscode.workspace.fs.writeFile(
      uri,
      Buffer.from(
        JSON.stringify({
          id: 'env-reveal',
          name: 'Reveal',
          values: [{ key: 'baseUrl', value: 'http://example.test', type: 'default', enabled: true }],
          _postman_variable_scope: 'environment'
        }),
        'utf8'
      )
    );

    try {
      await api.store.reload();
      const provider = new EnvironmentTreeProvider(api.store, () => api.activeEnvironmentId());

      await api.store.setEnvironmentVariable('env-reveal', 'token', 'abc');
      const entry = api.store.environment('env-reveal')!;
      const node = await provider.variableNode(entry, 'token');
      assert.ok(node, 'the variable should have a row of its own');
      assert.equal(provider.getTreeItem(node).id, `variable:${entry.uri.toString()}:token`);

      const parent = provider.getParent(node);
      assert.equal(
        parent?.kind === 'environment' && parent.entry.id,
        'env-reveal',
        'a variable row hangs off its environment, which reveal has to expand'
      );

      await vscode.commands.executeCommand('restclient.environments.focus');
      await api.environmentsView.reveal(node, { select: true });
      assert.deepEqual(
        api.environmentsView.selection.map((n) => (n.kind === 'variable' ? n.variable.key : n.kind)),
        ['token'],
        'the new variable should be the selection'
      );
    } finally {
      await vscode.workspace.fs.delete(uri, { useTrash: false }).then(undefined, () => undefined);
      await api.store.reload();
    }
  });

  test('environment editing routes secrets to SecretStorage, not the file', async function () {
    this.timeout(30000);
    const folder = vscode.workspace.workspaceFolders![0];
    const uri = vscode.Uri.joinPath(folder.uri, 'api', 'secret-test.postman_environment.json');

    await vscode.workspace.fs.writeFile(
      uri,
      Buffer.from(
        JSON.stringify(
          {
            id: 'env-secret-test',
            name: 'Secret Test',
            values: [{ key: 'plain', value: 'hello', type: 'default', enabled: true }],
            _postman_variable_scope: 'environment'
          },
          null,
          '\t'
        ),
        'utf8'
      )
    );

    try {
      await api.store.reload();

      await api.store.editEnvironment(uri, [
        { key: 'plain', value: 'hello there', type: 'default', enabled: true },
        { key: 'apiKey', value: 'top-secret-value', type: 'secret', enabled: true }
      ]);

      const onDisk = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
      const secret = onDisk.values.find((v: any) => v.key === 'apiKey');
      assert.equal(secret.value, '', 'the secret must not be written to the file');
      assert.equal(secret.type, 'secret');
      assert.equal(onDisk.values.find((v: any) => v.key === 'plain').value, 'hello there');

      // It must be retrievable from the keychain for a run.
      const resolved = await api.secrets.resolveFor('env-secret-test', onDisk.values);
      assert.deepEqual(resolved, { apiKey: 'top-secret-value' });

      // Sending `undefined` for a secret means "unchanged", not "clear".
      await api.store.editEnvironment(uri, [
        { key: 'plain', value: 'hello there', type: 'default', enabled: true },
        { key: 'apiKey', type: 'secret', enabled: true }
      ]);
      const stillThere = await api.secrets.get('env-secret-test', 'apiKey');
      assert.equal(stillThere, 'top-secret-value', 'an unchanged secret survives a save');

      // Removing the variable must purge the keychain entry too.
      await api.store.editEnvironment(uri, [
        { key: 'plain', value: 'hello there', type: 'default', enabled: true }
      ]);
      assert.equal(
        await api.secrets.get('env-secret-test', 'apiKey'),
        undefined,
        'deleting a secret variable clears it from the keychain'
      );
    } finally {
      await api.secrets.delete('env-secret-test', 'apiKey');
      await vscode.workspace.fs.delete(uri, { useTrash: false }).then(undefined, () => undefined);
      await api.store.reload();
    }
  });

  test('environment editor webview mounts', async function () {
    this.timeout(30000);
    const folder = vscode.workspace.workspaceFolders![0];
    const uri = vscode.Uri.joinPath(folder.uri, 'api', 'mount-test.postman_environment.json');
    await vscode.workspace.fs.writeFile(
      uri,
      Buffer.from(JSON.stringify({ id: 'env-mount', name: 'Mount', values: [], _postman_variable_scope: 'environment' }), 'utf8')
    );

    try {
      await api.store.reload();
      const panel = api.envPanels.open(api.store.environment('env-mount')!);
      await Promise.race([
        panel.whenReady,
        new Promise((_r, reject) =>
          setTimeout(() => reject(new Error('environment webview never reported ready')), 15000)
        )
      ]);
      panel.dispose();
    } finally {
      await vscode.workspace.fs.delete(uri, { useTrash: false }).then(undefined, () => undefined);
      await api.store.reload();
    }
  });

  test('the Postman console records traffic from a run', async function () {
    this.timeout(60000);
    const server = await startServer();
    try {
      await vscode.workspace.fs.writeFile(
        envUri,
        Buffer.from(
          JSON.stringify({
            id: 'env-console',
            name: 'Console',
            values: [
              { key: 'baseUrl', value: server.url, type: 'default', enabled: true },
              { key: 'user', value: 'alice', type: 'default', enabled: true },
              { key: 'pass', value: 's3cr3t', type: 'default', enabled: true }
            ],
            _postman_variable_scope: 'environment'
          }),
          'utf8'
        )
      );
      await api.store.reload();
      await api.setActiveEnvironment('env-console');

      api.consoleView.clear();
      assert.equal(api.consoleView.size, 0);

      const entry = api.store.collections[0];
      const me = entry.materialized.tree.find((n) => n.name === 'Me')!;
      const handle = await api.runService.start({ entry, itemId: me.id }, () => {});
      await handle.completion;

      // The Me request logs to the console and makes a nested pm.sendRequest,
      // so the console should hold strictly more than the one HTTP call.
      assert.ok(api.consoleView.size >= 3, `expected console traffic, got ${api.consoleView.size}`);
    } finally {
      await vscode.workspace.fs.delete(envUri, { useTrash: false }).then(undefined, () => undefined);
      await api.store.reload();
      await server.close();
    }
  });

  test('console webview mounts when the panel is focused', async function () {
    this.timeout(30000);
    // Focusing the view is what causes VS Code to resolve the provider.
    await vscode.commands.executeCommand('restclient.showConsole');
    await Promise.race([
      api.consoleView.whenReady,
      new Promise((_r, reject) =>
        setTimeout(() => reject(new Error('console webview never reported ready')), 15000)
      )
    ]);
  });

  test('the cookie jar persists to global storage and can be cleared', async function () {
    this.timeout(30000);
    await api.cookies.clear();
    assert.equal(api.cookies.count(), 0);

    await api.cookies.save({
      version: 'tough-cookie@4.0.0',
      storeType: 'MemoryCookieStore',
      rejectPublicSuffixes: true,
      cookies: [{ key: 'session', value: 'abc', domain: 'example.com', path: '/' }]
    });
    assert.equal(api.cookies.count(), 1);

    // Cookies are session credentials: they must live in global storage, never
    // in the workspace where they could be committed.
    const file = vscode.Uri.joinPath(api.globalStorageUri, 'cookies.json');
    const onDisk = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8'));
    assert.equal(onDisk.cookies.length, 1);
    assert.equal(onDisk.cookies[0].key, 'session');

    const workspaceRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;
    assert.ok(
      !api.globalStorageUri.fsPath.startsWith(workspaceRoot),
      'cookie storage must be outside the workspace'
    );

    await api.cookies.clear();
    assert.equal(api.cookies.count(), 0);
    const cleared = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8'));
    assert.deepEqual(cleared.cookies, []);
  });

  test('cookie manager CRUD round-trips through the jar', async function () {
    this.timeout(30000);
    await api.cookies.clear();

    await api.cookies.upsert({
      key: 'session',
      value: 'abc',
      domain: 'api.example.com',
      path: '/',
      httpOnly: true
    });
    await api.cookies.upsert({ key: 'theme', value: 'dark', domain: 'api.example.com', path: '/' });
    await api.cookies.upsert({ key: 'other', value: '1', domain: 'cdn.example.com', path: '/assets' });

    const groups = api.cookies.byDomain();
    assert.deepEqual(groups.map((g) => g.domain), ['api.example.com', 'cdn.example.com']);
    assert.deepEqual(groups[0].cookies.map((c) => c.key), ['session', 'theme'], 'sorted by name');
    assert.equal(groups[0].cookies[0].httpOnly, true);

    // Editing an existing cookie must replace it, not add a duplicate.
    await api.cookies.upsert(
      { key: 'session', value: 'updated', domain: 'api.example.com', path: '/' },
      { domain: 'api.example.com', path: '/', key: 'session' }
    );
    const afterEdit = api.cookies.byDomain()[0].cookies;
    assert.equal(afterEdit.length, 2, 'no duplicate was created');
    assert.equal(afterEdit.find((c) => c.key === 'session')!.value, 'updated');

    // Renaming is an edit of identity, so the old entry must disappear.
    await api.cookies.upsert(
      { key: 'renamed', value: 'updated', domain: 'api.example.com', path: '/' },
      { domain: 'api.example.com', path: '/', key: 'session' }
    );
    const afterRename = api.cookies.byDomain()[0].cookies.map((c) => c.key);
    assert.deepEqual(afterRename, ['renamed', 'theme']);

    await api.cookies.remove('api.example.com', '/', 'renamed');
    assert.deepEqual(api.cookies.byDomain()[0].cookies.map((c) => c.key), ['theme']);

    await api.cookies.removeDomain('api.example.com');
    assert.deepEqual(api.cookies.byDomain().map((g) => g.domain), ['cdn.example.com']);

    await api.cookies.clear();
    assert.equal(api.cookies.count(), 0);
  });

  test('the Cookies pane lists the jar by domain and deletes from a row', async function () {
    this.timeout(30000);
    await api.cookies.clear();

    await api.cookies.upsert({
      key: 'session',
      value: 'abc',
      domain: 'api.example.com',
      path: '/',
      httpOnly: true,
      expires: 'Infinity'
    });
    await api.cookies.upsert({ key: 'theme', value: 'dark', domain: 'api.example.com', path: '/' });
    await api.cookies.upsert({
      key: 'stale',
      value: 'x',
      domain: 'cdn.example.com',
      path: '/assets',
      expires: '2000-01-01T00:00:00.000Z'
    });

    const provider = new CookieTreeProvider(api.cookies);
    const domains = await provider.getChildren();
    assert.deepEqual(
      domains.map((n) => (n.kind === 'domain' ? n.domain : n.kind)),
      ['api.example.com', 'cdn.example.com'],
      'domains are the top-level rows'
    );

    const cookies = await provider.getChildren(domains[0]);
    assert.deepEqual(
      cookies.map((n) => provider.getTreeItem(n).label),
      ['session', 'theme'],
      'cookies hang off their domain'
    );
    const first = provider.getTreeItem(cookies[0]);
    assert.equal(first.contextValue, 'cookie');
    assert.equal(first.description, 'abc');

    // An expired cookie is not sent, so the row has to say so.
    const expired = provider.getTreeItem((await provider.getChildren(domains[1]))[0]);
    assert.equal(expired.description, 'x · /assets · expired');

    const parent = provider.getParent(cookies[0]);
    assert.equal(parent?.kind === 'domain' && parent.domain, 'api.example.com');

    await vscode.commands.executeCommand('restclient.deleteCookie', cookies[0]);
    assert.deepEqual(
      api.cookies.byDomain()[0].cookies.map((c) => c.key),
      ['theme'],
      'deleting from a row edits the jar requests use'
    );

    // The row a command was handed has to survive a trip through the view.
    await vscode.commands.executeCommand('restclient.cookies.focus');
    const remaining = await provider.getChildren((await provider.getChildren())[0]);
    await api.cookiesView.reveal(remaining[0], { select: true });
    assert.deepEqual(
      api.cookiesView.selection.map((n) => (n.kind === 'cookie' ? n.cookie.key : n.kind)),
      ['theme'],
      'the revealed cookie should be the selection'
    );

    await api.cookies.clear();
    assert.equal(api.cookies.count(), 0);
  });

  test('a cookie added by hand is actually sent by the runner', async function () {
    this.timeout(60000);
    const server = await startServer();
    try {
      await api.cookies.clear();
      // The jar is hand-built JSON, so this proves tough-cookie accepts it.
      await api.cookies.upsert({ key: 'manual', value: 'from-ui', domain: '127.0.0.1', path: '/' });

      await vscode.workspace.fs.writeFile(
        envUri,
        Buffer.from(
          JSON.stringify({
            id: 'env-cookie-send',
            name: 'Cookie Send',
            values: [{ key: 'baseUrl', value: server.url, type: 'default', enabled: true }],
            _postman_variable_scope: 'environment'
          }),
          'utf8'
        )
      );
      await api.store.reload();
      await api.setActiveEnvironment('env-cookie-send');

      // A throwaway collection whose single request echoes the Cookie header.
      const collectionUri = vscode.Uri.joinPath(
        vscode.workspace.workspaceFolders![0].uri,
        'api',
        'cookie-send.postman_collection.json'
      );
      await vscode.workspace.fs.writeFile(
        collectionUri,
        Buffer.from(
          JSON.stringify({
            info: { _postman_id: 'cookie-send', name: 'CookieSend', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
            item: [{ name: 'echo', request: { method: 'GET', url: '{{baseUrl}}/me' } }]
          }),
          'utf8'
        )
      );

      try {
        await api.store.reload();
        const entry = api.store.collections.find((c) => c.name === 'CookieSend')!;
        const item = entry.materialized.tree[0];

        const messages: RunnerMessage[] = [];
        const handle = await api.runService.start({ entry, itemId: item.id }, (m) => messages.push(m));
        await handle.completion;

        const response = messages.find((m) => m.type === 'response');
        assert.ok(response && response.type === 'response', 'the request should have completed');
        const body = JSON.parse(Buffer.from(response.response.bodyBase64, 'base64').toString('utf8'));
        assert.equal(
          body.sawAuth,
          null,
          'sanity: this request has no auth'
        );
        assert.ok(
          String(body.cookie ?? '').includes('manual=from-ui'),
          `the hand-added cookie should have been sent, got ${JSON.stringify(body.cookie)}`
        );
      } finally {
        await vscode.workspace.fs.delete(collectionUri, { useTrash: false }).then(undefined, () => undefined);
      }
    } finally {
      await api.cookies.clear();
      await vscode.workspace.fs.delete(envUri, { useTrash: false }).then(undefined, () => undefined);
      await api.store.reload();
      await server.close();
    }
  });

  test('cookie manager webview mounts', async function () {
    this.timeout(30000);
    const panel = CookiePanel.show(
      vscode.extensions.getExtension(EXTENSION_ID)!.extensionUri,
      api.cookies
    );
    try {
      await Promise.race([
        panel.whenReady,
        new Promise((_r, reject) =>
          setTimeout(() => reject(new Error('cookie webview never reported ready')), 15000)
        )
      ]);
    } finally {
      panel.dispose();
    }
  });

  test('imports a file from outside the workspace by copying it in', async function () {
    this.timeout(60000);
    const folder = vscode.workspace.workspaceFolders![0];
    const config = vscode.workspace.getConfiguration('restclient', folder.uri);
    // Preset, so no folder dialog opens: a test cannot answer one.
    await config.update('importLocation', 'imported', vscode.ConfigurationTarget.Workspace);

    const outside = vscode.Uri.file(
      path.join(os.tmpdir(), `rc-import-${Date.now()}`, 'add-me.postman_environment.json')
    );
    const original = JSON.stringify({
      id: 'env-added-1',
      name: 'Added',
      values: [
        { key: 'plain', value: 'visible', type: 'default', enabled: true },
        { key: 'apiKey', value: 'super-secret', type: 'secret', enabled: true }
      ],
      _postman_variable_scope: 'environment'
    });
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(outside.fsPath)));
    await write(outside, original);

    const copy = vscode.Uri.joinPath(folder.uri, 'imported', 'add-me.postman_environment.json');

    try {
      const before = api.store.environments.length;
      await vscode.commands.executeCommand('restclient.import', outside);
      await api.store.reload();

      assert.equal(api.store.environments.length, before + 1, 'the environment should be tracked');
      const added = api.store.environment('env-added-1');
      assert.ok(added, 'the environment should be loadable');

      // The copy is what gets worked on, and the original is left out of it.
      assert.equal(added.uri.fsPath, copy.fsPath, 'the copy should be what is tracked');
      assert.notEqual(added.uri.fsPath, outside.fsPath, 'the original must never be tracked');
      assert.equal(await read(outside), original, 'importing must not rewrite the original');
      assert.equal(await read(copy), original, 'importing must not rewrite the copy either');

      // Carried over from when this test asserted the opposite: registering a
      // file must never blank a value, however it arrives.
      const apiKey = (added.json.values ?? []).find((v: any) => v.key === 'apiKey');
      assert.equal(apiKey?.value, 'super-secret', 'the plaintext secret should survive the copy');

      assert.ok(
        configured('environments').includes('imported/add-me.postman_environment.json'),
        `the setting should name the copy, got ${JSON.stringify(configured('environments'))}`
      );

      await api.store.unregister('environment', copy);
      assert.equal(api.store.environment('env-added-1'), undefined, 'removing should untrack it');
      await vscode.workspace.fs.stat(copy); // still there — we only stopped tracking it
    } finally {
      await api.store.unregister('environment', copy).then(undefined, () => undefined);
      await remove(copy);
      await remove(vscode.Uri.joinPath(folder.uri, 'imported'));
      await remove(vscode.Uri.file(path.dirname(outside.fsPath)));
      await config.update('importLocation', undefined, vscode.ConfigurationTarget.Workspace);
      await api.store.reload();
    }
  });

  test('imports a file already in the workspace without duplicating it', async function () {
    this.timeout(60000);
    const folder = vscode.workspace.workspaceFolders![0];
    const config = vscode.workspace.getConfiguration('restclient', folder.uri);
    await config.update('importLocation', 'imported', vscode.ConfigurationTarget.Workspace);

    const source = vscode.Uri.joinPath(folder.uri, 'add-me.postman_environment.json');
    const original = JSON.stringify({
      id: 'env-added-2',
      name: 'Added In Place',
      values: [{ key: 'plain', value: 'visible', type: 'default', enabled: true }],
      _postman_variable_scope: 'environment'
    });
    await write(source, original);

    try {
      await vscode.commands.executeCommand('restclient.import', source);
      await api.store.reload();

      const added = api.store.environment('env-added-2');
      assert.ok(added, 'the environment should be loadable');
      // Already committed here: copying it again would serve nobody.
      assert.equal(added.uri.fsPath, source.fsPath, 'an in-workspace file stays where it is');
      assert.equal(await read(source), original, 'adding a file must not rewrite it');

      assert.ok(
        !(await exists(vscode.Uri.joinPath(folder.uri, 'imported', 'add-me.postman_environment.json'))),
        'nothing should have been copied into the import folder'
      );
    } finally {
      await api.store.unregister('environment', source).then(undefined, () => undefined);
      await remove(source);
      await remove(vscode.Uri.joinPath(folder.uri, 'imported'));
      await config.update('importLocation', undefined, vscode.ConfigurationTarget.Workspace);
      await api.store.reload();
    }
  });

  test('names a copy around a collision instead of overwriting', async function () {
    this.timeout(60000);
    const folder = vscode.workspace.workspaceFolders![0];
    const config = vscode.workspace.getConfiguration('restclient', folder.uri);
    await config.update('importLocation', 'imported', vscode.ConfigurationTarget.Workspace);

    const importFolder = vscode.Uri.joinPath(folder.uri, 'imported');
    const squatter = vscode.Uri.joinPath(importFolder, 'clash.postman_collection.json');
    const squatterText = collectionJson('already-here', 'Already Here');
    await vscode.workspace.fs.createDirectory(importFolder);
    await write(squatter, squatterText);

    const outside = vscode.Uri.file(
      path.join(os.tmpdir(), `rc-clash-${Date.now()}`, 'clash.postman_collection.json')
    );
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(outside.fsPath)));
    await write(outside, collectionJson('imported-one', 'Imported One'));

    const expected = vscode.Uri.joinPath(importFolder, 'clash-2.postman_collection.json');

    try {
      await vscode.commands.executeCommand('restclient.import', outside);
      await api.store.reload();

      const added = api.store.collections.find((c) => c.id === 'imported-one');
      assert.ok(added, 'the imported collection should be loadable');
      assert.equal(added.uri.fsPath, expected.fsPath, 'the clash should be counted around');
      assert.equal(await read(squatter), squatterText, 'the file already there must be untouched');
    } finally {
      await api.store.unregister('collection', expected).then(undefined, () => undefined);
      await remove(importFolder);
      await remove(vscode.Uri.file(path.dirname(outside.fsPath)));
      await config.update('importLocation', undefined, vscode.ConfigurationTarget.Workspace);
      await api.store.reload();
    }
  });

  test('converts into the copy, not the original', async function () {
    this.timeout(60000);
    const folder = vscode.workspace.workspaceFolders![0];
    const importFolder = vscode.Uri.joinPath(folder.uri, 'imported');
    await vscode.workspace.fs.createDirectory(importFolder);

    const outside = vscode.Uri.file(
      path.join(os.tmpdir(), `rc-v1-${Date.now()}`, 'legacy.postman_collection.json')
    );
    const original = v1CollectionJson('Legacy');
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(outside.fsPath)));
    await write(outside, original);

    const copy = vscode.Uri.joinPath(importFolder, 'legacy.postman_collection.json');

    try {
      // The modal cannot be answered from a test, so drive the half that matters.
      const landed = await api.store.convert(outside, '1.0.0', { copyInto: importFolder });

      assert.equal(landed.fsPath, copy.fsPath, 'the conversion should land in the copy');
      assert.equal(await read(outside), original, 'a file from outside is not ours to rewrite');

      const convertedText = await read(copy);
      assert.ok(
        JSON.parse(convertedText).info?.schema?.includes('/v2.1.0/'),
        'the copy should now be v2.1.0'
      );
      assert.ok(
        api.store.collections.some((c) => c.uri.fsPath === copy.fsPath),
        'the copy should be what got tracked'
      );
    } finally {
      await api.store.unregister('collection', copy).then(undefined, () => undefined);
      await remove(importFolder);
      await remove(vscode.Uri.file(path.dirname(outside.fsPath)));
      await api.store.reload();
    }
  });

  test('remembers the import location, and asks only once', async function () {
    this.timeout(60000);
    const folder = vscode.workspace.workspaceFolders![0];
    const config = vscode.workspace.getConfiguration('restclient', folder.uri);
    await config.update('importLocation', undefined, vscode.ConfigurationTarget.Workspace);

    const chosen = vscode.Uri.joinPath(folder.uri, 'chosen-imports');
    let asked = 0;

    try {
      const target = new ImportTarget(() => [folder], () => {
        asked++;
        return Promise.resolve(chosen);
      });

      assert.equal((await target.resolve())?.fsPath, chosen.fsPath);
      assert.equal(asked, 1, 'the first import has to ask');
      assert.equal(
        vscode.workspace.getConfiguration('restclient', folder.uri).get<string>('importLocation'),
        'chosen-imports',
        'remembered workspace-scoped and workspace-relative'
      );

      assert.equal((await target.resolve())?.fsPath, chosen.fsPath);
      assert.equal(asked, 1, 'the second import must not ask again');

      // And it exists now, so a copy has somewhere to land.
      await vscode.workspace.fs.stat(chosen);
    } finally {
      await remove(chosen);
      await config.update('importLocation', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('refuses an import location outside the workspace', async function () {
    this.timeout(60000);
    const folder = vscode.workspace.workspaceFolders![0];
    // Requests can only read files from the workspace root, so a collection
    // kept outside it could not reach its own attachments.
    const outside = vscode.Uri.file(path.join(os.tmpdir(), `rc-outside-${Date.now()}`));
    const target = new ImportTarget(() => [folder], () => Promise.resolve(outside));
    assert.equal(await target.resolve(), undefined, 'a folder outside the workspace is refused');
    assert.equal(
      vscode.workspace.getConfiguration('restclient', folder.uri).get<string>('importLocation'),
      '',
      'and nothing is remembered'
    );
  });

  test('the workspace scan is off in this fixture', async function () {
    this.timeout(60000);
    const folder = vscode.workspace.workspaceFolders![0];
    const unlisted = vscode.Uri.joinPath(folder.uri, 'api', 'unlisted.postman_collection.json');
    await write(unlisted, collectionJson('scan-off', 'Scan Off'));
    try {
      await api.store.rescan();
      assert.ok(
        !api.store.collections.some((c) => c.id === 'scan-off'),
        'with the scan off, only listed files are tracked'
      );
    } finally {
      await remove(unlisted);
      await api.store.reload();
    }
  });

  test('discovers a Postman file nobody listed', async function () {
    this.timeout(60000);
    const folder = vscode.workspace.workspaceFolders![0];
    const found = vscode.Uri.joinPath(folder.uri, 'api', 'found.postman_collection.json');
    await write(found, collectionJson('found-1', 'Found'));

    try {
      await withDiscovery(api, undefined, async () => {
        const entry = api.store.collections.find((c) => c.id === 'found-1');
        assert.ok(entry, 'the scan should have found it');
        assert.equal(entry.source, 'discovered');
        assert.equal(entry.uri.fsPath, found.fsPath, 'and worked on it where it lies');

        // The load-bearing assertion: discovery writes nothing to settings.
        assert.ok(
          !configured('collections').some((e) => e.includes('found.postman_collection.json')),
          `nothing should have been listed, got ${JSON.stringify(configured('collections'))}`
        );
      });
    } finally {
      await remove(found);
      await api.store.rescan();
    }
  });

  test('stops working on a discovered file by excluding it', async function () {
    this.timeout(60000);
    const folder = vscode.workspace.workspaceFolders![0];
    const found = vscode.Uri.joinPath(folder.uri, 'api', 'refused.postman_collection.json');
    await write(found, collectionJson('refused-1', 'Refused'));

    try {
      await withDiscovery(api, undefined, async () => {
        assert.ok(api.store.collections.some((c) => c.id === 'refused-1'), 'found first');

        await api.store.untrack('collection', found, 'discovered');

        assert.ok(!api.store.collections.some((c) => c.id === 'refused-1'), 'and then refused');
        await vscode.workspace.fs.stat(found); // the file itself stays put
        assert.ok(
          configured('discoverExclude').some((e) => e.includes('refused.postman_collection.json')),
          `the refusal should be recorded, got ${JSON.stringify(configured('discoverExclude'))}`
        );
        assert.ok(
          !configured('collections').some((e) => e.includes('refused.postman_collection.json')),
          'and it should not have been added to the explicit list'
        );

        // The way back, which is what the modal points the user at.
        await api.store.registry.unexclude(found);
        await api.store.rescan();
        assert.ok(
          api.store.collections.some((c) => c.id === 'refused-1'),
          'withdrawing the exclusion should bring it back'
        );
      });
    } finally {
      await remove(found);
      await api.store.rescan();
    }
  });

  test('a listed file the scan also finds stays gone once removed', async function () {
    this.timeout(60000);
    const folder = vscode.workspace.workspaceFolders![0];
    const both = vscode.Uri.joinPath(folder.uri, 'api', 'listed-and-found.postman_collection.json');
    await write(both, collectionJson('both-1', 'Both'));

    try {
      await setRegistry(
        [...BASE_COLLECTIONS, ...SCRATCH_COLLECTIONS, 'api/listed-and-found.postman_collection.json'],
        [...BASE_ENVIRONMENTS, ...SCRATCH_ENVIRONMENTS]
      );
      await withDiscovery(api, undefined, async () => {
        const entry = api.store.collections.find((c) => c.id === 'both-1');
        assert.ok(entry);
        assert.equal(entry.source, 'registered', 'saying so explicitly outranks merely being there');

        await api.store.untrack('collection', both, 'registered');

        // Without the exclusion the scan would put it straight back and the
        // command would appear to have done nothing.
        assert.ok(
          !api.store.collections.some((c) => c.id === 'both-1'),
          'removing a listed file the scan also finds has to stick'
        );
      });
    } finally {
      await restoreSuiteRegistry();
      await remove(both);
      await api.store.rescan();
    }
  });

  test('honours discoverPatterns', async function () {
    this.timeout(60000);
    const folder = vscode.workspace.workspaceFolders![0];
    const weird = vscode.Uri.joinPath(folder.uri, 'api', 'thing.weird.json');
    const conventional = vscode.Uri.joinPath(folder.uri, 'api', 'other.postman_collection.json');
    await write(weird, collectionJson('weird-1', 'Weird'));
    await write(conventional, collectionJson('conventional-1', 'Conventional'));

    try {
      await withDiscovery(api, ['api/*.weird.json'], async () => {
        assert.ok(
          api.store.collections.some((c) => c.id === 'weird-1'),
          'a repo that names them its own way should still work'
        );
        assert.ok(
          !api.store.collections.some((c) => c.id === 'conventional-1'),
          'the configured patterns replace the defaults rather than adding to them'
        );
      });
    } finally {
      await remove(weird);
      await remove(conventional);
      await api.store.rescan();
    }
  });

  test('scans every JSON file in the folder collections are kept in', async function () {
    this.timeout(60000);
    const folder = vscode.workspace.workspaceFolders![0];
    const kept = vscode.Uri.joinPath(folder.uri, 'imported');
    const plain = vscode.Uri.joinPath(kept, 'plain.json');
    const nested = vscode.Uri.joinPath(kept, 'nested', 'deep.json');
    const notPostman = vscode.Uri.joinPath(kept, 'notes.json');
    const unparseable = vscode.Uri.joinPath(kept, 'half-typed.json');
    const outside = vscode.Uri.joinPath(folder.uri, 'api', 'elsewhere.json');

    const config = vscode.workspace.getConfiguration('restclient', folder.uri);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(kept, 'nested'));
    await write(plain, collectionJson('plain-1', 'Plain'));
    await write(nested, collectionJson('nested-1', 'Nested'));
    await write(notPostman, JSON.stringify({ note: 'not an export' }));
    await write(unparseable, '{ "info": ');
    await write(outside, collectionJson('elsewhere-1', 'Elsewhere'));

    try {
      await config.update('importLocation', 'imported', vscode.ConfigurationTarget.Workspace);
      await withDiscovery(api, undefined, async () => {
        assert.ok(
          api.store.collections.some((c) => c.id === 'plain-1'),
          'choosing the folder is what says its JSON is ours, whatever it is named'
        );
        assert.ok(
          api.store.collections.some((c) => c.id === 'nested-1'),
          'and that goes for subfolders of it'
        );
        assert.ok(
          !api.store.collections.some((c) => c.id === 'elsewhere-1'),
          'nowhere else widens: outside the folder, Postman naming is still the signal'
        );
        assert.ok(
          !api.store.broken.some((b) => b.uri.fsPath === notPostman.fsPath) &&
            !api.store.unsupported.some((u) => u.uri.fsPath === notPostman.fsPath),
          'JSON in there that is not an export is simply not ours'
        );
        const broken = api.store.broken.find((b) => b.uri.fsPath === unparseable.fsPath);
        assert.ok(broken, 'a collection broken by a hand-edit must not just vanish from the tree');
        assert.equal(broken!.kind, 'collection');
      });
    } finally {
      await config.update('importLocation', undefined, vscode.ConfigurationTarget.Workspace);
      await remove(vscode.Uri.joinPath(kept, 'nested'));
      await remove(plain);
      await remove(notPostman);
      await remove(unparseable);
      await remove(outside);
      await api.store.rescan();
    }
  });

  test('honours search.exclude', async function () {
    this.timeout(60000);
    const folder = vscode.workspace.workspaceFolders![0];
    const hidden = vscode.Uri.joinPath(folder.uri, 'api', 'hidden', 'x.postman_collection.json');
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, 'api', 'hidden'));
    await write(hidden, collectionJson('hidden-1', 'Hidden'));

    const search = vscode.workspace.getConfiguration('search', folder.uri);
    try {
      await search.update('exclude', { '**/hidden/**': true }, vscode.ConfigurationTarget.Workspace);
      await withDiscovery(api, undefined, async () => {
        // findFiles applies neither files.exclude nor search.exclude once an
        // explicit exclude is passed, so this proves the glob is being built.
        assert.ok(
          !api.store.collections.some((c) => c.id === 'hidden-1'),
          'a folder the user excluded from search should not be scanned'
        );
      });
    } finally {
      await search.update('exclude', undefined, vscode.ConfigurationTarget.Workspace);
      await remove(vscode.Uri.joinPath(folder.uri, 'api', 'hidden'));
      await api.store.rescan();
    }
  });

  test('shows a v1 collection as needing conversion rather than loading it', async function () {
    this.timeout(60000);
    const folder = vscode.workspace.workspaceFolders![0];
    const legacy = vscode.Uri.joinPath(folder.uri, 'api', 'legacy.postman_collection.json');
    await write(legacy, v1CollectionJson('Legacy'));

    try {
      await withDiscovery(api, undefined, async () => {
        const unsupported = api.store
          .unsupportedFiles('collection')
          .find((u) => u.uri.fsPath === legacy.fsPath);
        assert.ok(unsupported, 'it should be reported rather than skipped');
        assert.equal(unsupported.convertFrom, '1.0.0');
        assert.ok(unsupported.reason.includes('1.0.0'), 'the row has to say what it is');
        assert.ok(
          !api.store.collections.some((c) => c.uri.fsPath === legacy.fsPath),
          'a v1 collection read as a v2.1 one comes out as nonsense, so it must not load'
        );

        // Converting is what the row offers, and it happens in place here: the
        // file is already in the workspace.
        const landed = await api.store.convert(legacy, '1.0.0');
        assert.equal(landed.fsPath, legacy.fsPath);
        assert.ok(
          api.store.collections.some((c) => c.uri.fsPath === legacy.fsPath),
          'and then it loads'
        );
        assert.equal(api.store.unsupportedFiles('collection').length, 0);
      });
    } finally {
      await api.store.unregister('collection', legacy).then(undefined, () => undefined);
      await remove(legacy);
      await restoreSuiteRegistry();
      await api.store.rescan();
    }
  });

  test('picks up a file created while the window is open', async function () {
    this.timeout(60000);
    const folder = vscode.workspace.workspaceFolders![0];
    const late = vscode.Uri.joinPath(folder.uri, 'api', 'late.postman_collection.json');

    try {
      await withDiscovery(api, undefined, async () => {
        // No manual reload: the watcher and the 250ms debounce have to do it.
        const appeared = new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => { subscription.dispose(); resolve(false); }, 20000);
          const subscription = api.store.onDidChange(() => {
            if (!api.store.collections.some((c) => c.id === 'late-1')) { return; }
            clearTimeout(timer);
            subscription.dispose();
            resolve(true);
          });
        });

        await write(late, collectionJson('late-1', 'Late'));
        assert.ok(await appeared, 'a file appearing in the workspace should show up on its own');
      });
    } finally {
      await remove(late);
      await api.store.rescan();
    }
  });

  test('moves a plaintext secret into the keychain only when asked', async function () {
    this.timeout(60000);
    const folder = vscode.workspace.workspaceFolders![0];
    const uri = vscode.Uri.joinPath(folder.uri, 'api', 'secret-test.postman_environment.json');
    await vscode.workspace.fs.writeFile(
      uri,
      Buffer.from(
        JSON.stringify({
          id: 'env-plaintext',
          name: 'Plaintext',
          values: [{ key: 'apiKey', value: 'super-secret', type: 'secret', enabled: true }],
          _postman_variable_scope: 'environment'
        }),
        'utf8'
      )
    );

    try {
      await api.store.reload();
      const entry = api.store.environment('env-plaintext');
      assert.ok(entry, 'the environment should be tracked');

      // Registering must never blank a value in a file the user owns.
      assert.equal(
        (entry.json.values ?? []).find((v: any) => v.key === 'apiKey')?.value,
        'super-secret',
        'the plaintext secret should still be in the file'
      );
      assert.equal(await api.secrets.get('env-plaintext', 'apiKey'), undefined);

      await api.store.moveSecretToKeychain('env-plaintext', 'apiKey');
      await api.store.reload();

      const moved = api.store.environment('env-plaintext');
      assert.equal(
        (moved?.json.values ?? []).find((v: any) => v.key === 'apiKey')?.value,
        '',
        'the file should be blanked once the value is in the keychain'
      );
      assert.equal(await api.secrets.get('env-plaintext', 'apiKey'), 'super-secret');
    } finally {
      await api.secrets.delete('env-plaintext', 'apiKey').then(undefined, () => undefined);
      await vscode.workspace.fs.delete(uri, { useTrash: false }).then(undefined, () => undefined);
      await api.store.reload();
    }
  });

  test('imports every file of an explorer multi-selection', async () => {
    const folder = vscode.workspace.workspaceFolders![0].uri;
    const sources = ['multi-a', 'multi-b'].map((n) =>
      vscode.Uri.joinPath(folder, `${n}.postman_environment.json`)
    );

    await Promise.all(
      sources.map((uri, i) =>
        vscode.workspace.fs.writeFile(
          uri,
          Buffer.from(
            JSON.stringify({
              id: `env-multi-${i}`,
              name: `Multi ${i}`,
              values: [{ key: 'k', value: String(i), type: 'default', enabled: true }],
              _postman_variable_scope: 'environment'
            }),
            'utf8'
          )
        )
      )
    );

    try {
      // The explorer context menu invokes commands as (uri, uris[]), where uris
      // holds the whole selection and already includes the first argument.
      await vscode.commands.executeCommand('restclient.import', sources[0], sources);
      await api.store.reload();

      assert.ok(api.store.environment('env-multi-0'), 'the first selected file should import');
      assert.ok(api.store.environment('env-multi-1'), 'the rest of the selection should import too');

      for (const id of ['env-multi-0', 'env-multi-1']) {
        const entry = api.store.environment(id);
        if (entry) { await api.store.unregister('environment', entry.uri); }
      }
    } finally {
      await Promise.all(sources.map((uri) => api.store.unregister('environment', uri)));
      await Promise.all(
        sources.map((uri) =>
          vscode.workspace.fs.delete(uri, { useTrash: false }).then(undefined, () => undefined)
        )
      );
    }
  });

  test('a closed request editor keeps its response in memory when reopened', async function () {
    this.timeout(60000);
    const server = await startServer();
    try {
      await vscode.workspace.fs.writeFile(
        envUri,
        Buffer.from(
          JSON.stringify({
            id: 'env-cache',
            name: 'Cache',
            values: [{ key: 'baseUrl', value: server.url, type: 'default', enabled: true }],
            _postman_variable_scope: 'environment'
          }),
          'utf8'
        )
      );
      await api.store.reload();
      await api.setActiveEnvironment('env-cache');

      const entry = api.store.collections[0];
      const node = entry.materialized.tree.find((n) => n.name === 'Me')!;

      const panel = api.panels.open(entry, node);
      await panel.whenReady;
      await panel.run();
      panel.dispose();

      // Reopening builds a brand new webview; the response must come back with it.
      const reopened = api.panels.open(entry, node);
      await reopened.whenReady;
      const restored = reopened.restoredForTest();
      assert.ok(restored?.response, 'the cached response should be replayed');
      assert.equal(restored.response.code, 200);

      api.results.clear();
      const afterClear = api.panels.open(entry, node);
      assert.equal(
        afterClear.restoredForTest(),
        undefined,
        'clearing must drop it — nothing was persisted to fall back on'
      );
      afterClear.dispose();
    } finally {
      await api.setActiveEnvironment(undefined);
      await vscode.workspace.fs.delete(envUri, { useTrash: false }).then(undefined, () => undefined);
      await api.store.reload();
      await server.close();
    }
  });

  test('the Environments view lists environments and their variables', async function () {
    this.timeout(60000);
    const folder = vscode.workspace.workspaceFolders![0];
    const uri = vscode.Uri.joinPath(folder.uri, 'api', 'mount-test.postman_environment.json');
    await vscode.workspace.fs.writeFile(
      uri,
      Buffer.from(
        JSON.stringify({
          id: 'env-tree',
          name: 'Tree',
          values: [
            { key: 'baseUrl', value: 'http://example.test', type: 'default', enabled: true },
            { key: 'off', value: 'x', type: 'default', enabled: false },
            { key: 'apiKey', value: 'plain-secret', type: 'secret', enabled: true }
          ],
          _postman_variable_scope: 'environment'
        }),
        'utf8'
      )
    );

    try {
      await api.store.reload();
      const provider = new EnvironmentTreeProvider(api.store, () => 'env-tree');

      const roots = await provider.getChildren();
      const root = roots.find((n) => n.kind === 'environment' && n.entry.id === 'env-tree');
      assert.ok(root, 'the environment should appear at the root');
      assert.equal(root.kind === 'environment' && root.active, true, 'the active one is marked');

      const item = provider.getTreeItem(root);
      assert.equal(item.contextValue, 'environmentActive');
      assert.match(String(item.description), /active/);

      const children = await provider.getChildren(root);
      assert.deepEqual(
        children.map((c) => (c.kind === 'variable' ? c.variable.key : '')),
        ['baseUrl', 'off', 'apiKey']
      );

      const [plain, disabled, secret] = children.map((c) => provider.getTreeItem(c));
      assert.equal(plain.contextValue, 'variable');
      assert.match(String(plain.description), /http:\/\/example\.test/);
      assert.match(String(disabled.description), /disabled/);
      // A secret still in the file must be called out, not shown as a value.
      assert.equal(secret.contextValue, 'variablePlaintextSecret');
      assert.doesNotMatch(String(secret.description), /plain-secret/);
    } finally {
      await vscode.workspace.fs.delete(uri, { useTrash: false }).then(undefined, () => undefined);
      await api.store.reload();
    }
  });

  test('filtering the Collections pane narrows it and says what it hid', async function () {
    this.timeout(60000);
    const tree = api.collectionsTree;

    try {
      api.setCollectionFilter('login');

      const smoke = tree.getChildren().find((n) => n.kind === 'collection' && n.entry.name === 'Smoke');
      assert.ok(smoke, 'the collection holding a match survives');
      assert.deepEqual(
        tree.getChildren(smoke).map((n) => (n.kind === 'item' ? n.node.name : '')),
        ['Login'],
        'and carries only the matching request'
      );
      assert.match(String(api.collectionsView.message), /Filtered by "login" — 1 request in 1 collection\./);
      assert.match(String(api.collectionsView.description), /login/);

      // Filtered rows are their own rows, which is what lets them come up open.
      const row = tree.getTreeItem(tree.getChildren(smoke)[0]);
      assert.match(String(row.id), /#filtered$/);

      // What `reveal` relies on: the row it is about to select may be hidden.
      const entry = api.store.collections.find((c) => c.name === 'Smoke')!;
      const hidden = entry.materialized.tree.find((n) => n.name === 'Me')!;
      assert.equal(tree.hides({ kind: 'item', entry, node: hidden }), true);
      assert.equal(tree.hides({ kind: 'item', entry, node: entry.materialized.tree[0] }), false);
      assert.equal(tree.hides(smoke), false);

      api.setCollectionFilter('no-such-request');
      assert.deepEqual(tree.getChildren(), [], 'nothing matching leaves an empty tree');
      assert.match(String(api.collectionsView.message), /Nothing matches "no-such-request"\./);
    } finally {
      api.setCollectionFilter(undefined);
    }

    assert.equal(api.collectionsView.message, undefined, 'clearing takes the notice away');
    assert.ok(
      tree.getChildren().some((n) => n.kind === 'collection' && n.entry.name === 'Smoke'),
      'and puts the rows back'
    );
  });

  test('filtering the Environments pane matches names, keys and values', async function () {
    this.timeout(60000);
    const tree = api.environmentsTree;
    const local = async () => {
      const row = (await tree.getChildren()).find((n) => n.kind === 'environment' && n.entry.name === 'Local');
      assert.ok(row, 'the Local environment should survive the filter');
      return row;
    };

    try {
      // A value match: "which environment points at alice?"
      api.setEnvironmentFilter('alice');
      assert.deepEqual(
        (await tree.getChildren(await local())).map((n) => (n.kind === 'variable' ? n.variable.key : '')),
        ['user']
      );
      assert.match(String(api.environmentsView.message), /1 variable in 1 environment\./);

      const row = tree.getTreeItem(await local());
      assert.equal(row.collapsibleState, vscode.TreeItemCollapsibleState.Expanded, 'open, not collapsed');
      assert.match(String(row.id), /#filtered$/, 'and a row VS Code has not already drawn');

      // A name match is a request to see the environment, all of it.
      api.setEnvironmentFilter('Local');
      assert.deepEqual(
        (await tree.getChildren(await local())).map((n) => (n.kind === 'variable' ? n.variable.key : '')),
        ['baseUrl', 'user', 'pass']
      );

      api.setEnvironmentFilter('no-such-variable');
      assert.deepEqual(await tree.getChildren(), []);
    } finally {
      api.setEnvironmentFilter(undefined);
    }

    assert.equal(api.environmentsView.message, undefined);
  });

  test('managing an environment from the sidebar edits the file in place', async function () {
    this.timeout(60000);
    const folder = vscode.workspace.workspaceFolders![0];
    const uri = vscode.Uri.joinPath(folder.uri, 'api', 'managed.postman_environment.json');

    try {
      const created = await api.store.createEnvironment(uri, 'Managed');
      assert.equal(created.name, 'Managed');
      assert.deepEqual(created.json.values, [], 'a new environment starts empty');

      const id = created.id;
      await api.store.setEnvironmentVariable(id, 'baseUrl', 'http://one.test');
      await api.store.setEnvironmentVariable(id, 'token', 'abc');
      const values = () => (api.store.environment(id)?.json.values ?? []) as any[];
      assert.deepEqual(values().map((v) => v.key), ['baseUrl', 'token']);

      await api.store.setEnvironmentVariableEnabled(id, 'token', false);
      assert.equal(values().find((v) => v.key === 'token')?.enabled, false);

      // Promoting to a secret moves the value out of the file entirely.
      await api.store.setEnvironmentVariableSecret(id, 'token', true);
      assert.equal(values().find((v) => v.key === 'token')?.value, '');
      assert.equal(await api.secrets.get(id, 'token'), 'abc');

      // Demoting must put it back rather than lose it.
      await api.store.setEnvironmentVariableSecret(id, 'token', false);
      assert.equal(values().find((v) => v.key === 'token')?.value, 'abc');
      assert.equal(await api.secrets.get(id, 'token'), undefined);

      await api.store.deleteEnvironmentVariable(id, 'token');
      assert.deepEqual(values().map((v) => v.key), ['baseUrl']);

      await api.store.unregister('environment', uri);
      assert.equal(api.store.environment(id), undefined);
      await vscode.workspace.fs.stat(uri); // the file survives being untracked
    } finally {
      await api.store.unregister('environment', uri).then(undefined, () => undefined);
      await vscode.workspace.fs.delete(uri, { useTrash: false }).then(undefined, () => undefined);
      await api.store.reload();
    }
  });

  test('a view title button does not clobber state with the tree node it passes', async () => {
    // VS Code invokes every view/title command with the tree's focusedElement,
    // so these handlers are handed a TreeNode where they declare a Uri or a
    // string. Guarding that is the difference between the globe opening the
    // picker and it silently clearing the selection.
    const focused = { kind: 'collection', entry: api.store.collections[0] };

    await api.setActiveEnvironment('env-local-0001');
    assert.equal(api.activeEnvironmentId(), 'env-local-0001');

    // Not awaited: with no preselection the handler opens a QuickPick, which
    // only settles once something dismisses it.
    void vscode.commands.executeCommand('restclient.selectEnvironment', focused);
    await new Promise((r) => setTimeout(r, 250));

    assert.equal(
      api.activeEnvironmentId(),
      'env-local-0001',
      'the focused tree node must not be stored as the active environment'
    );
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');

    await api.setActiveEnvironment(undefined);
  });

  test('a new collection is a real, editable v2.1.0 file where it was asked for', async function () {
    this.timeout(60000);
    const folder = vscode.workspace.workspaceFolders![0];
    const uri = vscode.Uri.joinPath(folder.uri, 'api', 'made-here.postman_collection.json');

    try {
      const created = await api.store.createCollection(uri, 'Made Here');
      assert.equal(created.name, 'Made Here');
      assert.equal(created.uri.fsPath, uri.fsPath, 'it lands exactly where it was asked for');
      assert.deepEqual(created.json.item, [], 'a new collection starts empty');
      assert.match(String(created.json.info.schema), /v2\.1\.0/);
      assert.ok(created.json.info._postman_id, 'Postman needs an id to re-import it');

      // Tracked in settings like any imported collection, and immediately editable.
      assert.ok(
        api.store.collections.some((c) => c.uri.fsPath === uri.fsPath),
        'the new collection should be tracked'
      );
      await api.store.editCollection(uri, addItem(undefined, newRequestItem('First')));
      const reloaded = api.store.collections.find((c) => c.uri.fsPath === uri.fsPath)!;
      assert.deepEqual(reloaded.materialized.tree.map((n) => n.name), ['First']);

      // Creating over an existing file needs the caller to have asked first.
      await assert.rejects(
        () => api.store.createCollection(uri, 'Clobber'),
        /already exists/,
        'an unguarded create must not overwrite'
      );
      const survived = api.store.collections.find((c) => c.uri.fsPath === uri.fsPath)!;
      assert.equal(survived.name, 'Made Here', 'the refused create changed nothing');
    } finally {
      await api.store.unregister('collection', uri).then(undefined, () => undefined);
      await vscode.workspace.fs.delete(uri, { useTrash: false }).then(undefined, () => undefined);
      await api.store.reload();
    }
  });

  test('the Environments pane is where the active environment is chosen', async function () {
    this.timeout(60000);
    // Activation used to hang off a globe in the Collections title bar, which had
    // nothing to do with collections. The pane that lists the environments owns
    // it now, one row at a time.
    const provider = new EnvironmentTreeProvider(api.store, () => api.activeEnvironmentId());
    const rowFor = async (id: string) =>
      (await provider.getChildren()).find((n) => n.kind === 'environment' && n.entry.id === id);

    await api.setActiveEnvironment(undefined);
    const inactive = await rowFor('env-local-0001');
    assert.ok(inactive, 'the fixture environment should be listed');

    const idle = provider.getTreeItem(inactive);
    assert.equal(idle.contextValue, 'environment');
    assert.equal(idle.command?.command, 'restclient.setActiveEnvironment');
    await vscode.commands.executeCommand(idle.command!.command, ...(idle.command!.arguments ?? []));
    assert.equal(api.activeEnvironmentId(), 'env-local-0001', 'clicking a row should activate it');

    // The active row has no click action: unsetting is the explicit command, so a
    // stray click cannot leave requests resolving against nothing.
    const active = await rowFor('env-local-0001');
    const running = provider.getTreeItem(active!);
    assert.equal(running.contextValue, 'environmentActive');
    assert.equal(running.command, undefined);

    await vscode.commands.executeCommand('restclient.clearActiveEnvironment');
    assert.equal(api.activeEnvironmentId(), undefined);

    // The context menu hands the command a tree node rather than an id.
    await vscode.commands.executeCommand('restclient.setActiveEnvironment', inactive);
    assert.equal(api.activeEnvironmentId(), 'env-local-0001');

    // And anything that is not an environment must be ignored, not stored.
    await vscode.commands.executeCommand('restclient.setActiveEnvironment', {
      kind: 'collection',
      entry: api.store.collections[0]
    });
    assert.equal(
      api.activeEnvironmentId(),
      'env-local-0001',
      'a non-environment argument must not change the selection'
    );

    await api.setActiveEnvironment(undefined);
  });
  test('exporting a collection hands over a copy, and starts working on nothing', async function () {
    this.timeout(30000);
    const folder = vscode.workspace.workspaceFolders![0];
    const source = vscode.Uri.joinPath(folder.uri, 'api', 'export-src.postman_collection.json');
    const dest = vscode.Uri.joinPath(folder.uri, 'api', 'handed-over.postman_collection.json');

    try {
      await api.store.createCollection(source, 'Export Src');
      await api.store.editCollection(source, addItem(undefined, newRequestItem('First')));
      const tracked = api.store.collections.length;

      // The dialog is skipped by passing the destination, the way the import
      // command takes a Uri from the explorer.
      await vscode.commands.executeCommand('restclient.exportCollection', source, dest);

      const written = Buffer.from(await vscode.workspace.fs.readFile(dest)).toString('utf8');
      const original = Buffer.from(await vscode.workspace.fs.readFile(source)).toString('utf8');
      assert.equal(written, original, 'an export is a byte-for-byte copy of the file on disk');
      assert.equal(JSON.parse(written).item[0].name, 'First');

      // Unlike New Collection, exporting does not adopt what it wrote.
      assert.equal(api.store.collections.length, tracked, 'the export must not be registered');
      assert.ok(
        !api.store.collections.some((c) => c.uri.fsPath === dest.fsPath),
        'the exported copy is not a collection this workspace works on'
      );

      // Exporting over a tracked file would destroy work in progress.
      await vscode.commands.executeCommand('restclient.exportCollection', source, source);
      const survived = Buffer.from(await vscode.workspace.fs.readFile(source)).toString('utf8');
      assert.equal(survived, original, 'a refused export changed nothing');
    } finally {
      await api.store.unregister('collection', source).then(undefined, () => undefined);
      await vscode.workspace.fs.delete(source, { useTrash: false }).then(undefined, () => undefined);
      await vscode.workspace.fs.delete(dest, { useTrash: false }).then(undefined, () => undefined);
      await api.store.reload();
    }
  });

  test('exporting every environment names the files after the environments', async function () {
    this.timeout(30000);
    const folder = vscode.workspace.workspaceFolders![0];
    const out = vscode.Uri.joinPath(folder.uri, 'export-out');

    try {
      await vscode.workspace.fs.createDirectory(out);
      const expected = exportFileNames(api.store.environments.map((e) => e.name), 'environment');

      await vscode.commands.executeCommand('restclient.exportAllEnvironments', out);

      const written = (await vscode.workspace.fs.readDirectory(out)).map(([name]) => name);
      assert.deepEqual(written.sort(), [...expected].sort(), 'one file per tracked environment');

      const local = JSON.parse(
        Buffer.from(
          await vscode.workspace.fs.readFile(vscode.Uri.joinPath(out, 'local.postman_environment.json'))
        ).toString('utf8')
      );
      assert.equal(local.id, 'env-local-0001');
      assert.equal(
        local.values.find((v: any) => v.key === 'pass').value,
        '',
        'secrets stay empty unless the export was told to include them'
      );
    } finally {
      await vscode.workspace.fs
        .delete(out, { recursive: true, useTrash: false })
        .then(undefined, () => undefined);
    }
  });

  test('an environment export can carry the secrets its file deliberately does not', async function () {
    this.timeout(30000);
    const folder = vscode.workspace.workspaceFolders![0];
    const uri = vscode.Uri.joinPath(folder.uri, 'api', 'secret-test.postman_environment.json');

    await vscode.workspace.fs.writeFile(
      uri,
      Buffer.from(
        JSON.stringify(
          {
            id: 'env-secret-test',
            name: 'Secret Test',
            values: [{ key: 'plain', value: 'hello', type: 'default', enabled: true }],
            _postman_variable_scope: 'environment'
          },
          null,
          '\t'
        ),
        'utf8'
      )
    );

    try {
      await api.store.reload();
      await api.store.editEnvironment(uri, [
        { key: 'plain', value: 'hello', type: 'default', enabled: true },
        { key: 'apiKey', value: 'top-secret-value', type: 'secret', enabled: true }
      ]);

      const exported = await api.store.exportEnvironmentJson('env-secret-test');
      assert.equal(
        exported.values.find((v: any) => v.key === 'apiKey').value,
        'top-secret-value',
        'the keychain value goes into the export'
      );
      assert.equal(exported.values.find((v: any) => v.key === 'plain').value, 'hello');
      assert.ok(exported._postman_exported_at, 'Postman stamps an export');

      // The file this workspace edits is untouched by having been exported.
      const onDisk = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
      assert.equal(onDisk.values.find((v: any) => v.key === 'apiKey').value, '');
    } finally {
      await api.secrets.delete('env-secret-test', 'apiKey');
      await vscode.workspace.fs.delete(uri, { useTrash: false }).then(undefined, () => undefined);
      await api.store.reload();
    }
  });

  test('a collection whose JSON is broken stays in the pane, with the reason', async function () {
    this.timeout(30000);
    const folder = vscode.workspace.workspaceFolders![0];
    const uri = vscode.Uri.joinPath(folder.uri, 'api', 'broken.postman_collection.json');
    // A missing comma after the info object: valid up to line 3, then not.
    const broken = '{\n\t"info": { "name": "Broken" }\n\t"item": []\n}\n';

    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(broken, 'utf8'));
      await api.store.reload();

      // It is not a collection anything can run or edit...
      assert.ok(
        !api.store.collections.some((c) => c.uri.fsPath === uri.fsPath),
        'an unparseable file must not be handed to the runner or the editor'
      );
      // ...but it has not silently vanished either.
      const entry = api.store.broken.find((b) => b.uri.fsPath === uri.fsPath);
      assert.ok(entry, 'a tracked file that will not parse should be reported');
      assert.equal(entry.kind, 'collection');
      assert.equal(entry.name, 'broken.postman_collection.json');

      const [problem] = entry.problems;
      assert.equal(problem.message, "Expected ','");
      assert.equal(problem.line, 3);
      assert.equal(problem.column, 2);

      const provider = new CollectionTreeProvider(api.store);
      const row = provider.getChildren().find((n) => n.kind === 'broken');
      assert.ok(row, 'the Collections pane should still list the file');

      const rowItem = provider.getTreeItem(row);
      assert.equal(rowItem.contextValue, 'collectionBroken');
      assert.equal(rowItem.label, 'broken.postman_collection.json');
      assert.equal(rowItem.description, 'invalid JSON');

      const children = provider.getChildren(row);
      assert.equal(children.length, entry.problems.length, 'one row per problem');
      const problemItem = provider.getTreeItem(children[0]);
      assert.equal(problemItem.label, "Expected ','");
      assert.equal(problemItem.description, 'Ln 3, Col 2');

      // Clicking it must land the cursor on the token that has to change.
      assert.equal(problemItem.command?.command, 'vscode.open');
      await vscode.commands.executeCommand(
        problemItem.command!.command,
        ...(problemItem.command!.arguments ?? [])
      );
      const editor = vscode.window.activeTextEditor;
      assert.ok(editor, 'the problem should have opened an editor');
      assert.equal(editor.document.uri.fsPath, uri.fsPath);
      assert.equal(editor.selection.start.line, 2, 'zero-based line 2 is "Ln 3"');
      assert.equal(editor.selection.start.character, 1, 'zero-based column 1 is "Col 2"');
      assert.equal(
        editor.document.getText(editor.selection),
        '"item"',
        'the offending token should be selected, not just pointed at'
      );
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

      // And fixing the file puts it back where it belongs.
      await restore(api, uri, '{\n\t"info": { "name": "Broken" },\n\t"item": []\n}\n');
      assert.deepEqual(api.store.broken, [], 'a fixed file is no longer a problem');
      assert.ok(api.store.collections.some((c) => c.name === 'Broken'), 'and loads normally');
    } finally {
      await vscode.workspace.fs.delete(uri, { useTrash: false }).then(undefined, () => undefined);
      await api.store.reload();
    }
  });

  test('a broken environment gets the same treatment as a broken collection', async function () {
    this.timeout(30000);
    const folder = vscode.workspace.workspaceFolders![0];
    const uri = vscode.Uri.joinPath(folder.uri, 'api', 'broken.postman_environment.json');

    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from('{ "name": "Half', 'utf8'));
      await api.store.reload();

      assert.ok(!api.store.environments.some((e) => e.uri.fsPath === uri.fsPath));
      const entry = api.store.broken.find((b) => b.uri.fsPath === uri.fsPath);
      assert.ok(entry, 'the Environments pane should still know about the file');
      assert.equal(entry.kind, 'environment');

      const provider = new EnvironmentTreeProvider(api.store, () => api.activeEnvironmentId());
      const row = (await provider.getChildren()).find((n) => n.kind === 'broken');
      assert.ok(row, 'the file should have a row of its own');
      assert.equal(provider.getTreeItem(row).contextValue, 'environmentBroken');

      const children = await provider.getChildren(row);
      assert.ok(children.length, 'with its problems underneath');
      assert.ok(
        children.every((c) => c.kind === 'problem'),
        'a broken file has problems for children, nothing else'
      );

      // The two things still worth doing to it are offered, and work.
      await vscode.commands.executeCommand('restclient.openEnvironmentFile', row);
      assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, uri.fsPath);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } finally {
      await vscode.workspace.fs.delete(uri, { useTrash: false }).then(undefined, () => undefined);
      await api.store.reload();
    }
  });

  test('a tracked file that is not there is missing, not broken', async () => {
    // Two different states with two different remedies, so they are two
    // different lists. Nothing here failed to parse — there is nothing to
    // parse — and calling it broken would send the user looking for a syntax
    // error in a file that does not exist.
    await api.store.reload();
    assert.deepEqual(
      api.store.broken.map((b) => b.name),
      [],
      'only files that exist and will not parse are problems'
    );

    const absent = api.store.missing.find((m) => m.name === 'never-written.postman_collection.json');
    assert.ok(absent, 'a listed path with no file behind it is reported as missing');
    assert.equal(absent.kind, 'collection');
    assert.equal(absent.source, 'registered', 'only listed files are ever reported missing');
    assert.equal(
      absent.setting,
      'api/never-written.postman_collection.json',
      'quoted the way it is written in settings, which is the string to go and fix'
    );
  });

  test('a missing file gets a row that says so, and offers the setting', async () => {
    // The old behaviour was silence: a stale path produced an empty pane and no
    // account of why, which is the one outcome that leaves nobody anything to
    // act on.
    await api.store.reload();
    const provider = new CollectionTreeProvider(api.store, api.results, api.runService);
    const row = provider
      .getChildren()
      .find((n) => n.kind === 'missing' && n.entry.name === 'never-written.postman_collection.json');
    assert.ok(row, 'the Collections pane shows a row for the file it cannot find');

    const item = provider.getTreeItem(row);
    assert.equal(item.description, 'file not found');
    assert.equal(item.contextValue, 'collectionMissing');
    assert.equal(
      item.command?.command,
      'restclient.openSettings',
      'clicking it goes to the list to edit, since there is no file to open'
    );
    assert.deepEqual(item.command?.arguments, ['restclient.collections']);
  });

  test('stopping work on a missing file drops the entry that named it', async () => {
    const ghost = 'api/ghost.postman_collection.json';
    await setRegistry([...BASE_COLLECTIONS, ghost], BASE_ENVIRONMENTS);
    await api.store.reload();
    try {
      const entry = api.store.missing.find((m) => m.name === 'ghost.postman_collection.json');
      assert.ok(entry, 'the ghost is reported before it can be dismissed');

      // Straight to the store: the command itself puts a modal in the way, and
      // what is under test is that the row carries enough to act on.
      await api.store.untrack('collection', entry.uri, entry.source);
      assert.ok(
        !configured('collections').includes(ghost),
        'the entry that named a file with nothing behind it is gone'
      );
      assert.ok(
        !api.store.missing.some((m) => m.name === 'ghost.postman_collection.json'),
        'and the row goes with it'
      );
    } finally {
      await restoreSuiteRegistry();
      await api.store.reload();
    }
  });

  test('the no-folder welcome opens a folder in this window, not a new one', () => {
    // `vscode.openFolder` was the old link and it is the wrong command here: it
    // is the generic "open somewhere" verb and lands the user in a second
    // window with no extension loaded in it — which reads exactly like
    // discovery being broken. The workbench file commands reuse an empty
    // window, and macOS desktop needs its own because `openFolder` is not the
    // command there.
    const extension = vscode.extensions.getExtension<TestApi>(EXTENSION_ID)!;
    const welcome: Array<{ view: string; contents: string; when?: string }> =
      extension.packageJSON.contributes.viewsWelcome;
    const noFolder = welcome.filter((w) => (w.when ?? '').includes('!restclient:hasWorkspace'));

    assert.ok(noFolder.length >= 2, 'the no-folder case is split by platform');
    assert.ok(
      noFolder.every((w) => !w.contents.includes('command:vscode.openFolder')),
      'vscode.openFolder opens a second window and must not be the link here'
    );
    assert.ok(
      noFolder.some((w) => w.contents.includes('command:workbench.action.files.openFileFolder')),
      'macOS desktop gets openFileFolder'
    );
    assert.ok(
      noFolder.some((w) => w.contents.includes('command:workbench.action.files.openFolder')),
      'everywhere else gets openFolder'
    );
  });

  test('the empty panes offer a way into the settings behind them', () => {
    // Autodiscovery decides whether a pane is empty because there is nothing to
    // find or because nothing is looking, and it was reachable only by knowing
    // the setting's name.
    const extension = vscode.extensions.getExtension<TestApi>(EXTENSION_ID)!;
    const welcome: Array<{ view: string; contents: string; when?: string }> =
      extension.packageJSON.contributes.viewsWelcome;

    for (const view of ['restclient.collections', 'restclient.environments']) {
      const empty = welcome.filter(
        (w) => w.view === view && (w.when ?? '').startsWith('restclient:hasWorkspace &&')
      );
      assert.ok(empty.length, `${view} has empty-state copy`);
      assert.ok(
        empty.every((w) => w.contents.includes('command:restclient.openSettings')),
        `${view} offers its settings when it has nothing to show`
      );
    }

    const titles: Array<{ command: string; when: string }> =
      extension.packageJSON.contributes.menus['view/title'];
    for (const view of ['restclient.collections', 'restclient.environments']) {
      assert.ok(
        titles.some((e) => e.command === 'restclient.openSettings' && e.when.includes(view)),
        `${view} has a settings button in its title bar`
      );
    }
  });

  test('every command a welcome view links to actually exists', async () => {
    // A welcome link is a bare string in the manifest — nothing checks it, and
    // a wrong id renders as a button that does nothing at all. This is exactly
    // how the old `vscode.openFolder` link went unnoticed.
    const extension = vscode.extensions.getExtension<TestApi>(EXTENSION_ID)!;
    const welcome: Array<{ contents: string }> = extension.packageJSON.contributes.viewsWelcome;
    const registered = new Set(await vscode.commands.getCommands(true));

    const linked = new Set<string>();
    for (const view of welcome) {
      for (const match of view.contents.matchAll(/\(command:([^)\s]+)\)/g)) {
        linked.add(match[1]);
      }
    }
    assert.ok(linked.size, 'the welcome views link to something');

    // These two are one choice made twice, gated on platform: only the one for
    // the host running this suite is registered here.
    const platformGated = new Set([
      'workbench.action.files.openFolder',
      'workbench.action.files.openFileFolder'
    ]);
    for (const command of linked) {
      if (platformGated.has(command)) { continue; }
      assert.ok(registered.has(command), `${command} is linked but not registered`);
    }
    assert.ok(
      [...platformGated].some((command) => registered.has(command)),
      'this platform has one of the open-folder commands'
    );
  });

  test('New Request and New Folder belong to the rows they act on, not the title bar', () => {
    // They target a collection or folder, so from the title bar there is no
    // obvious parent — the handler had to guess or ask. The rows have no such
    // ambiguity, and both are inline there.
    const extension = vscode.extensions.getExtension<TestApi>(EXTENSION_ID)!;
    const menus = extension.packageJSON.contributes.menus;
    const titles: Array<{ command: string; when: string }> = menus['view/title'];
    const items: Array<{ command: string; when: string; group: string }> = menus['view/item/context'];

    for (const command of ['restclient.newRequest', 'restclient.newFolder']) {
      assert.ok(
        !titles.some((e) => e.command === command && e.when.includes('restclient.collections')),
        `${command} should not be in the Collections title bar`
      );
      const rows = items.filter((e) => e.command === command);
      assert.ok(
        rows.some((e) => e.group.startsWith('inline')),
        `${command} should be an inline action on a row`
      );
      assert.ok(
        rows.some((e) => !e.group.startsWith('inline')),
        `${command} should also be a labelled context-menu entry`
      );
    }
  });
});
