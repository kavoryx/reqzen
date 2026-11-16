const secrets = new Set();
const MAX_REGISTERED_SECRETS = 4096;
const SENSITIVE_NAME = /token|secret|password|passwd|apikey|privatekey|signingkey|encryptionkey|clientkey|providerkey|groqkey|openaikey|claudekey|authorization|cookie|credential|^auth|^basic|^key$/;
const SECRET_FIELD = /(["']?(?:(?:access|refresh|id|api|auth|session|oauth|client|x[_-]?auth)[_-]?token|token|authorization|x[_-]?api[_-]?key|api[_-]?key|client[_-]?secret|private[_-]?key|secret|password|passwd|cookie|credential)["']?\s*[:=]\s*["']?)([^"'&\s,}]+)/gi;
const AUTH_VALUE = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]+=*/gi;
const KNOWN_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|hf_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})\b/g;

function registerSecret(value, minLength = 4) {
  if (typeof value !== 'string') return;
  const secret = value.trim();
  if (secret.length >= minLength && secret.length <= 8192) {
    secrets.add(secret);
    if (secrets.size > MAX_REGISTERED_SECRETS) secrets.delete(secrets.values().next().value);
  }
}

function registerFromText(text) {
  const source = String(text);
  for (const match of source.matchAll(SECRET_FIELD)) registerSecret(match[2], 1);
  for (const match of source.matchAll(AUTH_VALUE)) {
    const space = match[0].indexOf(' ');
    registerSecret(match[0].slice(space + 1), 1);
  }
  for (const match of source.matchAll(KNOWN_TOKEN)) registerSecret(match[0]);
}

function sensitiveName(name) {
  return SENSITIVE_NAME.test(String(name).toLowerCase().replace(/[^a-z0-9]/g, ''));
}

function registerSensitiveValues(value, key = '') {
  if (Array.isArray(value)) {
    for (const item of value) registerSensitiveValues(item);
    return;
  }
  if (value && typeof value === 'object') {
    if (typeof value.name === 'string' && sensitiveName(value.name) && typeof value.value === 'string') {
      registerSecret(value.value, 1);
    }
    for (const [name, item] of Object.entries(value)) registerSensitiveValues(item, name);
    return;
  }
  if (typeof value !== 'string') return;
  if (sensitiveName(key)) registerSecret(value, 1);
  registerFromText(value);
  if (key === 'body') {
    try {
      registerSensitiveValues(JSON.parse(value));
    } catch {
      // Form-encoded and free-text bodies are still covered by the patterns above.
    }
  }
}

function redact(text) {
  let output = String(text ?? '');
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    output = output.split(secret).join('[REDACTED]');
  }
  return output
    .replace(AUTH_VALUE, '[REDACTED]')
    .replace(SECRET_FIELD, '$1[REDACTED]')
    .replace(KNOWN_TOKEN, '[REDACTED]');
}

module.exports = { registerSecret, registerSensitiveValues, redact };
