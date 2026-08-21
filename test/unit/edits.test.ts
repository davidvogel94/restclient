import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildRequestEdits } from '../../src/collections/edits';
import { applyJsonEdits } from '../../src/collections/jsonEdit';
import { materialize } from '../../src/collections/model';
import { buildRequestView } from '../../src/collections/view';

const REPO = path.resolve(__dirname, '../../..');
const FIXTURE = path.join(REPO, 'fixtures/collections/smoke.postman_collection.json');

function loadFixture() {
  const text = fs.readFileSync(FIXTURE, 'utf8');
  const { tree, json } = materialize(JSON.parse(text));
  return { text, tree, json };
}

/** Apply one semantic update to the fixture and return the reparsed result. */
function apply(itemName: string, update: any) {
  const { text, tree, json } = loadFixture();
  const node = tree.find((n) => n.name === itemName)!;
  const raw = update.field === 'script' || update.field === 'name'
    ? json.item[node.jsonPath[1] as number]
    : json.item[node.jsonPath[1] as number];
  const edits = buildRequestEdits(node.jsonPath, raw, update);
  const after = applyJsonEdits(text, edits);
  return { after, parsed: JSON.parse(after), index: node.jsonPath[1] as number };
}

test('method update rewrites only the method', () => {
  const { parsed, index } = apply('Login', { field: 'method', value: 'patch' });
  assert.equal(parsed.item[index].request.method, 'PATCH', 'method is upper-cased');
  assert.equal(parsed.item[index].name, 'Login', 'name untouched');
});

test('url update decomposes into Postman url parts', () => {
  const { parsed, index } = apply('Login', {
    field: 'url',
    value: 'https://api.example.com/v1/users/:id?a=1'
  });
  const url = parsed.item[index].request.url;
  assert.equal(url.raw, 'https://api.example.com/v1/users/:id?a=1');
  assert.deepEqual(url.host, ['api', 'example', 'com']);
  assert.deepEqual(url.path, ['v1', 'users', ':id']);
  assert.deepEqual(url.query, [{ key: 'a', value: '1' }]);
  assert.equal(url.variable[0].key, 'id', 'path variable extracted');
});

test('query rows regenerate the raw url and drop disabled rows from it', () => {
  const { parsed, index } = apply('Me', {
    field: 'query',
    rows: [
      { key: 'nonce', value: '{{nonce}}' },
      { key: 'page', value: '2' },
      { key: 'debug', value: 'true', disabled: true }
    ]
  });
  const url = parsed.item[index].request.url;
  assert.equal(url.raw, '{{baseUrl}}/me?nonce={{nonce}}&page=2');
  assert.equal(url.query.length, 3, 'the disabled row is still stored');
  assert.equal(url.query[2].disabled, true);
});

test('headers replace wholesale and drop empty keys', () => {
  const { parsed, index } = apply('Login', {
    field: 'headers',
    rows: [
      { key: 'Content-Type', value: 'application/json' },
      { key: '', value: 'ignored' },
      { key: 'X-Trace', value: 'abc', disabled: true }
    ]
  });
  const headers = parsed.item[index].request.header;
  assert.equal(headers.length, 2, 'the blank row is dropped');
  assert.deepEqual(headers[0], { key: 'Content-Type', value: 'application/json' });
  assert.equal(headers[1].disabled, true);
});

test('auth: inherit removes the block, noauth writes noauth, typed writes params', () => {
  const inherited = apply('Me', { field: 'auth', authType: 'inherit', rows: [] });
  assert.equal(inherited.parsed.item[inherited.index].request.auth, undefined);

  const none = apply('Me', { field: 'auth', authType: 'noauth', rows: [] });
  assert.deepEqual(none.parsed.item[none.index].request.auth, { type: 'noauth' });

  const typed = apply('Me', {
    field: 'auth',
    authType: 'apikey',
    rows: [
      { key: 'key', value: 'X-Api-Key' },
      { key: 'value', value: '{{apiKey}}' },
      { key: 'in', value: 'header' }
    ]
  });
  const auth = typed.parsed.item[typed.index].request.auth;
  assert.equal(auth.type, 'apikey');
  assert.deepEqual(auth.apikey, [
    { key: 'key', value: 'X-Api-Key', type: 'string' },
    { key: 'value', value: '{{apiKey}}', type: 'string' },
    { key: 'in', value: 'header', type: 'string' }
  ]);
});

