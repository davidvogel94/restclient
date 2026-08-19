import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  appendTo,
  applyJsonEdits,
  detectFormat,
  minimalReplacement,
  removeAt,
  reorder
} from '../../src/collections/jsonEdit';
import { materialize } from '../../src/collections/model';

const REPO = path.resolve(__dirname, '../../..');
const FIXTURE = path.join(REPO, 'fixtures/collections/smoke.postman_collection.json');

function fixtureText(): string {
  return fs.readFileSync(FIXTURE, 'utf8');
}

test('detects tab indentation used by Postman exports', () => {
  const format = detectFormat(fixtureText());
  assert.equal(format.insertSpaces, false, 'Postman exports are tab-indented');
  assert.equal(format.eol, '\n');
});

test('detects space indentation and its width', () => {
  assert.deepEqual(detectFormat('{\n    "a": 1\n}\n'), { insertSpaces: true, tabSize: 4, eol: '\n' });
  assert.deepEqual(detectFormat('{\n  "a": 1\n}\n'), { insertSpaces: true, tabSize: 2, eol: '\n' });
  assert.equal(detectFormat('{\r\n  "a": 1\r\n}\r\n').eol, '\r\n');
});

test('editing one value leaves every other byte untouched', () => {
  const before = fixtureText();
  const { tree } = materialize(JSON.parse(before));
  const login = tree.find((n) => n.name === 'Login')!;

  const after = applyJsonEdits(before, [
    { path: [...login.jsonPath, 'request', 'method'], value: 'PUT' }
  ]);

  assert.notEqual(after, before);
  assert.equal(JSON.parse(after).item[0].request.method, 'PUT');

  // The strongest form of "nothing else moved": the new text is the old text
  // with exactly that one token swapped, character for character.
  assert.equal(after, before.replace('"method": "POST"', '"method": "PUT"'));

  // minimalReplacement narrows to the differing characters (P-OS-T / P-U-T),
  // and the span must reconstruct the document exactly.
  const diff = minimalReplacement(before, after)!;
  assert.equal(
    before.slice(0, diff.startOffset) + diff.text + before.slice(diff.endOffset),
    after,
    'the replacement span must reproduce the edited document'
  );
  assert.ok(diff.endOffset - diff.startOffset < 8, 'the edited span should be tiny');
});

test('an edit deep inside a nested folder targets the right item', () => {
  const source = {
    info: { name: 'Nested', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      { name: 'Top', request: { method: 'GET', url: 'https://a' } },
      {
        name: 'Folder',
        item: [
          { name: 'Inner A', request: { method: 'GET', url: 'https://b' } },
          { name: 'Inner B', request: { method: 'GET', url: 'https://c' } }
        ]
      }
    ]
  };
  const before = JSON.stringify(source, null, '\t') + '\n';
  const { tree } = materialize(JSON.parse(before));

  const folder = tree.find((n) => n.name === 'Folder')!;
  const innerB = folder.children.find((n) => n.name === 'Inner B')!;
  assert.deepEqual(innerB.jsonPath, ['item', 1, 'item', 1]);

  const after = applyJsonEdits(before, [
    { path: [...innerB.jsonPath, 'request', 'method'], value: 'DELETE' }
  ]);

  const parsed = JSON.parse(after);
  assert.equal(parsed.item[1].item[1].request.method, 'DELETE');
  assert.equal(parsed.item[1].item[0].request.method, 'GET', 'sibling untouched');
  assert.equal(parsed.item[0].request.method, 'GET', 'unrelated item untouched');
});

test('preserves space indentation when the file uses spaces', () => {
  const before = '{\n  "info": {\n    "name": "Spaces"\n  },\n  "item": []\n}\n';
  const after = applyJsonEdits(before, [{ path: ['info', 'name'], value: 'Renamed' }]);
  assert.ok(after.includes('  "info"'), 'two-space indent kept');
  assert.ok(!after.includes('\t'), 'no tabs introduced');
  assert.equal(JSON.parse(after).info.name, 'Renamed');
});

test('append, remove and reorder', () => {
  const before = JSON.stringify(
    { item: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
    null,
    '\t'
  );

  const appended = applyJsonEdits(before, [appendTo(['item'], { name: 'd' })]);
  assert.deepEqual(JSON.parse(appended).item.map((i: any) => i.name), ['a', 'b', 'c', 'd']);

  const removed = applyJsonEdits(before, [removeAt(['item', 1])]);
  assert.deepEqual(JSON.parse(removed).item.map((i: any) => i.name), ['a', 'c']);

  const items = JSON.parse(before).item;
  const moved = applyJsonEdits(before, [{ path: ['item'], value: reorder(items, 0, 3) }]);
  assert.deepEqual(JSON.parse(moved).item.map((i: any) => i.name), ['b', 'c', 'a']);
});

test('reorder moves an element to every position correctly', () => {
  const items = ['a', 'b', 'c', 'd'];
  // `to` is the insertion point in the original array, the drop-target convention.
  assert.deepEqual(reorder(items, 0, 2), ['b', 'a', 'c', 'd']);
  assert.deepEqual(reorder(items, 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(reorder(items, 1, 1), ['a', 'b', 'c', 'd'], 'moving onto itself is a no-op');
  assert.deepEqual(reorder(items, 0, 4), ['b', 'c', 'd', 'a']);
});

test('sequential edits compose without corrupting offsets', () => {
  const before = fixtureText();
  const { tree } = materialize(JSON.parse(before));
  const login = tree.find((n) => n.name === 'Login')!;
  const me = tree.find((n) => n.name === 'Me')!;

  const after = applyJsonEdits(before, [
    { path: [...login.jsonPath, 'name'], value: 'Sign in' },
    { path: [...me.jsonPath, 'name'], value: 'Profile' },
    { path: [...login.jsonPath, 'request', 'method'], value: 'PATCH' }
  ]);

  const parsed = JSON.parse(after);
  assert.equal(parsed.item[0].name, 'Sign in');
  assert.equal(parsed.item[1].name, 'Profile');
  assert.equal(parsed.item[0].request.method, 'PATCH');
  // Everything else must still be intact and parseable.
  assert.equal(parsed.info.name, 'Smoke');
  assert.equal(parsed.auth.type, 'basic');
  assert.equal(parsed.item[1].event.length, 2);
});

test('round trip with no edits is byte-identical', () => {
  const before = fixtureText();
  assert.equal(applyJsonEdits(before, []), before);
  assert.equal(minimalReplacement(before, before), undefined);
});

test('a no-op edit writing the same value changes nothing', () => {
  const before = fixtureText();
  const after = applyJsonEdits(before, [{ path: ['info', 'name'], value: 'Smoke' }]);
  assert.equal(after, before, 'writing an identical value must not reformat the file');
});
