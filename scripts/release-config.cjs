const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'release.config.json');
const packagePath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');
const config = require(configPath);
const packageJson = require(packagePath);
const lock = require(lockPath);

function template(value) {
  return value.replace(/\$\{(productName|version)\}/g, (_, key) => config[key]);
}

function verify(tag) {
  if (!/^\d+\.\d+\.\d+$/.test(config.version)) {
    throw new Error(`Invalid release version: ${config.version}`);
  }
  if (packageJson.version !== config.version) {
    throw new Error(
      `package.json version ${packageJson.version} does not match release.config.json version ${config.version}. Run npm run release:sync.`
    );
  }
  if (lock.version !== config.version || lock.packages[''].version !== config.version) {
    throw new Error(`package-lock.json does not match release.config.json version ${config.version}. Run npm run release:sync.`);
  }
  if (tag && tag !== `v${config.version}`) {
    throw new Error(`Release tag ${tag} does not match configured version v${config.version}.`);
  }

  const publishedNames = config.artifacts.map(({ published }) => template(published));
  if (new Set(publishedNames).size !== publishedNames.length) {
    throw new Error('Published installer filenames must be unique.');
  }
}

function sync() {
  packageJson.version = config.version;
  lock.version = config.version;
  lock.packages[''].version = config.version;

  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

function label(assetRoot) {
  verify();
  for (const artifact of config.artifacts) {
    const directory = path.join(path.resolve(assetRoot), artifact.directory);
    const source = path.join(directory, template(artifact.source));
    const destination = path.join(directory, template(artifact.published));
    if (!fs.existsSync(source)) {
      throw new Error(`Missing installer artifact: ${source}`);
    }
    fs.renameSync(source, destination);
  }
}

const command = process.argv[2];

try {
  if (command === 'sync') {
    sync();
  } else if (command === 'verify') {
    verify(process.env.RELEASE_TAG);
  } else if (command === 'label') {
    label(process.argv[3] || 'release-assets');
  } else {
    throw new Error('Usage: node scripts/release-config.cjs <sync|verify|label>');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