test('body modes each write their Postman shape', () => {
  const raw = apply('Login', { field: 'body', mode: 'raw', text: '{"a":1}', language: 'json' });
  assert.deepEqual(raw.parsed.item[raw.index].request.body, {
    mode: 'raw',
    raw: '{"a":1}',
    options: { raw: { language: 'json' } }
  });

  const gql = apply('Login', {
    field: 'body',
    mode: 'graphql',
    text: 'query { me { id } }',
    rows: [{ key: 'variables', value: '{"x":1}' }]
  });
  assert.deepEqual(gql.parsed.item[gql.index].request.body, {
    mode: 'graphql',
    graphql: { query: 'query { me { id } }', variables: '{"x":1}' }
  });

  const form = apply('Login', {
    field: 'body',
    mode: 'formdata',
    rows: [
      { key: 'name', value: 'alice' },
      { key: 'avatar', value: './me.png', description: 'file' }
    ]
  });
  assert.deepEqual(form.parsed.item[form.index].request.body.formdata, [
    { key: 'name', value: 'alice', type: 'text' },
    { key: 'avatar', src: './me.png', type: 'file' }
  ]);

  const none = apply('Login', { field: 'body', mode: 'none' });
  assert.equal(none.parsed.item[none.index].request.body, undefined);
});

test('a disabled form-data row survives the round trip back into the editor', () => {
  // What the enable/disable and File checkboxes in the editor rely on: whatever
  // is written has to read back as the same rows, or the box springs back.
  const rows = [
    { key: 'name', value: 'alice', disabled: true },
    { key: 'avatar', value: 'me.png', disabled: false, description: 'file' }
  ];
  const { after, index } = apply('Login', { field: 'body', mode: 'formdata', rows });

  assert.deepEqual(JSON.parse(after).item[index].request.body.formdata, [
    { key: 'name', value: 'alice', type: 'text', disabled: true },
    { key: 'avatar', src: 'me.png', type: 'file' }
  ]);

  const { tree, json } = materialize(JSON.parse(after));
  const view = buildRequestView(json, 'smoke', tree.find((n) => n.name === 'Login')!)!;
  // Serialized, because that is how the editor decides whether the rows it is
  // showing still match the file — an absent key and an undefined one are the
  // same thing to it.
  assert.equal(JSON.stringify(view.body.entries), JSON.stringify(rows));
});

test('script update replaces one listener and keeps the other', () => {
  const { parsed, index } = apply('Me', {
    field: 'script',
    listen: 'prerequest',
    source: "pm.variables.set('x', 1);\npm.variables.set('y', 2);"
  });
  const events = parsed.item[index].event;
  const pre = events.find((e: any) => e.listen === 'prerequest');
  const tests = events.find((e: any) => e.listen === 'test');

  assert.deepEqual(pre.script.exec, ["pm.variables.set('x', 1);", "pm.variables.set('y', 2);"]);
  assert.equal(pre.script.type, 'text/javascript', 'existing script type preserved');
  assert.ok(tests, 'the test listener survives untouched');
  assert.ok(tests.script.exec.some((l: string) => l.includes('bearer token')));
});

test('clearing a script removes its listener entirely', () => {
  const { parsed, index } = apply('Me', { field: 'script', listen: 'prerequest', source: '   ' });
  const events = parsed.item[index].event;
  assert.equal(events.find((e: any) => e.listen === 'prerequest'), undefined);
  assert.ok(events.find((e: any) => e.listen === 'test'), 'the test script is kept');
});

test('adding a script to an item that has none creates the event array', () => {
  const { text, tree, json } = loadFixture();
  const login = tree.find((n) => n.name === 'Login')!;
  const rawLogin = json.item[login.jsonPath[1] as number];

  // Login has only a test script; add a pre-request one.
  const edits = buildRequestEdits(login.jsonPath, rawLogin, {
    field: 'script',
    listen: 'prerequest',
    source: "console.log('hi');"
  });
  const parsed = JSON.parse(applyJsonEdits(text, edits));
  const events = parsed.item[login.jsonPath[1] as number].event;
  assert.equal(events[0].listen, 'prerequest', 'prerequest is written first');
  assert.equal(events[1].listen, 'test');
});
