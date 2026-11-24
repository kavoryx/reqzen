// The only bridge between the page and Electron. It exposes a few functions: open a snapshot file, send one checked request, and ask the local model for help.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux',
  openSnapshot: (options) => ipcRenderer.invoke('snapshot:open', options),
  listSnapshots: () => ipcRenderer.invoke('snapshot:list'),
  selectSnapshot: (id) => ipcRenderer.invoke('snapshot:select', { id }),
  removeSnapshot: (id) => ipcRenderer.invoke('snapshot:remove', { id }),
  saveSnapshotCustomFields: (input) => ipcRenderer.invoke('snapshot:saveCustomFields', input),
  lastSnapshot: () => ipcRenderer.invoke('snapshot:last'),
  runRequest: (run) => ipcRenderer.invoke('request:run', run),
  modelStatus: () => ipcRenderer.invoke('model:status'),
  listModels: () => ipcRenderer.invoke('model:list'),
  onModelSettingsChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('model:settings-changed', handler);
    return () => ipcRenderer.removeListener('model:settings-changed', handler);
  },
  askAgents: (input) => ipcRenderer.invoke('agent:search', input),
  fillFromDescription: (input) => ipcRenderer.invoke('assist:plan', input),
  listEnvironments: () => ipcRenderer.invoke('env:list'),
  saveEnvironment: (input) => ipcRenderer.invoke('env:save', input),
  deleteEnvironment: (id) => ipcRenderer.invoke('env:delete', id),
  saveEnvironmentOverride: (input) => ipcRenderer.invoke('env:overrideSave', input),
  resetEnvironmentOverride: (id) => ipcRenderer.invoke('env:overrideReset', id),
  hideEnvironment: (id) => ipcRenderer.invoke('env:hide', id),
  listVariables: () => ipcRenderer.invoke('variables:list'),
  saveVariable: (input) => ipcRenderer.invoke('variables:save', input),
  deleteVariable: (id) => ipcRenderer.invoke('variables:delete', id),
  listPayloads: () => ipcRenderer.invoke('payloads:list'),
  savePayload: (input) => ipcRenderer.invoke('payloads:save', input),
  getLibrary: () => ipcRenderer.invoke('library:get'),
  saveLibrary: (library) => ipcRenderer.invoke('library:save', { library }),
  exportCollection: (input) => ipcRenderer.invoke('library:export', input),
  importCollection: () => ipcRenderer.invoke('library:import'),
  listTokenTypes: () => ipcRenderer.invoke('tokenTypes:list'),
  listConfirmations: () => ipcRenderer.invoke('confirmations:list'),
  scanGitHub: (input) => ipcRenderer.invoke('github:scan', input),
  getScanRules: () => ipcRenderer.invoke('scanRules:get'),
  listKeptClones: () => ipcRenderer.invoke('github:listClones'),
  deleteKeptClone: (input) => ipcRenderer.invoke('github:deleteClone', input),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  exportCatalog: (input) => ipcRenderer.invoke('catalog:export', input),
  findLocalProjects: (input) => ipcRenderer.invoke('projects:findLocal', input),
  findGitHubProjects: (input) => ipcRenderer.invoke('projects:findGitHub', input),
  getDocs: () => ipcRenderer.invoke('docs:get'),
  saveDocSettings: (input) => ipcRenderer.invoke('docs:settings', input),
  getDocJob: () => ipcRenderer.invoke('docs:job'),
  stopDocJob: () => ipcRenderer.invoke('docs:jobStop'),
  setDocKey: (input) => ipcRenderer.invoke('docs:key', input),
  generateDocs: (input) => ipcRenderer.invoke('docs:generate', input),
  generateOverview: (input) => ipcRenderer.invoke('docs:overview', input),
  saveScanRules: (input) => ipcRenderer.invoke('scanRules:save', input),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  setWindowAppearance: (mode) => ipcRenderer.invoke('window:appearance', mode),
  setTextScale: (scale) => ipcRenderer.invoke('window:text-scale', scale),
  onCloseRequest: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('window:close-request', handler);
    return () => ipcRenderer.removeListener('window:close-request', handler);
  },
  onSettingsOpen: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('settings:open', handler);
    return () => ipcRenderer.removeListener('settings:open', handler);
  },
  findInPage: (input) => ipcRenderer.invoke('find:run', input),
  stopFind: () => ipcRenderer.invoke('find:stop'),
  onFindOpen: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('find:open', handler);
    return () => ipcRenderer.removeListener('find:open', handler);
  },
  onFindResult: (callback) => {
    const handler = (_event, result) => callback(result);
    ipcRenderer.on('find:result', handler);
    return () => ipcRenderer.removeListener('find:result', handler);
  },
  saveConfirmations: (input) => ipcRenderer.invoke('confirmations:save', input),
  confirmationRequired: (input) => ipcRenderer.invoke('confirmations:required', input),
  saveTokenType: (input) => ipcRenderer.invoke('tokenTypes:save', input),
  exportWorkspace: (input) => ipcRenderer.invoke('workspace:export', input),
  importWorkspace: () => ipcRenderer.invoke('workspace:import'),
  fetchToken: (input) => ipcRenderer.invoke('token:fetch', input),
  getPreferences: () => ipcRenderer.invoke('preferences:get'),
  savePreferences: (preferences) => ipcRenderer.invoke('preferences:save', { preferences }),
  listCustomRequests: () => ipcRenderer.invoke('customRequests:list'),
  saveCustomRequest: (input) => ipcRenderer.invoke('customRequests:save', input),
  deleteCustomRequest: (id) => ipcRenderer.invoke('customRequests:delete', id),
});
