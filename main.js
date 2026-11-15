// Electron main process. It owns the file dialog, file reading, and the only network calls the app makes:
// one checked request at a time, to hosts listed in configured environments (see lib/runPolicy.js).
const { app, BrowserWindow, dialog, ipcMain, Menu, session } = require('electron');

// Keep the data folder that earlier versions used, so saved environments and the last snapshot survive the rename.
app.setPath('userData', require('path').join(app.getPath('appData'), 'API Explorer'));
const fs = require('fs');
const path = require('path');
const { checkRun, scrubToken } = require('./lib/runPolicy');
const { send } = require('./lib/httpRun');
const confirmations = require('./lib/confirmations');
const githubScan = require('./lib/githubScan');
const scanRules = require('./lib/scanRules');
const gitClone = require('./lib/gitClone');
const localScan = require('./lib/localScan');
const projectFinder = require('./lib/projectFinder');
const catalogExport = require('./lib/catalogExport');
const ollama = require('./lib/ollama');
const assist = require('./lib/assist');
const docAgent = require('./lib/docAgent');
const { runDocumentation, needsDescription: docJobNeeds } = require('./lib/docJob');
const claudeApi = require('./lib/claudeApi');
const agents = require('./lib/agents');
const environments = require('./lib/environments');
const variables = require('./lib/variables');
const payloads = require('./lib/payloads');
const library = require('./lib/library');
const tokenFetch = require('./lib/tokenFetch');
const tokenTypes = require('./lib/tokenTypes');
const customRequests = require('./lib/customRequests');
const preferences = require('./lib/preferences');

// The user's own environments, kept in the app's data folder on this computer. Set once the app is ready.
let envFile = null;
let overridesFile = null;
let hiddenFile = null;
let variablesFile = null;
let payloadsFile = null;
let libraryFile = null;
let customFile = null;
let preferencesFile = null;
const savedCustomRequests = () => (customFile ? customRequests.load(customFile) : []);
let tokenSourcesFile = null;
let confirmationsFile = null;
let githubCacheDir = null;
let scanRulesFile = null;
let docsFile = null;
let githubClonesDir = null;
let docSettingsFile = null;
let claudeKey = ''; // held in memory for this session only; never saved
const savedLibrary = () => (libraryFile ? library.load(libraryFile) : library.sanitizeStore({}));
const savedPayloads = () => (payloadsFile ? payloads.load(payloadsFile) : {});
// Shared variables such as orgId, kept on this computer.
const savedVariables = () => (variablesFile ? variables.load(variablesFile) : []);
const knownEnvironmentIds = () => currentView().environments.map((e) => e.environmentId);
const yourEnvironments = () => (envFile ? environments.load(envFile) : []);
// Address overrides for built-in (snapshot) environments, keyed by environment id.
const overrides = () => (overridesFile ? environments.loadOverrides(overridesFile) : {});

// Built-in environments removed from the list on this computer. The snapshot file itself is not changed.
const hiddenIds = () => {
  try {
    const list = JSON.parse(fs.readFileSync(hiddenFile, 'utf8'));
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const saveHiddenIds = (ids) => {
  fs.mkdirSync(path.dirname(hiddenFile), { recursive: true });
  fs.writeFileSync(hiddenFile, JSON.stringify(ids, null, 2), { mode: 0o600 });
};
// The built-in environments of the open snapshot that are still listed.
const visibleBuiltIn = () => {
  const hidden = hiddenIds();
  return ((openSnapshot && openSnapshot.environments) || []).filter((e) => !hidden.includes(e.environmentId));
};

// What the open snapshot allows, plus the user's environments. Runs are checked against this view.
function currentView() {
  return {
    ...openSnapshot,
    environments: environments.mergeEnvironments(visibleBuiltIn(), yourEnvironments(), overrides()),
  };
}

const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;
const CONTENT_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'API Explorer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));

  // Find in page: Cmd+F (Ctrl+F elsewhere) opens the find bar in the page. Edit roles keep copy and paste working.
  const sendToPage = (channel, ...args) => { if (!win.isDestroyed()) win.webContents.send(channel, ...args); };
  win.webContents.on('found-in-page', (_event, result) => sendToPage('find:result', { active: result.activeMatchOrdinal, total: result.matches }));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => sendToPage('find:open') },
      ],
    },
    {
      label: 'Snapshot',
      submenu: [{
        label: 'Remove loaded snapshot…',
        click: async () => {
          if (!openSnapshot && (!lastSnapshotFile || !fs.existsSync(lastSnapshotFile))) {
            await dialog.showMessageBox(win, {
              type: 'info',
              message: 'There is no loaded snapshot to remove.',
            });
            return;
          }
          const choice = await dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['Cancel', 'Remove snapshot'],
            defaultId: 0,
            cancelId: 0,
            message: 'Remove the loaded API snapshot?',
            detail: 'The saved snapshot and its cached environments will be removed from this computer. Your own environments will be kept.',
          });
          if (choice.response !== 1) return;

          try {
            if (lastSnapshotFile && fs.existsSync(lastSnapshotFile)) fs.unlinkSync(lastSnapshotFile);
          } catch (error) {
            await dialog.showMessageBox(win, {
              type: 'error',
              message: 'The loaded snapshot could not be removed.',
              detail: error.message,
            });
            return;
          }

          openSnapshot = null;
          let cacheError = null;
          try {
            if (envCacheFile && fs.existsSync(envCacheFile)) fs.unlinkSync(envCacheFile);
          } catch (error) {
            cacheError = error;
          }
          if (cacheError) {
            await dialog.showMessageBox(win, {
              type: 'error',
              message: 'The snapshot was removed, but its cached environments could not be removed.',
              detail: cacheError.message,
            });
          }
          win.webContents.reload();
        },
      }],
    },
    { role: 'viewMenu' },
    {
      label: 'Window',
      // Cmd+W closes the dialog in front (the page decides); with no dialog open, the page asks for the window to close.
      submenu: [
        { label: 'Close', accelerator: 'CmdOrCtrl+W', click: () => sendToPage('window:close-request') },
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin' ? [{ type: 'separator' }, { role: 'front' }] : []),
      ],
    },
  ]));
}

ipcMain.handle('find:run', (event, input) => {
  const text = input && typeof input.text === 'string' ? input.text.slice(0, 200) : '';
  if (text !== '') event.sender.findInPage(text, { findNext: input.findNext === true, forward: input.forward !== false });
});

ipcMain.handle('window:close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.close();
});

ipcMain.handle('find:stop', (event) => {
  event.sender.stopFindInPage('clearSelection');
});

// The snapshot that is open. Kept here so the allow-list comes from the file, not from the page.
let openSnapshot = null;

// The only channel the page has: pick a snapshot file and return its text.
// A catalogue file may carry token types (names and settings, never values). The ones this computer does not have yet are
// added; a name already in use is skipped. Returns the saved list, or null when nothing was added.
function importSnapshotTokenTypes(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.tokenTypes) || snapshot.tokenTypes.length === 0 || !tokenSourcesFile) return null;
  const envIdByName = Object.fromEntries((snapshot.environments || []).map((e) => [String(e.name).toLowerCase(), e.environmentId]));
  const merged = tokenTypes.mergeRows(savedTokenTypes(), snapshot.tokenTypes, envIdByName);
  return tokenTypes.save(tokenSourcesFile, merged.types);
}

