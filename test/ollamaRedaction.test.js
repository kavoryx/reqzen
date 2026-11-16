const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const ollama = require('../lib/ollama');
const aiRedaction = require('../lib/aiRedaction');

test('Ollama receives prompts with registered credentials removed', async () => {
  const secret = 'ollama-request-access-token-47';
  const previousUrl = process.env.OLLAMA_BASE_URL;
  const previousModel = process.env.OLLAMA_CHAT_MODEL;
  aiRedaction.registerSecret(secret, 1);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(req.url, '/api/chat');
      assert.doesNotMatch(body.messages.map((message) => message.content).join('\n'), /ollama-request-access-token-47/);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: { content: '{"ok":true}' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.OLLAMA_CHAT_MODEL = 'local-test';
  try {
    assert.equal(await ollama.chatJson('Keep credentials private.', `Use ${secret}.`), '{"ok":true}');
  } finally {
    if (previousUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previousUrl;
    if (previousModel === undefined) delete process.env.OLLAMA_CHAT_MODEL;
    else process.env.OLLAMA_CHAT_MODEL = previousModel;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
