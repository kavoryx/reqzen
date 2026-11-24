const test = require('node:test');
const assert = require('node:assert/strict');
const ex = require('../lib/catalogExport');

const snapshot = {
  format: 'api-explorer-snapshot', formatVersion: 1, exportedAt: 'old', exportedBy: 'GitHub scan',
  services: [{ serviceId: 's1', name: 'inventory', contextPath: '' }],
  environments: [
    { environmentId: 'e1', name: 'Dev', production: false, enabled: true, baseUrl: 'https://dev.example' },
    { environmentId: 'e2', name: 'Integration', production: false, enabled: true, baseUrl: 'https://integration.example.test' },
  ],
  serviceOverrides: [],
  operations: [
    { operationId: 'o1', revisionId: 'r1', serviceId: 's1', serviceName: 'inventory', contractVersion: 'v1', httpMethod: 'POST', pathTemplate: '/inventory/v1/items', visibility: 'HIDDEN', lifecycleStatus: 'ACTIVE', schemaComplete: true, summary: '', description: '',
      definition: { 'x-apiexplorer': { controller: 'ItemController', method: 'create', source: 'Item.java', returnType: 'Item' }, operation: { parameters: [{ name: 'page', in: 'query', required: false, schema: { type: 'integer' } }], requestBody: { content: { 'application/json': { schema: { 'x-source-type': 'ItemDto' } } } } } } },
    { operationId: 'o2', revisionId: 'r2', serviceId: 's1', serviceName: 'inventory', contractVersion: 'v1', httpMethod: 'GET', pathTemplate: '/inventory/v1/items/{id}', visibility: 'PUBLIC', lifecycleStatus: 'DEPRECATED', schemaComplete: true, summary: 'Get item', description: 'From the spec.', definition: { 'x-apiexplorer': {} } },
  ],
};
const docs = { r1: { description: 'Creates an item for the given inventory.', source: 'local' }, r2: { description: 'Should not replace the spec text.', source: 'local' } };
const overviews = { inventory: { overview: 'Tracks inventory items.', source: 'local' } };

test('the export keeps the snapshot format, adds generated descriptions and the overview, and names the default environment', () => {
  const out = ex.buildCatalog({ snapshot, docs, overviews, defaultEnvironmentId: '' });
  assert.equal(out.format, 'api-explorer-snapshot');
  assert.equal(out.formatVersion, 1);
  assert.equal(out.defaultEnvironmentId, 'e1', 'the first environment is the default when none is named');
  assert.equal(out.operations[0].description, 'Creates an item for the given inventory.');
  assert.equal(out.operations[0].definition['x-apiexplorer'].descriptionSource, 'local');
  assert.equal(out.operations[1].description, 'From the spec.', 'the spec text is kept, not replaced');
  assert.equal(out.operations[1].definition['x-apiexplorer'].descriptionSource, 'spec');
  assert.equal(out.services[0].overview, 'Tracks inventory items.');
  assert.notEqual(out.exportedAt, 'old');
});

test('without generated text the export has only the spec descriptions', () => {
  const out = ex.buildCatalog({ snapshot, docs, overviews, includeGenerated: false });
  assert.equal(out.operations[0].description, '');
  assert.equal(out.services[0].overview, undefined);
});

test('export includes generated summaries without replacing source summaries', () => {
  const out = ex.buildCatalog({ snapshot, docs: { r1: { summary: 'Create item', description: 'Creates an item.', source: 'local' }, r2: { summary: 'Generated', description: 'Text.', source: 'local' } } });
  assert.equal(out.operations[0].summary, 'Create item');
  assert.equal(out.operations[1].summary, 'Get item');
});

test('a named default environment is used when it exists, otherwise the first one', () => {
  assert.equal(ex.pickDefaultEnvironment(snapshot.environments, 'e1'), 'e1');
  assert.equal(ex.pickDefaultEnvironment(snapshot.environments, 'missing'), 'e1');
  assert.equal(ex.pickDefaultEnvironment([{ environmentId: 'x', name: 'Other' }], ''), 'x');
});

test('the CSV has one row per API, quotes what needs quoting, and starts with a byte-order mark', () => {
  const csv = ex.toCsv(ex.buildCatalog({ snapshot, docs, overviews }));
  assert.ok(csv.startsWith('﻿'));
  const lines = csv.trim().split(/\r\n/);
  assert.equal(lines.length, 3, 'header and two APIs');
  assert.equal(lines[1], 'inventory,POST,/inventory/v1/items,v1,HIDDEN,ACTIVE,,Creates an item for the given inventory.,local,"page (query, integer)",ItemDto,Item,Item.java,ItemController');
  const quoted = ex.toCsv({ operations: [{ serviceName: 's', httpMethod: 'GET', pathTemplate: '/a', definition: {}, summary: 'a, "b"' }] });
  assert.match(quoted, /"a, ""b"""/);
});

test('a catalogue with no operations cannot be exported', () => {
  assert.throws(() => ex.buildCatalog({ snapshot: {} }), /no API list/);
});

test('the export can leave out services, environments and token types', () => {
  const sub = { ...snapshot, services: [...snapshot.services, { serviceId: 's2', name: 'billing', contextPath: '' }],
    operations: [...snapshot.operations, { ...snapshot.operations[0], operationId: 'o3', revisionId: 'r3', serviceId: 's2', serviceName: 'billing' }] };
  const only = ex.buildCatalog({ snapshot: sub, services: ['s2'], includeEnvironments: false });
  assert.deepEqual(only.operations.map((o) => o.serviceId), ['s2']);
  assert.deepEqual(only.services.map((s) => s.name), ['billing']);
  assert.deepEqual(only.environments, []);
  assert.equal(only.defaultEnvironmentId, '');
  assert.equal('tokenTypes' in only, false, 'token types are left out unless asked for');

  const all = ex.buildCatalog({ snapshot: sub, services: null, tokenTypes: [{ name: 'Admin token', url: 'https://auth.example/token' }] });
  assert.equal(all.operations.length, 3);
  assert.equal(all.environments.length, 2);
  assert.equal(all.tokenTypes[0].name, 'Admin token');
});

