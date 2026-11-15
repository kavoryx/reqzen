const test = require('node:test');
const assert = require('node:assert/strict');
const confirmations = require('../lib/confirmations');

const internal = { environmentId: 'env-dev', name: 'Development', production: false };
const prod = { environmentId: 'env-prod', name: 'Production', production: true };

test('internal environments ask for nothing by default', () => {
  for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(confirmations.requiredFor({}, internal, m), false);
});

test('production asks before every write, but not before GET', () => {
  assert.equal(confirmations.requiredFor({}, prod, 'GET'), false);
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(confirmations.requiredFor({}, prod, m), true);
});

test('HEAD and OPTIONS follow GET; an unknown method always asks', () => {
  assert.equal(confirmations.requiredFor({}, prod, 'HEAD'), false);
  assert.equal(confirmations.requiredFor({}, prod, 'OPTIONS'), false);
  assert.equal(confirmations.requiredFor({}, internal, 'TRACE'), true);
});

test('a saved setting for one environment changes only that environment', () => {
  const saved = { 'env-dev': { GET: false, POST: true, PUT: false, PATCH: false, DELETE: true } };
  assert.equal(confirmations.requiredFor(saved, internal, 'POST'), true);
  assert.equal(confirmations.requiredFor(saved, internal, 'DELETE'), true);
  assert.equal(confirmations.requiredFor(saved, prod, 'POST'), true);
  const relaxed = { 'env-prod': { GET: false, POST: false, PUT: false, PATCH: false, DELETE: false } };
  assert.equal(confirmations.requiredFor(relaxed, prod, 'DELETE'), false);
});

test('validate needs a yes or no for every method', () => {
  assert.deepEqual(confirmations.validate({ GET: false, POST: true, PUT: true, PATCH: true, DELETE: true }).problems, []);
  assert.ok(confirmations.validate({ GET: 'yes' }).problems.includes('GET: choose yes or no.'));
});
