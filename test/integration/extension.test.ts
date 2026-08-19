import * as assert from 'node:assert';
import * as http from 'node:http';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import type { RunnerMessage } from '../../src/runner/protocol';
import { CookiePanel } from '../../src/panels/cookiePanel';
import { EnvironmentTreeProvider } from '../../src/tree/environmentProvider';
import { buildRequestEdits } from '../../src/collections/edits';
import {
  addItem,
  deleteItem,
  duplicateItem,
  newFolderItem,
  newRequestItem,
  renameItem
} from '../../src/collections/structure';

const EXTENSION_ID = 'locatrix.restclient';
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
  'api/cookie-send.postman_collection.json'
];
const SCRATCH_ENVIRONMENTS = [
  `api/${TEST_ENV_FILE}`,
  'api/secret-test.postman_environment.json',
  'api/mount-test.postman_environment.json'
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

  test('adds a Postman file without copying or rewriting it', async function () {
    this.timeout(60000);
    const folder = vscode.workspace.workspaceFolders![0];
    const source = vscode.Uri.joinPath(folder.uri, 'add-me.postman_environment.json');
    const original = JSON.stringify({
      id: 'env-added-1',
      name: 'Added',
      values: [
        { key: 'plain', value: 'visible', type: 'default', enabled: true },
        { key: 'apiKey', value: 'super-secret', type: 'secret', enabled: true }
      ],
      _postman_variable_scope: 'environment'
    });
    await vscode.workspace.fs.writeFile(source, Buffer.from(original, 'utf8'));

    try {
      const before = api.store.environments.length;
      await vscode.commands.executeCommand('restclient.import', source);
      await api.store.reload();

      assert.equal(api.store.environments.length, before + 1, 'the environment should be tracked');
      const added = api.store.environment('env-added-1');
      assert.ok(added, 'the environment should be discoverable');

      // Worked on in place: same path, byte-identical content.
      assert.equal(added.uri.fsPath, source.fsPath, 'nothing should have been copied');
      const onDisk = Buffer.from(await vscode.workspace.fs.readFile(source)).toString('utf8');
      assert.equal(onDisk, original, 'adding a file must not rewrite it');

      // And it is recorded in settings, not in hidden state.
      const configured = vscode.workspace
        .getConfiguration('restclient', folder.uri)
        .get<string[]>('environments', []);
      assert.ok(
        configured.includes('add-me.postman_environment.json'),
        `the setting should name the file, got ${JSON.stringify(configured)}`
      );

      await api.store.unregister('environment', source);
      assert.equal(api.store.environment('env-added-1'), undefined, 'removing should untrack it');
      await vscode.workspace.fs.stat(source); // still there — we only stopped tracking it
    } finally {
      await api.store.unregister('environment', source).then(undefined, () => undefined);
      await vscode.workspace.fs.delete(source, { useTrash: false }).then(undefined, () => undefined);
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
      await panel.sendForTest();
      panel.dispose();

      // Reopening builds a brand new webview; the response must come back with it.
      const reopened = api.panels.open(entry, node);
      await reopened.whenReady;
      const restored = reopened.restoredForTest();
      assert.ok(restored?.response, 'the cached response should be replayed');
      assert.equal(restored.response.code, 200);

      api.panels.clearResponses();
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
});
