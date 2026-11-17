// Token types (User, Support, Service, Super, Customer, ...). They are not tied to an environment: any environment can run
// any type. A type either calls an API from the open snapshot or sends its own request to a token address. It names the
// field that holds the token, and says whether the access token box is sent with the call
// (default: no). Stored on this computer. Version 3 of the file holds one list. Versions 1 and 2 (per environment) are
// converted on load.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateTokenType, DEFAULT_FIELD } = require('./tokenFetch');
const library = require('./library');

const MAX_TYPES = 40;
const MAX_NAME = 60;
const MAX_VALUE_CHARS = 8000;
const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
const WORKSPACE_FORMAT = 'api-explorer-workspace';
const WORKSPACE_VERSION = 1;

const newTypeId = () => `tt:${crypto.randomUUID()}`;
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Checks one token type. `existing` lists every saved type; names must be unique across them. */
function validateType(input, existing, selfId) {
  const problems = [];
  const name = String((input && input.name) || '').trim();
  if (name === '') problems.push('Name the token type, for example Support token.');
  if (name.length > MAX_NAME) problems.push(`The name must be ${MAX_NAME} characters or fewer.`);
  if (name !== '' && existing.some((t) => t.id !== selfId && t.name.toLowerCase() === name.toLowerCase())) {
    problems.push('A token type with this name already exists.');
  }
  if (!selfId && existing.length >= MAX_TYPES) problems.push(`You can keep up to ${MAX_TYPES} token types.`);
  const cfg = validateTokenType(input);
  problems.push(...cfg.problems);
  const operation = cfg.value.mode === 'api' && input && input.operation ? library.sanitizeItem(input.operation) : null;
  return { problems, value: { name, ...cfg.value, operation: operation || null } };
}

function sanitizeType(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const mode = raw.mode === 'request' ? 'request' : 'api';
  const operationId = text(raw.operationId, 200);
  const operation = mode === 'api' && raw.operation ? library.sanitizeItem(raw.operation) : null;
  const url = text(raw.url, 2000);
  if (mode === 'api' && operationId === '' && !operation) return null;
  if (mode === 'request' && url === '') return null;
  return {
    id: text(raw.id, 100) || newTypeId(),
    name: text(raw.name, MAX_NAME).trim() || 'Token',
    mode,
    operationId,
    operation,
    url: mode === 'request' ? url : '',
    method: mode === 'request' ? (text(raw.method, 10).toUpperCase() || 'POST') : '',
    headers: mode === 'request' ? text(raw.headers, 4000) : '',
    contentType: raw.contentType === 'form' ? 'form' : 'json',
    tokenField: text(raw.tokenField, 100) || DEFAULT_FIELD,
    body: text(raw.body, 200 * 1024),
    // Types saved before this option existed sent no access token, so "none" is the right default for them too.
    auth: ['bearer', 'basic'].includes(raw.auth) ? raw.auth : 'none',
    basic: raw.auth === 'basic' ? text(raw.basic, 2000) : '',
  };
}

/** Reads any saved shape into one list of types. Per-environment files are flattened; version 1 entries become "Token". */
function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  if (raw.version === 3) {
    return (Array.isArray(raw.types) ? raw.types : []).map(sanitizeType).filter(Boolean).slice(0, MAX_TYPES);
  }
  const out = [];
  if (raw.version === 2) {
    const envs = raw.environments && typeof raw.environments === 'object' && !Array.isArray(raw.environments) ? raw.environments : {};
    for (const entry of Object.values(envs)) {
      for (const t of Array.isArray(entry && entry.types) ? entry.types : []) {
        const type = sanitizeType(t);
        if (type && !out.some((o) => o.id === type.id)) out.push(type);
      }
    }
    return out.slice(0, MAX_TYPES);
  }
  for (const cfg of Object.values(raw)) {
    const type = sanitizeType({ ...(cfg || {}), name: 'Token' });
    if (type) out.push(type);
  }
  return out.slice(0, MAX_TYPES);
}

function load(file) {
  try {
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return [];
  }
}

function save(file, types) {
  const clean = normalize({ version: 3, types });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 3, types: clean }, null, 2), { mode: 0o600 });
  return clean;
}

/** The fields of a type that go into a workspace file, without its id. */
function portable(t) {
  const { id, ...rest } = t;
  return rest;
}

