// Requests the user builds by hand (or from a curl command) for APIs that are not in the imported contract. Stored on
// this computer. A saved request keeps no token: bearer auth reads the token box when it is sent.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_REQUESTS = 200;
const MAX_ROWS = 50;
const MAX_BODY = 200 * 1024;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const AUTH = new Set(['none', 'bearer', 'apikey']);
const KEY = /^[A-Za-z0-9._~-]{1,100}$/;

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function sanitizeRows(list) {
  return (Array.isArray(list) ? list : [])
    .filter((r) => r && typeof r === 'object' && KEY.test(String(r.key || '')))
    .slice(0, MAX_ROWS)
    .map((r) => ({ key: String(r.key), value: text(r.value, 2000), enabled: r.enabled !== false }));
}

/** Checks one request. Returns the cleaned value or the problems. */
function validate(input) {
  const problems = [];
  const name = text(input && input.name, 80).trim();
  if (name === '') problems.push('Name the request so you can find it again.');
  const method = text(input && input.method, 10).toUpperCase();
  if (!METHODS.has(method)) problems.push('Choose a method: GET, POST, PUT, PATCH or DELETE.');
  const url = text(input && input.url, 2000).trim();
  if (url === '') problems.push('Enter the address, or a path such as /v1/items.');
  const auth = AUTH.has(input && input.auth) ? input.auth : 'none';
  const body = text(input && input.body, MAX_BODY);
  if (input && typeof input.body === 'string' && input.body.length > MAX_BODY) problems.push('The body is larger than 200 KB.');
  if (/[\r\n]/.test(url)) problems.push('The address must not contain a line break.');
  const value = {
    name, method, url, auth,
    authKey: auth === 'apikey' ? text(input && input.authKey, 100).trim() : '',
    authValue: auth === 'apikey' ? text(input && input.authValue, 2000) : '',
    query: sanitizeRows(input && input.query),
    headers: sanitizeRows(input && input.headers),
    body,
  };
  if (auth === 'apikey' && !KEY.test(value.authKey)) problems.push('Give the API key header a name, for example X-API-Key.');
  for (const row of [...value.query, ...value.headers]) {
    if (row.value.includes('\n') || row.value.includes('\r')) problems.push(`${row.key}: the value must not contain a line break.`);
  }
  return { problems, value };
}

function load(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (Array.isArray(data) ? data : []).filter((r) => r && typeof r.id === 'string' && typeof r.name === 'string')
      .slice(0, MAX_REQUESTS);
  } catch {
    return [];
  }
}

function save(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list.slice(0, MAX_REQUESTS), null, 2), { mode: 0o600 });
}

const newId = () => `req:${crypto.randomUUID()}`;

module.exports = { validate, load, save, newId, MAX_REQUESTS };
