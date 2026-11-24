const test = require('node:test');
const assert = require('node:assert/strict');
const aiRedaction = require('../lib/aiRedaction');

test('known credentials are removed even when they appear without a label', () => {
  const secret = 'exact-session-access-token-39';
  aiRedaction.registerSecret(secret);
  const prompt = aiRedaction.redact(`Find the account for ${secret}`);
  assert.doesNotMatch(prompt, /exact-session-access-token-39/);
  assert.match(prompt, /\[REDACTED\]/);
});

test('sensitive values in request structures are remembered for later prompts', () => {
  const apiKey = ['sensitive', 'api', 'key', '73'].join('-');
  aiRedaction.registerSensitiveValues({
    headers: { Authorization: 'Bearer sensitive-header-token-82', 'X-Api-Key': apiKey },
    variables: [{ name: 'refreshToken', value: 'sensitive-variable-token-64' }],
  });
  const prompt = aiRedaction.redact('Question: sensitive-header-token-82 sensitive-api-key-73 sensitive-variable-token-64');
  assert.doesNotMatch(prompt, /sensitive-header-token-82|sensitive-api-key-73|sensitive-variable-token-64/);
});

test('short values explicitly marked as tokens are also redacted', () => {
  aiRedaction.registerSensitiveValues({ token: 'q9' });
  assert.equal(aiRedaction.redact('q9'), '[REDACTED]');
});

test('common bearer, key-value, JWT, and provider token formats are redacted', () => {
  const jwt = [
    'eyJhbGciOiJIUzI1NiJ9',
    'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    'signed-token-value',
  ].join('.');
  const prompt = aiRedaction.redact([
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz.123456',
    'api_key = "private-key-value"',
    'api_token: compact-token-value',
    jwt,
    'gsk_12345678901234567890123456789012',
  ].join('\n'));
  assert.doesNotMatch(prompt, /abcdefghijklmnopqrstuvwxyz|private-key-value|compact-token-value|signed-token-value|gsk_1234567890/);
  assert.match(prompt, /\[REDACTED\]/);
});
