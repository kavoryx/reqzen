// Reads the service name a Spring Boot project declares: spring.application.name in application.properties,
// application.yml or application.yaml. Plain file reading, no model needed. Files under src/main/resources are preferred,
// test folders and profile files (application-dev.yml) are ignored.
const fs = require('fs');
const path = require('path');

const SKIP = new Set(['node_modules', '.git', 'target', 'build', 'dist', 'out', 'bin', 'obj', '.idea', '.gradle', '__pycache__', 'test']);
// application files first; bootstrap files (Spring Cloud) are a fallback.
const FILE_ORDER = ['application.properties', 'application.yml', 'application.yaml', 'bootstrap.properties', 'bootstrap.yml', 'bootstrap.yaml'];
/** Folder names that say nothing about the service (a Java or Node source layout). */
const GENERIC_FOLDERS = new Set(['src', 'main', 'java', 'kotlin', 'resources', 'target']);
const MAX_DEPTH = 6;
const MAX_ENTRIES = 5000;
const MAX_FILE_BYTES = 256 * 1024;

/** A usable service name, or null (empty, a placeholder such as ${APP}, or characters a URL would not take). */
function cleanValue(value) {
  let s = String(value || '').replace(/\s+#.*$/, '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
  if (s === '' || s.includes('${')) return null;
  return /^[A-Za-z0-9._-]{1,100}$/.test(s) ? s : null;
}

/** spring.application.name from YAML text, read by indentation (enough for this one key path). */
function yamlName(text) {
  const stack = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---')) continue;
    const indent = raw.length - raw.trimStart().length;
    const m = /^("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*:(?:\s+(.*))?$/.exec(trimmed);
    if (!m) continue;
    const key = m[1].replace(/^["']|["']$/g, '');
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    if (stack.map((s) => s.key).join('.') === 'spring.application' && key === 'name') {
      const value = cleanValue(m[2]);
      if (value) return value;
    }
    const rest = (m[2] || '').trim();
    if (rest === '' || rest.startsWith('#')) stack.push({ indent, key });
  }
  return null;
}

/** spring.application.name from .properties text. */
function propertiesName(text) {
  for (const raw of String(text).split(/\r?\n/)) {
    const m = /^\s*spring\.application\.name\s*[=:]\s*(.*)$/.exec(raw);
    if (m) {
      const value = cleanValue(m[1].replace(/\s+[#!].*$/, ''));
      if (value) return value;
    }
  }
  return null;
}

/** The service name of the project under dir, or null when no application file declares one. */
function readSpringName(dir) {
  const found = [];
  const stack = [{ dir, depth: 0 }];
  let seen = 0;
  while (stack.length > 0 && seen < MAX_ENTRIES) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      seen++;
      if (e.isSymbolicLink()) continue;
      const abs = path.join(cur.dir, e.name);
      if (e.isDirectory()) {
        if (cur.depth < MAX_DEPTH && !SKIP.has(e.name) && !e.name.startsWith('.')) stack.push({ dir: abs, depth: cur.depth + 1 });
      } else if (e.isFile() && FILE_ORDER.includes(e.name)) {
        found.push(abs);
      }
    }
  }
  const rank = (p) => [p.split(path.sep).join('/').includes('src/main/resources/') ? 0 : 1, FILE_ORDER.indexOf(path.basename(p))];
  found.sort((a, b) => {
    const [ra, fa] = rank(a);
    const [rb, fb] = rank(b);
    return ra - rb || fa - fb || a.localeCompare(b);
  });
  for (const file of found) {
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
      const text = fs.readFileSync(file, 'utf8');
      const name = file.endsWith('.properties') ? propertiesName(text) : yamlName(text);
      if (name) return name;
    } catch {
      // An unreadable file is skipped; the next one is tried.
    }
  }
  return null;
}

module.exports = { readSpringName, yamlName, propertiesName, cleanValue, GENERIC_FOLDERS };
