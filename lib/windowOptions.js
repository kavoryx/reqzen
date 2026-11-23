function platformWindowOptions(platform, dark) {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 14 },
    };
  }
  if (platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: dark ? '#171B22' : '#F6F7F9',
        symbolColor: dark ? '#A3ADBD' : '#526071',
        height: 48,
      },
      backgroundMaterial: 'mica',
      autoHideMenuBar: true,
    };
  }
  return {};
}

module.exports = { platformWindowOptions };
