const test = require('node:test');
const assert = require('node:assert/strict');
const { platformWindowOptions } = require('../lib/windowOptions');

test('macOS uses inset native traffic lights', () => {
  assert.deepEqual(platformWindowOptions('darwin', false), {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
  });
});

test('Windows uses a theme-matched overlay and Mica with its menu hidden', () => {
  assert.deepEqual(platformWindowOptions('win32', false), {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#F6F7F9', symbolColor: '#526071', height: 48 },
    backgroundMaterial: 'mica',
    autoHideMenuBar: true,
  });
  assert.equal(platformWindowOptions('win32', true).titleBarOverlay.color, '#171B22');
});

test('other platforms keep Electron native window chrome', () => {
  assert.deepEqual(platformWindowOptions('linux', false), {});
});
