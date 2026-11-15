// The desktop library: favourite APIs and collections of APIs, kept on this computer. Sharing is by file: the app's own
// format, or Postman Collection v2.1. Neither file contains tokens, variable values, saved payloads or environment hosts.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_COLLECTIONS = 50;
const MAX_ITEMS = 500;
const MAX_FAVOURITES = 200;
const MAX_NAME = 80;
const MAX_TEXT = 300;
const MAX_DEFAULT_BODY = 100 * 1024;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const FORMAT = 'api-explorer-collection';
const FORMAT_VERSION = 1;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** One saved API. The key is what identifies it across snapshots: method, path, service and version. */
function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const item = {
    operationId: text(raw.operationId, 200),
    serviceName: text(raw.serviceName, MAX_TEXT),
    contractVersion: text(raw.contractVersion, 100),
    httpMethod: text(raw.httpMethod, 10).toUpperCase(),
    pathTemplate: text(raw.pathTemplate, 500),
    summary: text(raw.summary, MAX_TEXT),
    contextPath: text(raw.contextPath, 200),
    defaultBody: text(raw.defaultBody, MAX_DEFAULT_BODY),
  };
  if (!item.httpMethod || !item.pathTemplate || !item.serviceName) return null;
  return item;
}

const itemKey = (item) => `${item.httpMethod} ${item.serviceName} ${item.contractVersion} ${item.pathTemplate}`;

function uniqueItems(list, max) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const item = sanitizeItem(raw);
    if (!item || seen.has(itemKey(item))) continue;
    seen.add(itemKey(item));
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

function sanitizeCollection(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: text(raw.id, 100) || newCollectionId(),
    name: text(raw.name, MAX_NAME).trim() || 'Untitled collection',
    items: uniqueItems(Array.isArray(raw.items) ? raw.items : [], MAX_ITEMS),
  };
}

/** A clean library: bad entries are dropped and limits are applied, so a damaged file cannot break the page. */
function sanitizeStore(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const collections = (Array.isArray(data.collections) ? data.collections : [])
    .map(sanitizeCollection).filter(Boolean).slice(0, MAX_COLLECTIONS);
  return {
    favourites: uniqueItems(Array.isArray(data.favourites) ? data.favourites : [], MAX_FAVOURITES),
    collections,
  };
}

function newCollectionId() {
  return `col:${crypto.randomUUID()}`;
}

function load(file) {
  try {
    return sanitizeStore(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return sanitizeStore({});
  }
}

function save(file, store) {
  const clean = sanitizeStore(store);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(clean, null, 2), { mode: 0o600 });
  return clean;
}

/** The app's own file format. Only the API identity and the contract's default body are included. */
function exportApp(collection, now = new Date()) {
  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    name: collection.name,
    exportedAt: now.toISOString(),
    items: collection.items.map((i) => ({
      operationId: i.operationId, serviceName: i.serviceName, contractVersion: i.contractVersion,
      httpMethod: i.httpMethod, pathTemplate: i.pathTemplate, summary: i.summary,
      contextPath: i.contextPath, defaultBody: i.defaultBody,
    })),
  };
}

/** Reads a collection file made by exportApp. Returns the collection to add, or the problems. */
function importApp(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_IMPORT_BYTES) {
    return { ok: false, problems: ['The file is larger than 2 MB or is not text.'] };
  }
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    return { ok: false, problems: ['The file is not valid JSON.'] };
  }
  if (!data || data.format !== FORMAT) return { ok: false, problems: ['This is not a Reqnara collection file.'] };
  if (data.formatVersion !== FORMAT_VERSION) {
    return { ok: false, problems: [`Collection format version ${String(data.formatVersion)} is not supported by this app.`] };
  }
  const collection = sanitizeCollection({ name: data.name, items: Array.isArray(data.items) ? data.items : [] });
  if (collection.items.length === 0) return { ok: false, problems: ['The collection has no valid APIs.'] };
  return { ok: true, collection: { ...collection, id: newCollectionId() } };
}

/** Postman Collection v2.1. The base URL and token are Postman variables the user sets after importing. */
function exportPostman(collection, now = new Date()) {
  return {
    info: {
      _postman_id: crypto.randomUUID(),
      name: collection.name,
      description: `Exported from Reqnara on ${now.toISOString()}. Set baseUrl (the environment host) and accessToken before sending.`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: collection.items.map(postmanItem),
    variable: [{ key: 'baseUrl', value: '' }, { key: 'accessToken', value: '' }],
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }] },
  };
}

function postmanItem(item) {
  const segments = `${item.contextPath || ''}${item.pathTemplate}`.split('/').filter(Boolean)
    .map((s) => s.replace(/\{([^}]+)\}/g, ':$1'));
  const request = {
    method: item.httpMethod,
    header: [],
    url: { raw: `{{baseUrl}}/${segments.join('/')}`, host: ['{{baseUrl}}'], path: segments },
    description: `${item.serviceName} ${item.contractVersion}`,
  };
  if (BODY_METHODS.has(item.httpMethod) && item.defaultBody) {
    request.body = { mode: 'raw', raw: item.defaultBody, options: { raw: { language: 'json' } } };
  }
  return { name: item.summary || `${item.httpMethod} ${item.pathTemplate}`, request };
}

/** A file name that is safe on macOS and Windows. */
function fileNameFor(name, suffix) {
  const base = String(name).replace(/[^A-Za-z0-9 _.-]+/g, '_').trim().slice(0, 60) || 'collection';
  return `${base}${suffix}`;
}

module.exports = {
  sanitizeStore, sanitizeItem, load, save, exportApp, importApp, exportPostman, fileNameFor, itemKey,
  MAX_COLLECTIONS, MAX_ITEMS, MAX_FAVOURITES,
};
