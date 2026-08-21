import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  ALWAYS_EXCLUDED,
  DEFAULT_DISCOVER_PATTERNS,
  combineExcludes,
  combinePatterns,
  enabledKeys,
  importFolderPattern,
  kindFromFileName,
  looksLikePostmanFileName,
  normalizePatterns
} from '../../src/collections/discovery';

test('normalizePatterns keeps only usable patterns, in the order given', () => {
  assert.deepEqual(normalizePatterns(['  **/*.json  ', '', 'api/*.json']), ['**/*.json', 'api/*.json']);
  assert.deepEqual(normalizePatterns(['a', 'a']), ['a'], 'a duplicated glob is one glob');
  assert.deepEqual(normalizePatterns([1, null, 'a']), ['a'], 'settings are user-typed JSON');
  assert.deepEqual(normalizePatterns('**/*.json'), [], 'a bare string is not the array this expects');
  assert.deepEqual(normalizePatterns(undefined), []);
});

test('combinePatterns leaves a lone pattern alone', () => {
  // It ends up in a log line; `{**/*.json}` reads like a mistake.
  assert.equal(combinePatterns(['**/*.json']), '**/*.json');
});

test('combinePatterns brace-joins several patterns', () => {
  assert.equal(combinePatterns(['a.json', 'b.json']), '{a.json,b.json}');
  assert.equal(combinePatterns([...DEFAULT_DISCOVER_PATTERNS]), `{${DEFAULT_DISCOVER_PATTERNS.join(',')}}`);
});

test('combinePatterns has nothing to say when there is nothing to look for', () => {
  // Not `{}`, which matches nothing in a way that looks like a bug.
  assert.equal(combinePatterns([]), undefined);
});

test('enabledKeys reads a files.exclude map the way VS Code does', () => {
  assert.deepEqual(
    enabledKeys({ '**/node_modules': true, '**/dist': false, '**/*.js': { when: '$(basename).ts' } }),
    ['**/node_modules', '**/*.js'],
    'a when-condition is still an exclusion; only an explicit false is not'
  );
});

test('enabledKeys survives a setting that is not a map', () => {
  assert.deepEqual(enabledKeys(undefined), []);
  assert.deepEqual(enabledKeys(['**/dist']), [], 'an array is not the shape this setting has');
  assert.deepEqual(enabledKeys('**/dist'), []);
});

test('combineExcludes merges every source that gets a say', () => {
  const combined = combineExcludes([['**/dist/**'], undefined, ['  **/out/**  ']]);
  assert.ok(combined.includes('**/dist/**'));
  assert.ok(combined.includes('**/out/**'), 'trimmed, since these come from settings');
  assert.ok(combined.startsWith('{') && combined.endsWith('}'));
});

test('combineExcludes never drops the floor', () => {
  // A user who emptied search.exclude has not asked for a scan of node_modules.
  for (const pattern of ALWAYS_EXCLUDED) {
    assert.ok(combineExcludes([]).includes(pattern), `${pattern} is not optional`);
    assert.ok(combineExcludes([['**/dist/**']]).includes(pattern));
  }
});

test('combineExcludes states a pattern once', () => {
  const combined = combineExcludes([['**/dist/**'], ['**/dist/**'], [...ALWAYS_EXCLUDED]]);
  assert.equal(combined.split('**/dist/**').length - 1, 1);
  assert.equal(combined.split(ALWAYS_EXCLUDED[0]).length - 1, 1);
});

test('looksLikePostmanFileName recognises Postman\'s own naming, and nothing else', () => {
  assert.ok(looksLikePostmanFileName('orders.postman_collection.json'));
  assert.ok(looksLikePostmanFileName('local.postman_environment.json'));
  assert.ok(looksLikePostmanFileName('shared.postman_globals.json'));
  assert.ok(looksLikePostmanFileName('/ws/api/Orders.Postman_Collection.JSON'), 'file systems differ on case');
  assert.ok(!looksLikePostmanFileName('collection.json'), 'a widened glob catches files like this');
  assert.ok(!looksLikePostmanFileName('tsconfig.json'));
  assert.ok(!looksLikePostmanFileName('postman_collection.json.bak'));
  assert.ok(!looksLikePostmanFileName(''));
});

test('kindFromFileName places a file that cannot be asked what it is', () => {
  assert.equal(kindFromFileName('orders.postman_collection.json'), 'collection');
  assert.equal(kindFromFileName('/ws/api/local.postman_environment.json'), 'environment');
  assert.equal(kindFromFileName('shared.postman_globals.json'), 'environment', 'globals are variables too');
  assert.equal(kindFromFileName('tsconfig.json'), undefined);
});

test('importFolderPattern scans everything under the chosen collections folder', () => {
  assert.equal(importFolderPattern('postman'), 'postman/**/*.json');
  assert.equal(importFolderPattern('api/collections'), 'api/collections/**/*.json');
  assert.equal(importFolderPattern('api\\collections'), 'api/collections/**/*.json', 'globs take forward slashes');
  assert.equal(importFolderPattern('./postman/'), 'postman/**/*.json');
});

test('importFolderPattern treats the workspace root as a legitimate answer', () => {
  // A repo that *is* the collection folder. `.` is what the setting records for it.
  assert.equal(importFolderPattern('.'), '**/*.json');
  assert.equal(importFolderPattern(''), '**/*.json');
});

test('importFolderPattern has nothing to add for a folder it cannot reach', () => {
  assert.equal(importFolderPattern(undefined), undefined, 'no folder chosen');
  assert.equal(
    importFolderPattern('../shared/postman'),
    undefined,
    'outside the workspace: a workspace-relative glob could not reach it anyway'
  );
});
