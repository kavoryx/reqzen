// Calls the local Ollama model from the main process. Loopback only: the app never sends contract text to another host.
const http = require('http');
const aiRedaction = require('./aiRedaction');

const DEFAULT_URL = 'http://127.0.0.1:11434';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function baseUrl() {
  const u = new URL(process.env.OLLAMA_BASE_URL || DEFAULT_URL);
  if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname)) {
    throw new Error('The local model must be on this computer (localhost).');
  }
  return u;
}

function model() {
  return process.env.OLLAMA_CHAT_MODEL || 'qwen2.5:3b';
}

function request(method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const base = baseUrl();
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: base.hostname,
        port: base.port || 80,
        path,
        method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode > 299) {
            reject(new Error(`The local model returned status ${res.statusCode}.`));
          } else {
            resolve(text);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('The local model did not answer in time.')));
    req.on('error', () => reject(new Error('The local model is not running. Start Ollama and try again.')));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Whether the model server answers, and which model is set. */
async function status() {
  try {
    await request('GET', '/api/tags', undefined, 3000);
    return { available: true, model: model() };
  } catch (e) {
    return { available: false, model: model(), reason: e instanceof Error ? e.message : 'unavailable' };
  }
}

/** One chat turn that must answer with JSON. Returns the model's text. */
async function chatJson(system, user, timeoutMs = 90000) {
  aiRedaction.registerSensitiveValues({ system, user });
  const text = await request('POST', '/api/chat', {
    model: model(),
    stream: false,
    format: 'json',
    options: { temperature: 0 },
    messages: [{ role: 'system', content: aiRedaction.redact(system) }, { role: 'user', content: aiRedaction.redact(user) }],
  }, timeoutMs);
  const data = JSON.parse(text);
  return data && data.message && typeof data.message.content === 'string' ? data.message.content : '';
}

module.exports = { status, chatJson, baseUrl, model };
