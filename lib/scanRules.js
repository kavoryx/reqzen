// Scan rules: which annotations (or decorators) mark a controller, which mark an endpoint and its HTTP method, and how
// parameters are read. A rule set is plain JSON, so it can be shared, edited, and used for any language that writes
// annotations or decorators before classes and methods (Java, C#, Kotlin, TypeScript, and similar).
const fs = require('fs');
const path = require('path');

// Common test folders are never read as source: they hold fixtures, not APIs. Paths use "/" separators.
const DEFAULT_SKIP_PATH = '(^|/)(src/test|test|tests|__tests__)/';

// Markers that set an API's visibility. A class marker applies to every endpoint in it; a method marker applies to that endpoint only.
const VISIBILITIES = ['HIDDEN', 'INTERNAL'];

// The API version is the first capture group of this pattern, matched on the full path (for example /sample/v1/items gives v1).
const DEFAULT_VERSION_PATTERN = '(?:^|/)(v\\d+(?:\\.\\d+)?)(?=/|$)';
// Both default markers hide the API, so it shows as Hidden. A rule set can map another annotation to INTERNAL.
const DEFAULT_VISIBILITY_MARKERS = [
  { annotation: 'Hidden', visibility: 'HIDDEN' },
  { annotation: 'InternalApi', visibility: 'HIDDEN' },
];

const METHOD_SET = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const LOCATIONS = ['path', 'query', 'header', 'body'];
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const MAX_ITEMS = 100;

const SPRING = {
  name: 'Spring MVC (Java)',
  fileExtensions: ['.java'],
  skipFilePattern: 'Test\\.java$',
  skipPathPattern: DEFAULT_SKIP_PATH,
  classMarkers: ['RestController', 'Controller'],
  basePathAnnotation: 'RequestMapping',
  mappings: [
    { annotation: 'GetMapping', method: 'GET' },
    { annotation: 'PostMapping', method: 'POST' },
    { annotation: 'PutMapping', method: 'PUT' },
    { annotation: 'DeleteMapping', method: 'DELETE' },
    { annotation: 'PatchMapping', method: 'PATCH' },
    { annotation: 'RequestMapping', method: null },
  ],
  defaultMethod: 'GET',
  methodArgument: 'method',
  pathArguments: ['value', 'path'],
  pathParamStyle: 'braces',
  parameters: [
    { annotation: 'PathVariable', in: 'path', requiredArgument: null, requiredDefault: true },
    { annotation: 'RequestParam', in: 'query', requiredArgument: 'required', requiredDefault: true },
    { annotation: 'RequestHeader', in: 'header', requiredArgument: 'required', requiredDefault: true },
    { annotation: 'RequestBody', in: 'body', requiredArgument: null, requiredDefault: true },
  ],
  deprecatedMarkers: ['Deprecated'],
  visibilityMarkers: DEFAULT_VISIBILITY_MARKERS,
};

const NESTJS = {
  name: 'NestJS (TypeScript)',
  fileExtensions: ['.ts'],
  skipFilePattern: '\\.spec\\.ts$',
  skipPathPattern: DEFAULT_SKIP_PATH,
  classMarkers: ['Controller'],
  basePathAnnotation: 'Controller',
  mappings: [
    { annotation: 'Get', method: 'GET' },
    { annotation: 'Post', method: 'POST' },
    { annotation: 'Put', method: 'PUT' },
    { annotation: 'Delete', method: 'DELETE' },
    { annotation: 'Patch', method: 'PATCH' },
  ],
  defaultMethod: 'GET',
  methodArgument: null,
  pathArguments: [],
  pathParamStyle: 'colon',
  parameters: [
    { annotation: 'Param', in: 'path', requiredArgument: null, requiredDefault: true },
    { annotation: 'Query', in: 'query', requiredArgument: null, requiredDefault: false },
    { annotation: 'Headers', in: 'header', requiredArgument: null, requiredDefault: false },
    { annotation: 'Body', in: 'body', requiredArgument: null, requiredDefault: true },
  ],
  deprecatedMarkers: ['Deprecated'],
  visibilityMarkers: DEFAULT_VISIBILITY_MARKERS,
};

