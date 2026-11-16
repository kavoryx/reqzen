// The environments a user adds in the app. Kept in the app's own data folder on this computer, never in a snapshot.
const crypto = require('crypto');
const fs = require('fs');

const MAX_USER_ENVIRONMENTS = 50;

/** Checks one environment and returns the cleaned values. `taken` lists every existing name and id. */
function validate(input, taken, selfId) {
  const problems = [];
  const name = String((input && input.name) || '').trim();
  if (!name) problems.push('Name is required.');
  if (name.length > 80) problems.push('Name must be 80 characters or fewer.');
  if (name && taken.some((t) => t.id !== selfId && t.name.toLowerCase() === name.toLowerCase())) {
    problems.push('An environment with this name already exists.');
  }

  let baseUrl = '';
  let url = null;
  try {
    url = new URL(String((input && input.baseUrl) || '').trim());
  } catch {
    problems.push('The address is not a valid URL. Example: https://host.example.com or http://localhost:3000');
  }
  if (url) {
    if (!['https:', 'http:'].includes(url.protocol)) problems.push('The address must use http:// or https://.');
    if (url.username || url.password) problems.push('The address must not contain a user name or password.');
    if (url.search || url.hash) problems.push('The address must not contain a query or fragment.');
    if (url.pathname !== '/' && url.pathname !== '') problems.push('Enter only the host part, for example https://host.example.com or http://localhost:3000.');
    baseUrl = url.origin;
  }
  return {
    problems,
    value: { name, baseUrl, production: !!(input && input.production), enabled: !(input && input.enabled === false) },
  };
}

/** Reads the saved list. A missing or damaged file gives an empty list rather than an error. */
function load(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data.filter((e) => e && typeof e.id === 'string' && typeof e.name === 'string') : [];
  } catch {
    return [];
  }
}

function save(file, list) {
  fs.mkdirSync(require('path').dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2), { mode: 0o600 });
}

function newId() {
  return `yours:${crypto.randomUUID()}`;
}

/** Reads the saved address overrides for built-in (snapshot) environments: { environmentId: { baseUrl } }. */
function loadOverrides(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const out = {};
    for (const [id, v] of Object.entries(data)) {
      if (v && typeof v.baseUrl === 'string') out[id] = { baseUrl: v.baseUrl };
    }
    return out;
  } catch {
    return {};
  }
}

function saveOverrides(file, overrides) {
  fs.mkdirSync(require('path').dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(overrides, null, 2), { mode: 0o600 });
}

/**
 * Snapshot environments first, then the user's, in the same shape the snapshot uses. An address override replaces the
 * snapshot's default host for that environment only; the name, production flag and on/off state stay as the snapshot has them.
 */
function mergeEnvironments(snapshotEnvs, yours, overrides) {
  const snap = (snapshotEnvs || []).map((e) => {
    const o = overrides && overrides[e.environmentId];
    return o
      ? { ...e, baseUrl: o.baseUrl, yours: false, overridden: true, snapshotBaseUrl: e.baseUrl }
      : { ...e, yours: false, overridden: false };
  });
  const own = yours.map((e) => ({
    environmentId: e.id, name: e.name, production: e.production === true, enabled: e.enabled !== false, baseUrl: e.baseUrl, yours: true,
  }));
  return [...snap, ...own];
}

module.exports = { validate, load, save, newId, loadOverrides, saveOverrides, mergeEnvironments, MAX_USER_ENVIRONMENTS };
