const release = require('./release.config.json');

module.exports = {
  ...release.installer,
  productName: release.productName,
  extraMetadata: {
    version: release.version
  }
};
