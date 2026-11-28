const test = require('node:test');
const assert = require('node:assert/strict');
const { convertOpenApi3 } = require('../lib/openapi');

const doc = {
  openapi: '3.0.1',
  info: { title: 'Sample', version: 'v3' },
  paths: {
    '/sample/v1/items/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: { summary: 'Get item', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } } } },
      delete: { summary: 'Old delete', deprecated: true, responses: { 204: { description: 'gone' } } },
    },
    '/sample/v1/items': {
      post: { summary: 'Create item', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Missing' } } } }, responses: {} },
      trace: { responses: {} },
    },
  },
  components: {
    schemas: {
      Item: { type: 'object', properties: { owner: { $ref: '#/components/schemas/Owner' } } },
      Owner: { type: 'object', properties: { name: { type: 'string' } } },
      Unused: { type: 'string' },
    },
  },
};

test('converts operations with their deprecation status and only the schemas they use', () => {
  const r = convertOpenApi3(doc, { serviceName: 'sample', source: 'owner/repo/sample' });
  const byKey = Object.fromEntries(r.operations.map((o) => [`${o.httpMethod} ${o.pathTemplate}`, o]));
  assert.deepEqual(Object.keys(byKey).sort(), ['DELETE /sample/v1/items/{id}', 'GET /sample/v1/items/{id}', 'POST /sample/v1/items']);
  assert.equal(byKey['DELETE /sample/v1/items/{id}'].lifecycleStatus, 'DEPRECATED');
  assert.equal(byKey['GET /sample/v1/items/{id}'].lifecycleStatus, 'ACTIVE');
  assert.equal(byKey['GET /sample/v1/items/{id}'].schemaComplete, true);
  assert.deepEqual(Object.keys(byKey['GET /sample/v1/items/{id}'].definition.components.schemas).sort(), ['Item', 'Owner']);
  assert.equal(byKey['POST /sample/v1/items'].schemaComplete, false);
  assert.deepEqual(byKey['POST /sample/v1/items'].definition['x-apiexplorer'].unresolvedTypes, ['#/components/schemas/Missing']);
  assert.equal(byKey['GET /sample/v1/items/{id}'].serviceName, 'sample');
  assert.equal(byKey['GET /sample/v1/items/{id}'].contractVersion, 'v3');
});

test('ids are stable across scans', () => {
  const a = convertOpenApi3(doc, { serviceName: 'sample', source: 's' }).operations.map((o) => o.operationId);
  const b = convertOpenApi3(doc, { serviceName: 'sample', source: 's' }).operations.map((o) => o.operationId);
  assert.deepEqual(a, b);
});

test('OpenAPI extensions hide APIs without losing deprecation status', () => {
  const r = convertOpenApi3({
    openapi: '3.0.1',
    info: { title: 'Hidden', version: 'v1' },
    paths: {
      '/old': {
        get: {
          deprecated: true,
          'x-internal': true,
          responses: {},
        },
      },
    },
  }, { serviceName: 'sample', source: 'sample' });
  assert.equal(r.operations[0].visibility, 'HIDDEN');
  assert.equal(r.operations[0].lifecycleStatus, 'DEPRECATED');
});

test('a Swagger 2 document is not converted', () => {
  const r = convertOpenApi3({ swagger: '2.0', paths: {} }, { serviceName: 'x', source: 's' });
  assert.equal(r.operations.length, 0);
  assert.equal(r.problems[0], 'This is not an OpenAPI 3 document.');
});
