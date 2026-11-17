const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../lib/library');

const items = { operationId: 'op-1', serviceName: 'example-service', contractVersion: 'v4', httpMethod: 'GET', pathTemplate: '/sample/v4/items', summary: 'Get all items', contextPath: '/api', defaultBody: '' };
const create = { operationId: 'op-2', serviceName: 'example-service', contractVersion: 'v4', httpMethod: 'POST', pathTemplate: '/sample/v4/groups/{groupId}/items', summary: 'Create an item', contextPath: '', defaultBody: '{\n  "name": ""\n}' };

test('a damaged or partial library loads with bad entries dropped and duplicates removed', () => {
  const store = lib.sanitizeStore({
    favourites: [items, items, { httpMethod: 'GET' }, null],
    collections: [{ name: '  ', items: [create] }, 'junk'],
  });
  assert.equal(store.favourites.length, 1);
  assert.equal(store.collections.length, 1);
  assert.equal(store.collections[0].name, 'Untitled collection');
  assert.match(store.collections[0].id, /^col:/);
});

test('the app format round-trips a collection and carries no tokens or variables', () => {
  const collection = { id: 'col:1', name: 'Items', items: [items, create] };
  const file = lib.exportApp(collection, new Date('2026-11-09T00:00:00Z'));
  const text = JSON.stringify(file);
  assert.equal(file.format, 'api-explorer-collection');
  assert.ok(!/token|accessToken|Authorization|baseUrl|environment/i.test(text));
  const back = lib.importApp(text);
  assert.equal(back.ok, true);
  assert.equal(back.collection.name, 'Items');
  assert.deepEqual(back.collection.items.map((i) => i.operationId), ['op-1', 'op-2']);
  assert.notEqual(back.collection.id, 'col:1');
});

test('an import with the wrong format, version or no valid APIs is refused with a reason', () => {
  assert.match(lib.importApp('{nope').problems[0], /not valid JSON/);
  assert.match(lib.importApp(JSON.stringify({ format: 'other' })).problems[0], /not a Reqzen collection/);
  assert.match(lib.importApp(JSON.stringify({ format: 'api-explorer-collection', formatVersion: 9, items: [] })).problems[0], /version 9/);
  assert.match(lib.importApp(JSON.stringify({ format: 'api-explorer-collection', formatVersion: 1, items: [{}] })).problems[0], /no valid APIs/);
});

test('the Postman export uses variables for host and token and converts path parameters', () => {
  const p = lib.exportPostman({ id: 'col:1', name: 'Items', items: [items, create] }, new Date('2026-11-09T00:00:00Z'));
  assert.equal(p.info.schema, 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
  assert.deepEqual(p.variable.map((v) => v.key), ['baseUrl', 'accessToken']);
  assert.equal(p.auth.bearer[0].value, '{{accessToken}}');
  const [getItem, postItem] = p.item;
  assert.equal(getItem.request.url.raw, '{{baseUrl}}/api/sample/v4/items');
  assert.equal(getItem.request.body, undefined);
  assert.equal(postItem.request.url.raw, '{{baseUrl}}/sample/v4/groups/:groupId/items');
  assert.equal(postItem.request.body.raw, '{\n  "name": ""\n}');
  assert.equal(postItem.name, 'Create an item');
});

test('a missing file loads as an empty library, and a saved library round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-'));
  const file = path.join(dir, 'library.json');
  assert.deepEqual(lib.load(file), { favourites: [], collections: [] });
  fs.writeFileSync(file, '[oops');
  assert.deepEqual(lib.load(file), { favourites: [], collections: [] });
  const saved = lib.save(file, { favourites: [items], collections: [{ id: 'col:9', name: 'Items', items: [create] }] });
  assert.deepEqual(lib.load(file), saved);
});

test('file names are safe for macOS and Windows', () => {
  assert.equal(lib.fileNameFor('Items / prod: v2', '.json'), 'Items _ prod_ v2.json');
});
