const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const ollama = require('../lib/ollama');

test('local model discovery returns installed Ollama models', async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/api/tags');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'qwen2.5:3b' }, { name: 'llama3.2:latest' }, { name: 'qwen2.5:3b' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    assert.deepEqual(await ollama.listModels({ baseUrl: `http://127.0.0.1:${port}` }), ['llama3.2:latest', 'qwen2.5:3b']);
    ollama.configure({ baseUrl: `http://127.0.0.1:${port}`, model: 'llama3.2:latest' });
    assert.deepEqual(await ollama.status(), {
      available: true,
      model: 'llama3.2:latest',
      models: ['llama3.2:latest', 'qwen2.5:3b'],
    });
  } finally {
    ollama.configure({ baseUrl: '', model: '' });
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
