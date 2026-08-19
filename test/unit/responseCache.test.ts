import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ResponseCache, type CachedResponse } from '../../src/panels/responseCache';

function entry(bodyKb: number): CachedResponse {
  return {
    assertions: [],
    console: [],
    response: { bodyBase64: 'x'.repeat(bodyKb * 1024) } as any
  };
}

test('round-trips an entry', () => {
  const cache = new ResponseCache();
  cache.set('a', entry(1));
  assert.equal(cache.get('a')?.response?.bodyBase64.length, 1024);
  assert.equal(cache.get('missing'), undefined);
});

test('re-setting a key replaces rather than duplicates', () => {
  const cache = new ResponseCache();
  cache.set('a', entry(1));
  cache.set('a', entry(2));
  assert.equal(cache.size, 1);
  assert.equal(cache.get('a')?.response?.bodyBase64.length, 2048);
});

test('evicts the oldest entries past the count limit', () => {
  const cache = new ResponseCache();
  for (let i = 0; i < 60; i++) { cache.set(`k${i}`, entry(1)); }
  assert.equal(cache.size, 50);
  assert.equal(cache.get('k0'), undefined, 'the oldest should be gone');
  assert.ok(cache.get('k59'), 'the newest should survive');
});

test('evicts on the byte budget, keeping the newest', () => {
  const cache = new ResponseCache();
  // 10 x 5 MB is well past the 32 MB budget.
  for (let i = 0; i < 10; i++) { cache.set(`k${i}`, entry(5 * 1024)); }
  assert.ok(cache.size < 10, 'oversized set should have been trimmed');
  assert.ok(cache.get('k9'), 'the most recent response must be kept');
});

test('a single oversized response is still kept', () => {
  const cache = new ResponseCache();
  cache.set('huge', entry(40 * 1024));
  assert.equal(cache.size, 1, 'evicting the only entry would lose what was just fetched');
});

test('clear empties it', () => {
  const cache = new ResponseCache();
  cache.set('a', entry(1));
  cache.clear();
  assert.equal(cache.size, 0);
});
