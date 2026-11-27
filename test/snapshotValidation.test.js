const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonDocument, parseSnapshot, validateSnapshot } = require('../lib/snapshotValidation');

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

test('parses safe external-agent JSON transport variants without weakening snapshot validation', () => {
  for (const text of [
    `\uFEFF${JSON.stringify(snapshot)}`,
    `\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\``,
    `Here is the generated snapshot:\n${JSON.stringify({ snapshot })}\n`,
  ]) {
    const parsed = parseSnapshot(text);
    assert.equal(parsed.problem, '');
    assert.deepEqual(parsed.snapshot.operations, snapshot.operations);
  }
  const alias = parseSnapshot(JSON.stringify({ ...snapshot, format: 'reqzen-api-snapshot', formatVersion: '1' }));
  assert.equal(alias.problem, '');
  assert.equal(alias.snapshot.formatVersion, 1);
  assert.equal(alias.snapshot.format, 'api-explorer-snapshot');
  assert.equal(parseSnapshot('not json').snapshot, null);
  assert.match(parseSnapshot('not json').problem, /valid JSON/);
  assert.equal(parseSnapshot(JSON.stringify({ operations: [], services: [] })).problem, '');
  assert.match(parseSnapshot(JSON.stringify({ result: { format: 'postman-collection', operations: [], services: [] } })).problem, /not a supported/);
  assert.equal(parseJsonDocument('{"unterminated":'), null);
});

test('normalizes service-nested Reqzen exports into the canonical snapshot shape', () => {
  const external = {
    format: 'reqzen-snapshot',
    formatVersion: 1,
    customFieldDefinitions: [{ key: 'repo', label: 'Repo', visible: true }],
    services: [{
      id: 'service-1',
      name: 'Users',
      repo: 'example/users',
      operations: [{
        id: 'operation-1',
        method: 'GET',
        path: '/v1/users/{id}',
        version: 'v1',
        summary: 'Get user',
        parameters: [{ name: 'id', in: 'path', required: true }],
        customFields: { repo: 'example/users' },
      }],
    }],
  };
  const parsed = parseSnapshot(JSON.stringify(external));
  assert.equal(parsed.problem, '');
  assert.equal(parsed.snapshot.format, 'api-explorer-snapshot');
  assert.deepEqual(parsed.snapshot.services[0], {
    id: 'service-1', name: 'Users', repo: 'example/users', serviceId: 'service-1',
  });
  assert.deepEqual(parsed.snapshot.operations[0], {
    id: 'operation-1',
    operationId: 'operation-1',
    revisionId: 'operation-1',
    method: 'GET',
    httpMethod: 'GET',
    path: '/v1/users/{id}',
    pathTemplate: '/v1/users/{id}',
    version: 'v1',
    contractVersion: 'v1',
    serviceId: 'service-1',
    serviceName: 'Users',
    summary: 'Get user',
    parameters: [{ name: 'id', in: 'path', required: true }],
    customFields: { repo: 'example/users' },
  });
});
