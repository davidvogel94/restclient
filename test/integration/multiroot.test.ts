import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import { CollectionTreeProvider } from '../../src/tree/provider';

/**
 * A genuine multi-root workspace, which is the supported answer to "my
 * collections are not in the repo I opened".
 *
 * Its own suite and its own window rather than a folder added to the main
 * fixture at runtime: converting a single-folder window into a workspace is
 * persistent state that outlives the run, and one interrupted run would poison
 * every run after it. A `.code-workspace` fixture is the same thing declared up
 * front, and it is also closer to what a user actually has.
 *
 * The fixture is deliberately lopsided. `repo` has the scan turned *off* and
 * one collection listed by a relative path in its own folder settings;
 * `collections` has no settings at all. So a pass means two separate things
 * work: settings are read per folder, and one folder opting out does not opt
 * the other out.
 */

const EXTENSION_ID = 'davidvogel94.restclient';

async function waitFor(condition: () => boolean, what: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) { throw new Error(`Timed out waiting: ${what}`); }
    await new Promise((r) => setTimeout(r, 50));
  }
}

suite('REST Client in a multi-root workspace', () => {
  let api: TestApi;
  let repo: vscode.WorkspaceFolder;
  let collections: vscode.WorkspaceFolder;

  suiteSetup(async function () {
    this.timeout(60000);
    const extension = vscode.extensions.getExtension<TestApi>(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} should be present`);
    api = await extension.activate();

    const folders = vscode.workspace.workspaceFolders ?? [];
    assert.equal(folders.length, 2, 'the multi-root fixture should be open');
    repo = folders[0];
    collections = folders[1];
    assert.equal(path.basename(repo.uri.fsPath), 'repo');
    assert.equal(path.basename(collections.uri.fsPath), 'collections');

    await api.store.rescan();
  });

  test('every folder is a root the runner may read from', () => {
    assert.deepEqual(api.store.workspaceRoots, [repo.uri.fsPath, collections.uri.fsPath]);
  });

  test('a folder listing a collection relatively resolves it against itself', async () => {
    // `api/listed.postman_collection.json` is written in `repo`'s own folder
    // settings. Resolved against the wrong root it names nothing, so this
    // failing looks exactly like the file having gone missing.
    await waitFor(
      () => api.store.collections.some((c) => c.name === 'Listed'),
      'the listed collection to load'
    );
    const listed = api.store.collections.find((c) => c.name === 'Listed')!;
    assert.equal(listed.source, 'registered');
    assert.equal(api.store.rootFor(listed.uri), repo.uri.fsPath);
    assert.deepEqual(api.store.missing, [], 'nothing was looked for in the wrong folder');
  });

  test('a second folder is scanned even though the first one opted out', async () => {
    await waitFor(
      () => api.store.collections.some((c) => c.name === 'Sibling'),
      'the collection in the second folder to be discovered'
    );
    await waitFor(
      () => api.store.environments.some((e) => e.name === 'Sibling Env'),
      'the environment in the second folder to be discovered'
    );

    const sibling = api.store.collections.find((c) => c.name === 'Sibling')!;
    assert.equal(sibling.source, 'discovered', 'nothing had to be listed for it to appear');
    assert.equal(
      api.store.rootFor(sibling.uri),
      collections.uri.fsPath,
      'its own folder is what its relative paths resolve against'
    );

    // `repo` sets `autoDiscover: false`, and it must stay false for `repo`
    // alone — otherwise turning the scan off anywhere turns it off everywhere.
    assert.ok(
      !api.store.collections.some((c) => c.uri.fsPath.startsWith(repo.uri.fsPath) && c.source === 'discovered'),
      'the folder that opted out is not scanned'
    );
  });

  test('both folders feed the same tree', async () => {
    const provider = new CollectionTreeProvider(api.store, api.results, api.runService);
    const names = provider
      .getChildren()
      .filter((n) => n.kind === 'collection')
      .map((n) => n.entry.name)
      .sort();
    assert.deepEqual(names, ['Listed', 'Sibling']);
  });

  test('tracking a file writes it into the settings of the folder that holds it', async () => {
    // The write scope is the part multi-root actually changes: an entry has to
    // land in the folder it is relative to, or it resolves against the wrong
    // root the next time the window opens.
    const added = vscode.Uri.joinPath(collections.uri, 'sibling.postman_environment.json');
    const settingsUri = vscode.Uri.joinPath(collections.uri, '.vscode', 'settings.json');

    await api.store.registry.add('environment', added);
    try {
      const written = Buffer.from(await vscode.workspace.fs.readFile(settingsUri)).toString('utf8');
      assert.ok(
        written.includes('sibling.postman_environment.json'),
        'the entry is in the holding folder’s settings'
      );
      assert.ok(
        !written.includes(collections.uri.fsPath),
        'and is relative, not an absolute path baked in from this machine'
      );
      assert.ok(
        api.store.registry.has('environment', added),
        'and reading it back resolves against the same folder'
      );
    } finally {
      await api.store.registry.remove('environment', added);
      assert.ok(
        !api.store.registry.has('environment', added),
        'removing it takes the entry back out of that folder'
      );
      await vscode.workspace.fs.delete(settingsUri, { useTrash: false }).then(undefined, () => undefined);
    }
  });
});
