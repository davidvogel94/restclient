import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  FILE_SUFFIX,
  nameFromFileName,
  slugify,
  splitFileName,
  uniqueFileName
} from '../../src/collections/importer';

test('slugify makes a display name safe to put in a file name', () => {
  assert.equal(slugify('Orders API'), 'orders-api');
  assert.equal(slugify('  Staging / EU  '), 'staging-eu');
  assert.equal(slugify('a//b'), 'ab');
  assert.equal(slugify('...'), 'untitled');
  assert.equal(slugify(''), 'untitled');
});

test('nameFromFileName strips the Postman suffix a save dialog leaves behind', () => {
  assert.equal(nameFromFileName(`orders-api${FILE_SUFFIX.collection}`), 'Orders Api');
  assert.equal(nameFromFileName(`staging${FILE_SUFFIX.environment}`), 'Staging');
  assert.equal(nameFromFileName('globals.postman_globals.json'), 'Globals');
  assert.equal(nameFromFileName('orders.json'), 'Orders');
});

test('nameFromFileName leaves existing capitalisation alone', () => {
  // Someone who typed "OrdersAPI" meant it; only all-lower words get titled.
  assert.equal(nameFromFileName(`OrdersAPI${FILE_SUFFIX.collection}`), 'OrdersAPI');
  assert.equal(nameFromFileName('my_orders api.json'), 'My Orders Api');
});

test('a name survives the round trip through a file name', () => {
  const name = 'Orders Api';
  assert.equal(nameFromFileName(`${slugify(name)}${FILE_SUFFIX.collection}`), name);
});

test('nameFromFileName has nothing to offer for an empty name', () => {
  assert.equal(nameFromFileName(FILE_SUFFIX.collection), '');
  assert.equal(nameFromFileName(''), '');
});

test('splitFileName treats the Postman suffix as one suffix', () => {
  assert.deepEqual(splitFileName('orders.postman_collection.json'), {
    base: 'orders',
    suffix: '.postman_collection.json'
  });
  assert.deepEqual(splitFileName('local.postman_environment.json'), {
    base: 'local',
    suffix: '.postman_environment.json'
  });
  assert.deepEqual(splitFileName('shared.postman_globals.json'), {
    base: 'shared',
    suffix: '.postman_globals.json'
  });
});

test('splitFileName falls back to a plain extension, then to none', () => {
  assert.deepEqual(splitFileName('orders.json'), { base: 'orders', suffix: '.json' });
  assert.deepEqual(splitFileName('orders'), { base: 'orders', suffix: '' });
  assert.deepEqual(splitFileName('.gitignore'), { base: '.gitignore', suffix: '' }, 'a dotfile is all name');
});

test('uniqueFileName leaves a free name exactly as it arrived', () => {
  // The name the file came with is the name the user recognises.
  assert.equal(uniqueFileName('orders.postman_collection.json', () => false), 'orders.postman_collection.json');
});

test('uniqueFileName counts up, keeping the Postman suffix last', () => {
  const taken = new Set(['orders.postman_collection.json', 'orders-2.postman_collection.json']);
  assert.equal(
    uniqueFileName('orders.postman_collection.json', (n) => taken.has(n)),
    'orders-3.postman_collection.json',
    'never orders.postman_collection-3.json: the copy still has to look like an export'
  );
});

test('a copy still reads as the collection it came from', () => {
  const taken = new Set(['orders-api.postman_collection.json']);
  const copy = uniqueFileName('orders-api.postman_collection.json', (n) => taken.has(n));
  assert.equal(nameFromFileName(copy), 'Orders Api 2');
});
