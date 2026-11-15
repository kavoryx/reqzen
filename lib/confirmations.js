// Which requests ask for confirmation before they are sent, per environment and HTTP method. Set in Environments.
// Defaults: a production environment asks before POST, PUT, PATCH and DELETE, but not before GET. Other environments ask
// for nothing. HEAD and OPTIONS follow GET. An unknown method always asks. Stored on this computer.
const fs = require('fs');
const path = require('path');

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const PRODUCTION_DEFAULTS = { GET: false, POST: true, PUT: true, PATCH: true, DELETE: true };
const OTHER_DEFAULTS = { GET: false, POST: false, PUT: false, PATCH: false, DELETE: false };

/** The method this setting applies to: HEAD and OPTIONS follow GET. */
function settingMethod(method) {
  const m = String(method || '').toUpperCase();
  return m === 'HEAD' || m === 'OPTIONS' ? 'GET' : m;
}

/** The settings for one environment: its saved values, or the defaults for its kind. `env` needs environmentId and production. */
function effective(saved, env) {
  const out = { ...(env && env.production === true ? PRODUCTION_DEFAULTS : OTHER_DEFAULTS) };
  const mine = saved && env ? saved[env.environmentId] : null;
  if (mine && typeof mine === 'object') {
    for (const m of METHODS) if (typeof mine[m] === 'boolean') out[m] = mine[m];
  }
  return out;
}

/** True when sending this method to this environment needs the environment name typed first. */
function requiredFor(saved, env, method) {
  const m = settingMethod(method);
  if (!METHODS.includes(m)) return true;
  return effective(saved, env)[m] === true;
}

/** Checks the settings from the page: one boolean per method, and a known environment id. */
function validate(input) {
  const problems = [];
  const methods = {};
  for (const m of METHODS) {
    const v = input && input[m];
    if (typeof v !== 'boolean') problems.push(`${m}: choose yes or no.`);
    else methods[m] = v;
  }
  return { problems, value: methods };
}

function load(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function save(file, map) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(map, null, 2), { mode: 0o600 });
  return map;
}

module.exports = { METHODS, effective, requiredFor, settingMethod, validate, load, save };
