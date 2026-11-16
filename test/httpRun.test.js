const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { send } = require('../lib/httpRun');

test('sends HTTP requests to local development servers', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('local response');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const response = await send({
    method: 'GET',
    url: `http://127.0.0.1:${address.port}/health`,
    headers: {},
    body: null,
  });
  assert.equal(response.status, 200);
  assert.equal(response.body, 'local response');
});

test('refuses unsupported request protocols in the transport', async () => {
  await assert.rejects(
    send({ method: 'GET', url: 'ftp://localhost/resource', headers: {}, body: null }),
    /Only http and https requests can be sent/,
  );
});
