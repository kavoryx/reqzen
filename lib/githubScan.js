// Reads API routes from source files in GitHub folders and builds one catalog (an API Explorer snapshot) from them.
// Built-in source scanners detect common frameworks; custom annotation rules remain available (see scanRules.js).
// Only api.github.com and raw.githubusercontent.com are contacted. Files and folders are limited in size and number.
// A token, if given, is used for this scan only and is never written to disk or returned.
const crypto = require('crypto');
const https = require('https');
const { scanSource, sourceExtensions, isBuiltInRules } = require('./sourceScanner');
const { stableId } = require('./openapi');
const { activeRules, isSkippedPath } = require('./scanRules');

const ALLOWED_HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com']);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES_PER_SOURCE = 300;
const MAX_LISTINGS = 80;
const MAX_DEPTH = 5;
const NAME_PART = /^[A-Za-z0-9._-]{1,100}$/;

/** Reads "owner/repo", a GitHub URL, or a GitHub tree URL (with a branch). Returns null when it is not a repository. */
function parseRepo(input) {
  const text = String(input || '').trim().replace(/\.git$/, '').replace(/\/$/, '');
  let m = text.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.*))?)?$/i);
  if (m) return { owner: m[1], repo: m[2], ref: m[3] || '', path: m[4] || '' };
  m = text.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (m) return { owner: m[1], repo: m[2], ref: '', path: '' };
  return null;
}

/** Splits a folder path, refusing ".." and empty or odd parts. */
function cleanPath(p) {
  const parts = String(p || '').split('/').map((s) => s.trim()).filter(Boolean);
  if (parts.some((s) => s === '..' || s === '.' || !NAME_PART.test(s))) return null;
  return parts.join('/');
}

/** The real HTTPS reader. Refuses other hosts, follows no redirects, and stops at the size limit. */
function httpGet(url, headers, maxBytes) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error('An address is not valid.'));
      return;
    }
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.host.toLowerCase())) {
      reject(new Error(`The host ${u.host} is not allowed for GitHub scanning.`));
      return;
    }
    const req = https.request({ protocol: 'https:', hostname: u.hostname, path: `${u.pathname}${u.search}`, method: 'GET', headers, timeout: 20000 }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy(new Error('A file is larger than the limit, so it was skipped.'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('GitHub did not answer in time.')));
    req.on('error', reject);
    req.end();
  });
}

