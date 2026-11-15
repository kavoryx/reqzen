// Getting an access token from a token type the user set up for an environment. A token type either calls an API from
// the open snapshot, or sends its own request to a token address on an allowed host.
// It needs no access token unless the type says so. Only the token field is read from the response; the response is
// never shown to the page.
const { allowedHosts, WRITE_METHODS, MAX_BODY_BYTES } = require('./runPolicy');

const MAX_BODY_CHARS = 200 * 1024;
const MAX_TOKEN_CHARS = 8000;
const MAX_URL_CHARS = 2000;
const MAX_HEADER_CHARS = 4000;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/;
// Headers a token request may not set itself. Authorization is added only by the "use the access token box" option.
const FORBIDDEN_HEADERS = new Set(['authorization', 'host', 'content-length', 'connection', 'transfer-encoding', 'proxy-authorization', 'x-target-authorization']);
const DEFAULT_FIELD = 'access_token';
// A Basic credential as curl sends it: "Basic " plus base64 of client_id:secret.
const BASIC_CREDENTIAL = /^Basic [A-Za-z0-9+/]+=*$/;
const AUTH_MODES = ['none', 'bearer', 'basic'];

/** Reads "Name: value" lines. Returns the clean headers and the problems. */
function parseHeaderLines(textValue) {
  const headers = [];
  const problems = [];
  for (const raw of String(textValue || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const colon = line.indexOf(':');
    const name = colon > 0 ? line.slice(0, colon).trim() : '';
    const value = colon > 0 ? line.slice(colon + 1).trim() : '';
    if (!HEADER_NAME.test(name)) {
      problems.push(`Header "${line.slice(0, 40)}" must look like "Name: value".`);
    } else if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      problems.push(`${name}: this header cannot be set here. Use the authorization option instead.`);
    } else if (/[\r\n]/.test(value) || value.length > MAX_HEADER_CHARS) {
      problems.push(`${name}: the value is not allowed.`);
    } else {
      headers.push({ name, value });
    }
  }
  return { headers, problems };
}

/**
 * Checks one token type and returns the cleaned values. Mode "api" needs the API that returns the token (operationId).
 * Mode "request" needs the token address, method and headers. Both use the same token field and body rules.
 */
