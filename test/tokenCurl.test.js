const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = import('../ui/src/tokenCurl.mjs');

test('imports a token curl with Basic credentials, form fields and a nested token endpoint', async () => {
  const { parseTokenCurl } = await helpers;
  const result = parseTokenCurl("curl 'https://auth.example.test/token' -u 'client:sëcret' --data-urlencode 'scope=read write' -d 'grant_type=client_credentials'");
  assert.equal(result.method, 'POST');
  assert.equal(result.url, 'https://auth.example.test/token');
  assert.equal(result.body, 'scope=read%20write&grant_type=client_credentials');
  assert.equal(result.contentType, 'form');
  assert.equal(result.basic, `Basic ${Buffer.from('client:sëcret').toString('base64')}`);
  assert.equal(result.auth, 'basic');
});

test('round-trips JSON, quotes, headers and Basic authentication', async () => {
  const { parseTokenCurl, tokenCurl } = await helpers;
  const original = {
    method: 'POST', url: 'https://auth.example.test/token', headers: 'X-Tenant: team',
    body: '{"name":"O\'Brien"}', contentType: 'json', auth: 'basic', basic: 'Basic Y2xpZW50OnNlY3JldA==',
  };
  const parsed = parseTokenCurl(tokenCurl(original));
  assert.equal(parsed.body, original.body);
  assert.equal(parsed.basic, original.basic);
  assert.equal(parsed.headers, 'X-Tenant: team\nContent-Type: application/json');
  assert.equal(parsed.contentType, 'json');
});

test('Bearer credentials are not imported, and unsupported shell and curl features are rejected', async () => {
  const { parseTokenCurl } = await helpers;
  const result = parseTokenCurl("curl 'https://auth.example.test/token' -H 'Authorization: Bearer secret'");
  assert.equal(result.auth, 'bearer');
  assert.equal(result.headers, '');
  assert.equal(result.droppedBearer, true);
  for (const command of [
    "curl 'https://auth.example.test/token' --data @secret.txt",
    "curl 'https://auth.example.test/token' --json '{}' --json '{}'",
    'curl "https://auth.example.test/$TOKEN"',
    "curl 'https://auth.example.test/token' | other",
    "curl 'https://auth.example.test/token",
  ]) assert.throws(() => parseTokenCurl(command));
});

test('imports common browser curl options and shell continuations', async () => {
  const { parseTokenCurl } = await helpers;
  const result = parseTokenCurl('curl.exe --location --request=POST `\r\n  --header="Content-Type: application/x-www-form-urlencoded" `\r\n  --data-urlencode="scope=read write" `\r\n  --url=https://auth.example.test/token -k');
  assert.equal(result.method, 'POST');
  assert.equal(result.url, 'https://auth.example.test/token');
  assert.equal(result.headers, 'Content-Type: application/x-www-form-urlencoded');
  assert.equal(result.body, 'scope=read%20write');
  assert.equal(result.contentType, 'form');
  assert.equal(result.securityWarning, true);
});

test('copied empty-body requests retain their explicit method and content type', async () => {
  const { parseTokenCurl, tokenCurl } = await helpers;
  const command = tokenCurl({ method: 'GET', url: 'https://auth.example.test/token', headers: '', body: '', contentType: 'json', auth: 'none', basic: '' });
  const parsed = parseTokenCurl(command);
  assert.equal(parsed.method, 'GET');
  assert.equal(parsed.headers, 'Content-Type: application/json');
  assert.equal(parsed.body, '');
});
