const http = require('http');
const https = require('https');
const aiRedaction = require('./aiRedaction');

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';
const DEFAULT_MODEL = 'qwen2.5:3b';
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const GROQ_DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_RESPONSE_BYTES = 1024 * 1024;

function connection(input = {}) {
  const baseUrl = typeof input.baseUrl === 'string' && input.baseUrl.trim()
    ? input.baseUrl.trim().slice(0, 300)
    : DEFAULT_BASE_URL;
  const model = typeof input.model === 'string' && input.model.trim()
    ? input.model.trim().slice(0, 160)
    : DEFAULT_MODEL;
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new Error('Use HTTPS for remote AI servers. HTTP is allowed only for a server on this computer.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The AI server address must not contain credentials, a query, or a fragment.');
  }
  return { baseUrl: url.toString().replace(/\/+$/, ''), model };
}

function endpoint(baseUrl, path) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${path}`;
  return url;
}

function request(url, method, body, key, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const transport = url.protocol === 'https:' ? https : http;
    const headers = payload
      ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
      : {};
    if (key) headers.authorization = `Bearer ${key}`;
    const req = transport.request(url, {
      method,
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          res.destroy();
          reject(new Error('The AI server response was too large.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode > 299) {
          reject(new Error(`The AI server returned HTTP ${res.statusCode}. Check the server address, model, and API key.`));
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => reject(new Error('The AI server could not be reached. Check the address and connection.')));
    if (payload) req.write(payload);
    req.end();
  });
}

function parseResponse(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('The AI server returned an unreadable response.');
  }
}

async function listModels(input = {}) {
  const settings = connection(input);
  const text = await request(endpoint(settings.baseUrl, 'models'), 'GET', undefined, input.key, 10000);
  const data = parseResponse(text);
  const models = Array.isArray(data.data) ? data.data : [];
  return [...new Set(models
    .map((item) => item && typeof item.id === 'string' ? item.id.trim() : '')
    .filter((id) => id !== '')
    .map((id) => id.slice(0, 160)))];
}

async function status(input = {}) {
  try {
    const settings = connection(input);
    const models = await listModels({ ...settings, key: input.key });
    if (models.length > 0 && !models.includes(settings.model)) {
      return {
        available: false,
        model: settings.model,
        models,
        reason: `The configured model "${settings.model}" was not listed by the AI server.`,
      };
    }
    return { available: true, model: settings.model, models };
  } catch (e) {
    const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim().slice(0, 160) : DEFAULT_MODEL;
    return { available: false, model, reason: e instanceof Error ? e.message : 'The AI server is unavailable.' };
  }
}

async function chatJson(system, user, input = {}, timeoutMs = 90000) {
  const settings = connection(input);
  aiRedaction.registerSecret(input.key, 1);
  const text = await request(endpoint(settings.baseUrl, 'chat/completions'), 'POST', {
    model: settings.model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: aiRedaction.redact(system) }, { role: 'user', content: aiRedaction.redact(user) }],
  }, input.key, timeoutMs);
  const data = parseResponse(text);
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('The AI server did not return a message.');
  }
  return content;
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  GROQ_BASE_URL,
  GROQ_DEFAULT_MODEL,
  connection,
  listModels,
  status,
  chatJson,
};