test('leaving out environments also leaves out the service overrides that name them', () => {
  const withOverride = { ...snapshot, serviceOverrides: [{ serviceId: 's1', environmentId: 'e1', baseUrl: 'https://dev.example', enabled: true }] };
  const without = ex.buildCatalog({ snapshot: withOverride, includeEnvironments: false });
  assert.deepEqual(without.serviceOverrides, []);
  assert.equal(JSON.stringify(without).includes('dev.example'), false, 'no environment address is written');
  const withEnvs = ex.buildCatalog({ snapshot: withOverride, includeEnvironments: true });
  assert.equal(withEnvs.serviceOverrides.length, 1);
});

test('sharing filters services, environments, token types and environment-specific variable values', () => {
  const sub = {
    ...snapshot,
    services: [...snapshot.services, { serviceId: 's2', name: 'billing' }],
    operations: [...snapshot.operations, { ...snapshot.operations[0], operationId: 'o3', serviceId: 's2', serviceName: 'billing' }],
    serviceOverrides: [
      { serviceId: 's1', environmentId: 'e1', baseUrl: 'https://one.example' },
      { serviceId: 's1', environmentId: 'e2', baseUrl: 'https://two.example' },
      { serviceId: 's2', environmentId: 'e1', baseUrl: 'https://other.example' },
    ],
  };
  const environments = [{ ...snapshot.environments[0], overridden: true, snapshotBaseUrl: 'https://original-private.example' }, snapshot.environments[1]];
  const types = [{ id: 't1', name: 'Client', mode: 'request', url: 'https://user:pass@auth.example/token?secret=hidden#fragment', method: 'POST', auth: 'basic', basic: 'secret-basic', headers: 'X-Key: header-secret', body: 'body-secret' }];
  const savedVariables = [{ id: 'v1', name: 'org', value: 'shared', byEnvironment: { e1: 'dev-value', e2: 'production-secret' } }];
  const selections = { services: ['s1'], environments: ['e1'], tokenTypes: ['t1'], variables: ['v1'], defaultEnvironmentId: 'e2', includeVariableValues: true };
  const result = ex.buildShareCatalog({ snapshot: sub, environments, types, savedVariables, selections });
  assert.deepEqual(result.operations.map((op) => op.operationId), ['o1', 'o2']);
  assert.deepEqual(result.environments.map((env) => env.environmentId), ['e1']);
  assert.equal(result.defaultEnvironmentId, 'e1');
  assert.deepEqual(result.serviceOverrides, [sub.serviceOverrides[0]]);
  assert.deepEqual(result.variables, [{ name: 'org', value: 'shared', byEnvironment: { e1: 'dev-value' } }]);
  assert.equal(result.tokenTypes[0].url, 'https://auth.example/token');
  assert.equal(result.tokenTypes[0].headers, '');
  assert.equal(result.tokenTypes[0].body, '');
  const text = JSON.stringify(result);
  for (const secret of ['production-secret', 'original-private.example', 'secret-basic', 'header-secret', 'body-secret', 'user:pass', 'secret=hidden']) {
    assert.ok(!text.includes(secret), secret);
  }
  assert.equal(require('../lib/snapshotValidation').validateSnapshot(result), '');
  const included = ex.buildShareCatalog({ snapshot: sub, environments, types, savedVariables, selections: { ...selections, includeTokenSecrets: true } });
  assert.equal(included.tokenTypes[0].basic, 'secret-basic');
  assert.equal(included.tokenTypes[0].body, 'body-secret');
  assert.match(included.tokenTypes[0].url, /secret=hidden/);
  assert.equal(included.tokenTypes[0].tokenValues, undefined);
});

test('sharing refuses stale selections and unconfirmed or unavailable variable values', () => {
  const args = { snapshot, environments: snapshot.environments, types: [], savedVariables: [{ id: 'v', name: 'org', value: '', byEnvironment: { e2: 'secret' } }], selections: { services: ['s1'], environments: ['e1'], tokenTypes: [], variables: ['v'] } };
  assert.throws(() => ex.buildShareCatalog(args), /Confirm/);
  assert.throws(() => ex.buildShareCatalog({ ...args, selections: { ...args.selections, includeVariableValues: true } }), /no shared value/);
  assert.throws(() => ex.buildShareCatalog({ ...args, selections: { ...args.selections, services: ['missing'], variables: [] } }), /no longer available/);
  assert.throws(() => ex.buildShareCatalog({ ...args, selections: { ...args.selections, services: [], variables: [] } }), /at least one service/);
});

test('sharing accepts older service entries without ids and strips saved API token bodies by default', () => {
  const legacy = { ...snapshot, services: [{ name: 'inventory' }], operations: [{ ...snapshot.operations[0], serviceId: undefined }] };
  const types = [{ id: 't', name: 'API token', mode: 'api', operationId: 'o1', operation: { defaultBody: 'private-body' }, body: 'private-body' }];
  const out = ex.buildShareCatalog({ snapshot: legacy, environments: [], types, savedVariables: [], selections: { services: ['inventory'], environments: [], tokenTypes: ['t'], variables: [] } });
  assert.equal(out.operations.length, 1);
  assert.equal(out.operations[0].serviceId, 'inventory');
  assert.equal(out.tokenTypes[0].operation.defaultBody, '');
});
