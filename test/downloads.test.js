const test = require('node:test');
const assert = require('node:assert/strict');
const downloadHelpers = import('../website/downloads.mjs');

test('installer assets are mapped to their OS and processor, including legacy names', async () => {
  const { targetForAsset } = await downloadHelpers;
  assert.equal(targetForAsset('Reqnara-0.2.2-x64.exe'), 'windows');
  assert.equal(targetForAsset('Reqnara-0.2.2-arm64.dmg'), 'macos-arm64');
  assert.equal(targetForAsset('Reqnara-0.2.2-x64.dmg'), 'macos-x64');
  assert.equal(targetForAsset('Reqnara-Windows-0.2.3-x64.exe'), 'windows');
  assert.equal(targetForAsset('Reqnara-macOS-Apple-Silicon-0.2.3-arm64.dmg'), 'macos-arm64');
  assert.equal(targetForAsset('Reqnara-macOS-Intel-0.2.3-x64.dmg'), 'macos-x64');
});

test('unsupported or ambiguous installer assets are not offered as downloads', async () => {
  const { indexAssets, targetForAsset } = await downloadHelpers;
  assert.equal(targetForAsset('Reqnara-Linux-0.2.3-x64.AppImage'), null);
  assert.equal(targetForAsset('Reqnara-Windows-0.2.3-arm64.exe'), null);
  assert.equal(targetForAsset(null), null);

  const assets = indexAssets([
    { name: 'Reqnara-Windows-0.2.3-x64.exe' },
    { name: 'Reqnara-Windows-0.2.3-x64-alt.exe' },
    { name: 'Reqnara-macOS-Apple-Silicon-0.2.3-arm64.dmg' }
  ]);
  assert.equal(assets.windows, null);
  assert.equal(assets['macos-arm64'].name, 'Reqnara-macOS-Apple-Silicon-0.2.3-arm64.dmg');
  assert.equal(assets['macos-x64'], undefined);
});
