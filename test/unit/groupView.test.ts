import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { materialize } from '../../src/collections/model';
import { buildGroupView, contentRequests, type GroupEntry } from '../../src/collections/view';

/** The contents tree as indented text, which is the shape under test. */
function outline(entries: GroupEntry[], depth = 0): string[] {
  return entries.flatMap((entry) =>
    entry.kind === 'folder'
      ? ['  '.repeat(depth) + `[${entry.name}]`, ...outline(entry.children, depth + 1)]
      : ['  '.repeat(depth) + `${entry.method} ${entry.name}`]
  );
}

function build() {
  return materialize({
    info: {
      name: 'Shop',
      description: 'The storefront API.',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
    },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
    variable: [{ key: 'baseUrl', value: 'https://api.shop', type: 'default' }],
    event: [{ listen: 'prerequest', script: { exec: ['console.log("collection")'] } }],
    item: [
      { name: 'Health', request: { method: 'GET', url: { raw: '{{baseUrl}}/health' } } },
      {
        name: 'Orders',
        description: { content: 'Everything order-shaped.', type: 'text/markdown' },
        variable: [{ key: 'orderId', value: '7' }],
        event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => {});'] } }],
        item: [
          { name: 'List', request: { method: 'GET', url: { raw: '{{baseUrl}}/orders' } } },
          {
            name: 'Nested',
            auth: { type: 'basic', basic: [{ key: 'username', value: 'u' }] },
            item: [
              { name: 'Deep', request: { method: 'DELETE', url: { raw: '{{baseUrl}}/orders/1' } } }
            ]
          }
        ]
      }
    ]
  } as any);
}

const folder = (name: string) => {
  const m = build();
  const node = [...m.index.values()].find((n) => n.name === name && n.isFolder)!;
  return { m, view: buildGroupView(m, 'Shop', node)! };
};

test('the collection view is its own settings and everything under it', () => {
  const m = build();
  const view = buildGroupView(m, 'Shop')!;

  assert.equal(view.kind, 'collection');
  assert.equal(view.itemId, undefined, 'the collection is not an item');
  assert.equal(view.name, 'Shop');
  assert.deepEqual(view.path, []);
  assert.equal(view.description, 'The storefront API.');
  assert.equal(view.auth.type, 'bearer');
  assert.equal(view.auth.inheritedFrom, undefined, 'nothing sits above a collection');
  assert.deepEqual(view.variables.map((v) => v.key), ['baseUrl']);
  assert.match(view.scripts.prerequest ?? '', /collection/);
  assert.deepEqual(view.inheritedScripts, [], 'a collection inherits from nowhere');

  assert.deepEqual(
    outline(view.contents),
    [
      'GET Health',
      '[Orders]',
      '  GET List',
      '  [Nested]',
      '    DELETE Deep'
    ],
    'folders stay folders, in collection order, rather than becoming a column'
  );
  assert.equal(view.requests, 3, 'requests at any depth');
  assert.equal(view.folders, 2, 'Orders and Nested, counted at any depth');
});

test('a folder view carries its own settings and its slice of the tree', () => {
  const { view } = folder('Orders');

  assert.equal(view.kind, 'folder');
  assert.equal(view.name, 'Orders');
  assert.deepEqual(view.path, [], 'Orders sits at the collection root');
  assert.equal(view.description, 'Everything order-shaped.', 'a {content} description reads as text');
  assert.deepEqual(view.variables.map((v) => v.key), ['orderId']);
  assert.equal(view.scripts.test, 'pm.test("ok", () => {});');
  assert.equal(view.folders, 1);
  assert.equal(view.requests, 2);
  assert.deepEqual(
    outline(view.contents),
    ['GET List', '[Nested]', '  DELETE Deep'],
    'the tree starts at this folder, not at the collection'
  );
});

test('a folder with no auth of its own says where its auth comes from', () => {
  const { view } = folder('Orders');
  assert.equal(view.auth.type, 'bearer');
  assert.equal(view.auth.inheritedFrom, 'Shop');
  assert.deepEqual(view.auth.params.map((p) => p.key), ['token']);
});

test('a folder that declares auth is not reported as inheriting it', () => {
  const { view } = folder('Nested');
  assert.equal(view.auth.type, 'basic');
  assert.equal(view.auth.inheritedFrom, undefined);
  assert.deepEqual(view.path, ['Orders'], 'named down from the collection, exclusive of itself');
});

test('a nested folder also runs everything its ancestors declare', () => {
  const { view } = folder('Nested');
  assert.deepEqual(
    view.inheritedScripts.map((s) => `${s.from}:${s.listen}`),
    ['Shop:prerequest', 'Orders:test']
  );
});

test('a folder with nothing set reports the empty state rather than nothing at all', () => {
  const m = materialize({
    info: { name: 'Bare' },
    item: [{ name: 'Empty', item: [] }]
  } as any);
  const node = [...m.index.values()].find((n) => n.name === 'Empty')!;
  const view = buildGroupView(m, 'Bare', node)!;

  assert.equal(view.auth.type, 'none');
  assert.deepEqual(view.variables, []);
  assert.equal(view.description, '');
  assert.deepEqual(view.contents, []);
  assert.equal(view.requests, 0);
  assert.equal(view.folders, 0);
});

test('a node that is a request, not a folder, has no group view', () => {
  const m = build();
  const request = [...m.index.values()].find((n) => n.name === 'Health')!;
  assert.equal(buildGroupView(m, 'Shop', request), undefined);
});

test('identically named sibling folders stay distinguishable', () => {
  const m = materialize({
    info: { name: 'Dupes' },
    item: [
      { name: 'Same', item: [{ name: 'First', request: { method: 'GET', url: 'https://1' } }] },
      { name: 'Same', item: [{ name: 'Second', request: { method: 'GET', url: 'https://2' } }] }
    ]
  } as any);

  const folders = [...m.index.values()].filter((n) => n.isFolder);
  assert.deepEqual(
    folders.map((n) => contentRequests(buildGroupView(m, 'Dupes', n)!.contents)[0].name),
    ['First', 'Second'],
    'the `~n` path suffix resolves each to its own folder'
  );
  assert.deepEqual(
    folders.map((n) => buildGroupView(m, 'Dupes', n)!.name),
    ['Same', 'Same'],
    'the suffix is an addressing device, never shown'
  );
});

test('a run visits the contents in the order the tree draws them', () => {
  const m = build();
  const view = buildGroupView(m, 'Shop')!;
  assert.deepEqual(
    contentRequests(view.contents).map((r) => r.name),
    ['Health', 'List', 'Deep'],
    'depth-first, which is what Run All queues and postman-runtime then does'
  );
  assert.equal(
    contentRequests(view.contents).length,
    view.requests,
    'the count and the list cannot disagree'
  );
});

test('a folder holding only folders still reports what is under it', () => {
  const m = materialize({
    info: { name: 'Deep' },
    item: [
      {
        name: 'Outer',
        item: [{ name: 'Inner', item: [{ name: 'Leaf', request: { method: 'PUT', url: 'https://l' } }] }]
      }
    ]
  } as any);
  const outer = [...m.index.values()].find((n) => n.name === 'Outer')!;
  const view = buildGroupView(m, 'Deep', outer)!;

  assert.deepEqual(outline(view.contents), ['[Inner]', '  PUT Leaf']);
  assert.equal(view.requests, 1, 'a folder with no direct requests is not an empty folder');
  assert.equal(view.folders, 1);
});
