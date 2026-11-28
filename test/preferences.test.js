const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const prefs = require('../lib/preferences');

test('unknown values fall back to the defaults', () => {
  assert.deepEqual(prefs.sanitize({ mode: 'neon', palette: 'teal' }), { mode: 'system', palette: 'teal', wrapText: false, columnWidths: null, textScale: 100, shortcuts: prefs.SHORTCUTS, acceptAllIncompleteContracts: false, acceptedIncompleteServices: [], apiSearch: prefs.SEARCH_DEFAULTS });
  assert.deepEqual(prefs.sanitize(null), prefs.DEFAULTS);
});

test('a missing or damaged file loads as the defaults, and a saved choice round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-'));
  const file = path.join(dir, 'preferences.json');
  assert.deepEqual(prefs.load(file), prefs.DEFAULTS);
  fs.writeFileSync(file, '{oops');
  assert.deepEqual(prefs.load(file), prefs.DEFAULTS);
  prefs.save(file, { mode: 'dark', palette: 'violet', textScale: 130 });
  assert.deepEqual(prefs.load(file), { mode: 'dark', palette: 'violet', wrapText: false, columnWidths: null, textScale: 130, shortcuts: prefs.SHORTCUTS, acceptAllIncompleteContracts: false, acceptedIncompleteServices: [], apiSearch: prefs.SEARCH_DEFAULTS });
});

test('text size accepts only supported increments and bounds', () => {
  for (const value of [80, 100, 150]) assert.equal(prefs.sanitize({ textScale: value }).textScale, value);
  for (const value of [70, 160, 105, '120', null]) assert.equal(prefs.sanitize({ textScale: value }).textScale, 100);
});

test('wrap text and column widths are kept only when they are valid', () => {
  assert.equal(prefs.sanitize({ wrapText: true }).wrapText, true);
  assert.equal(prefs.sanitize({ wrapText: 'yes' }).wrapText, false);
  assert.deepEqual(prefs.sanitize({ columnWidths: [120, 400, 200, 260, 90] }).columnWidths, [120, 400, 200, 260, 90]);
  assert.equal(prefs.sanitize({ columnWidths: [120, 400] }).columnWidths, null, 'the wrong number of columns is refused');
  assert.equal(prefs.sanitize({ columnWidths: [120, 5000, 200, 260, 90] }).columnWidths, null, 'a width out of range is refused');
});

test('shortcut and contract approval preferences are sanitized', () => {
  const value = prefs.sanitize({
    shortcuts: { command: 'Ctrl+Shift+P', send: 'Ctrl+Ctrl+Enter', find: 'totally-invalid' },
    acceptAllIncompleteContracts: true,
    acceptedIncompleteServices: ['Orders', '', 'Orders', 3],
  });
  assert.equal(value.shortcuts.command, 'Ctrl+Shift+P');
  assert.equal(value.shortcuts.send, prefs.SHORTCUTS.send);
  assert.equal(value.shortcuts.find, prefs.SHORTCUTS.find);
  assert.equal(value.acceptAllIncompleteContracts, true);
  assert.deepEqual(value.acceptedIncompleteServices, ['Orders']);
});

test('API search settings retain editable guidance and migrate legacy alias groups', () => {
  assert.deepEqual(prefs.sanitize({
    apiSearch: {
      instructions: '  Prefer collection endpoints.\nitem, resource  ',
    },
  }).apiSearch, {
    instructions: '  Prefer collection endpoints.\nitem, resource  ',
  });
  const value = prefs.sanitize({
    apiSearch: {
      enforceIntent: false,
      strictEntity: true,
      distinguishGetAll: false,
      entityGroups: ['  virtual machine, vm, invvm ', '', 4, 'virtual machine, vm, invvm'],
    },
  });
  assert.deepEqual(value.apiSearch, {
    instructions: `${prefs.SEARCH_INSTRUCTIONS}\nvirtual machine, vm, invvm`,
  });
});