const PRESETS = { spring: SPRING, nestjs: NESTJS };

function isIdent(v) {
  return typeof v === 'string' && IDENT.test(v);
}

/** Checks a rule set. Returns the problems and a cleaned copy to save or use. */
function validate(input) {
  const problems = [];
  const r = input && typeof input === 'object' ? input : {};
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 80) : '';
  if (name === '') problems.push('Give the rule set a name.');

  const extensions = Array.isArray(r.fileExtensions) ? r.fileExtensions : [];
  if (extensions.length === 0 || extensions.length > 20 || extensions.some((e) => typeof e !== 'string' || !/^\.[A-Za-z0-9]{1,10}$/.test(e))) {
    problems.push('File types must be extensions such as .java or .ts.');
  }
  let skip = '';
  let skipPath = r.skipPathPattern === undefined ? DEFAULT_SKIP_PATH : String(r.skipPathPattern).trim().slice(0, 200);
  if (skipPath !== '') {
    try {
      new RegExp(skipPath);
    } catch {
      problems.push('The "skip folders" pattern is not a valid regular expression.');
    }
  }
  if (typeof r.skipFilePattern === 'string' && r.skipFilePattern.trim() !== '') {
    skip = r.skipFilePattern.trim().slice(0, 200);
    try {
      new RegExp(skip);
    } catch {
      problems.push('The "skip files" pattern is not a valid regular expression.');
    }
  }
  const classMarkers = Array.isArray(r.classMarkers) ? r.classMarkers : [];
  if (classMarkers.length === 0 || classMarkers.length > MAX_ITEMS || !classMarkers.every(isIdent)) {
    problems.push('Controller markers must be names such as RestController or Controller.');
  }
  const basePathAnnotation = r.basePathAnnotation === null || r.basePathAnnotation === undefined || r.basePathAnnotation === '' ? null : r.basePathAnnotation;
  if (basePathAnnotation !== null && !isIdent(basePathAnnotation)) problems.push('The base path marker must be a name.');

  const mappings = Array.isArray(r.mappings) ? r.mappings : [];
  if (mappings.length === 0 || mappings.length > MAX_ITEMS) problems.push('Add at least one endpoint marker.');
  for (const m of mappings) {
    if (!m || !isIdent(m.annotation)) problems.push('Each endpoint marker must be a name.');
    else if (m.method !== null && !METHOD_SET.includes(m.method)) problems.push(`${m.annotation}: the HTTP method must be one of ${METHOD_SET.join(', ')}, or left to the argument.`);
  }
  if (mappings.some((m) => m && m.method === null) && !(isIdent(r.methodArgument))) {
    problems.push('A marker with no fixed method needs the name of the argument that gives the method.');
  }
  if (!METHOD_SET.includes(r.defaultMethod)) problems.push('The default HTTP method must be one of the standard methods.');

  const pathArguments = Array.isArray(r.pathArguments) ? r.pathArguments : [];
  if (!pathArguments.every(isIdent)) problems.push('Path argument names must be names.');

  if (!['braces', 'colon'].includes(r.pathParamStyle)) problems.push('Path parameters must be written as {id} (braces) or :id (colon).');
  const parameters = Array.isArray(r.parameters) ? r.parameters : [];
  if (parameters.length > MAX_ITEMS) problems.push('Too many parameter markers.');
  for (const p of parameters) {
    if (!p || !isIdent(p.annotation)) problems.push('Each parameter marker must be a name.');
    else if (!LOCATIONS.includes(p.in)) problems.push(`${p.annotation}: the location must be path, query, header or body.`);
    else if (p.requiredArgument !== null && p.requiredArgument !== undefined && !isIdent(p.requiredArgument)) problems.push(`${p.annotation}: the required argument must be a name.`);
  }
  const deprecated = Array.isArray(r.deprecatedMarkers) ? r.deprecatedMarkers : [];
  const versionPattern = r.versionPattern === undefined ? DEFAULT_VERSION_PATTERN : String(r.versionPattern).trim().slice(0, 200);
  if (versionPattern !== '') {
    try {
      new RegExp(versionPattern);
    } catch {
      problems.push('The version pattern is not a valid regular expression.');
    }
  }
  const visibilityMarkers = r.visibilityMarkers === undefined ? DEFAULT_VISIBILITY_MARKERS : r.visibilityMarkers;
  if (!Array.isArray(visibilityMarkers) || visibilityMarkers.length > MAX_ITEMS) {
    problems.push('Visibility markers must be a list.');
  } else {
    for (const v of visibilityMarkers) {
      if (!v || !isIdent(v.annotation) || !VISIBILITIES.includes(v.visibility)) problems.push('Each visibility marker needs a name and HIDDEN or INTERNAL.');
    }
  }
  if (!deprecated.every(isIdent)) problems.push('Deprecation markers must be names.');

  const value = {
    name,
    fileExtensions: extensions.map((e) => e.toLowerCase()).slice(0, 20),
    skipFilePattern: skip,
    skipPathPattern: skipPath,
    classMarkers,
    basePathAnnotation,
    mappings: mappings.slice(0, MAX_ITEMS).map((m) => ({ annotation: m.annotation, method: m.method ?? null })),
    defaultMethod: r.defaultMethod,
    methodArgument: isIdent(r.methodArgument) ? r.methodArgument : null,
    pathArguments: pathArguments.filter(isIdent),
    pathParamStyle: r.pathParamStyle,
    parameters: parameters.slice(0, MAX_ITEMS).map((p) => ({
      annotation: p.annotation,
      in: p.in,
      requiredArgument: isIdent(p.requiredArgument) ? p.requiredArgument : null,
      requiredDefault: p.requiredDefault !== false,
    })),
    deprecatedMarkers: deprecated,
    versionPattern,
    visibilityMarkers: Array.isArray(visibilityMarkers) ? visibilityMarkers.filter((v) => v && isIdent(v.annotation) && VISIBILITIES.includes(v.visibility)).map((v) => ({ annotation: v.annotation, visibility: v.visibility })) : [],
  };
  return { problems, value };
}