function githubHeaders(token) {
  const h = { 'User-Agent': 'API-Explorer', Accept: 'application/vnd.github+json' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** Hides the token if an error message ever contains it. */
function scrub(message, token) {
  return token ? String(message).split(token).join('••••') : String(message);
}

/** The file test for built-in language scanners or custom rules, minus the names the active rules skip. */
function fileMatcher(rules) {
  const checked = activeRules(rules);
  const exts = sourceExtensions(checked).map((e) => e.replace(/\./g, '\\.'));
  const ext = new RegExp(`(${exts.join('|')})$`, 'i');
  const skip = checked.skipFilePattern ? new RegExp(checked.skipFilePattern, 'i') : null;
  const autoSourceTest = /(?:\.test\.[^.]+|\.spec\.[^.]+|^test_.*\.py$|.*_test\.py$)/i;
  return (name) => ext.test(name) && !(skip && skip.test(name)) && (isBuiltInRules(checked) ? !autoSourceTest.test(name) : true);
}

/**
 * Lists the source files under one folder of one repository (recursively, up to a depth and a count). Returns the files
 * and the messages about what was skipped.
 */
async function listSourceFiles(repo, folder, opts) {
  const files = [];
  const notes = [];
  let listings = 0;
  const walk = async (dir, depth) => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES_PER_SOURCE) return;
    if (listings >= MAX_LISTINGS) {
      notes.push('The folder is large. Only part of it was read; choose a smaller folder.');
      return;
    }
    listings++;
    const ref = repo.ref ? `?ref=${encodeURIComponent(repo.ref)}` : '';
    const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/contents/${dir}${ref}`;
    const res = await opts.get(url, githubHeaders(opts.token), 1024 * 1024);
    if (res.status === 404) throw new Error('The repository or folder was not found. Check the address, the folder, and the token’s access.');
    if (res.status === 403 || res.status === 429) throw new Error('GitHub refused the request (rate limit or access). Try again later or give a token.');
    if (res.status !== 200) throw new Error(`GitHub answered HTTP ${res.status}.`);
    const entries = JSON.parse(res.body);
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      if (e.type === 'dir') {
        if (!isSkippedPath(opts.rules, `${e.path}/`)) await walk(e.path, depth + 1);
      }
      else if (e.type === 'file' && opts.matchFile(e.name) && !isSkippedPath(opts.rules, e.path)) {
        if (typeof e.size === 'number' && e.size > MAX_FILE_BYTES) notes.push(`${e.path}: larger than 512 KB, skipped.`);
        else files.push({ path: e.path, url: e.download_url });
      }
    }
  };
  await walk(folder, 0);
  return { files, notes };
}

/** Returns the id of a service, creating it in the list the first time its name is seen. */
function serviceFor(name, serviceByName, services) {
  if (!serviceByName.has(name)) {
    const sid = stableId(`service:${name}`);
    serviceByName.set(name, sid);
    services.push({ serviceId: sid, name, contextPath: '' });
  }
  return serviceByName.get(name);
}

/**
 * Builds the snapshot text from services, operations and a report. One API seen twice under the same service keeps its first copy.
 * Shared by every scan (GitHub API, clone, local folder).
 */
function assembleCatalog(services, operations, report) {
  // One API can appear under two sources with the same service: keep the first.
  const seen = new Set();
  const unique = operations.filter((o) => {
    const k = `${o.serviceName} ${o.httpMethod} ${o.pathTemplate}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  report.operationCount = unique.length;
  const snapshot = {
    format: 'api-explorer-snapshot',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    exportedBy: 'GitHub scan',
    services,
    environments: [],
    serviceOverrides: [],
    operations: unique,
  };
  return { text: JSON.stringify(snapshot), report };
}

/**
 * Builds a catalog from a list of sources: { repo: "owner/repo" or URL, path: folder inside the repo, service: name }.
 * `get` is the HTTP reader (injected for tests). Returns the snapshot text and a report per file.
 */
async function buildCatalog(sources, opts) {
  const get = opts.get || httpGet;
  const token = opts.token || '';
  const rules = activeRules(opts.rules);
  const matchFile = fileMatcher(rules);
  const report = { sources: [], operationCount: 0, problems: [] };
  const operations = [];
  const services = [];
  const serviceByName = new Map();

  for (const src of sources) {
    const repo = parseRepo(src.repo);
    const folder = cleanPath(src.path || repo?.path || '');
    const label = repo ? `${repo.owner}/${repo.repo}${folder ? `/${folder}` : ''}` : String(src.repo || '');
    const serviceName = String(src.service || '').trim() || (folder ? folder.split('/').pop() : repo ? repo.repo : '');
    const entry = { source: label, service: serviceName, files: [], operations: 0, problems: [], languages: [], frameworks: [] };
    report.sources.push(entry);
    if (!repo) { entry.problems.push('This is not a GitHub repository address. Use owner/repo or a github.com URL.'); continue; }
    if (src.path && folder === null) { entry.problems.push('The folder path is not valid.'); continue; }
    if (!serviceName || !NAME_PART.test(serviceName)) { entry.problems.push('Give the service a name (letters, numbers, dots, dashes).'); continue; }

    let found;
    try {
      found = await listSourceFiles(repo, folder || '', { get, token, matchFile, rules });
    } catch (e) {
      entry.problems.push(scrub(e.message, token));
      continue;
    }
    entry.problems.push(...found.notes);
    if (found.files.length === 0) entry.problems.push(`No files with the extensions ${sourceExtensions(rules).join(', ')} were found in this folder.`);

    if (!serviceByName.has(serviceName)) {
      const sid = stableId(`service:${serviceName}`);
      serviceByName.set(serviceName, sid);
      services.push({ serviceId: sid, name: serviceName, contextPath: '' });
    }
    const serviceId = serviceByName.get(serviceName);

    for (const f of found.files) {
      const fileReport = { path: f.path, status: 'skipped', operations: 0, problems: [] };
      entry.files.push(fileReport);
      let res;
      try {
        res = await get(f.url, githubHeaders(token), MAX_FILE_BYTES);
      } catch (e) {
        fileReport.problems.push(scrub(e.message, token));
        continue;
      }
      if (res.status !== 200) { fileReport.problems.push(`The file could not be downloaded (HTTP ${res.status}).`); continue; }
      const scanned = scanSource(res.body, { file: f.path, serviceName, serviceId, rules });
      fileReport.language = scanned.language;
      fileReport.framework = scanned.framework;
      if (scanned.language && !entry.languages.includes(scanned.language)) entry.languages.push(scanned.language);
      if (scanned.framework && !entry.frameworks.includes(scanned.framework)) entry.frameworks.push(scanned.framework);
      if (scanned.controllers.length === 0 && scanned.operations.length === 0) {
        fileReport.status = 'no controller';
        continue;
      }
      fileReport.status = 'loaded';
      fileReport.controllers = scanned.controllers;
      fileReport.operations = scanned.operations.length;
      fileReport.problems.push(...scanned.problems);
      operations.push(...scanned.operations);
    }
    entry.operations = entry.files.reduce((n, f) => n + f.operations, 0);
    entry.problems.push(...entry.files.flatMap((f) => f.problems.map((p) => `${f.path}: ${p}`)));
  }

  return assembleCatalog(services, operations, report);
}

/**
 * A cache key from the sources and the rule set (never the token), so the same sources and rules reuse the same saved
 * scan. Changing the rules gives a new key. The version is part of the key, so a scan saved by an older reader is not reused.
 */
function cacheKey(sources, rules, mode = 'api') {
  const normalised = sources.map((s) => ({ repo: String(s.repo || '').trim(), path: String(s.path || '').trim(), service: String(s.service || '').trim() }));
  const r = activeRules(rules);
  return crypto.createHash('sha256').update(JSON.stringify({ v: 'source-scan-1', mode, normalised, rules: r })).digest('hex').slice(0, 32);
}

module.exports = { parseRepo, cleanPath, buildCatalog, cacheKey, httpGet, ALLOWED_HOSTS, fileMatcher, assembleCatalog, serviceFor };
