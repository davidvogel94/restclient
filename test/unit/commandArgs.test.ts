import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  cookieNodeArg,
  envNodeArg,
  missingNodeArg,
  stringArg,
  treeNodeArg,
  uriArgs
} from '../../src/commandArgs';

/** Enough of a vscode.Uri for the duck-typed guard. */
function uri(fsPath: string): any {
  return { scheme: 'file', path: fsPath, fsPath, toString: () => `file://${fsPath}` };
}

/** What a `view/title` button actually passes: the tree's focused element. */
const TREE_NODE: any = {
  kind: 'item',
  entry: { uri: uri('/ws/.restclient/collections/a.json'), name: 'A' },
  node: { id: 'a', name: 'Req', isFolder: false }
};

test('uriArgs ignores a focused tree node', () => {
  assert.deepEqual(uriArgs(TREE_NODE), []);
  assert.deepEqual(uriArgs(undefined), []);
  assert.deepEqual(uriArgs({ kind: 'collection', entry: {} }), []);
});

test('uriArgs keeps a single uri', () => {
  const a = uri('/tmp/a.postman_collection.json');
  assert.deepEqual(uriArgs(a).map((u) => u.fsPath), ['/tmp/a.postman_collection.json']);
});

test('uriArgs collects an explorer multi-selection without duplicating the first', () => {
  const a = uri('/tmp/a.json');
  const b = uri('/tmp/b.json');
  const c = uri('/tmp/c.json');
  // VS Code invokes explorer/context commands as (uri, uris[]) where uris includes uri.
  assert.deepEqual(uriArgs(a, [a, b, c]).map((u) => u.fsPath), ['/tmp/a.json', '/tmp/b.json', '/tmp/c.json']);
});

test('uriArgs drops non-uris mixed into the selection array', () => {
  const a = uri('/tmp/a.json');
  assert.deepEqual(uriArgs(a, [a, TREE_NODE, 'nope', null]).map((u) => u.fsPath), ['/tmp/a.json']);
});

test('stringArg only accepts strings', () => {
  assert.equal(stringArg('env-1'), 'env-1');
  assert.equal(stringArg(''), '');
  assert.equal(stringArg(TREE_NODE), undefined);
  assert.equal(stringArg(undefined), undefined);
  assert.equal(stringArg(7), undefined);
});

test('treeNodeArg only accepts real tree nodes', () => {
  assert.equal(treeNodeArg(TREE_NODE), TREE_NODE);
  assert.equal(treeNodeArg({ kind: 'collection', entry: { name: 'A' } })?.kind, 'collection');
  assert.equal(treeNodeArg(uri('/tmp/a.json')), undefined);
  assert.equal(treeNodeArg('env-1'), undefined);
  assert.equal(treeNodeArg({ kind: 'item' }), undefined, 'a node with no entry is not usable');
  assert.equal(treeNodeArg(undefined), undefined);
});

test('envNodeArg only accepts Environments view nodes', () => {
  const env: any = { kind: 'environment', entry: { id: 'e1', name: 'Local' }, active: true };
  const variable: any = { kind: 'variable', entry: { id: 'e1' }, variable: { key: 'baseUrl' } };

  assert.equal(envNodeArg(env), env);
  assert.equal(envNodeArg(variable), variable);
  // A collection-tree node must not be mistaken for an environment one.
  assert.equal(envNodeArg(TREE_NODE), undefined);
  assert.equal(envNodeArg({ kind: 'environment' }), undefined, 'a node with no entry is not usable');
  assert.equal(envNodeArg('e1'), undefined);
  assert.equal(envNodeArg(undefined), undefined);
});

test('cookieNodeArg only accepts Cookies view rows', () => {
  const domain: any = { kind: 'domain', domain: 'api.example.com', cookies: [] };
  const cookie: any = {
    kind: 'cookie',
    domain: 'api.example.com',
    cookie: { key: 'session', value: 'abc', domain: 'api.example.com', path: '/' }
  };
  assert.equal(cookieNodeArg(domain), domain);
  assert.equal(cookieNodeArg(cookie), cookie);
  assert.equal(cookieNodeArg(TREE_NODE), undefined);
  assert.equal(cookieNodeArg({ kind: 'cookie' }), undefined, 'a row with no cookie is not usable');
  assert.equal(cookieNodeArg({ kind: 'domain' }), undefined);
  assert.equal(cookieNodeArg(undefined), undefined);
});

test('missingNodeArg only accepts a row for a file that is not on disk', () => {
  const missing: any = {
    kind: 'missing',
    entry: { kind: 'collection', uri: { fsPath: '/ws/gone.json' }, name: 'gone.json' }
  };
  const broken: any = { kind: 'broken', entry: { problems: [] } };

  assert.equal(missingNodeArg(missing), missing);
  // The three unusable-file rows are told apart by kind, because the action
  // each one supports is different.
  assert.equal(missingNodeArg(broken), undefined);
  assert.equal(missingNodeArg(TREE_NODE), undefined);
  assert.equal(missingNodeArg({ kind: 'missing' }), undefined, 'a row with no entry is not usable');
  assert.equal(missingNodeArg(undefined), undefined);
});
