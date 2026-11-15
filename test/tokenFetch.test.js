const test = require('node:test');
const assert = require('node:assert/strict');
const tokenFetch = require('../lib/tokenFetch');

const snapshot = { environments: [{ environmentId: 'e', name: 'Development', enabled: true, baseUrl: 'https://api.example.test' }], services: [] };
const env = snapshot.environments[0];
const run = (over = {}) => ({ url: 'https://api.example.test/token', method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' }, confirmWrite: true, ...over });

test('a token setup needs an API, a valid field name and JSON or an empty body', () => {
  assert.ok(tokenFetch.validateTokenSource({}).problems.includes('Choose the API that returns the token.'));
  assert.deepEqual(tokenFetch.validateTokenSource({ operationId: 'op', tokenField: '', body: '' }).value.tokenField, 'access_token');
  assert.equal(tokenFetch.validateTokenSource({ operationId: 'op', tokenField: 'data.access token' }).problems.length, 1);
  assert.equal(tokenFetch.validateTokenSource({ operationId: 'op', body: '{oops' }).problems[0], 'The request body is not valid JSON.');
});

test('the token call needs https, an allowed host, and confirmation for a POST', () => {
  assert.deepEqual(tokenFetch.checkTokenRun(snapshot, run(), {}, env), []);
  assert.ok(tokenFetch.checkTokenRun(snapshot, run({ url: 'http://api.example.test/token' }), {}, env).includes('Only https addresses can be used.'));
  assert.ok(tokenFetch.checkTokenRun(snapshot, run({ url: 'https://evil.example.test/token' }), {}, env).some((p) => p.includes('not an enabled environment')));
  assert.ok(tokenFetch.checkTokenRun(snapshot, run({ confirmWrite: false }), {}, env).some((p) => p.includes('changes data')));
  assert.ok(tokenFetch.checkTokenRun(snapshot, run(), { schemaComplete: false }, env).some((p) => p.includes('incomplete')));
});

test('a separately hosted token endpoint works after its host is added as an environment', () => {
  const auth = { environmentId: 'auth', name: 'Authentication', enabled: true, baseUrl: 'https://login.example.test' };
  const workspace = { ...snapshot, environments: [...snapshot.environments, auth] };
  assert.deepEqual(tokenFetch.checkTokenRun(workspace, run({ url: 'https://login.example.test/oauth/token' }), {}, auth), []);
});

test('only a content type header is allowed on the token call, and no authorization header', () => {
  assert.ok(tokenFetch.checkTokenRun(snapshot, run({ headers: { Authorization: 'Bearer x' } }), {}, env).some((p) => p.includes('Authorization')));
});

test('the token is read from the field, including a nested path and a number', () => {
  assert.deepEqual(tokenFetch.extractToken('{"access_token":"abc.def"}', 'access_token'), { ok: true, token: 'abc.def' });
  assert.deepEqual(tokenFetch.extractToken('{"data":{"token":"t1"}}', 'data.token'), { ok: true, token: 't1' });
  assert.deepEqual(tokenFetch.extractToken('{"access_token":12345}', ''), { ok: true, token: '12345' });
});

test('a response with no usable token, a line break in it, or invalid JSON is refused', () => {
  assert.match(tokenFetch.extractToken('{"other":"x"}', 'access_token').problem, /no usable "access_token"/);
  assert.equal(tokenFetch.extractToken('{"access_token":"a\\nb"}', 'access_token').ok, false);
  assert.equal(tokenFetch.extractToken('<html>', 'access_token').problem, 'The token response is not JSON.');
});

test('a Basic client credential is kept only as an Authorization value for the token call', () => {
  const basic = 'Basic Y2xpZW50OnNlY3JldA==';
  const ok = tokenFetch.validateTokenType({ mode: 'request', url: 'https://login.example.test/t', auth: 'basic', basic });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.value.basic, basic);
  assert.ok(tokenFetch.validateTokenType({ mode: 'request', url: 'https://login.example.test/t', auth: 'basic', basic: 'Bearer x' }).problems[0].includes('Basic credential'));
  // The header check still refuses Authorization typed as a plain header.
  assert.ok(tokenFetch.validateTokenType({ mode: 'request', url: 'https://login.example.test/t', headers: 'Authorization: Basic Y2xpZW50OnNlY3JldA==' }).problems.some((p) => p.includes('Authorization')));
  const base = { url: 'https://api.example.test/token', method: 'POST', body: 'grant_type=client_credentials', headers: {}, confirmWrite: true };
  assert.deepEqual(tokenFetch.checkTokenRun(snapshot, { ...base, auth: 'basic', basic }, null, env), []);
  assert.ok(tokenFetch.checkTokenRun(snapshot, { ...base, auth: 'basic', basic: '' }, null, env).some((p) => p.includes('Basic credential is missing')));
});
