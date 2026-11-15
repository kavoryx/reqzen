const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const prefs = require('../lib/preferences');

test('unknown values fall back to the defaults', () => {
  assert.deepEqual(prefs.sanitize({ mode: 'neon', palette: 'teal' }), { mode: 'system', palette: 'teal', wrapText: false, columnWidths: null });
  assert.deepEqual(prefs.sanitize(null), { mode: 'system', palette: 'blue', wrapText: false, columnWidths: null });
});

test('a missing or damaged file loads as the defaults, and a saved choice round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-'));
  const file = path.join(dir, 'preferences.json');
  assert.deepEqual(prefs.load(file), prefs.DEFAULTS);
  fs.writeFileSync(file, '{oops');
  assert.deepEqual(prefs.load(file), prefs.DEFAULTS);
  prefs.save(file, { mode: 'dark', palette: 'violet' });
  assert.deepEqual(prefs.load(file), { mode: 'dark', palette: 'violet', wrapText: false, columnWidths: null });
});

test('wrap text and column widths are kept only when they are valid', () => {
  assert.equal(prefs.sanitize({ wrapText: true }).wrapText, true);
  assert.equal(prefs.sanitize({ wrapText: 'yes' }).wrapText, false);
  assert.deepEqual(prefs.sanitize({ columnWidths: [120, 400, 200, 260, 90] }).columnWidths, [120, 400, 200, 260, 90]);
  assert.equal(prefs.sanitize({ columnWidths: [120, 400] }).columnWidths, null, 'the wrong number of columns is refused');
  assert.equal(prefs.sanitize({ columnWidths: [120, 5000, 200, 260, 90] }).columnWidths, null, 'a width out of range is refused');
});
