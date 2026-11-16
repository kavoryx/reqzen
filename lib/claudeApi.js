// Calls the Claude API from the main process. The key is given per call and is never
// logged, saved or returned. Error messages never include the key or the response body.
const https = require('https');
const aiRedaction = require('./aiRedaction');

const HOST = 'api.anthropic.com';
const DEFAULT_MODEL = 'claude-haiku-5-5';

function chatJson(system, user, { key, model, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!key) {
      reject(new Error('No Claude API key is set.'));
      return;
    }
    aiRedaction.registerSecret(key, 1);
    const body = JSON.stringify({
      model: model || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
      max_tokens: 2048,
      system: aiRedaction.redact(system),
      messages: [{ role: 'user', content: aiRedaction.redact(user) }],
    });
    const req = https.request({
      protocol: 'https:',
      hostname: HOST,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`The Claude API answered HTTP ${res.statusCode}.`));
          return;
        }
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const text = Array.isArray(data.content) ? data.content.map((b) => b.text || '').join('') : '';
          resolve(text);
        } catch {
          reject(new Error('The Claude API answer could not be read.'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('The Claude API did not answer in time.')));
    req.on('error', () => reject(new Error('The Claude API could not be reached.')));
    req.end(body);
  });
}

module.exports = { chatJson, HOST, DEFAULT_MODEL };