ipcMain.handle('snapshot:open', async (event, options) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const choice = await dialog.showOpenDialog(win, {
    title: 'Open API snapshot',
    properties: ['openFile'],
    filters: [{ name: 'API snapshot', extensions: ['json'] }],
  });
  if (choice.canceled || choice.filePaths.length === 0) {
    return null;
  }
  const file = choice.filePaths[0];
  const size = fs.statSync(file).size;
  if (size > MAX_SNAPSHOT_BYTES) {
    throw new Error('The snapshot is larger than 50 MB.');
  }
  const text = fs.readFileSync(file, 'utf8');
  openSnapshot = safeParse(text);
  rememberEnvironments(openSnapshot);
  const types = options && options.compareOnly === true ? null : importSnapshotTokenTypes(openSnapshot);
  const name = path.basename(file);
  saveLastSnapshot(name, text);
  return { name, text, types };
});

// The last snapshot is copied into the app's data folder, so startup can load it without asking again, even if the
// original file has moved. Only the most recent one is kept, and it is replaced when another file is opened.
let lastSnapshotFile = null;

// The environments of the last snapshot that had any. A source scan has none of its own, so they are kept here and given
// to the scan, so the token panel still lists them after a restart.
let envCacheFile = null;

function knownEnvironments() {
  try {
    const list = JSON.parse(fs.readFileSync(envCacheFile, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function rememberEnvironments(snapshot) {
  if (!envCacheFile || !snapshot || !Array.isArray(snapshot.environments) || snapshot.environments.length === 0) return;
  try {
    fs.mkdirSync(path.dirname(envCacheFile), { recursive: true });
    fs.writeFileSync(envCacheFile, JSON.stringify(snapshot.environments), { mode: 0o600 });
  } catch {
    // Not kept; the environments of this snapshot are still used for this session.
  }
}

function forgetKnownEnvironment(id) {
  if (!envCacheFile) return;
  const left = knownEnvironments().filter((e) => e && e.environmentId !== id);
  try {
    fs.writeFileSync(envCacheFile, JSON.stringify(left), { mode: 0o600 });
  } catch {
    // The hidden list still keeps it out of the app.
  }
}

function withKnownEnvironments(snapshot) {
  if (snapshot && Array.isArray(snapshot.environments) && snapshot.environments.length === 0) {
    const known = knownEnvironments();
    if (known.length > 0) snapshot.environments = known;
  }
  return snapshot;
}

function saveLastSnapshot(name, text) {
  if (!lastSnapshotFile) return;
  try {
    fs.mkdirSync(path.dirname(lastSnapshotFile), { recursive: true });
    fs.writeFileSync(lastSnapshotFile, JSON.stringify({ name, text }), { mode: 0o600 });
  } catch {
    // Not saving the copy is not fatal: the user can open the file again.
  }
}

ipcMain.handle('snapshot:last', () => {
  if (!lastSnapshotFile || !fs.existsSync(lastSnapshotFile)) return null;
  try {
    const saved = JSON.parse(fs.readFileSync(lastSnapshotFile, 'utf8'));
    if (!saved || typeof saved.name !== 'string' || typeof saved.text !== 'string') return null;
    const parsed = withKnownEnvironments(safeParse(saved.text));
    if (!parsed || parsed.format !== 'api-explorer-snapshot') return null;
    openSnapshot = parsed;
    return { name: saved.name, text: JSON.stringify(parsed) };
  } catch {
    return null;
  }
});

function safeParse(text) {
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

// Sends one request. The page supplies the built request and the token; the main process checks everything first.
ipcMain.handle('request:run', async (_event, run) => {
  const operation = run && run.operation ? run.operation : null;
  const envForRun = currentView().environments.find((e) => e.name === (run && run.environmentName));
  const confirmRequired = envForRun ? confirmations.requiredFor(savedConfirmations(), envForRun, run && run.method) : true;
  const { problems, production } = checkRun(currentView(), { ...run, confirmRequired }, operation);
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  const started = Date.now();
  try {
    const sentHeaders = run.noAuth === true ? { ...run.headers } : { ...run.headers, Authorization: `Bearer ${run.token}` };
    const res = await send({ method: run.method, url: run.url, headers: sentHeaders, body: run.body });
    const headers = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, scrubToken(v, run.token)]));
    return {
      ok: true,
      production,
      status: res.status,
      durationMs: Date.now() - started,
      headers,
      body: scrubToken(res.body, run.token),
    };
  } catch (e) {
    return { ok: false, problems: [e instanceof Error ? e.message : 'The request failed.'] };
  }
});

// Local model: status, search ranking, and filling a request from a description. Answers are checked before use.
ipcMain.handle('model:status', async () => ollama.status());

// Documentation agent. Settings: the model provider, the manual writing instructions, the after-scan instructions, and whether
// a scan writes descriptions by itself. The Claude key is held in memory for this session only, never saved.
const savedDocSettings = () => {
  try {
    const data = JSON.parse(fs.readFileSync(docSettingsFile, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
};
const docProvider = () => (savedDocSettings().provider === 'claude' ? 'claude' : 'local');
// kind 'manual' is the Documentation window's prompt; 'auto' is the prompt used after a scan.
const docInstructions = (kind = 'manual') => docAgent.instructionsOrDefault(savedDocSettings()[kind === 'auto' ? 'afterScanInstructions' : 'instructions']);
const generateAfterScanSaved = () => savedDocSettings().generateAfterScan !== false;
const DOC_BATCH = 50;

// The background run started after a scan. One run at a time; the page polls its status.
let docJob = { state: 'idle' };
let docJobStop = false;

const usableOperation = (o) => ({
  revisionId: o.revisionId, httpMethod: o.httpMethod, pathTemplate: o.pathTemplate, serviceName: o.serviceName,
  summary: o.summary, lifecycleStatus: o.lifecycleStatus, definition: o.definition,
});

function docChat() {
  if (docProvider() === 'claude') return { source: 'claude', chat: (s, u) => claudeApi.chatJson(s, u, { key: claudeKey }) };
  // A local model on a laptop can be slow, so it gets longer than the default before a call is counted as failed.
  return { source: 'local', chat: (s, u) => ollama.chatJson(s, u, 180000) };
}

/** Whether a model is ready to write descriptions, with the reason when it is not. */
async function modelReady() {
  if (docProvider() === 'claude') {
    return claudeKey ? { ok: true } : { ok: false, reason: 'No Claude API key is set for this session. Enter one in Documentation, or set up the local model.' };
  }
  const st = await ollama.status();
  return st && st.available ? { ok: true } : { ok: false, reason: `The local model is not running${st && st.reason ? ` (${st.reason})` : ''}. Start it to write descriptions.` };
}

/**
 * Called after a fresh scan. Starts the background run when the flag is on and a model is ready; otherwise says why not.
 * The scan result is returned at once; the run continues behind it.
 */
async function afterScanDocs(text, flag) {
  if (flag === false) return { status: 'skipped', reason: 'Writing descriptions was turned off for this scan.' };
  if (docJob.state === 'running') return { status: 'busy', reason: 'A documentation run is already in progress.' };
  const ready = await modelReady();
  if (!ready.ok) return { status: 'skipped', reason: ready.reason };
  if (!docsFile) return { status: 'skipped', reason: 'The app is not ready yet.' };
  let snapshot;
  try {
    snapshot = JSON.parse(text);
  } catch {
    return { status: 'skipped', reason: 'The scan result could not be read.' };
  }
  const docs = docAgent.load(docsFile);
  const ops = (snapshot.operations || []).filter((o) => docJobNeeds(o, docs)).map(usableOperation);
  if (ops.length === 0) return { status: 'done', total: 0, reason: 'Every API already has a description.' };
  const { source, chat } = docChat();
  docJobStop = false;
  docJob = { state: 'running', total: ops.length, done: 0, fromModel: 0, factual: 0, reason: '' };
  runDocumentation({
    operations: ops, chat, source, instructions: docInstructions('auto'),
    save: (results) => docAgent.merge(docsFile, results),
    shouldStop: () => docJobStop,
    onProgress: (status) => { docJob = { ...docJob, ...status }; },
  }).then((status) => { docJob = { ...docJob, ...status }; })
    .catch((e) => { docJob = { ...docJob, state: 'failed', reason: String(e && e.message ? e.message : 'The run failed.') }; });
  return { status: 'started', total: ops.length };
}

ipcMain.handle('docs:get', () => ({
  docs: docsFile ? docAgent.load(docsFile) : {},
  overviews: docsFile ? docAgent.loadOverviews(docsFile) : {},
  provider: docProvider(),
  instructions: docInstructions('manual'),
  afterScanInstructions: docInstructions('auto'),
  defaultInstructions: docAgent.DEFAULT_INSTRUCTIONS,
  generateAfterScan: generateAfterScanSaved(),
  hasKey: claudeKey !== '',
}));

ipcMain.handle('docs:settings', (_event, input) => {
  if (!docSettingsFile) return { ok: false, problems: ['The app is not ready yet.'] };
  const current = savedDocSettings();
  const next = { ...current };
  if (input && (input.provider === 'claude' || input.provider === 'local')) next.provider = input.provider;
  // Blank text means "use the default", so the saved value is removed.
  for (const key of ['instructions', 'afterScanInstructions']) {
    if (input && typeof input[key] === 'string') {
      const text = input[key].trim().slice(0, 3000);
      if (text === '') delete next[key];
      else next[key] = text;
    }
  }
  if (input && typeof input.generateAfterScan === 'boolean') next.generateAfterScan = input.generateAfterScan;
  fs.mkdirSync(path.dirname(docSettingsFile), { recursive: true });
  fs.writeFileSync(docSettingsFile, JSON.stringify(next), { mode: 0o600 });
  return {
    ok: true,
    provider: docProvider(),
    instructions: docInstructions('manual'),
    afterScanInstructions: docInstructions('auto'),
    generateAfterScan: generateAfterScanSaved(),
  };
});

ipcMain.handle('docs:key', (_event, input) => {
  claudeKey = input && typeof input.key === 'string' ? input.key.trim().slice(0, 300) : '';
  return { ok: true, hasKey: claudeKey !== '' };
});

// The background run's status, for the page to show progress.
ipcMain.handle('docs:job', () => docJob);
ipcMain.handle('docs:jobStop', () => {
  docJobStop = true;
  return docJob;
});

// Writes descriptions for up to 50 APIs per call from the Documentation window. The page calls again for the rest.
ipcMain.handle('docs:generate', async (_event, input) => {
  if (!docsFile) return { ok: false, problem: 'The app is not ready yet.' };
  if (docJob.state === 'running') return { ok: false, problem: 'A run is already writing descriptions in the background. Stop it, or wait for it to finish.' };
  const ops = Array.isArray(input && input.operations) ? input.operations.slice(0, DOC_BATCH) : [];
  const usable = ops.filter((o) => o && typeof o.revisionId === 'string' && o.definition).map(usableOperation);
  if (usable.length === 0) return { ok: false, problem: 'No APIs to describe.' };
  const { source, chat } = docChat();
  if (source === 'claude' && claudeKey === '') return { ok: false, problem: 'Enter a Claude API key in settings first.' };
  try {
    const { results, modelFailures } = await docAgent.runDocAgent({ operations: usable, chat, source, instructions: docInstructions('manual') });
    if (modelFailures === usable.length) {
      return { ok: false, problem: source === 'claude' ? 'The Claude API did not answer. Check the key and the connection.' : 'The local model did not answer. Check that it is running.' };
    }
    const docs = docAgent.merge(docsFile, results);
    return { ok: true, docs, written: results.length, fromModel: results.filter((r) => r.source !== 'template').length };
  } catch (e) {
    return { ok: false, problem: e instanceof Error ? e.message : 'The documentation agent failed.' };
  }
});

ipcMain.handle('docs:overview', async (_event, input) => {
  if (!docsFile) return { ok: false, problem: 'The app is not ready yet.' };
  const serviceName = input && typeof input.serviceName === 'string' ? input.serviceName.slice(0, 100) : '';
  const ops = Array.isArray(input && input.operations) ? input.operations.slice(0, 200) : [];
  if (serviceName === '' || ops.length === 0) return { ok: false, problem: 'No APIs for this service.' };
  const { source, chat } = docChat();
  if (source === 'claude' && claudeKey === '') return { ok: false, problem: 'Enter a Claude API key in settings first.' };
  const result = await docAgent.runOverview({ serviceName, operations: ops.map((o) => ({ httpMethod: o.httpMethod, pathTemplate: o.pathTemplate, summary: o.summary })), chat, source, instructions: docInstructions('manual') });
  if (result.modelFailed) return { ok: false, problem: 'The model did not answer. Check that it is running or that the key is valid.' };
  const overviews = docAgent.saveOverview(docsFile, serviceName, result.overview, result.source);
  return { ok: true, overview: result.overview, source: result.source, overviews };
});

ipcMain.handle('assist:rank', async (_event, input) => {
  const candidates = Array.isArray(input && input.candidates) ? input.candidates : [];
  const offered = candidates.slice(0, assist.MAX_CANDIDATES).map((c) => String(c.id));
  if (offered.length === 0 || typeof input.query !== 'string' || input.query.trim() === '') {
    return { ok: true, ids: [] };
  }
  try {
    const prompt = assist.rankPrompt(input.query, candidates);
    const text = await ollama.chatJson(prompt.system, prompt.user);
    return { ok: true, ids: assist.parseRank(text, offered) };
  } catch (e) {
    return { ok: false, problem: e instanceof Error ? e.message : 'The local model failed.' };
  }
});

// The search agents: Supervisor decides, Discovery ranks. The page sends the question and the offline candidates.
ipcMain.handle('agent:search', async (_event, input) => {
  const candidates = Array.isArray(input && input.candidates) ? input.candidates : [];
  const question = input && typeof input.question === 'string' ? input.question : '';
  if (question.trim() === '') return { ok: false, problem: 'Type a question first.' };
  try {
    const result = await agents.runAgents({
      question,
      candidates,
      chat: (system, user) => ollama.chatJson(system, user),
    });
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, problem: e instanceof Error ? e.message : 'The agents could not run.' };
  }
});

ipcMain.handle('assist:plan', async (_event, input) => {
  if (!input || typeof input.description !== 'string' || input.description.trim() === '' || !input.operation) {
    return { ok: false, problem: 'Describe the call first.' };
  }
  try {
    const prompt = assist.planPrompt(input.description, input.operation);
    const text = await ollama.chatJson(prompt.system, prompt.user);
    return { ok: true, ...assist.parsePlan(text, input.operation, input.description) };
  } catch (e) {
    return { ok: false, problem: e instanceof Error ? e.message : 'The local model failed.' };
  }
});

ipcMain.handle('env:list', () => ({ yours: yourEnvironments(), overrides: overrides(), hidden: hiddenIds() }));

// Removes a built-in environment for good on this computer. Runs can no longer use it, and it is not offered again.
ipcMain.handle('env:hide', (_event, id) => {
  if (!hiddenFile || typeof id !== 'string') return { ok: false, problems: ['Choose an environment to remove.'] };
  if (!openSnapshot || !(openSnapshot.environments || []).some((e) => e.environmentId === id)) {
    return { ok: false, problems: ['That built-in environment is not in the open snapshot.'] };
  }
  const next = [...new Set([...hiddenIds(), id])];
  saveHiddenIds(next);
  // Gone from the remembered copy too, so a scan does not bring it back.
  forgetKnownEnvironment(id);
  return { ok: true, hidden: next };
});


// Changes the default address of one built-in environment on this computer only. The name and flags stay as the snapshot has them.
ipcMain.handle('env:overrideSave', (_event, input) => {
  if (!overridesFile || !openSnapshot) return { ok: false, problems: ['Open a snapshot first.'] };
  const id = input && typeof input.environmentId === 'string' ? input.environmentId : '';
  const builtIn = (openSnapshot.environments || []).find((e) => e.environmentId === id);
  if (!builtIn) return { ok: false, problems: ['That built-in environment is not in the open snapshot.'] };
  const { problems, value } = environments.validate({ name: builtIn.name, baseUrl: input.baseUrl }, [], id);
  if (problems.length > 0) return { ok: false, problems };
  const next = { ...overrides(), [id]: { baseUrl: value.baseUrl } };
  environments.saveOverrides(overridesFile, next);
  return { ok: true, overrides: next };
});

// Removes the address override so the built-in environment uses the snapshot's default host again.
ipcMain.handle('env:overrideReset', (_event, id) => {
  if (!overridesFile || typeof id !== 'string') return { ok: false, problems: ['Choose an environment to reset.'] };
  const next = { ...overrides() };
  delete next[id];
  environments.saveOverrides(overridesFile, next);
  return { ok: true, overrides: next };
});

ipcMain.handle('env:save', (_event, input) => {
  if (!envFile) return { ok: false, problems: ['The app is not ready yet.'] };
  const list = yourEnvironments();
  const selfId = input && typeof input.id === 'string' ? input.id : null;
  if (selfId && !list.some((e) => e.id === selfId)) {
    return { ok: false, problems: ['That environment no longer exists.'] };
  }
  if (!selfId && list.length >= environments.MAX_USER_ENVIRONMENTS) {
    return { ok: false, problems: [`You can keep up to ${environments.MAX_USER_ENVIRONMENTS} environments.`] };
  }
  const taken = [
    ...((openSnapshot && openSnapshot.environments) || []).map((e) => ({ id: e.environmentId, name: e.name })),
    ...list.map((e) => ({ id: e.id, name: e.name })),
  ];
  const { problems, value } = environments.validate(input, taken, selfId);
  if (problems.length > 0) return { ok: false, problems };
  const next = selfId
    ? list.map((e) => (e.id === selfId ? { ...e, ...value } : e))
    : [...list, { id: environments.newId(), ...value }];
  environments.save(envFile, next);
  return { ok: true, yours: next };
});

ipcMain.handle('env:delete', (_event, id) => {
  if (!envFile || typeof id !== 'string') return { ok: false, problems: ['Choose an environment to delete.'] };
  const next = yourEnvironments().filter((e) => e.id !== id);
  environments.save(envFile, next);
  return { ok: true, yours: next };
});

// Variables that any API can use. The page sends names and values; the main process checks them before saving.
ipcMain.handle('variables:list', () => ({ variables: savedVariables() }));

ipcMain.handle('variables:save', (_event, input) => {
  if (!variablesFile) return { ok: false, problems: ['The app is not ready yet.'] };
  const list = savedVariables();
  const selfId = input && typeof input.id === 'string' ? input.id : null;
  if (selfId && !list.some((v) => v.id === selfId)) return { ok: false, problems: ['That variable no longer exists.'] };
  if (!selfId && list.length >= variables.MAX_VARIABLES) {
    return { ok: false, problems: [`You can keep up to ${variables.MAX_VARIABLES} variables.`] };
  }
  const { problems, value } = variables.validate(input, list, selfId, knownEnvironmentIds());
  if (problems.length > 0) return { ok: false, problems };
  const next = selfId
    ? list.map((v) => (v.id === selfId ? { ...v, ...value } : v))
    : [...list, { id: variables.newId(), ...value }];
  variables.save(variablesFile, next);
  return { ok: true, variables: next };
});

ipcMain.handle('variables:delete', (_event, id) => {
  if (!variablesFile || typeof id !== 'string') return { ok: false, problems: ['Choose a variable to delete.'] };
  const next = savedVariables().filter((v) => v.id !== id);
  variables.save(variablesFile, next);
  return { ok: true, variables: next };
});

// Default request payloads per API. An empty text removes the saved default.
ipcMain.handle('payloads:list', () => ({ payloads: savedPayloads() }));

ipcMain.handle('payloads:save', (_event, input) => {
  if (!payloadsFile) return { ok: false, problems: ['The app is not ready yet.'] };
  const id = input && typeof input.operationId === 'string' ? input.operationId.slice(0, 200) : '';
  if (id === '') return { ok: false, problems: ['Choose an API first.'] };
  const text = input && typeof input.text === 'string' ? input.text : '';
  const next = { ...savedPayloads() };
  if (text.trim() === '') {
    delete next[id];
  } else {
    const { problems } = payloads.validate(text);
    if (problems.length > 0) return { ok: false, problems };
    next[id] = text;
  }
  payloads.save(payloadsFile, next);
  return { ok: true, payloads: next };
});

// Favourites and collections of APIs. Files are exported and imported through the system dialogs.
ipcMain.handle('library:get', () => ({ library: savedLibrary() }));

ipcMain.handle('library:save', (_event, input) => {
  if (!libraryFile) return { ok: false, problems: ['The app is not ready yet.'] };
  return { ok: true, library: library.save(libraryFile, input && input.library) };
});

ipcMain.handle('library:export', async (_event, input) => {
  const kind = input && input.kind === 'postman' ? 'postman' : 'app';
  const collection = savedLibrary().collections.find((c) => c.id === (input && input.collectionId));
  if (!collection) return { ok: false, problems: ['Choose a collection to export.'] };
  const suffix = kind === 'postman' ? '.postman_collection.json' : '.json';
  const picked = await dialog.showSaveDialog({ defaultPath: library.fileNameFor(collection.name, suffix), filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (picked.canceled || !picked.filePath) return { ok: false, problems: ['Export cancelled.'], cancelled: true };
  const content = kind === 'postman' ? library.exportPostman(collection) : library.exportApp(collection);
  fs.writeFileSync(picked.filePath, JSON.stringify(content, null, 2), { mode: 0o600 });
  return { ok: true, path: picked.filePath };
});

ipcMain.handle('library:import', async () => {
  if (!libraryFile) return { ok: false, problems: ['The app is not ready yet.'] };
  const picked = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (picked.canceled || picked.filePaths.length === 0) return { ok: false, problems: ['Import cancelled.'], cancelled: true };
  let content;
  try {
    const stat = fs.statSync(picked.filePaths[0]);
    if (stat.size > 2 * 1024 * 1024) return { ok: false, problems: ['The file is larger than 2 MB.'] };
    content = fs.readFileSync(picked.filePaths[0], 'utf8');
  } catch {
    return { ok: false, problems: ['The file could not be read.'] };
  }
  const result = library.importApp(content);
  if (!result.ok) return result;
  const current = savedLibrary();
  if (current.collections.length >= library.MAX_COLLECTIONS) {
    return { ok: false, problems: [`You can keep up to ${library.MAX_COLLECTIONS} collections.`] };
  }
  const next = library.save(libraryFile, { ...current, collections: [...current.collections, result.collection] });
  return { ok: true, library: next };
});

// Confirmation before sending, per environment and method (set in Environments).
const savedConfirmations = () => (confirmationsFile ? confirmations.load(confirmationsFile) : {});
const confirmationRows = () => currentView().environments.map((e) => ({
  environmentId: e.environmentId, name: e.name, production: e.production === true, enabled: e.enabled !== false,
  methods: confirmations.effective(savedConfirmations(), e),
}));

ipcMain.handle('confirmations:list', () => ({ environments: confirmationsFile ? confirmationRows() : [] }));

ipcMain.handle('confirmations:save', (_event, input) => {
  if (!confirmationsFile) return { ok: false, problems: ['The app is not ready yet.'] };
  const envId = input && typeof input.environmentId === 'string' ? input.environmentId : '';
  const env = currentView().environments.find((e) => e.environmentId === envId);
  if (!env) return { ok: false, problems: ['That environment is not available.'] };
  const { problems, value } = confirmations.validate(input && input.methods);
  if (problems.length > 0) return { ok: false, problems };
  const map = savedConfirmations();
  confirmations.save(confirmationsFile, { ...map, [envId]: { ...confirmations.effective(map, env), ...value } });
  return { ok: true, environments: confirmationRows() };
});

// Asked by the page before it shows the typed-name box. The main process checks again when the request is sent.
ipcMain.handle('confirmations:required', (_event, input) => {
  const env = currentView().environments.find((e) => e.name === (input && input.environmentName));
  return { required: env ? confirmations.requiredFor(savedConfirmations(), env, input && input.method) : true };
});

// Reads OpenAPI 3 files from GitHub folders. A saved scan is reused unless refresh is asked for. The token is used for
// this scan only: it is not saved, not returned, and not put in the catalog or the report.
const NO_GIT = 'Git is not installed on this computer. Install git and scan again, or clone the repository yourself and choose its folder with "Local folder":';

function noGitProblems(sources) {
  const repo = sources.map((s) => githubScan.parseRepo(s.repo)).find(Boolean);
  const address = repo ? `https://github.com/${repo.owner}/${repo.repo}` : 'https://github.com/OWNER/REPO';
  return [NO_GIT, `git clone ${address}`];
}

// Clones the folders the scan needs, scans them, and deletes the copy unless the user asked to keep it. Repositories
// shared by several services are cloned once. Copies are made under the app's data folder only.
async function cloneAndBuild(sources, { token, rules, keep, splitProjects }) {
  const parsed = sources.map((s) => {
    const repo = githubScan.parseRepo(s.repo);
    const folder = githubScan.cleanPath(s.path || (repo && repo.path) || '');
    return { src: s, repo, folder };
  });
  const bad = parsed.find((p) => !p.repo || p.folder === null);
  if (bad) return { ok: false, code: 'invalid', problem: 'Check the repository and folder addresses: use owner/repo or a github.com link, and a folder inside it.' };

  const groups = new Map();
  for (const p of parsed) {
    const key = `${p.repo.owner}/${p.repo.repo}@${p.repo.ref}`;
    if (!groups.has(key)) groups.set(key, { repo: p.repo, items: [] });
    groups.get(key).items.push(p);
  }

  const root = keep ? path.join(githubClonesDir, 'kept') : path.join(githubClonesDir, 'tmp');
  fs.mkdirSync(root, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(root, 'scan-'));
  try {
    const folderSources = [];
    let index = 0;
    for (const { repo, items } of groups.values()) {
      index++;
      const parent = path.join(runDir, `${index}-${repo.owner}-${repo.repo}`.replace(/[^A-Za-z0-9._-]/g, '_'));
      fs.mkdirSync(parent, { recursive: true });
      const folders = [...new Set(items.map((p) => p.folder || ''))];
      const cloned = await gitClone.cloneRepo({ owner: repo.owner, repo: repo.repo, ref: repo.ref, folders, token, parentDir: parent });
      if (!cloned.ok) return { ok: false, code: cloned.code, problem: cloned.problem };
      for (const p of items) {
        const dir = p.folder ? path.join(cloned.dir, p.folder) : cloned.dir;
        folderSources.push({ folder: dir, service: p.src.service.trim(), split: splitProjects, label: `${repo.owner}/${repo.repo}${p.folder ? `/${p.folder}` : ''}` });
      }
    }
    const built = localScan.buildFromFolders(folderSources, { rules });
    return { ok: true, built, clonePaths: keep ? [runDir] : [] };
  } finally {
    if (!keep) gitClone.removeDir(runDir);
  }
}

// A scan is kept as the last snapshot, like an opened file, so the app shows it after a restart without scanning again.
function rememberScan(sources, text) {
  try {
    const parsed = safeParse(text);
    if (!parsed || parsed.format !== 'api-explorer-snapshot') return;
    const names = sources.map((s) => s.service.trim() || path.basename(s.path.trim() || s.repo.trim())).filter(Boolean).join(', ');
    openSnapshot = parsed;
    saveLastSnapshot(`Source scan: ${names}`, JSON.stringify(withKnownEnvironments(parsed)));
  } catch {
    // A scan that cannot be kept is still shown; it is only not remembered.
  }
}

// Reads a repository or folder for the scan rules. Modes: 'clone' (default: git, sparse, copy deleted after the scan),
// 'api' (the GitHub API, the fallback), and 'folder' (a folder already on this computer). The result is cached until refresh.
ipcMain.handle('github:scan', async (_event, input) => {
  if (!githubCacheDir) return { ok: false, problems: ['The app is not ready yet.'] };
  const mode = input && ['clone', 'api', 'folder'].includes(input.mode) ? input.mode : 'clone';
  const keep = input && input.keepClone === true;
  // Each folder inside the given folder becomes its own service, named after it (clone and folder modes).
  const splitProjects = input && input.splitProjects === true;
  const sources = Array.isArray(input && input.sources)
    ? input.sources.slice(0, 30).map((s) => ({
      repo: String((s && s.repo) || '').slice(0, 300),
      path: String((s && s.path) || '').slice(0, 300),
      service: String((s && s.service) || '').slice(0, 100),
    }))
    : [];
  if (sources.length === 0 || sources.every((s) => s.repo.trim() === '')) return { ok: false, problems: ['Add at least one repository or folder.'] };
  if (mode === 'folder' && sources.some((s) => s.repo.trim() !== '' && !path.isAbsolute(s.repo.trim()))) {
    return { ok: false, problems: ['Choose each folder with Browse, so its full path is known.'] };
  }
  const token = input && typeof input.token === 'string' ? input.token.trim().slice(0, 300) : '';
  const refresh = input && input.refresh === true;
  const rules = scanRules.activeRules(scanRulesFile ? scanRules.load(scanRulesFile) : null);
  const file = path.join(githubCacheDir, `${githubScan.cacheKey(sources, rules, splitProjects ? `${mode}:split` : mode)}.json`);
  if (!refresh && fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      rememberScan(sources, saved.text);
      return { ok: true, cached: true, mode, scannedAt: saved.scannedAt, text: saved.text, report: saved.report, clonePaths: [], documentation: null };
    } catch {
      // A damaged saved scan is ignored and the source is read again.
    }
  }
  try {
    let built;
    let clonePaths = [];
    if (mode === 'folder') {
      built = localScan.buildFromFolders(sources.map((s) => ({ folder: s.repo.trim(), service: s.service.trim(), label: s.repo.trim(), split: splitProjects })), { rules });
    } else if (mode === 'api') {
      built = await githubScan.buildCatalog(sources, { token, rules });
    } else {
      const git = await gitClone.gitAvailable();
      if (!git.available) return { ok: false, code: 'no-git', problems: noGitProblems(sources) };
      const result = await cloneAndBuild(sources, { token, rules, keep, splitProjects });
      if (!result.ok) return { ok: false, code: result.code, problems: [result.problem] };
      built = result.built;
      clonePaths = result.clonePaths;
    }
    const scannedAt = new Date().toISOString();
    fs.mkdirSync(githubCacheDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ scannedAt, sources, text: built.text, report: built.report }), { mode: 0o600 });
    rememberScan(sources, built.text);
    // A fresh scan can start writing descriptions in the background (see afterScanDocs).
    const documentation = await afterScanDocs(built.text, input && typeof input.generateDocs === 'boolean' ? input.generateDocs : undefined);
    return { ok: true, cached: false, mode, scannedAt, text: built.text, report: built.report, clonePaths, documentation };
  } catch (e) {
    return { ok: false, problems: [String(e && e.message ? e.message : 'The scan failed.').split(token || '\u0000').join('••••')] };
  }
});

// A copy kept on purpose, listed so the user can delete it from the scan window. Only copies under 'kept' can be deleted.
ipcMain.handle('github:listClones', () => {
  if (!githubClonesDir) return { paths: [] };
  const kept = path.join(githubClonesDir, 'kept');
  try {
    return { paths: fs.readdirSync(kept, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(kept, d.name)) };
  } catch {
    return { paths: [] };
  }
});

ipcMain.handle('github:deleteClone', (_event, input) => {
  const target = input && typeof input.path === 'string' ? input.path : '';
  const kept = githubClonesDir ? path.join(githubClonesDir, 'kept') : '';
  if (!kept || !gitClone.isInside(kept, target)) return { ok: false, problems: ['That copy was not kept by this app, so it is not deleted here.'] };
  if (!fs.existsSync(target)) return { ok: true };
  return gitClone.removeDir(target) ? { ok: true } : { ok: false, problems: ['The folder could not be deleted. Close any program using it and try again.'] };
});

// Finds the projects inside a parent folder, so the user can confirm them before a scan (see lib/projectFinder.js).
ipcMain.handle('projects:findLocal', (_event, input) => {
  const folder = input && typeof input.folder === 'string' ? input.folder.trim() : '';
  if (!path.isAbsolute(folder)) return { ok: false, problems: ['Choose the folder with Browse.'] };
  try {
    if (!fs.statSync(folder).isDirectory()) return { ok: false, problems: ['That is a file, not a folder.'] };
  } catch {
    return { ok: false, problems: ['The folder cannot be read.'] };
  }
  const rules = scanRules.activeRules(scanRulesFile ? scanRules.load(scanRulesFile) : null);
  const found = projectFinder.findProjects(folder, rules);
  return { ok: true, projects: found.projects, notes: found.notes };
});

// The same for a repository: only the parent folder is cloned (sparse), read, and then deleted. Paths are repository paths.
ipcMain.handle('projects:findGitHub', async (_event, input) => {
  const repo = githubScan.parseRepo(input && input.repo);
  const folder = githubScan.cleanPath(input && input.path ? input.path : '');
  if (!repo || folder === null) return { ok: false, problems: ['Check the repository and folder addresses.'] };
  if (!githubClonesDir) return { ok: false, problems: ['The app is not ready yet.'] };
  const git = await gitClone.gitAvailable();
  if (!git.available) return { ok: false, code: 'no-git', problems: noGitProblems([{ repo: input.repo }]) };
  const token = input && typeof input.token === 'string' ? input.token.trim().slice(0, 300) : '';
  const rules = scanRules.activeRules(scanRulesFile ? scanRules.load(scanRulesFile) : null);
  const tmp = fs.mkdtempSync(path.join(githubClonesDir, 'tmp', 'find-'));
  try {
    const cloned = await gitClone.cloneRepo({ owner: repo.owner, repo: repo.repo, ref: repo.ref, folders: [folder || ''], token, parentDir: tmp });
    if (!cloned.ok) return { ok: false, code: cloned.code, problems: [cloned.problem] };
    const base = folder ? path.join(cloned.dir, folder) : cloned.dir;
    const found = projectFinder.findProjects(base, rules);
    // Local copy paths are not returned: a project is identified by its path inside the repository.
    const projects = found.projects.map(({ absolute, ...p }) => ({ ...p, path: [folder || '', p.path].filter(Boolean).join('/') }));
    return { ok: true, projects, notes: found.notes };
  } catch (e) {
    return { ok: false, problems: [String(e && e.message ? e.message : 'The projects could not be found.').split(token || '\u0000').join('••••')] };
  } finally {
    gitClone.removeDir(tmp);
  }
});

// Exports the open catalogue as JSON (the same format Open snapshot reads, with the descriptions and overviews written so
// far) or as CSV for a spreadsheet. The file holds no tokens or request values.
ipcMain.handle('catalog:export', async (event, input) => {
  const format = input && input.format === 'csv' ? 'csv' : 'json';
  let catalog;
  try {
    const docs = docsFile ? docAgent.load(docsFile) : {};
    const overviews = docsFile ? docAgent.loadOverviews(docsFile) : {};
    catalog = catalogExport.buildCatalog({
      snapshot: input && input.snapshot,
      docs,
      overviews,
      defaultEnvironmentId: input && typeof input.defaultEnvironmentId === 'string' ? input.defaultEnvironmentId : '',
      includeGenerated: !(input && input.includeGenerated === false),
      exportedBy: 'API Explorer',
      // Services, environments and token types are chosen in the export dialog. Token types never carry values.
      services: input && Array.isArray(input.services) ? input.services.filter((x) => typeof x === 'string') : null,
      includeEnvironments: !(input && input.includeEnvironments === false),
      tokenTypes: input && input.includeTokenTypes === true ? tokenTypes.exportRows(savedTokenTypes(), environmentNames(), null) : null,
    });
  } catch (e) {
    return { ok: false, problems: [e instanceof Error ? e.message : 'The catalogue could not be exported.'] };
  }
  const win = BrowserWindow.fromWebContents(event.sender);
  const service = (catalog.services[0] && catalog.services[0].name ? catalog.services[0].name : 'api-catalog').replace(/[^A-Za-z0-9._-]/g, '_');
  const choice = await dialog.showSaveDialog(win, {
    title: 'Export API catalogue',
    defaultPath: `api-catalog-${service}-${new Date().toISOString().slice(0, 10)}.${format}`,
    filters: format === 'csv' ? [{ name: 'CSV', extensions: ['csv'] }] : [{ name: 'API catalogue', extensions: ['json'] }],
  });
  if (choice.canceled || !choice.filePath) return { ok: false, cancelled: true };
  const body = format === 'csv' ? catalogExport.toCsv(catalog) : JSON.stringify(catalog, null, 2);
  fs.writeFileSync(choice.filePath, body, { mode: 0o600 });
  return { ok: true, path: choice.filePath, operations: catalog.operations.length };
});

ipcMain.handle('folder:pick', async () => {
  const picked = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (picked.canceled || picked.filePaths.length === 0) return { ok: false, cancelled: true };
  return { ok: true, path: picked.filePaths[0] };
});

// Scan rules: which annotations or decorators mark controllers, endpoints and parameters. Spring is the default.
ipcMain.handle('scanRules:get', () => ({
  rules: scanRules.activeRules(scanRulesFile ? scanRules.load(scanRulesFile) : null),
  presets: Object.entries(scanRules.PRESETS).map(([id, p]) => ({ id, rules: scanRules.validate(p).value })),
}));
ipcMain.handle('scanRules:save', (_event, input) => {
  if (!scanRulesFile) return { ok: false, problems: ['The app is not ready yet.'] };
  const saved = scanRules.save(scanRulesFile, input && input.rules);
  if (saved.problems.length > 0) return { ok: false, problems: saved.problems };
  return { ok: true, rules: saved.value };
});

// Token types (User, Support, Service, ...): one list for the app, run against any environment. Plus the workspace file.
const savedTokenTypes = () => (tokenSourcesFile ? tokenTypes.load(tokenSourcesFile) : []);
const environmentNames = () => Object.fromEntries(currentView().environments.map((e) => [e.environmentId, e.name]));

ipcMain.handle('tokenTypes:list', () => ({ types: savedTokenTypes() }));

ipcMain.handle('tokenTypes:save', (_event, input) => {
  if (!tokenSourcesFile) return { ok: false, problems: ['The app is not ready yet.'] };
  const types = savedTokenTypes();
  const id = input && typeof input.id === 'string' ? input.id : '';
  if (input && input.config === null) {
    return { ok: true, types: tokenTypes.save(tokenSourcesFile, types.filter((t) => t.id !== id)) };
  }
  if (id && !types.some((t) => t.id === id)) return { ok: false, problems: ['That token type no longer exists.'] };
  const { problems, value } = tokenTypes.validateType(input && input.config, types, id || null);
  if (problems.length > 0) return { ok: false, problems };
  const saved = { id: id || tokenTypes.newTypeId(), ...value };
  const next = id ? types.map((t) => (t.id === id ? saved : t)) : [...types, saved];
  return { ok: true, types: tokenTypes.save(tokenSourcesFile, next) };
});

// Workspace: every collection, favourite and token type in one file. Token values only when the user asks for them.
ipcMain.handle('workspace:export', async (_event, input) => {
  if (!libraryFile || !tokenSourcesFile) return { ok: false, problems: ['The app is not ready yet.'] };
  const includeValues = input && input.includeValues === true;
  const values = {};
  for (const v of Array.isArray(input && input.values) ? input.values : []) {
    if (v && typeof v.environmentId === 'string' && typeof v.typeId === 'string' && typeof v.value === 'string') {
      values[`${v.environmentId}|${v.typeId}`] = v.value;
    }
  }
  const rows = tokenTypes.exportRows(savedTokenTypes(), environmentNames(), includeValues ? values : null);
  const content = tokenTypes.exportWorkspace(savedLibrary(), rows, includeValues);
  const picked = await dialog.showSaveDialog({
    defaultPath: library.fileNameFor('API Explorer workspace', '.workspace.json'),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (picked.canceled || !picked.filePath) return { ok: false, problems: ['Export cancelled.'], cancelled: true };
  fs.writeFileSync(picked.filePath, JSON.stringify(content, null, 2), { mode: 0o600 });
  return { ok: true, path: picked.filePath, includesTokenValues: includeValues };
});

ipcMain.handle('workspace:import', async () => {
  if (!libraryFile || !tokenSourcesFile) return { ok: false, problems: ['The app is not ready yet.'] };
  const picked = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (picked.canceled || picked.filePaths.length === 0) return { ok: false, problems: ['Import cancelled.'], cancelled: true };
  let content;
  try {
    const stat = fs.statSync(picked.filePaths[0]);
    if (stat.size > 4 * 1024 * 1024) return { ok: false, problems: ['The file is larger than 4 MB.'] };
    content = fs.readFileSync(picked.filePaths[0], 'utf8');
  } catch {
    return { ok: false, problems: ['The file could not be read.'] };
  }
  const parsed = tokenTypes.parseWorkspace(content);
  if (!parsed.ok) return parsed;
  const current = savedLibrary();
  const keyOf = (i) => `${i.httpMethod} ${i.serviceName} ${i.contractVersion} ${i.pathTemplate}`;
  const favourites = [...current.favourites, ...parsed.favourites.filter((f) => !current.favourites.some((c) => keyOf(c) === keyOf(f)))];
  const collections = [...current.collections, ...parsed.collections.map((c) => ({ ...c, id: `col:${require('crypto').randomUUID()}` }))]
    .slice(0, library.MAX_COLLECTIONS);
  const nextLibrary = library.save(libraryFile, { favourites, collections });
  const envIdByName = Object.fromEntries(currentView().environments.map((e) => [e.name.toLowerCase(), e.environmentId]));
  const merged = tokenTypes.mergeRows(savedTokenTypes(), parsed.tokenRows, envIdByName);
  const savedTypes = tokenTypes.save(tokenSourcesFile, merged.types);
  return {
    ok: true,
    library: nextLibrary,
    types: savedTypes,
    values: merged.applied,
    skipped: merged.skipped,
    includesTokenValues: parsed.includesTokenValues,
  };
});

// Runs one token call and returns what happened, including the real HTTP status, the error text and a redacted copy of
// the request and response. Used by Run (fills the access token box) and Test (shows the result only).
const SECRET_KEYS = 'access_token|refresh_token|id_token|token|client_secret|secret|password|api_key|apikey';
const SECRET_FIELD = new RegExp(`(["']?(?:${SECRET_KEYS})["']?\\s*[:=]\\s*["']?)([^"'&\\s,}]+)`, 'gi');

/** The secret parts of a Basic credential (the base64 text, the decoded pair, and the password part). */
function basicSecrets(basic) {
  if (!basic) return [];
  const encoded = String(basic).replace(/^Basic\s+/i, '');
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return [encoded, decoded, colon >= 0 ? decoded.slice(colon + 1) : ''];
}

/** Hides secret values in text before it is shown on screen. */
function maskSecrets(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('••••');
  }
  return out.replace(SECRET_FIELD, '$1••••');
}

async function runTokenCall(input) {
  const view = currentView();
  const env = view.environments.find((e) => e.environmentId === (input && input.environmentId));
  // Headers come either as a record (from an API the snapshot knows) or as "Name: value" lines (from a token address).
  const headerRecord = typeof (input && input.headers) === 'string'
    ? Object.fromEntries(tokenFetch.parseHeaderLines(input.headers).headers.map((h) => [h.name, h.value]))
    : (input && input.headers && typeof input.headers === 'object' ? { ...input.headers } : {});
  const bearer = input && input.auth === 'bearer' ? String(input.bearer || '') : '';
  const basic = input && input.auth === 'basic' ? String(input.basic || '') : '';
  const run = {
    url: input && input.url, method: input && input.method, body: input && input.body === undefined ? null : input.body,
    headers: headerRecord, confirmWrite: input && input.confirmWrite === true, acceptIncomplete: input && input.acceptIncomplete === true,
    auth: ['bearer', 'basic'].includes(input && input.auth) ? input.auth : 'none', bearer, basic,
  };
  if (run.body !== null && !Object.keys(run.headers).some((h) => h.toLowerCase() === 'content-type')) {
    run.headers['Content-Type'] = input && input.contentType === 'form' ? 'application/x-www-form-urlencoded' : 'application/json';
  }
  const secrets = [bearer, ...basicSecrets(basic)];
  const problems = tokenFetch.checkTokenRun(view, run, input && input.operation, env);
  if (problems.length > 0) return { ok: false, stage: 'check', problems };
  // The access token and Basic credential are added here, after the checks, so a request cannot set them by itself.
  const sent = run.auth === 'bearer' ? { ...run.headers, Authorization: `Bearer ${bearer}` }
    : run.auth === 'basic' ? { ...run.headers, Authorization: basic } : run.headers;
  const lines = [`${run.method} ${maskSecrets(run.url, secrets)}`];
  for (const [name, value] of Object.entries(sent)) {
    lines.push(`${name}: ${name.toLowerCase() === 'authorization' ? '•••• (hidden)' : value}`);
  }
  if (run.body !== null) lines.push('', maskSecrets(run.body, secrets));
  const requestSummary = lines.join('\n');
  let res;
  try {
    res = await send({ method: run.method, url: run.url, headers: sent, body: run.body });
  } catch (err) {
    const code = err && err.code ? `${err.code}: ` : '';
    const reason = err && err.message ? err.message : 'unknown error';
    return { ok: false, stage: 'network', problems: [`The request did not complete. ${code}${reason}`], requestSummary };
  }
  const responseExcerpt = maskSecrets(res.body, secrets).slice(0, 800);
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, stage: 'http', status: res.status, problems: [`The token API answered HTTP ${res.status}.`], responseExcerpt, requestSummary };
  }
  const got = tokenFetch.extractToken(res.body, input.tokenField);
  if (!got.ok) return { ok: false, stage: 'field', status: res.status, problems: [got.problem], responseExcerpt, requestSummary };
  return {
    ok: true, status: res.status, token: got.token, tokenLength: got.token.length, production: env.production === true,
    responseExcerpt, requestSummary,
  };
}

ipcMain.handle('token:fetch', (_event, input) => runTokenCall(input));

// Appearance: light, dark or system, and the colour palette.
ipcMain.handle('preferences:get', () => ({ preferences: preferencesFile ? preferences.load(preferencesFile) : { ...preferences.DEFAULTS } }));

ipcMain.handle('preferences:save', (_event, input) => {
  if (!preferencesFile) return { ok: false, problems: ['The app is not ready yet.'] };
  return { ok: true, preferences: preferences.save(preferencesFile, input && input.preferences) };
});

// Requests built by hand (or from curl) for APIs outside the imported contract.
ipcMain.handle('customRequests:list', () => ({ requests: savedCustomRequests() }));

ipcMain.handle('customRequests:save', (_event, input) => {
  if (!customFile) return { ok: false, problems: ['The app is not ready yet.'] };
  const { problems, value } = customRequests.validate(input && input.request);
  if (problems.length > 0) return { ok: false, problems };
  const list = savedCustomRequests();
  const id = input && typeof input.id === 'string' ? input.id : '';
  if (id && !list.some((r) => r.id === id)) return { ok: false, problems: ['That request no longer exists.'] };
  if (!id && list.length >= customRequests.MAX_REQUESTS) return { ok: false, problems: [`You can keep up to ${customRequests.MAX_REQUESTS} requests.`] };
  const next = id ? list.map((r) => (r.id === id ? { ...value, id } : r)) : [...list, { ...value, id: customRequests.newId() }];
  customRequests.save(customFile, next);
  return { ok: true, requests: next };
});

ipcMain.handle('customRequests:delete', (_event, id) => {
  if (!customFile || typeof id !== 'string') return { ok: false, problems: ['Choose a request to delete.'] };
  const next = savedCustomRequests().filter((r) => r.id !== id);
  customRequests.save(customFile, next);
  return { ok: true, requests: next };
});

app.whenReady().then(() => {
  libraryFile = path.join(app.getPath('userData'), 'library.json');
  customFile = path.join(app.getPath('userData'), 'custom-requests.json');
  preferencesFile = path.join(app.getPath('userData'), 'preferences.json');
  tokenSourcesFile = path.join(app.getPath('userData'), 'token-sources.json');
  confirmationsFile = path.join(app.getPath('userData'), 'confirmations.json');
  githubCacheDir = path.join(app.getPath('userData'), 'github-scans');
  githubClonesDir = path.join(app.getPath('userData'), 'github-clones');
  // Copies left from a scan that was stopped are removed. Kept copies are not touched.
  gitClone.resetDir(path.join(githubClonesDir, 'tmp'));
  scanRulesFile = path.join(app.getPath('userData'), 'scan-rules.json');
  docsFile = path.join(app.getPath('userData'), 'api-docs.json');
  docSettingsFile = path.join(app.getPath('userData'), 'doc-agent-settings.json');
  payloadsFile = path.join(app.getPath('userData'), 'payloads.json');
  variablesFile = path.join(app.getPath('userData'), 'variables.json');
  envFile = path.join(app.getPath('userData'), 'environments.json');
  overridesFile = path.join(app.getPath('userData'), 'environment-overrides.json');
  hiddenFile = path.join(app.getPath('userData'), 'environment-hidden.json');
  lastSnapshotFile = path.join(app.getPath('userData'), 'snapshot', 'last-snapshot.json');
  envCacheFile = path.join(app.getPath('userData'), 'snapshot', 'environments.json');
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CONTENT_POLICY] },
    });
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