/**
 * The rows for a workspace file: one per token type. Token values, when given, are stored under the environment name
 * they were fetched for (values is keyed "environmentId|typeId"), so they are only used for that environment again.
 */
function exportRows(types, envNames, values) {
  return types.map((t) => {
    const row = portable(t);
    // The Basic credential is a secret: it leaves the file unless token values are included.
    if (!values) delete row.basic;
    if (values) {
      const tokenValues = {};
      for (const [envId, envName] of Object.entries(envNames)) {
        const value = values[`${envId}|${t.id}`];
        if (typeof value === 'string' && value !== '') tokenValues[envName] = value.slice(0, MAX_VALUE_CHARS);
      }
      if (Object.keys(tokenValues).length > 0) row.tokenValues = tokenValues;
    }
    return row;
  });
}

/**
 * Adds token types from a workspace file. A type whose name is already used is skipped. Token values are applied only for
 * environments that exist in this snapshot. Returns the new list, the values to use in this session, and what was skipped.
 */
function mergeRows(types, rows, envIdByName) {
  const next = normalize({ version: 3, types });
  const applied = [];
  const skipped = [];
  for (const row of rows) {
    if (next.some((t) => t.name.toLowerCase() === row.name.toLowerCase())) {
      skipped.push(`${row.name}: already set up here.`);
      continue;
    }
    if (next.length >= MAX_TYPES) {
      skipped.push(`${row.name}: you already have ${MAX_TYPES} token types.`);
      continue;
    }
    const type = sanitizeType({ ...row, id: newTypeId() });
    if (!type) continue;
    next.push(type);
    for (const [envName, value] of Object.entries(row.tokenValues || {})) {
      const envId = envIdByName[String(envName).toLowerCase()];
      if (envId) applied.push({ environmentId: envId, typeId: type.id, value });
    }
  }
  return { types: next, applied, skipped };
}

/** The workspace file: every collection and favourite, the token types, and token values only when asked for. */
function exportWorkspace(lib, rows, includeValues, now = new Date()) {
  const cleanRows = includeValues ? rows : rows.map(({ tokenValues, ...rest }) => rest);
  return {
    format: WORKSPACE_FORMAT,
    formatVersion: WORKSPACE_VERSION,
    exportedAt: now.toISOString(),
    includesTokenValues: includeValues === true,
    favourites: lib.favourites,
    collections: lib.collections.map((c) => ({ name: c.name, items: c.items })),
    tokenTypes: cleanRows,
  };
}

/** Reads a workspace file. Returns the cleaned parts, or the problems. */
function parseWorkspace(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_IMPORT_BYTES) {
    return { ok: false, problems: ['The file is larger than 4 MB or is not text.'] };
  }
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    return { ok: false, problems: ['The file is not valid JSON.'] };
  }
  if (!data || data.format !== WORKSPACE_FORMAT) return { ok: false, problems: ['This is not a Reqzen workspace file.'] };
  if (data.formatVersion !== WORKSPACE_VERSION) {
    return { ok: false, problems: [`Workspace format version ${String(data.formatVersion)} is not supported by this app.`] };
  }
  const lib = library.sanitizeStore({ favourites: data.favourites, collections: data.collections });
  const rows = (Array.isArray(data.tokenTypes) ? data.tokenTypes : []).map((r) => {
    if (!r || typeof r !== 'object' || typeof r.name !== 'string') return null;
    const type = sanitizeType({ ...r, id: '' });
    if (!type) return null;
    const tokenValues = {};
    if (r.tokenValues && typeof r.tokenValues === 'object' && !Array.isArray(r.tokenValues)) {
      for (const [envName, value] of Object.entries(r.tokenValues)) {
        if (typeof value === 'string' && value.trim() !== '' && value.length <= MAX_VALUE_CHARS && !/[\r\n]/.test(value)) {
          tokenValues[String(envName).slice(0, 120)] = value.trim();
        }
      }
    }
    return { ...portable(type), ...(Object.keys(tokenValues).length > 0 ? { tokenValues } : {}) };
  }).filter(Boolean);
  return { ok: true, favourites: lib.favourites, collections: lib.collections, tokenRows: rows, includesTokenValues: data.includesTokenValues === true };
}

module.exports = {
  validateType, normalize, load, save, exportRows, mergeRows, exportWorkspace, parseWorkspace, newTypeId, MAX_TYPES,
};
