const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

test('snapshot sharing imports without overwriting and preserves custom edits across a restart', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqzen-share-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.json');
  const exported = path.join(dir, 'shared.json');
  const snapshot = {
    format: 'api-explorer-snapshot', formatVersion: 1,
    services: [{ serviceId: 's1', name: 'Reports' }],
    environments: [{ environmentId: 'e1', name: 'Dev', baseUrl: 'https://dev.example', enabled: true }],
    operations: [{ operationId: 'op1', revisionId: 'rev1', serviceId: 's1', serviceName: 'Reports', httpMethod: 'GET', pathTemplate: '/reports' }],
    tokenTypes: [{ name: 'Client', mode: 'request', url: 'https://auth.example/token' }],
    variables: [{ name: 'product', value: 'imported', byEnvironment: { e1: 'dev-value' } }, { name: 'team', value: '', byEnvironment: { e1: 'dev-team' } }],
  };
  fs.writeFileSync(source, JSON.stringify(snapshot));
  const userData = path.join(dir, 'API Explorer');
  fs.mkdirSync(userData);
  fs.writeFileSync(path.join(userData, 'variables.json'), JSON.stringify([{ id: 'existing', name: 'product', value: 'original', byEnvironment: {} }]));
  fs.writeFileSync(path.join(userData, 'token-sources.json'), JSON.stringify({ version: 3, types: [{ id: 'existing', name: 'Client', mode: 'request', url: 'https://auth.example/original' }] }));

  let importFile = source;
  async function start(dataRoot = dir) {
    const handlers = {};
    let loadedFile;
    let menuTemplate;
    let appData = dataRoot;
    const app = {
      getPath: (name) => name === 'userData' ? appData : dataRoot,
      setPath: (_name, value) => { appData = value; },
      whenReady: () => Promise.resolve(),
      on: () => {},
    };
    class Window {
      constructor() { this.webContents = { on: () => {} }; }
      loadFile(file) { loadedFile = file; return Promise.resolve(); }
      static fromWebContents(sender) { return sender.window || null; }
    }
    const electron = {
      app, BrowserWindow: Window,
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [importFile] }), showSaveDialog: async () => ({ canceled: false, filePath: exported }) },
      ipcMain: { handle: (name, handler) => { handlers[name] = handler; }, on: () => {} },
      Menu: { buildFromTemplate: (template) => { menuTemplate = template; return {}; }, setApplicationMenu: () => {} },
      nativeTheme: { on: () => {}, shouldUseDarkColors: false },
      session: { defaultSession: { webRequest: { onHeadersReceived: () => {} } } },
    };
    const originalLoad = Module._load;
    Module._load = function (request, ...args) {
      return request === 'electron' ? electron : originalLoad.call(this, request, ...args);
    };
    try {
      delete require.cache[require.resolve('../main')];
      require('../main');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(loadedFile, path.join(__dirname, '..', 'app', 'renderer', 'index.html'));
      const viewMenu = menuTemplate.find((item) => item.label === 'View');
      assert.ok(viewMenu.submenu.some((item) => item.role === 'reload'));
      assert.ok(viewMenu.submenu.some((item) => item.role === 'zoomIn'));
      assert.ok(!viewMenu.submenu.some((item) => /workspace/i.test(item.label || '')));
    } finally {
      Module._load = originalLoad;
    }
    return handlers;
  }

  let ipc = await start();
  const event = { sender: {} };
  let appliedScale;
  const windowEvent = { sender: { window: { isDestroyed: () => false, webContents: { setZoomFactor: (scale) => { appliedScale = scale; } } } } };
  assert.equal(ipc['window:text-scale'](windowEvent, 150).ok, true);
  assert.equal(appliedScale, 1.5);
  assert.equal(ipc['window:text-scale'](windowEvent, 155).ok, false);
  assert.equal(appliedScale, 1.5);
  assert.equal(ipc['window:text-scale'](event, 100).ok, false);
  const opened = await ipc['snapshot:open'](event);
  assert.equal(opened.skipped.length, 2);
  const savedVariables = JSON.parse(fs.readFileSync(path.join(userData, 'variables.json')));
  assert.equal(savedVariables[0].value, 'original');
  const teamId = savedVariables.find((variable) => variable.name === 'team').id;
  const definitions = [{ key: 'owner', label: 'Owner', visible: true }];
  const saved = ipc['snapshot:saveCustomFields'](event, { definitions, values: { op1: { owner: 'Platform' } } });
  assert.equal(saved.ok, true);

  ipc = await start();
  const restored = ipc['snapshot:last']();
  assert.equal(JSON.parse(restored.text).operations[0].customFields.owner, 'Platform');
  const selected = ipc['snapshot:select'](event, { id: opened.id });
  assert.equal(JSON.parse(selected.snapshot.text).operations[0].customFields.owner, 'Platform');
  const result = await ipc['catalog:export'](event, { share: true, format: 'json', services: ['s1'], environments: ['e1'], tokenTypes: ['existing'], variables: [teamId], includeVariableValues: true });
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(exported)).operations[0].customFields.owner, 'Platform');
  const reopened = await ipc['snapshot:open'](event);
  assert.equal(JSON.parse(reopened.text).operations[0].customFields.owner, 'Platform');

  const recipient = path.join(dir, 'recipient');
  fs.mkdirSync(recipient);
  importFile = exported;
  ipc = await start(recipient);
  const received = await ipc['snapshot:open'](event);
  assert.deepEqual(received.skipped, []);
  const recipientData = path.join(recipient, 'API Explorer');
  const importedVariables = JSON.parse(fs.readFileSync(path.join(recipientData, 'variables.json')));
  assert.equal(importedVariables[0].byEnvironment.e1, 'dev-team');
  const importedTypes = JSON.parse(fs.readFileSync(path.join(recipientData, 'token-sources.json')));
  assert.equal(importedTypes.types[0].url, 'https://auth.example/original');
  assert.equal(JSON.parse(received.text).operations[0].customFields.owner, 'Platform');
});
