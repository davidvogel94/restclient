import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { applyJsonEdits } from '../../src/collections/jsonEdit';
import { materialize } from '../../src/collections/model';
import {
  addItem,
  childArrayPath,
  deleteItem,
  duplicateItem,
  moveItem,
  newFolderItem,
  newRequestItem,
  renameItem
} from '../../src/collections/structure';

function build() {
  const source = {
    info: { name: 'Structure', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      { name: 'A', request: { method: 'GET', url: 'https://a' } },
      {
        name: 'Folder',
        item: [
          { name: 'B', request: { method: 'GET', url: 'https://b' } },
          { name: 'C', request: { method: 'POST', url: 'https://c' } }
        ]
      },
      { name: 'D', request: { method: 'GET', url: 'https://d' } }
    ]
  };
  const text = JSON.stringify(source, null, '\t') + '\n';
  const { tree, json } = materialize(JSON.parse(text));
  return { text, tree, json };
}

const names = (items: any[]) => items.map((i: any) => i.name);

test('adds a request at the collection root and inside a folder', () => {
  const { text, tree } = build();
  const atRoot = JSON.parse(applyJsonEdits(text, addItem(undefined, newRequestItem('New'))));
  assert.deepEqual(names(atRoot.item), ['A', 'Folder', 'D', 'New']);
  assert.equal(atRoot.item[3].request.method, 'GET');

  const folder = tree.find((n) => n.name === 'Folder')!;
  const inFolder = JSON.parse(applyJsonEdits(text, addItem(folder, newFolderItem('Sub'))));
  assert.deepEqual(names(inFolder.item[1].item), ['B', 'C', 'Sub']);
  assert.deepEqual(inFolder.item[1].item[2].item, [], 'a new folder starts empty');
});

test('childArrayPath targets the collection root or a folder', () => {
  const { tree } = build();
  assert.deepEqual(childArrayPath(undefined), ['item']);
  assert.deepEqual(childArrayPath(tree.find((n) => n.name === 'Folder')!), ['item', 1, 'item']);
});

test('renames without touching anything else', () => {
  const { text, tree } = build();
  const node = tree.find((n) => n.name === 'Folder')!.children.find((n) => n.name === 'C')!;
  const parsed = JSON.parse(applyJsonEdits(text, renameItem(node, 'C renamed')));
  assert.deepEqual(names(parsed.item[1].item), ['B', 'C renamed']);
  assert.equal(parsed.item[1].item[1].request.method, 'POST', 'request survives the rename');
});

test('deletes a nested item', () => {
  const { text, tree } = build();
  const node = tree.find((n) => n.name === 'Folder')!.children.find((n) => n.name === 'B')!;
  const parsed = JSON.parse(applyJsonEdits(text, deleteItem(node)));
  assert.deepEqual(names(parsed.item[1].item), ['C']);
  assert.deepEqual(names(parsed.item), ['A', 'Folder', 'D'], 'siblings untouched');
});

test('duplicate inserts a copy after the original and strips ids', () => {
  const { text, tree, json } = build();
  const node = tree.find((n) => n.name === 'A')!;
  const parsed = JSON.parse(applyJsonEdits(text, duplicateItem(json, node)));
  assert.deepEqual(names(parsed.item), ['A', 'A copy', 'Folder', 'D']);
  assert.equal(parsed.item[1].request.url, 'https://a', 'the copy keeps the request');
  assert.equal(parsed.item[1].id, undefined, 'the copy must not reuse the original id');
});

test('duplicating a folder copies its children', () => {
  const { text, tree, json } = build();
  const folder = tree.find((n) => n.name === 'Folder')!;
  const parsed = JSON.parse(applyJsonEdits(text, duplicateItem(json, folder)));
  assert.deepEqual(names(parsed.item), ['A', 'Folder', 'Folder copy', 'D']);
  assert.deepEqual(names(parsed.item[2].item), ['B', 'C']);
});

test('reorders within the same parent', () => {
  const { text, tree, json } = build();
  const d = tree.find((n) => n.name === 'D')!;
  const parsed = JSON.parse(applyJsonEdits(text, moveItem(json, d, ['item'], 0)));
  assert.deepEqual(names(parsed.item), ['D', 'A', 'Folder']);
});

test('a same-parent move onto itself is a no-op', () => {
  const { tree, json } = build();
  const a = tree.find((n) => n.name === 'A')!;
  assert.deepEqual(moveItem(json, a, ['item'], 0), []);
  assert.deepEqual(moveItem(json, a, ['item'], 1), []);
});

test('moves an item into a folder', () => {
  const { text, tree, json } = build();
  const a = tree.find((n) => n.name === 'A')!;
  const parsed = JSON.parse(applyJsonEdits(text, moveItem(json, a, ['item', 1, 'item'], 1)));
  assert.deepEqual(names(parsed.item), ['Folder', 'D']);
  assert.deepEqual(names(parsed.item[0].item), ['B', 'A', 'C']);
});

test('moves an item out of a folder back to the root', () => {
  const { text, tree, json } = build();
  const b = tree.find((n) => n.name === 'Folder')!.children.find((n) => n.name === 'B')!;
  const parsed = JSON.parse(applyJsonEdits(text, moveItem(json, b, ['item'], 0)));
  assert.deepEqual(names(parsed.item), ['B', 'A', 'Folder', 'D']);
  assert.deepEqual(names(parsed.item[2].item), ['C']);
});

test('refuses to move a folder inside itself', () => {
  const { tree, json } = build();
  const folder = tree.find((n) => n.name === 'Folder')!;
  assert.deepEqual(moveItem(json, folder, ['item', 1, 'item'], 0), [], 'dropping a folder into itself is rejected');
});

test('structural edits keep unrelated top-level keys intact', () => {
  const { text, tree, json } = build();
  const d = tree.find((n) => n.name === 'D')!;
  const parsed = JSON.parse(applyJsonEdits(text, moveItem(json, d, ['item', 1, 'item'], 0)));
  assert.equal(parsed.info.name, 'Structure');
  assert.ok(parsed.info.schema.includes('v2.1.0'));
});
