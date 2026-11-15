const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const custom = require('../lib/customRequests');

test('a custom request needs a name, a valid method and an address', () => {
  assert.deepEqual(custom.validate({ name: 'Items', method: 'get', url: '/v1/items' }).problems, []);
  assert.ok(custom.validate({ name: '', method: 'GET', url: '/x' }).problems.includes('Name the request so you can find it again.'));
  assert.ok(custom.validate({ name: 'x', method: 'TRACE', url: '/x' }).problems[0].includes('Choose a method'));
  assert.ok(custom.validate({ name: 'x', method: 'GET', url: '' }).problems[0].includes('Enter the address'));
});

test('an API key needs a valid header name, and bad header names are dropped', () => {
  assert.ok(custom.validate({ name: 'x', method: 'GET', url: '/x', auth: 'apikey', authKey: 'bad name', authValue: 'v' })
    .problems[0].includes('Give the API key header a name'));
  const r = custom.validate({ name: 'x', method: 'GET', url: '/x', headers: [{ key: 'X-Tenant', value: 'example-org' }, { key: 'bad key', value: '1' }] });
  assert.deepEqual(r.value.headers.map((h) => h.key), ['X-Tenant']);
});

test('a body over 200 KB and a line break in a value are refused', () => {
  assert.ok(custom.validate({ name: 'x', method: 'POST', url: '/x', body: 'a'.repeat(201 * 1024) }).problems.some((p) => p.includes('200 KB')));
  assert.ok(custom.validate({ name: 'x', method: 'GET', url: '/x', query: [{ key: 'q', value: 'a\nb' }] }).problems[0].includes('line break'));
});

test('saved requests round-trip, and a damaged file loads as none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-'));
  const file = path.join(dir, 'custom.json');
  assert.deepEqual(custom.load(file), []);
  const list = [{ id: custom.newId(), name: 'Items', method: 'GET', url: '/v1/items', auth: 'bearer' }];
  custom.save(file, list);
  assert.deepEqual(custom.load(file), list);
  fs.writeFileSync(file, '{oops');
  assert.deepEqual(custom.load(file), []);
});
