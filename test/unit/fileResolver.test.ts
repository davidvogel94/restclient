import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceFileResolver } from '../../src/runner/fileResolver';

/**
 * The jail a collection's `file` bodies are read through.
 *
 * A collection is untrusted input, so these are the tests that matter most in
 * this file: every one of them is a path a hostile collection could name.
 *
 * Asked through `stat`, and about paths that do not exist on purpose. What is
 * under test is the decision, not the filesystem — a refusal reports the jail,
 * and anything the jail let through reports `ENOENT`, which is the pass.
 */

const one = path.join(os.tmpdir(), 'rc-jail-one');
const two = path.join(os.tmpdir(), 'rc-jail-two');

/** How the jail answered: its own message, or nothing when it allowed the read. */
async function refusal(
  resolver: WorkspaceFileResolver,
  target: string
): Promise<string | undefined> {
  const err = await new Promise<any>((resolve) => {
    resolver.stat(target, (e) => resolve(e));
  });
  const message = String(err?.message ?? '');
  return /Refusing to read|No workspace folder is open/.test(message) ? message : undefined;
}

test('a single root still behaves exactly as it did', async () => {
  const resolver = new WorkspaceFileResolver(one);
  assert.equal(await refusal(resolver, 'body.json'), undefined);
  assert.match((await refusal(resolver, '../escape.json')) ?? '', /Refusing to read/);
  assert.match((await refusal(resolver, path.join(two, 'body.json'))) ?? '', /Refusing to read/);
});

test('every workspace folder is readable, not just the one paths resolve against', async () => {
  // A fixture in a folder the user deliberately added is not an escape: they
  // put it in the workspace precisely so requests could reach it.
  const resolver = new WorkspaceFileResolver(one, [one, two]);
  assert.equal(await refusal(resolver, path.join(two, 'body.json')), undefined);
  assert.equal(
    await refusal(resolver, 'body.json'),
    undefined,
    'relative still means the base folder'
  );
});

test('outside every folder is still refused', async () => {
  const resolver = new WorkspaceFileResolver(one, [one, two]);
  const outside = path.join(os.tmpdir(), 'rc-jail-three', 'body.json');
  assert.match((await refusal(resolver, outside)) ?? '', /Refusing to read/);
  assert.match((await refusal(resolver, '../../etc/passwd')) ?? '', /Refusing to read/);
});

test('a sibling whose name merely starts with a root is not inside it', async () => {
  const resolver = new WorkspaceFileResolver(one, [one]);
  assert.match((await refusal(resolver, `${one}-evil/body.json`)) ?? '', /Refusing to read/);
});

test('with no workspace open nothing is readable', async () => {
  const resolver = new WorkspaceFileResolver(undefined);
  assert.match((await refusal(resolver, 'body.json')) ?? '', /No workspace folder is open/);
});

test('createReadStream refuses synchronously, before touching the filesystem', () => {
  const resolver = new WorkspaceFileResolver(one, [one]);
  assert.throws(
    () => resolver.createReadStream(path.join(two, 'body.json')),
    /Refusing to read/
  );
});
