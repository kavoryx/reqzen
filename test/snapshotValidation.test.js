const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSnapshot } = require('../lib/snapshotValidation');

const operation = { operationId: 'id-1', httpMethod: 'GET', pathTemplate: '/v1/users/{id}', serviceName: 'Users' };
const snapshot = { format: 'api-explorer-snapshot', services: [{ serviceId: 's1', name: 'Users' }], operations: [operation] };

test('accepts a source-generated snapshot and reports malformed operations rather than silently dropping them', () => {
  assert.equal(validateSnapshot(snapshot), '');
  assert.match(validateSnapshot({ ...snapshot, operations: [operation, { ...operation, pathTemplate: '' }] }), /Operation 2/);
  assert.match(validateSnapshot({ ...snapshot, operations: [operation, operation] }), /duplicate operation ID/);
  assert.match(validateSnapshot({ ...snapshot, services: [{}] }), /Service 1/);
  assert.match(validateSnapshot({ ...snapshot, formatVersion: 999 }), /version/);
  assert.match(validateSnapshot({ ...snapshot, environments: 'invalid' }), /environments/);
  assert.match(validateSnapshot({ ...snapshot, tokenTypes: [{}] }), /token type/);
  assert.match(validateSnapshot({ ...snapshot, operations: [{ ...operation, definition: { operation: { parameters: [null] } } }] }), /parameters/);
  assert.match(validateSnapshot({ ...snapshot, operations: [{ ...operation, contractVersion: 2 }] }), /contractVersion/);
  assert.match(validateSnapshot({ format: 'wrong', services: [], operations: [] }), /not a supported/);
});
