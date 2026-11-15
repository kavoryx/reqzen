// Finds the projects inside a parent folder, so the user can confirm them before a scan. A project is a folder with a
// build or manifest file (pom.xml, package.json, ...) that holds controllers. Source files outside any manifest folder are
// grouped by their top-level folder. Only projects with at least one endpoint are returned.
const fs = require('fs');
const path = require('path');
const { scanControllerSource } = require('./controllerScanner');
const { activeRules, isSkippedPath } = require('./scanRules');
const { fileMatcher } = require('./githubScan');
const { SKIP_DIRS, MAX_FILE_BYTES } = require('./localScan');
const { readSpringName } = require('./springName');

const MANIFEST = /^(pom\.xml|build\.gradle|build\.gradle\.kts|package\.json|go\.mod|pyproject\.toml|setup\.py|Cargo\.toml|composer\.json|.+\.csproj)$/i;
const MAX_DEPTH = 12; // Same as the scanner: a Java package path under a project folder is often 9 to 11 levels deep.
const MAX_FILES = 5000;

/** The project a file belongs to when no manifest is above it: the folder before its src folder, else its top-level folder. */
function looseProjectKey(rel) {
  const parts = rel.split('/');
  const src = parts.indexOf('src');
  if (src === 0) return '';
  if (src > 0) return parts.slice(0, src).join('/');
  return parts.length > 1 ? parts[0] : '';
}

/** One walk of the tree: the matching files, and the folders that hold a manifest (relative paths, "/" separators). */
function scanTree(root, rules, matchFile) {
  const files = [];
  const manifests = new Map();
  const stack = [{ dir: root, rel: '', depth: 0 }];
  while (stack.length > 0) {
    const { dir, rel, depth } = stack.pop();
    if (depth > MAX_DEPTH) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.') && !isSkippedPath(rules, `${childRel}/`)) {
          stack.push({ dir: path.join(dir, e.name), rel: childRel, depth: depth + 1 });
        }
      } else if (e.isFile()) {
        if (MANIFEST.test(e.name) && !manifests.has(rel)) manifests.set(rel, e.name);
        if (matchFile(e.name) && !isSkippedPath(rules, childRel) && files.length < MAX_FILES) {
          files.push({ abs: path.join(dir, e.name), rel: childRel });
        }
      }
    }
  }
  return { files, manifests };
}

/** The endpoints in one file, or 0 when it cannot be read. */
function countOperations(file, serviceName, rules) {
  try {
    if (fs.statSync(file.abs).size > MAX_FILE_BYTES) return 0;
    const text = fs.readFileSync(file.abs, 'utf8');
    return scanControllerSource(text, { file: file.rel, serviceName, serviceId: 'preview', rules }).operations.length;
  } catch {
    return 0;
  }
}

/**
 * Projects under root: [{ path (relative, "" for the root itself), name, manifest, files, operations, absolute }].
 * `notes` says how many folders without endpoints were left out.
 */
function findProjects(root, savedRules) {
  const rules = activeRules(savedRules);
  const { files, manifests } = scanTree(root, rules, fileMatcher(rules));
  const candidates = [...manifests.keys()];

  // Each file belongs to the deepest manifest folder above it. Files under no manifest are grouped by top-level folder.
  const groups = new Map();
  for (const file of files) {
    let owner = null;
    for (const c of candidates) {
      if ((c === '' || file.rel.startsWith(`${c}/`)) && (owner === null || c.length > owner.length)) owner = c;
    }
    const key = owner !== null ? owner : looseProjectKey(file.rel);
    if (!groups.has(key)) groups.set(key, { manifest: owner !== null ? manifests.get(owner) || '' : '', files: [] });
    groups.get(key).files.push(file);
  }

  const projects = [];
  let withoutEndpoints = 0;
  for (const [key, group] of groups) {
    const name = readSpringName(path.join(root, key)) || (key === '' ? path.basename(root) : path.basename(key));
    let operations = 0;
    for (const f of group.files) operations += countOperations(f, name, rules);
    if (operations === 0) {
      withoutEndpoints++;
      continue;
    }
    projects.push({ path: key, name, manifest: group.manifest, files: group.files.length, operations, absolute: path.join(root, key) });
  }
  projects.sort((a, b) => a.path.localeCompare(b.path));
  const notes = withoutEndpoints > 0 ? [`${withoutEndpoints} folder(s) with no endpoints were left out.`] : [];
  return { projects, notes };
}

module.exports = { findProjects, scanTree, MANIFEST };
