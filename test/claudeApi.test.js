const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const { EventEmitter } = require('events');
const claudeApi = require('../lib/claudeApi');
const aiRedaction = require('../lib/aiRedaction');

test('Claude receives sanitized prompts while its provider key stays in the auth header', async () => {
  const requestToken = 'claude-request-access-token-39';
  const providerKey = 'claude-provider-key-private-82';
  aiRedaction.registerSecret(requestToken, 1);
  const originalRequest = https.request;
  https.request = (options, callback) => {
    assert.equal(options.hostname, claudeApi.HOST);
    assert.equal(options.headers['x-api-key'], providerKey);
    let payload = '';
    const request = new EventEmitter();
    request.write = (chunk) => { payload += chunk; };
    request.end = (chunk) => {
      if (chunk) payload += chunk;
      const body = JSON.parse(payload);
      const prompt = `${body.system}\n${body.messages[0].content}`;
      assert.doesNotMatch(prompt, /claude-request-access-token-39|claude-provider-key-private-82/);
      const response = new EventEmitter();
      response.statusCode = 200;
      callback(response);
      process.nextTick(() => {
        response.emit('data', Buffer.from(JSON.stringify({ content: [{ text: '{"ok":true}' }] })));
        response.emit('end');
      });
    };
    request.destroy = (error) => request.emit('error', error);
    return request;
  };
  try {
    assert.equal(await claudeApi.chatJson('Keep credentials private.', `Use ${requestToken} and ${providerKey}.`, { key: providerKey }), '{"ok":true}');
  } finally {
    https.request = originalRequest;
  }
});
