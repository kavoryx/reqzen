const test = require('node:test');
const assert = require('node:assert/strict');
const { nextZoomFactor, zoomAction } = require('../lib/zoomShortcuts');

test('Windows zoom shortcuts recognize plus, minus, numpad, and reset variants', () => {
  assert.equal(zoomAction({ control: true, key: '+' }, 'win32'), 'in');
  assert.equal(zoomAction({ control: true, key: '=' }, 'win32'), 'in');
  assert.equal(zoomAction({ control: true, code: 'NumpadAdd' }, 'win32'), 'in');
  assert.equal(zoomAction({ control: true, key: '-' }, 'win32'), 'out');
  assert.equal(zoomAction({ control: true, code: 'NumpadSubtract' }, 'win32'), 'out');
  assert.equal(zoomAction({ control: true, key: '0' }, 'win32'), 'reset');
  assert.equal(zoomAction({ meta: true, key: '-' }, 'win32'), null);
});

test('macOS uses Command without stealing plain or Alt-modified keys', () => {
  assert.equal(zoomAction({ meta: true, key: '+' }, 'darwin'), 'in');
  assert.equal(zoomAction({ meta: true, key: '-' }, 'darwin'), 'out');
  assert.equal(zoomAction({ control: true, key: '+' }, 'darwin'), null);
  assert.equal(zoomAction({ meta: true, alt: true, key: '-' }, 'darwin'), null);
});

test('zoom stays bounded and reset returns to 100 percent', () => {
  assert.equal(nextZoomFactor(1, 'in'), 1.1);
  assert.equal(nextZoomFactor(1, 'out'), 0.9);
  assert.equal(nextZoomFactor(0.5, 'out'), 0.5);
  assert.equal(nextZoomFactor(3, 'in'), 3);
  assert.equal(nextZoomFactor(1.4, 'reset'), 1);
});
