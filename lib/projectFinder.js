// Finds projects inside a parent folder, so the user can confirm them before a scan. Projects are grouped by build or
// manifest files, then source files are inspected with the built-in framework scanners and any configured custom rules.
const fs = require('fs');
const path = require('path');
const { scanSource } = require('./sourceScanner');
const { activeRules, isSkippedPath } = require('./scanRules');
const { fileMatcher } = require('./githubScan');
const { SKIP_DIRS, MAX_FILE_BYTES } = require('./localScan');
const { readSpringName } = require('./springName');

const MANIFEST = /^(pom\.xml|build\.gradle|build\.gradle\.kts|package\.json|go\.mod|pyproject\.toml|setup\.py|requirements\.txt|Pipfile|Cargo\.toml|composer\.json|.+\.csproj)$/i;
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
function scanFile(file, serviceName, rules) {
  try {
    if (fs.statSync(file.abs).size > MAX_FILE_BYTES) return { operations: 0, language: '', framework: '' };
    const text = fs.readFileSync(file.abs, 'utf8');
    const scanned = scanSource(text, { file: file.rel, serviceName, serviceId: 'preview', rules });
    return { operations: scanned.operations.length, language: scanned.language, framework: scanned.framework };
  } catch {
    return { operations: 0, language: '', framework: '' };
  }
}

/**
 * Projects under root include their detected languages and frameworks. `manifest` is the project-list display label;
 * `buildFile` retains the actual manifest filename.
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
    const languages = new Set();
    const frameworks = new Set();
    for (const f of group.files) {
      const scanned = scanFile(f, name, rules);
      operations += scanned.operations;
      if (scanned.language && scanned.operations > 0) languages.add(scanned.language);
      if (scanned.framework && scanned.operations > 0) frameworks.add(scanned.framework);
    }
    if (operations === 0) {
      withoutEndpoints++;
      continue;
    }
    const stackLabel = [group.manifest, ...languages, ...frameworks].filter(Boolean).join(' · ');
    projects.push({
      path: key,
      name,
      manifest: stackLabel,
      buildFile: group.manifest,
      languages: [...languages].sort(),
      frameworks: [...frameworks].sort(),
      files: group.files.length,
      operations,
      absolute: path.join(root, key),
    });
  }
  projects.sort((a, b) => a.path.localeCompare(b.path));
  const notes = withoutEndpoints > 0 ? [`${withoutEndpoints} folder(s) with no endpoints were left out.`] : [];
  return { projects, notes };
}

module.exports = { findProjects, scanTree, MANIFEST };
