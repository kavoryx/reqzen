const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vars = require('../lib/variables');

const ENVS = ['env-prod', 'env-int'];

test('accepts a name with a value, and keeps only known environments with real values', () => {
  const r = vars.validate({ name: ' productId ', value: ' product-1 ', byEnvironment: { 'env-int': ' product-int ', 'env-x': 'drop', 'env-prod': '  ' } }, [], null, ENVS);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.value, { name: 'productId', value: 'product-1', byEnvironment: { 'env-int': 'product-int' } });
});

test('refuses bad names, duplicate names (any case), and a variable with no value at all', () => {
  const existing = [{ id: 'var:1', name: 'ProductId', value: 'a', byEnvironment: {} }];
  assert.ok(vars.validate({ name: 'productid', value: 'b' }, existing, null, ENVS).problems.includes('A variable with this name already exists.'));
  assert.equal(vars.validate({ name: '1product', value: 'b' }, [], null, ENVS).problems.length, 1);
  assert.equal(vars.validate({ name: 'product id', value: 'b' }, [], null, ENVS).problems.length, 1);
  assert.ok(vars.validate({ name: 'team', value: '' }, [], null, ENVS).problems.includes('Enter a value, or a value for at least one environment.'));
});

test('editing keeps its own name without a duplicate error', () => {
  const existing = [{ id: 'var:1', name: 'productId', value: 'a', byEnvironment: {} }];
  assert.deepEqual(vars.validate({ name: 'productId', value: 'b' }, existing, 'var:1', ENVS).problems, []);
});

test('an environment value wins, the shared value fills the rest, and a missing value is left out', () => {
  const list = [
    { id: 'var:1', name: 'productId', value: 'shared', byEnvironment: { 'env-int': 'int-product' } },
    { id: 'var:2', name: 'teamId', value: '', byEnvironment: { 'env-prod': 'prod-team' } },
  ];
  assert.deepEqual(vars.valuesFor(list, 'env-int'), { productid: { name: 'productId', value: 'int-product' } });
  assert.deepEqual(vars.valuesFor(list, 'env-prod'), {
    productid: { name: 'productId', value: 'shared' },
    teamid: { name: 'teamId', value: 'prod-team' },
  });
  assert.deepEqual(vars.valuesFor(list, 'unknown'), { productid: { name: 'productId', value: 'shared' } });
});

test('a missing or damaged file loads as an empty list, and a saved list round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vars-'));
  const file = path.join(dir, 'variables.json');
  assert.deepEqual(vars.load(file), []);
  fs.writeFileSync(file, '{oops');
  assert.deepEqual(vars.load(file), []);
  const list = [{ id: vars.newId(), name: 'productId', value: 'x', byEnvironment: { 'env-int': 'y' } }];
  vars.save(file, list);
  assert.deepEqual(vars.load(file), list);
});

test('a variable matches a parameter whatever the spelling: productId, product_id, product-id and ProductID are one name', () => {
  const list = [{ id: 'var:1', name: 'productId', value: 'product-1', byEnvironment: {} }];
  for (const key of ['product_id', 'product-id', 'ProductID', 'PRODUCTID']) {
    assert.equal(vars.valuesFor(list, 'x')[vars.variableKey(key)].value, 'product-1', key);
  }
});

test('snapshot variables preserve existing values and report conflicts, invalid values and unavailable environments', () => {
  const existing = [{ id: 'var:1', name: 'productId', value: 'original', byEnvironment: {} }];
  const merged = vars.mergeRows(existing, [
    { name: 'PRODUCTID', value: 'replacement', byEnvironment: {} },
    { name: 'region', value: 'shared', byEnvironment: { 'env-int': 'int', 'env-other': 'secret' } },
    { name: 'empty', value: '', byEnvironment: { 'env-other': 'secret' } },
    { name: 'invalid name', value: 'x', byEnvironment: {} },
  ], ENVS);
  assert.equal(merged.variables[0].value, 'original');
  assert.deepEqual(merged.variables[1].byEnvironment, { 'env-int': 'int' });
  assert.equal(merged.variables.length, 2);
  assert.equal(merged.skipped.length, 5);
  assert.ok(merged.skipped.some((message) => message.includes('already exists')));
  assert.ok(merged.skipped.some((message) => message.includes('unavailable environments')));
  assert.ok(merged.skipped.some((message) => message.includes('invalid name')));
});