/** The rules to use: the saved set if it is valid, otherwise the Spring preset. */
function activeRules(saved) {
  if (saved) {
    const checked = validate(saved);
    if (checked.problems.length === 0) return checked.value;
  }
  return validate(SPRING).value;
}

// The markers as they were before @InternalApi defaulted to Hidden. Rules saved with exactly these are updated.
const OLD_VISIBILITY_MARKERS = { Hidden: 'HIDDEN', InternalApi: 'INTERNAL' };

function isOldMarkerDefault(markers) {
  if (!Array.isArray(markers) || markers.length !== 2) return false;
  const seen = Object.fromEntries(markers.map((m) => [m && m.annotation, m && m.visibility]));
  return Object.keys(OLD_VISIBILITY_MARKERS).every((k) => seen[k] === OLD_VISIBILITY_MARKERS[k]);
}

function load(file) {
  try {
    const rules = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (rules && isOldMarkerDefault(rules.visibilityMarkers)) {
      rules.visibilityMarkers = DEFAULT_VISIBILITY_MARKERS.map((v) => ({ ...v }));
    }
    return rules;
  } catch {
    return null;
  }
}

function save(file, rules) {
  const checked = validate(rules);
  if (checked.problems.length > 0) return checked;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(checked.value, null, 2), { mode: 0o600 });
  return { problems: [], value: checked.value };
}

/** Whether a path (relative to the scanned root, any separator) is under a skipped folder such as src/test. */
function isSkippedPath(rules, relPath) {
  if (!rules || !rules.skipPathPattern) return false;
  return new RegExp(rules.skipPathPattern).test(String(relPath).replace(/\\/g, '/'));
}

module.exports = { SPRING, NESTJS, PRESETS, METHOD_SET, LOCATIONS, DEFAULT_SKIP_PATH, VISIBILITIES, DEFAULT_VISIBILITY_MARKERS, DEFAULT_VERSION_PATTERN, validate, activeRules, load, save, isSkippedPath };
