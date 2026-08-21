import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildGroupEdits, type GroupUpdate } from '../../src/collections/edits';
import { applyJsonEdits } from '../../src/collections/jsonEdit';
import { materialize } from '../../src/collections/model';

const SOURCE = JSON.stringify(
  {
    info: {
      _postman_id: 'abc',
      name: 'Shop',
      description: 'The storefront API.',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
    },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: 'old', type: 'string' }] },
    variable: [
      { key: 'baseUrl', value: 'https://api.shop', type: 'string', description: 'the host' },
      { key: 'stale', value: 'x', type: 'default', disabled: true }
    ],
    item: [
      { name: 'Health', request: { method: 'GET', url: { raw: 'https://api.shop/health' } } },
      { name: 'Orders', item: [{ name: 'List', request: { method: 'GET', url: { raw: '/orders' } } }] }
    ]
  },
  null,
  '\t'
);

/** Apply one group update to the fixture, at the collection or at a folder. */
function apply(target: 'collection' | string, update: GroupUpdate) {
  const { json, index } = materialize(JSON.parse(SOURCE));
  const node = target === 'collection'
    ? undefined
    : [...index.values()].find((n) => n.name === target && n.isFolder)!;

  const groupPath = node?.jsonPath ?? [];
  let raw: any = json;
  for (const segment of groupPath) { raw = raw?.[segment as any]; }

  const after = applyJsonEdits(SOURCE, buildGroupEdits(groupPath, raw, update));
  return { after, parsed: JSON.parse(after) };
}

test('a collection is renamed inside info, a folder in place', () => {
  assert.equal(apply('collection', { field: 'name', value: 'Storefront' }).parsed.info.name, 'Storefront');
  const folder = apply('Orders', { field: 'name', value: 'Purchases' }).parsed;
  assert.equal(folder.item[1].name, 'Purchases');
  assert.equal(folder.info.name, 'Shop', 'the collection name is not the folder name');
});

test('a description is written where the container keeps it', () => {
  assert.equal(
    apply('collection', { field: 'description', value: 'Now with returns.' }).parsed.info.description,
    'Now with returns.'
  );
  assert.equal(
    apply('Orders', { field: 'description', value: 'Order endpoints.' }).parsed.item[1].description,
    'Order endpoints.'
  );
});

test('an emptied description is removed rather than left blank', () => {
  const parsed = apply('collection', { field: 'description', value: '   ' }).parsed;
  assert.equal('description' in parsed.info, false, 'Postman omits the key entirely');
});

test('auth is replaced with the shape Postman writes', () => {
  const parsed = apply('collection', {
    field: 'auth',
    authType: 'basic',
    rows: [{ key: 'username', value: 'admin' }, { key: 'password', value: '{{pw}}' }, { key: '', value: 'x' }]
  }).parsed;

  assert.deepEqual(parsed.auth, {
    type: 'basic',
    basic: [
      { key: 'username', value: 'admin', type: 'string' },
      { key: 'password', value: '{{pw}}', type: 'string' }
    ]
  });
  assert.equal('bearer' in parsed.auth, false, 'the previous type does not linger');
});

test('a folder set to inherit drops its auth block', () => {
  const withAuth = apply('Orders', { field: 'auth', authType: 'bearer', rows: [{ key: 'token', value: 't' }] }).parsed;
  assert.equal(withAuth.item[1].auth.type, 'bearer');

  const inherited = apply('Orders', { field: 'auth', authType: 'inherit', rows: [] }).parsed;
  assert.equal('auth' in inherited.item[1], false, 'no block at all is what "inherit" means');
});

test('noauth is a declaration, not an absence', () => {
  const parsed = apply('collection', { field: 'auth', authType: 'noauth', rows: [] }).parsed;
  assert.deepEqual(parsed.auth, { type: 'noauth' });
});

test('a variable edit keeps what Postman wrote alongside it', () => {
  const parsed = apply('collection', {
    field: 'variables',
    rows: [
      { key: 'baseUrl', value: 'https://staging.shop' },
      { key: 'stale', value: 'x' },
      { key: 'added', value: '1' },
      { key: '', value: 'dropped' }
    ]
  }).parsed;

  assert.deepEqual(parsed.variable, [
    { key: 'baseUrl', value: 'https://staging.shop', type: 'string', description: 'the host' },
    { key: 'stale', value: 'x', type: 'default' },
    { key: 'added', value: '1', type: 'default' }
  ]);
});

test('re-enabling a variable clears the flag that disabled it', () => {
  const parsed = apply('collection', {
    field: 'variables',
    rows: [{ key: 'stale', value: 'x', disabled: false }]
  }).parsed;
  assert.equal('disabled' in parsed.variable[0], false);
});

test('disabling one carries the flag through', () => {
  const parsed = apply('collection', {
    field: 'variables',
    rows: [{ key: 'baseUrl', value: 'https://api.shop', disabled: true }]
  }).parsed;
  assert.equal(parsed.variable[0].disabled, true);
});

test('removing the last variable removes the key', () => {
  const parsed = apply('collection', { field: 'variables', rows: [] }).parsed;
  assert.equal('variable' in parsed, false);
});

test('a folder gets its own variable list without touching the collection', () => {
  const parsed = apply('Orders', { field: 'variables', rows: [{ key: 'orderId', value: '7' }] }).parsed;
  assert.deepEqual(parsed.item[1].variable, [{ key: 'orderId', value: '7', type: 'default' }]);
  assert.equal(parsed.variable.length, 2, 'the collection list is untouched');
});

test('a script is written as an exec array and removed when emptied', () => {
  const added = apply('Orders', {
    field: 'script',
    listen: 'prerequest',
    source: 'pm.environment.set("a", 1);\npm.environment.set("b", 2);'
  }).parsed;
  assert.deepEqual(added.item[1].event, [
    {
      listen: 'prerequest',
      script: {
        type: 'text/javascript',
        exec: ['pm.environment.set("a", 1);', 'pm.environment.set("b", 2);']
      }
    }
  ]);

  const cleared = apply('Orders', { field: 'script', listen: 'prerequest', source: '  ' }).parsed;
  assert.equal('event' in cleared.item[1], false, 'no empty array left behind');
});

test('an edit rewrites only what it names', () => {
  const { after } = apply('Orders', { field: 'name', value: 'Purchases' });
  assert.equal(
    after.split('\n').length,
    SOURCE.split('\n').length,
    'the file is edited in place, not reserialised'
  );
  assert.match(after, /\t"info": \{/, 'tab indentation survives');
});
