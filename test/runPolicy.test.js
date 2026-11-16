const test = require('node:test');
const assert = require('node:assert/strict');
const { allowedHosts, checkRun, scrubToken } = require('../lib/runPolicy');

const snapshot = {
  environments: [
    { name: 'Development', enabled: true, production: false, baseUrl: 'https://dev.example.test' },
    { name: 'Production', enabled: true, production: true, baseUrl: 'https://prod.example.test' },
    { name: 'Old', enabled: false, production: false, baseUrl: 'https://old.example.test' },
  ],
  serviceOverrides: [{ enabled: true, baseUrl: 'https://svc.example.test' }, { enabled: false, baseUrl: 'https://off.example.test' }],
};

const run = (over = {}) => ({
  method: 'GET', url: 'https://dev.example.test/api/items?page=0', headers: {}, body: null,
  environmentName: 'Development', confirmEnvironment: 'Development', confirmWrite: false,
  acceptIncomplete: false, token: 'test-token-value', ...over,
});

test('allow-list has enabled environment and override hosts only', () => {
  const hosts = allowedHosts(snapshot);
  assert.ok(hosts.has('dev.example.test') && hosts.has('prod.example.test') && hosts.has('svc.example.test'));
  assert.ok(!hosts.has('old.example.test') && !hosts.has('off.example.test'));
});

test('a GET to an allowed host with a token and a matching name is allowed', () => {
  const r = checkRun(snapshot, run(), { schemaComplete: true });
  assert.deepEqual(r.problems, []);
  assert.equal(r.production, false);
});

test('a custom request can use a manually configured environment without a catalog', () => {
  const workspace = {
    environments: [{ name: 'My API', enabled: true, production: false, baseUrl: 'https://api.example.test' }],
    serviceOverrides: [],
  };
  const custom = run({
    url: 'https://api.example.test/v1/items',
    environmentName: 'My API',
    confirmEnvironment: 'My API',
    noAuth: true,
    token: '',
  });
  assert.deepEqual(checkRun(workspace, custom).problems, []);
  assert.ok(checkRun(workspace, { ...custom, url: 'https://other.example.test/v1/items' }).problems
    .some((problem) => problem.includes('not an enabled environment')));
});

test('allows http to any host but restricts https to enabled hosts', () => {
  assert.deepEqual(checkRun(snapshot, run({ url: 'http://localhost:3000/x' })).problems, []);
  assert.deepEqual(checkRun(snapshot, run({ url: 'http://other.example.test/x' })).problems, []);
  assert.ok(checkRun(snapshot, run({ url: 'ftp://dev.example.test/x' })).problems.includes('Only http and https addresses can be used.'));
  assert.ok(checkRun(snapshot, run({ url: 'https://u:p@dev.example.test/x' })).problems.some((p) => p.includes('user name')));
  assert.ok(checkRun(snapshot, run({ url: 'https://evil.example.com/x' })).problems.some((p) => p.includes('not an enabled environment')));
  assert.ok(checkRun(snapshot, run({ url: 'not a url' })).problems.includes('The request address is not valid.'));
});

test('when confirmation is required, the exact environment name must be typed back', () => {
  const r = checkRun(snapshot, run({ confirmRequired: true, confirmEnvironment: 'development' }));
  assert.ok(r.problems.some((p) => p.startsWith('Type the environment name exactly')));
  assert.deepEqual(checkRun(snapshot, run({ confirmRequired: true })).problems, []);
});

test('when confirmation is not required, no name is needed, and production is reported', () => {
  const post = run({ method: 'POST', environmentName: 'Production', confirmEnvironment: '', confirmRequired: false });
  const ok = checkRun(snapshot, post);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.production, true);
  assert.ok(checkRun(snapshot, { ...post, confirmRequired: true }).problems.some((p) => p.startsWith('Type the environment name')));
});

test('incomplete contracts need an explicit acceptance', () => {
  assert.ok(checkRun(snapshot, run(), { schemaComplete: false }).problems.some((p) => p.includes('incomplete')));
  assert.deepEqual(checkRun(snapshot, run({ acceptIncomplete: true }), { schemaComplete: false }).problems, []);
});

test('token is required and reserved headers and line breaks are refused', () => {
  assert.ok(checkRun(snapshot, run({ token: '  ' })).problems.includes('Enter the access token for this run.'));
  assert.ok(checkRun(snapshot, run({ headers: { Cookie: 'a=b' } })).problems.includes('Cookie: this header cannot be set here.'));
  assert.ok(checkRun(snapshot, run({ headers: { 'X-A': 'a\r\nb' } })).problems.some((p) => p.includes('line break')));
});

test('scrubToken removes every copy of the token', () => {
  assert.equal(scrubToken('a test-token-value b test-token-value', 'test-token-value'), 'a [token removed] b [token removed]');
  assert.equal(scrubToken('plain', ''), 'plain');
});

test('a custom request with no auth needs no token and may set its own Authorization header', () => {
  const noAuth = run({ noAuth: true, token: '', headers: { Authorization: 'Basic abc' } });
  assert.deepEqual(checkRun(snapshot, noAuth).problems, []);
  assert.ok(checkRun(snapshot, run({ token: '', headers: { Authorization: 'Basic abc' } })).problems.some((p) => p.includes('Authorization')));
  assert.ok(checkRun(snapshot, run({ noAuth: true, headers: { Cookie: 'a=b' } })).problems.some((p) => p.includes('Cookie')));
});
