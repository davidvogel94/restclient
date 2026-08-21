import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { materialize } from '../../src/collections/model';
import { buildGroupView, contentRequests, type GroupEntry } from '../../src/collections/view';
import {
  countRequests,
  filterEntries,
  filterItems,
  filterVariables,
  matches,
  parseFilter,
  type Filter
} from '../../src/tree/filter';

function tree() {
  return materialize({
    info: { name: 'Filtering', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      { name: 'Health', request: { method: 'GET', url: 'https://api.example.com/health' } },
      {
        name: 'Users',
        item: [
          { name: 'List', request: { method: 'GET', url: { raw: 'https://api.example.com/users' } } },
          { name: 'Create', request: { method: 'POST', url: { raw: 'https://api.example.com/users' } } },
          {
            name: 'Nested',
            item: [{ name: 'Delete', request: { method: 'DELETE', url: 'https://api.example.com/users/1' } }]
          }
        ]
      },
      { name: 'Reports', item: [{ name: 'Daily', request: { method: 'GET', url: 'https://api.example.com/reports' } }] }
    ]
  } as any).tree;
}

const of = (text: string): Filter => {
  const filter = parseFilter(text);
  assert.ok(filter, `expected "${text}" to parse as a filter`);
  return filter;
};

const names = (nodes: Array<{ name: string }>) => nodes.map((n) => n.name);

test('blank input is no filter at all', () => {
  assert.equal(parseFilter(undefined), undefined);
  assert.equal(parseFilter(''), undefined);
  assert.equal(parseFilter('   '), undefined);
  assert.deepEqual(parseFilter('  users  '), { text: 'users', terms: ['users'] });
});

test('every term must match, in any field and any order', () => {
  assert.equal(matches(of('user'), 'List Users'), true);
  assert.equal(matches(of('USERS'), 'list users'), true, 'case is ignored');
  assert.equal(matches(of('post users'), 'Create', 'POST', 'https://x/users'), true);
  assert.equal(matches(of('users post'), 'Create', 'POST', 'https://x/users'), true);
  assert.equal(matches(of('put users'), 'Create', 'POST', 'https://x/users'), false);
  assert.equal(matches(of('users'), 'Create', undefined), false, 'undefined fields are skipped');
});

test('a matching request is kept, its folders with it', () => {
  const kept = filterItems(tree(), of('create'));
  assert.deepEqual(names(kept), ['Users']);
  assert.deepEqual(names(kept[0].children), ['Create']);
});

test('a folder that matches by name keeps everything inside it', () => {
  const kept = filterItems(tree(), of('reports'));
  assert.deepEqual(names(kept), ['Reports']);
  assert.deepEqual(names(kept[0].children), ['Daily']);
});

test('matches are found however deeply they are nested', () => {
  const kept = filterItems(tree(), of('delete'));
  assert.deepEqual(names(kept), ['Users']);
  assert.deepEqual(names(kept[0].children), ['Nested']);
  assert.deepEqual(names(kept[0].children[0].children), ['Delete']);
});

test('method and URL are searchable, not just names', () => {
  assert.deepEqual(names(filterItems(tree(), of('health'))), ['Health'], 'a string URL');
  const byUrl = filterItems(tree(), of('example.com/users'));
  assert.deepEqual(names(byUrl[0].children), ['List', 'Create', 'Nested'], 'an object URL with a raw');
  const byMethod = filterItems(tree(), of('delete'));
  assert.deepEqual(names(byMethod[0].children[0].children), ['Delete']);
});

test('nothing matching leaves nothing behind', () => {
  assert.deepEqual(filterItems(tree(), of('nonesuch')), []);
});

test('pruning copies: the store\'s own tree keeps all of its children', () => {
  const original = tree();
  const kept = filterItems(original, of('create'));
  assert.deepEqual(names(kept[0].children), ['Create']);
  assert.deepEqual(names(original[1].children), ['List', 'Create', 'Nested'], 'untouched');
  assert.equal(kept[0].id, original[1].id, 'and the copy is still the same item');
  assert.deepEqual(kept[0].jsonPath, original[1].jsonPath);
});

test('counting reports requests, not folders', () => {
  assert.equal(countRequests(tree()), 5);
  assert.equal(countRequests(filterItems(tree(), of('users'))), 3);
  assert.equal(countRequests([]), 0);
});

test('variables match on key or value, but never a secret value', () => {
  const variables = [
    { key: 'baseUrl', value: 'https://staging.example.com', secret: false },
    { key: 'token', value: 'staging-secret', secret: true },
    { key: 'timeout', value: '30', secret: false }
  ];

  assert.deepEqual(
    filterVariables(variables, of('staging')).map((v) => v.key),
    ['baseUrl'],
    'the secret holding "staging" stays hidden'
  );
  assert.deepEqual(filterVariables(variables, of('token')).map((v) => v.key), ['token'], 'by key');
  assert.deepEqual(
    filterVariables(variables, of('example.com')).map((v) => v.key),
    ['baseUrl'],
    'by value'
  );
  assert.deepEqual(filterVariables(variables, of('nonesuch')), []);
});

/** The overview's contents tree, from the same collection the trees use. */
function entries(): GroupEntry[] {
  const source = {
    info: { name: 'Filtering', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      { name: 'Health', request: { method: 'GET', url: 'https://api.example.com/health' } },
      {
        name: 'Users',
        item: [
          { name: 'List', request: { method: 'GET', url: { raw: 'https://api.example.com/users' } } },
          { name: 'Create', request: { method: 'POST', url: { raw: 'https://api.example.com/users' } } },
          {
            name: 'Nested',
            item: [{ name: 'Delete', request: { method: 'DELETE', url: 'https://api.example.com/users/1' } }]
          }
        ]
      },
      { name: 'Reports', item: [{ name: 'Daily', request: { method: 'GET', url: 'https://api.example.com/reports' } }] }
    ]
  };
  return buildGroupView(materialize(source as any), 'Filtering')!.contents;
}

const outline = (list: GroupEntry[]): string[] =>
  list.flatMap((entry) =>
    entry.kind === 'folder' ? [`[${entry.name}]`, ...outline(entry.children)] : [entry.name]
  );

test('overview contents filter on the same terms as the trees', () => {
  assert.deepEqual(outline(filterEntries(entries(), of('create'))), ['[Users]', 'Create']);
  assert.deepEqual(
    outline(filterEntries(entries(), of('delete users'))),
    ['[Users]', '[Nested]', 'Delete'],
    'a deep hit keeps the folders above it'
  );
  assert.deepEqual(
    outline(filterEntries(entries(), of('example.com/health'))),
    ['Health'],
    'the URL is searched too'
  );
  assert.deepEqual(filterEntries(entries(), of('nonesuch')), []);
});

test('a folder named by the filter keeps everything inside it', () => {
  assert.deepEqual(
    outline(filterEntries(entries(), of('users'))),
    ['[Users]', 'List', 'Create', '[Nested]', 'Delete'],
    'including the children that do not repeat its name'
  );
});

test('filtering the contents leaves the panel\'s own view alone', () => {
  const all = entries();
  const kept = filterEntries(all, of('create'));
  assert.equal(contentRequests(kept).length, 1);
  assert.equal(contentRequests(all).length, 5, 'untouched');
  const folder = kept[0];
  assert.ok(folder.kind === 'folder');
  assert.equal(folder.itemId, (all[1] as Extract<GroupEntry, { kind: 'folder' }>).itemId);
});
