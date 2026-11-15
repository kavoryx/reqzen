const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const payloads = require('../lib/payloads');

test('accepts valid JSON and refuses text that is not JSON or is too large', () => {
  assert.deepEqual(payloads.validate('{"name":"Ada"}').problems, []);
  assert.deepEqual(payloads.validate('{name: Ada').problems, ['The payload is not valid JSON.']);
  assert.ok(payloads.validate('"x'.repeat(payloads.MAX_BYTES)).problems.includes('The payload is larger than 200 KB.'));
});

test('a missing or damaged file loads as an empty map, and saved payloads round-trip without empty entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payloads-'));
  const file = path.join(dir, 'payloads.json');
  assert.deepEqual(payloads.load(file), {});
  fs.writeFileSync(file, '[1]');
  assert.deepEqual(payloads.load(file), {});
  payloads.save(file, { op1: '{"a":1}', op2: '   ', op3: 7 });
  assert.deepEqual(payloads.load(file), { op1: '{"a":1}' });
});