function validateTokenType(input) {
  const src = input || {};
  const problems = [];
  const mode = src.mode === 'request' ? 'request' : 'api';
  const auth = AUTH_MODES.includes(src.auth) ? src.auth : 'none';
  const basic = auth === 'basic' ? String(src.basic || '').trim() : '';
  if (auth === 'basic' && !BASIC_CREDENTIAL.test(basic)) {
    problems.push('The Basic credential is missing or not valid. Paste the curl command that has the -u or Authorization: Basic header.');
  }
  const contentType = src.contentType === 'form' ? 'form' : 'json';
  const body = typeof src.body === 'string' ? src.body : '';
  const tokenField = String(src.tokenField || '').trim() || DEFAULT_FIELD;
  let operationId = '';
  let url = '';
  let method = '';
  let headers = '';

  if (mode === 'api') {
    operationId = String(src.operationId || '').trim().slice(0, 200);
    if (operationId === '') problems.push('Choose the API that returns the token.');
    method = '';
  } else {
    url = String(src.url || '').trim();
    method = String(src.method || 'POST').toUpperCase();
    if (!METHODS.includes(method)) problems.push('Choose a method: GET, POST, PUT, PATCH or DELETE.');
    if (url === '') problems.push('Enter the token address, or paste the curl command for it.');
    else if (!/^https:\/\//i.test(url)) problems.push('Only https addresses can be used.');
    if (url.length > MAX_URL_CHARS) problems.push(`The address must be ${MAX_URL_CHARS} characters or fewer.`);
    if (/[\r\n]/.test(url)) problems.push('The address must not contain a line break.');
    const parsed = parseHeaderLines(src.headers);
    problems.push(...parsed.problems);
    headers = parsed.headers.map((h) => `${h.name}: ${h.value}`).join('\n');
  }

  if (body.length > MAX_BODY_CHARS) problems.push('The request body is larger than 200 KB.');
  if (contentType === 'form' && body.trim().startsWith('{')) {
    problems.push('The body is JSON but the body format is form fields. Choose JSON as the body format, or write the body as name=value pairs.');
  }
  if (contentType === 'json' && body.trim() !== '') {
    try {
      JSON.parse(body);
    } catch {
      problems.push('The request body is not valid JSON.');
    }
  }
  if (!FIELD_PATH.test(tokenField)) problems.push('The token field must be a name such as access_token, or a path such as data.access_token.');

  return {
    problems,
    value: { mode, operationId, url, method, headers, contentType, body, tokenField, auth, basic },
  };
}

/** Kept for the API-only call shape used by the existing tests. */
function validateTokenSource(input) {
  return validateTokenType({ ...(input || {}), mode: 'api' });
}

/**
 * The policy for a token call. It needs https and a host in an enabled environment or service override. It confirms
 * writes and incomplete contracts. A type that uses the access token box needs one.
 */
function checkTokenRun(snapshot, run, operation, env) {
  const problems = [];
  if (!env || !env.enabled) problems.push('Choose an environment that is turned on in this snapshot.');
  let url = null;
  try {
    url = new URL(run.url);
  } catch {
    problems.push('The token request address is not valid.');
  }
  if (url) {
    if (url.protocol !== 'https:') problems.push('Only https addresses can be used.');
    if (url.username || url.password) problems.push('Addresses with a user name or password are refused.');
    const allowed = allowedHosts(snapshot);
    if (!allowed.has(url.host.toLowerCase())) {
      problems.push(`The host ${url.host} is not an enabled environment or service host in this workspace.`);
    }
  }
  const method = String(run.method || '').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS', ...WRITE_METHODS].includes(method)) problems.push('This method cannot be used for a token request.');
  if (WRITE_METHODS.has(method) && run.confirmWrite !== true) problems.push(`${method} changes data. Confirm to request the token.`);
  if (operation && operation.schemaComplete === false && run.acceptIncomplete !== true) {
    problems.push('This API’s contract is incomplete. Confirm to use it for the token request anyway.');
  }
  if (run.body !== null && run.body !== undefined && Buffer.byteLength(String(run.body), 'utf8') > MAX_BODY_BYTES) {
    problems.push('The request body is larger than 1 MB.');
  }
  for (const [name, value] of Object.entries(run.headers || {})) {
    if (!HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) problems.push(`${name}: this header cannot be set for a token request.`);
    if (/[\r\n]/.test(String(value)) || String(value).length > MAX_HEADER_CHARS) problems.push(`${name}: the value is not allowed.`);
  }
  if (run.auth === 'bearer' && (typeof run.bearer !== 'string' || run.bearer.trim() === '')) {
    problems.push('This token type uses the access token box. Type or paste an access token there first.');
  }
  if (run.auth === 'basic' && !BASIC_CREDENTIAL.test(String(run.basic || ''))) {
    problems.push('This token type’s Basic credential is missing. Edit the token type and paste its curl again.');
  }
  return problems;
}

/** Reads the token from a JSON response. Only a short text or number is accepted, with no line breaks. */
function extractToken(bodyText, field) {
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    return { ok: false, problem: 'The token response is not JSON.' };
  }
  let value = data;
  for (const part of String(field || DEFAULT_FIELD).split('.')) {
    value = value && typeof value === 'object' && !Array.isArray(value) ? value[part] : undefined;
  }
  const token = typeof value === 'number' ? String(value) : value;
  if (typeof token !== 'string' || token.trim() === '' || token.length > MAX_TOKEN_CHARS || /[\r\n]/.test(token)) {
    return { ok: false, problem: `The token response has no usable "${field || DEFAULT_FIELD}" value.` };
  }
  return { ok: true, token: token.trim() };
}

module.exports = {
  AUTH_MODES, BASIC_CREDENTIAL, validateTokenType, validateTokenSource, checkTokenRun, extractToken, parseHeaderLines, DEFAULT_FIELD,
};
