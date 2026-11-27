const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, enabled, sanitize } = require('../lib/aiFeatures');

test('AI workflow controls default on and retain explicit decisions', () => {
  assert.deepEqual(sanitize(null), DEFAULTS);
  assert.deepEqual(sanitize({ search: false, requestPlanning: true }), {
    search: false,
    requestPlanning: true,
    documentation: true,
  });
  assert.equal(enabled({ aiFeatures: { requestPlanning: false } }, 'requestPlanning'), false);
  assert.equal(enabled({}, 'search'), true);
});
