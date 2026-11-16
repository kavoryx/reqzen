const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const compatible = require('../lib/openaiCompatible');
const aiRedaction = require('../lib/aiRedaction');

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('connection defaults to Ollama-compatible local settings and rejects insecure remote URLs', () => {
  assert.deepEqual(compatible.connection(), {
    baseUrl: compatible.DEFAULT_BASE_URL,
    model: compatible.DEFAULT_MODEL,
  });
  assert.equal(compatible.connection({ baseUrl: 'https://api.groq.com/openai/v1' }).baseUrl, compatible.GROQ_BASE_URL);
  assert.throws(() => compatible.connection({ baseUrl: 'http://example.com/v1' }), /HTTPS for remote/);
  assert.throws(() => compatible.connection({ baseUrl: 'https://user:pass@example.com/v1' }), /must not contain credentials/);
  assert.throws(() => compatible.connection({ baseUrl: 'https://example.com/v1?key=value' }), /must not contain credentials/);
});

test('chat completion uses the configured model, JSON mode and session API key', async () => {
  await withServer((req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer session-key');
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.model, 'local-coder');
      assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.deepEqual(body.messages, [
        { role: 'system', content: 'Return JSON.' },
        { role: 'user', content: 'Describe this API.' },
      ]);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"description":"A valid description."}' } }] }));
    });
  }, async (baseUrl) => {
    const result = await compatible.chatJson('Return JSON.', 'Describe this API.', {
      baseUrl,
      model: 'local-coder',
      key: 'session-key',
    });
    assert.equal(result, '{"description":"A valid description."}');
  });
});

test('chat completion redacts registered request credentials and the provider key', async () => {
  const requestToken = 'request-credential-for-prompt-91';
  const providerKey = 'provider-credential-for-header-82';
  aiRedaction.registerSecret(requestToken, 1);
  await withServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const prompt = body.messages.map((message) => message.content).join('\n');
      assert.doesNotMatch(prompt, /request-credential-for-prompt-91|provider-credential-for-header-82/);
      assert.equal(req.headers.authorization, `Bearer ${providerKey}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
    });
  }, async (baseUrl) => {
    await compatible.chatJson('Keep credentials private.', `Use ${requestToken} and ${providerKey}.`, {
      baseUrl,
      model: 'local-coder',
      key: providerKey,
    });
  });
});

test('model discovery reads compatible model ids', async () => {
  await withServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/v1/models');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }, { name: 'ignored' }, { id: 'model-a' }] }));
  }, async (baseUrl) => {
    assert.deepEqual(await compatible.listModels({ baseUrl }), ['model-a', 'model-b']);
    assert.deepEqual(await compatible.status({ baseUrl, model: 'model-a' }), {
      available: true,
      model: 'model-a',
      models: ['model-a', 'model-b'],
    });
    const unavailable = await compatible.status({ baseUrl, model: 'missing-model' });
    assert.equal(unavailable.available, false);
    assert.match(unavailable.reason, /was not listed/);
  });
});

test('server errors do not expose the API key', async () => {
  await withServer((_req, res) => {
    res.writeHead(401);
    res.end('secret details');
  }, async (baseUrl) => {
    await assert.rejects(
      compatible.listModels({ baseUrl, key: 'never-show-this' }),
      (error) => {
        assert.match(error.message, /HTTP 401/);
        assert.doesNotMatch(error.message, /never-show-this|secret details/);
        return true;
      },
    );
  });
});
