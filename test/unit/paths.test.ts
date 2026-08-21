import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isInside,
  isInsideAny,
  parseEntry,
  rootFor,
  serializeEntry,
  type ParsedEntry
} from '../../src/collections/paths';

/** Narrow to the relative case, failing the test if it is anything else. */
function segments(parsed: ParsedEntry): string[] {
  assert.equal(parsed.kind, 'relative', `expected a relative entry, got ${parsed.kind}`);
  return parsed.kind === 'relative' ? parsed.segments : [];
}

test('parseEntry treats a plain path as workspace-relative', () => {
  assert.deepEqual(parseEntry('api/orders.postman_collection.json'), {
    kind: 'relative',
    segments: ['api', 'orders.postman_collection.json']
  });
});

test('parseEntry normalises separators and no-op segments', () => {
  assert.deepEqual(segments(parseEntry('api\\nested/file.json')), ['api', 'nested', 'file.json']);
  assert.deepEqual(segments(parseEntry('./api//file.json')), ['api', 'file.json']);
});

test('parseEntry keeps an absolute path absolute', () => {
  const abs = path.join(path.sep, 'srv', 'shared.postman_collection.json');
  assert.deepEqual(parseEntry(abs), { kind: 'absolute', fsPath: abs });
});

test('parseEntry expands a home-relative path', () => {
  const parsed = parseEntry('~/Postman/shared.json');
  assert.equal(parsed.kind, 'absolute');
  assert.equal(parsed.kind === 'absolute' && parsed.fsPath, path.join(os.homedir(), 'Postman/shared.json'));
});

test('parseEntry rejects blanks', () => {
  assert.deepEqual(parseEntry(''), { kind: 'invalid' });
  assert.deepEqual(parseEntry('   '), { kind: 'invalid' });
});

test('serializeEntry writes a workspace file back as a relative posix path', () => {
  const root = path.join(path.sep, 'ws');
  assert.equal(serializeEntry(path.join(root, 'api', 'a.json'), root), 'api/a.json');
});

test('serializeEntry keeps a file outside the workspace absolute', () => {
  const root = path.join(path.sep, 'ws');
  const outside = path.join(path.sep, 'elsewhere', 'a.json');
  assert.equal(serializeEntry(outside, root), outside);
});

test('serializeEntry falls back to absolute with no workspace', () => {
  const p = path.join(path.sep, 'ws', 'api', 'a.json');
  assert.equal(serializeEntry(p, undefined), p);
});

test('a serialized workspace entry parses back to the same segments', () => {
  const root = path.join(path.sep, 'ws');
  const entry = serializeEntry(path.join(root, 'api', 'nested', 'a.json'), root);
  assert.deepEqual(segments(parseEntry(entry)), ['api', 'nested', 'a.json']);
});

test('isInside counts the workspace folder and everything under it', () => {
  const root = path.join(path.sep, 'ws');
  assert.ok(isInside(path.join(root, 'a.json'), root));
  assert.ok(isInside(path.join(root, 'api', 'nested', 'a.json'), root));
  assert.ok(isInside(root, root), 'the folder itself, so it can be an import destination');
});

test('isInside rejects anything the workspace does not contain', () => {
  const root = path.join(path.sep, 'ws');
  assert.ok(!isInside(path.join(path.sep, 'elsewhere', 'a.json'), root));
  assert.ok(!isInside(path.join(root, '..', 'a.json'), root), 'an escape is an escape however it is written');
  assert.ok(
    !isInside(path.join(path.sep, 'ws-other', 'a.json'), root),
    'a sibling sharing a name prefix is not inside'
  );
});

test('isInside has no workspace to be inside of', () => {
  assert.ok(!isInside(path.join(path.sep, 'ws', 'a.json'), undefined));
});

test('isInside does not mistake a `..`-prefixed name for an escape', () => {
  // `..cache` is a directory, not a step upwards.
  const root = path.join(path.sep, 'ws');
  assert.ok(isInside(path.join(root, '..cache', 'a.json'), root));
});

test('rootFor picks the folder that actually contains the path', () => {
  const roots = ['/ws/one', '/ws/two'];
  assert.equal(rootFor('/ws/two/api/x.json', roots), '/ws/two');
  assert.equal(rootFor('/elsewhere/x.json', roots), undefined);
});

test('rootFor prefers the nearer root when one workspace folder nests in another', () => {
  // Both are legitimate workspace folders, and the inner one is the folder
  // whose settings and relative entries were written with this file in mind.
  const roots = ['/ws', '/ws/packages/api'];
  assert.equal(rootFor('/ws/packages/api/orders.json', roots), '/ws/packages/api');
  assert.equal(rootFor('/ws/other/orders.json', roots), '/ws');
});

test('isInsideAny accepts a file in the second folder and refuses one in neither', () => {
  const roots = ['/ws/one', '/ws/two'];
  assert.equal(isInsideAny('/ws/two/deep/body.txt', roots), true);
  assert.equal(isInsideAny('/ws/onefoo/body.txt', roots), false, 'a prefix is not a parent');
  assert.equal(isInsideAny('/tmp/body.txt', roots), false);
  assert.equal(isInsideAny('/tmp/body.txt', []), false, 'no folders means nothing is inside');
});
