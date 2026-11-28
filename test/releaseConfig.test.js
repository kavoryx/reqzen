const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const packageJson = require('../package.json');
const config = require('../release.config.json');
const builderConfig = require('../electron-builder.config.cjs');

function template(value) {
  return value
    .replaceAll('${productName}', config.productName)
    .replaceAll('${version}', config.version);
}

test('release version and installer build settings use the shared config', () => {
  assert.equal(packageJson.version, config.version);
  assert.equal(builderConfig.productName, config.productName);
  assert.equal(builderConfig.extraMetadata.version, config.version);
  assert.equal(builderConfig.appId, config.installer.appId);
  assert.equal(builderConfig.artifactName, config.installer.artifactName);
});

test('installer artifacts are renamed with configured release filenames', (t) => {
  const assetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reqzen-release-'));
  t.after(() => fs.rmSync(assetRoot, { recursive: true, force: true }));

  for (const artifact of config.artifacts) {
    const directory = path.join(assetRoot, artifact.directory);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, template(artifact.source)), '');
  }

  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'release-config.cjs'), 'label', assetRoot],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);

  for (const artifact of config.artifacts) {
    const directory = path.join(assetRoot, artifact.directory);
    assert.equal(fs.existsSync(path.join(directory, template(artifact.source))), false);
    assert.equal(fs.existsSync(path.join(directory, template(artifact.published))), true);
  }
});
