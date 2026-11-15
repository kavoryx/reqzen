// Rules for sending a request from the desktop app. Pure functions, so they can be tested without Electron.
// The allow-list comes from the snapshot that was opened (kept in the main process), never from the page.

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const RESERVED = new Set(['authorization', 'proxy-authorization', 'cookie', 'host', 'content-length', 'x-target-authorization']);
const MAX_BODY_BYTES = 1024 * 1024;

/** Hosts the snapshot allows: the host of every enabled environment default and enabled service override. */
function allowedHosts(snapshot) {
  const hosts = new Set();
  const add = (url) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'https:') hosts.add(u.host.toLowerCase());
    } catch {
      // Not a URL: contributes no host.
    }
  };
  for (const env of snapshot.environments || []) {
    if (env.enabled) add(env.baseUrl);
  }
  for (const o of snapshot.serviceOverrides || []) {
    if (o.enabled) add(o.baseUrl);
  }
  return hosts;
}

/**
 * Checks one run. Returns { problems, production } where problems is the list of reasons to refuse (empty = allowed).
 * `run` is what the page sends: method, url, headers (without Authorization), body, environmentName,
 * confirmEnvironment, confirmWrite, acceptIncomplete, token.
 */
function checkRun(snapshot, run, operation) {
  const problems = [];
  const env = (snapshot.environments || []).find((e) => e.name === run.environmentName);
  if (!env || !env.enabled) problems.push('Choose an environment that is turned on in this snapshot.');
  // Whether the environment name must be typed is set per environment and method (see lib/confirmations.js).
  if (run.confirmRequired === true && run.confirmEnvironment !== run.environmentName) {
    problems.push(`Type the environment name exactly to confirm: ${run.environmentName || '(none)'}.`);
  }

  let url;
  try {
    url = new URL(run.url);
  } catch {
    problems.push('The request address is not valid.');
  }
  if (url) {
    if (url.protocol !== 'https:') problems.push('Only https addresses can be used.');
    if (url.username || url.password) problems.push('Addresses with a user name or password are refused.');
    if (!allowedHosts(snapshot).has(url.host.toLowerCase())) {
      problems.push(`The host ${url.host} is not an environment in this snapshot.`);
    }
  }

  const method = String(run.method || '').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS', ...WRITE_METHODS].includes(method)) problems.push('This method cannot be sent.');

  if (operation && operation.schemaComplete === false && run.acceptIncomplete !== true) {
    problems.push('This API’s contract is incomplete. Tick the confirmation to send it anyway.');
  }

  // A custom request with no auth needs no token; it may then set its own Authorization header.
  const noAuth = run.noAuth === true;
  if (!noAuth) {
    if (typeof run.token !== 'string' || run.token.trim() === '') problems.push('Enter the access token for this run.');
    if (/[\r\n]/.test(run.token || '')) problems.push('The token contains a line break.');
  }

  for (const name of Object.keys(run.headers || {})) {
    const lower = name.toLowerCase();
    const ownAuth = noAuth && lower === 'authorization';
    if (RESERVED.has(lower) && !ownAuth) problems.push(`${name}: this header cannot be set here.`);
    if (/[\r\n]/.test(String(run.headers[name]))) problems.push(`${name}: the value contains a line break.`);
  }
  if (run.body !== null && run.body !== undefined && Buffer.byteLength(String(run.body), 'utf8') > MAX_BODY_BYTES) {
    problems.push('The request body is larger than 1 MB.');
  }

  return { problems, production: env ? env.production === true : false };
}

/** Removes every copy of the token from text (body or header values) before it reaches the page. */
function scrubToken(text, token) {
  if (!token || typeof text !== 'string') return text;
  return text.split(token).join('[token removed]');
}

module.exports = { allowedHosts, checkRun, scrubToken, WRITE_METHODS, MAX_BODY_BYTES };
