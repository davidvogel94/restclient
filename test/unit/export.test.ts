import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { environmentExportJson, exportFileName, exportFileNames } from '../../src/collections/export';
import { FILE_SUFFIX, nameFromFileName } from '../../src/collections/importer';

test('an exported file is named the way Postman names one', () => {
  assert.equal(exportFileName('Orders API', 'collection'), 'orders-api.postman_collection.json');
  assert.equal(exportFileName('Staging / EU', 'environment'), 'staging-eu.postman_environment.json');
});

test('an export file name reads back as the name it came from', () => {
  const name = 'Orders Api';
  assert.equal(nameFromFileName(exportFileName(name, 'collection')), name);
});

test('a bulk export keeps identically-named collections apart', () => {
  assert.deepEqual(
    exportFileNames(['Orders API', 'Orders API', 'Orders: API!', 'Billing'], 'collection'),
    [
      `orders-api${FILE_SUFFIX.collection}`,
      `orders-api-2${FILE_SUFFIX.collection}`,
      `orders-api-3${FILE_SUFFIX.collection}`,
      `billing${FILE_SUFFIX.collection}`
    ]
  );
});

test('the disambiguating suffix lands before the Postman suffix, not after', () => {
  // …-2.postman_collection.json, never …postman_collection-2.json: the export
  // has to still look like an export.
  const [, second] = exportFileNames(['Orders API', 'Orders API'], 'collection');
  assert.ok(second.endsWith(FILE_SUFFIX.collection));
});

test('an unnamed collection still gets a file name', () => {
  assert.deepEqual(exportFileNames(['', '...'], 'environment'), [
    `untitled${FILE_SUFFIX.environment}`,
    `untitled-2${FILE_SUFFIX.environment}`
  ]);
});

const environment = {
  id: 'env-1',
  name: 'Local',
  values: [
    { key: 'baseUrl', value: 'http://localhost:3000', type: 'default', enabled: true },
    { key: 'token', value: '', type: 'secret', enabled: true },
    { key: 'unset', value: '', type: 'secret', enabled: true }
  ],
  _postman_variable_scope: 'environment',
  _postman_exported_at: '2020-01-01T00:00:00.000Z'
};

test('exporting an environment puts the keychain values back in the file', () => {
  const json = environmentExportJson(environment, { token: 's3cret' }, '2026-08-21T00:00:00.000Z');

  assert.equal(json.values[1].value, 's3cret');
  assert.equal(json.values[1].type, 'secret');
  assert.equal(json._postman_exported_at, '2026-08-21T00:00:00.000Z');
});

test('a secret the keychain never held exports empty rather than undefined', () => {
  const json = environmentExportJson(environment, { token: 's3cret' }, 'now');
  assert.equal(json.values[2].value, '');
});

test('exporting an environment leaves everything else exactly as it was', () => {
  const json = environmentExportJson(environment, { token: 's3cret' }, 'now');

  assert.deepEqual(json.values[0], environment.values[0]);
  assert.equal(json.id, 'env-1');
  assert.equal(json.name, 'Local');
  assert.equal(json._postman_variable_scope, 'environment');
  // The source is untouched — the store hands out its own `entry.json`.
  assert.equal(environment.values[1].value, '');
  assert.equal(environment._postman_exported_at, '2020-01-01T00:00:00.000Z');
});

test('an environment with no variables at all still exports', () => {
  const json = environmentExportJson({ id: 'e', name: 'Empty' }, {}, 'now');
  assert.deepEqual(json.values, []);
});
