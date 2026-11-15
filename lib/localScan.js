// Scans source files in folders on this computer, with the same rules, limits and report as the GitHub scan. Symbolic
// links are not followed, and common dependency or build folders are skipped. Only files the rules name are read.
const fs = require('fs');
const path = require('path');
const { scanControllerSource } = require('./controllerScanner');
const { activeRules, isSkippedPath } = require('./scanRules');
const { fileMatcher, assembleCatalog, serviceFor } = require('./githubScan');

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 3000;
const MAX_DEPTH = 12;
const { readSpringName, GENERIC_FOLDERS } = require('./springName');

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build', 'dist', 'out', 'bin', 'obj', '.idea', '.gradle', '__pycache__']);

/**
 * Lists the files under a folder that match the rules. Returns { files: [{abs, rel}], notes }. Relative paths use "/".
 */
function walk(root, matchFile, rules) {
  const files = [];
  const notes = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    if (depth > MAX_DEPTH) { notes.push('Some folders are nested too deeply and were skipped.'); continue; }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      notes.push(`A folder could not be read: ${path.relative(root, dir) || '.'}`);
      continue;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (!SKIP_DIRS.has(e.name) && !isSkippedPath(rules, `${rel}/`)) stack.push({ dir: abs, depth: depth + 1 });
      } else if (e.isFile() && matchFile(e.name) && !isSkippedPath(rules, path.relative(root, abs))) {
        if (files.length >= MAX_FILES) {
          notes.push(`More than ${MAX_FILES} matching files; the rest were skipped.`);
          return { files, notes };
        }
        files.push({ abs, rel: path.relative(root, abs).split(path.sep).join('/') });
      }
    }
  }
  return { files, notes };
}

/**
 * For a parent folder that holds many projects: one source per child folder that has matching files, named after that
 * child. A source that is not split, or is not a folder, is returned as it is.
 */
function expandProjects(source, rules) {
  if (!source.split) return [source];
  let entries;
  try {
    entries = fs.readdirSync(source.folder, { withFileTypes: true });
  } catch {
    return [source];
  }
  const matchFile = fileMatcher(rules);
  const projects = entries
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
    .map((e) => {
      const folder = path.join(source.folder, e.name);
      return { folder, service: readSpringName(folder) || e.name, label: `${source.label || source.folder}/${e.name}` };
    })
    .filter((p) => walk(p.folder, matchFile, rules).files.length > 0);
  return projects.length > 0 ? projects : [source];
}

/** The service name for a folder given no name: spring.application.name, else the folder name (skipping src/main). */
function serviceFromFolder(folder) {
  const spring = readSpringName(folder);
  if (spring) return spring;
  const parts = path.resolve(folder).split(path.sep).filter(Boolean);
  while (parts.length > 1 && GENERIC_FOLDERS.has(parts[parts.length - 1])) parts.pop();
  return parts[parts.length - 1] || '';
}

/**
 * Builds a catalog from folders. Each source is { folder: absolute path, service: name, label: text shown in the report }.
 * Returns { text, report } just like the GitHub scan.
 */
function buildFromFolders(sources, { rules: savedRules } = {}) {
  const rules = activeRules(savedRules);
  const matchFile = fileMatcher(rules);
  sources = sources.flatMap((s) => expandProjects(s, rules));
  const report = { sources: [], operationCount: 0, problems: [] };
  const operations = [];
  const services = [];
  const serviceByName = new Map();

  for (const src of sources) {
    const serviceName = String(src.service || '').trim() || serviceFromFolder(src.folder || '');
    const entry = { source: src.label || src.folder, service: serviceName, files: [], operations: 0, problems: [] };
    report.sources.push(entry);
    let stat;
    try {
      stat = fs.statSync(src.folder);
    } catch {
      entry.problems.push('The folder does not exist or cannot be read.');
      continue;
    }
    if (!stat.isDirectory()) {
      entry.problems.push('This is a file, not a folder. Choose the folder that holds the service.');
      continue;
    }
    if (!serviceName) {
      entry.problems.push('Give the service a name.');
      continue;
    }
    const found = walk(src.folder, matchFile, rules);
    entry.problems.push(...found.notes);
    if (found.files.length === 0) entry.problems.push(`No files with the extensions ${rules.fileExtensions.join(', ')} were found in this folder.`);

    const serviceId = serviceFor(serviceName, serviceByName, services);
    for (const f of found.files) {
      const fileReport = { path: f.rel, status: 'skipped', operations: 0, problems: [] };
      entry.files.push(fileReport);
      let text;
      try {
        const size = fs.statSync(f.abs).size;
        if (size > MAX_FILE_BYTES) {
          fileReport.problems.push('Larger than 512 KB, skipped.');
          continue;
        }
        text = fs.readFileSync(f.abs, 'utf8');
      } catch {
        fileReport.problems.push('The file could not be read.');
        continue;
      }
      const scanned = scanControllerSource(text, { file: f.rel, serviceName, serviceId, rules });
      if (scanned.controllers.length === 0) {
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

module.exports = { serviceFromFolder, buildFromFolders, expandProjects, walk, MAX_FILE_BYTES, SKIP_DIRS };
