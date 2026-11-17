const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tt = require('../lib/tokenTypes');

const operation = { operationId: 'op-token', serviceName: 'example-service', contractVersion: 'v1', httpMethod: 'POST', pathTemplate: '/auth/v1/token', summary: 'Token', contextPath: '/api', defaultBody: '' };

test('a token type needs a name that is unique across the app, and a valid API or token address', () => {
  const existing = [{ id: 'tt:1', name: 'Support', operationId: 'op', tokenField: 'access_token', body: '' }];
  assert.ok(tt.validateType({ name: 'support', operationId: 'op' }, existing, null).problems.includes('A token type with this name already exists.'));
  assert.deepEqual(tt.validateType({ name: 'Super', operationId: 'op' }, existing, null).problems, []);
  assert.ok(tt.validateType({ name: '', operationId: 'op' }, [], null).problems[0].includes('Name the token type'));
  assert.equal(tt.validateType({ name: 'Edit', operationId: 'op' }, existing, 'tt:1').problems.length, 0);
  assert.deepEqual(tt.validateType({ name: 'Authentication', mode: 'request', url: 'https://login.example.test/x' }, [], null).problems, []);
  assert.ok(tt.validateType({ name: 'Staging', mode: 'request', url: '' }, [], null).problems[0].includes('token address'));
});

test('a version 1 file (one token API per environment) loads as one type named Token', () => {
  const list = tt.normalize({ 'env-int': { operationId: 'op-1', tokenField: 'access_token', body: '{}' } });
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Token');
  assert.equal(list[0].operationId, 'op-1');
  assert.equal(list[0].auth, 'none');
});

test('a version 2 file (per environment) is flattened into one list', () => {
  const list = tt.normalize({ version: 2, environments: {
    a: { types: [{ id: 'tt:a', name: 'User', operationId: 'op-u', tokenField: 'access_token', body: '' }] },
    b: { types: [{ id: 'tt:b', name: 'Support', operationId: 'op-s', tokenField: 'data.token', body: '' }] },
  } });
  assert.deepEqual(list.map((t) => t.name), ['User', 'Support']);
});

test('the saved file keeps one list of types and survives a reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-'));
  const file = path.join(dir, 'token-sources.json');
  assert.deepEqual(tt.load(file), []);
  const list = [
    { id: 'tt:a', name: 'User', mode: 'api', operationId: 'op-u', operation, tokenField: 'access_token', body: '' },
    { id: 'tt:b', name: 'Authentication', mode: 'request', url: 'https://login.example.test/oauth/token', method: 'POST', headers: 'Accept: application/json', contentType: 'form', auth: 'none', tokenField: 'access_token', body: 'client_id=a' },
  ];
  tt.save(file, list);
  const reloaded = tt.load(file);
  assert.equal(reloaded.length, 2);
  assert.equal(reloaded[1].url, 'https://login.example.test/oauth/token');
  assert.equal(reloaded[1].contentType, 'form');
  assert.equal(reloaded[0].auth, 'none');
  fs.writeFileSync(file, '[bad');
  assert.deepEqual(tt.load(file), []);
});

test('a workspace export carries token types and values only when asked, and values follow the environment name', () => {
  const list = [{ id: 'tt:a', name: 'Service', mode: 'api', operationId: 'op-svc', operation, tokenField: 'access_token', body: '' }];
  const rows = tt.exportRows(list, { 'env-dev': 'Development', 'env-prod': 'Production' }, { 'env-dev|tt:a': 'svc-secret' });
  const without = JSON.stringify(tt.exportWorkspace({ favourites: [], collections: [] }, rows, false));
  assert.ok(!without.includes('svc-secret'));
  const parsed = tt.parseWorkspace(JSON.stringify(tt.exportWorkspace({ favourites: [], collections: [] }, rows, true)));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.includesTokenValues, true);
  const merged = tt.mergeRows([], parsed.tokenRows, { development: 'env-new', production: 'env-prod' });
  assert.equal(merged.types[0].name, 'Service');
  assert.deepEqual(merged.applied, [{ environmentId: 'env-new', typeId: merged.types[0].id, value: 'svc-secret' }]);
  assert.equal(merged.types[0].operation.pathTemplate, '/auth/v1/token');
});

test('a workspace import skips type names already used here', () => {
  const rows = [
    { name: 'User', mode: 'api', operationId: 'op', operation: null, tokenField: 'access_token', body: '' },
    { name: 'Authentication', mode: 'request', url: 'https://login.example.test/x', method: 'POST', headers: '', contentType: 'json', auth: 'none', tokenField: 'access_token', body: '' },
  ];
  const existing = [{ id: 'tt:x', name: 'user', mode: 'api', operationId: 'op', operation: null, tokenField: 'access_token', body: '', auth: 'none' }];
  const r = tt.mergeRows(existing, rows, {});
  assert.equal(r.types.length, 2);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0], /already set up/);
});

test('a workspace file of the wrong kind or version is refused', () => {
  assert.match(tt.parseWorkspace('{}').problems[0], /not a Reqzen workspace/);
  assert.match(tt.parseWorkspace(JSON.stringify({ format: 'api-explorer-workspace', formatVersion: 3 })).problems[0], /version 3/);
});

test('a Basic credential stays out of a workspace file unless token values are included', () => {
  const list = [{ id: 'tt:c', name: 'Client', mode: 'request', url: 'https://login.example.test/t', method: 'POST', headers: '', contentType: 'form', auth: 'basic', basic: 'Basic Y2xpZW50OnRlc3Q=', operationId: '', operation: null, tokenField: 'access_token', body: 'grant_type=client_credentials' }];
  const without = JSON.stringify(tt.exportWorkspace({ favourites: [], collections: [] }, tt.exportRows(list, {}, null), false));
  assert.ok(!without.includes('Y2xpZW50OnRlc3Q='));
  const rows = tt.exportRows(list, {}, {});
  assert.equal(tt.parseWorkspace(JSON.stringify(tt.exportWorkspace({ favourites: [], collections: [] }, rows, false))).tokenRows[0].auth, 'basic');
});
