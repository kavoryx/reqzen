// Reads controller classes and their endpoint methods from source text. What counts as a controller, an endpoint, a
// parameter and a deprecation is taken from a rule set (see scanRules.js), so the same reader works for Spring (Java),
// NestJS (TypeScript) or any language that writes annotations or decorators before classes and methods.
// Body types are named but not expanded yet, so those operations are marked as incomplete until their classes are read.
const { stableId } = require('./openapi');
const { SPRING, activeRules } = require('./scanRules');

// Type names that need no class to be read (used only to decide whether a body type is still unresolved).
const PRIMITIVES = new Set(['String', 'int', 'Integer', 'long', 'Long', 'short', 'Short', 'byte', 'Byte', 'char', 'Character',
  'boolean', 'Boolean', 'double', 'Double', 'float', 'Float', 'Object', 'void', 'Void', 'Map', 'List', 'Set', 'Collection',
  'Optional', 'ResponseEntity', 'UUID', 'LocalDate', 'LocalDateTime', 'Instant', 'Date', 'number', 'string', 'boolean', 'any']);

/** Blanks out comments but keeps their positions. Doc blocks (/** ... *\/) are returned with the index where they end. */
function stripComments(src) {
  const docs = [];
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < src.length && src[j] !== quote && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      const block = src.slice(i, stop);
      if (block.startsWith('/**')) docs.push({ end: out.length + block.length, text: block });
      out += block.replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return { clean: out, docs };
}

/** Index of the bracket that closes the one at `open`, skipping string literals. */
function closing(text, open) {
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const close = pairs[text[open]];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      i = j;
    } else if (c === text[open]) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits text at commas that are not inside <>, () or {}. */
function splitTop(text) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const c of text) {
    if ('<({['.includes(c)) depth++;
    if ('>)}]'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Reads the annotations or decorators at the start of a header. Returns them and the rest of the header. */
function readAnnotations(header) {
  const annotations = [];
  let rest = '';
  let i = 0;
  // Only annotations before the signature count: once a parenthesis that is not an annotation's arguments starts (the
  // method's parameter list), the rest of the text is kept as it is, including the parameters' own annotations.
  while (i < header.length) {
    if (header[i] === '(') {
      rest += header.slice(i);
      break;
    }
    if (header[i] === '@' && /[A-Za-z]/.test(header[i + 1] || '')) {
      const m = header.slice(i + 1).match(/^[\w.]+/);
      const name = m[0].split('.').pop();
      let j = i + 1 + m[0].length;
      let args = null;
      const after = header.slice(j).match(/^\s*\(/);
      if (after) {
        const open = j + after[0].length - 1;
        const close = closing(header, open);
        args = header.slice(open + 1, close === -1 ? header.length : close);
        j = close === -1 ? header.length : close + 1;
      }
      annotations.push({ name, args });
      i = j;
    } else {
      rest += header[i];
      i++;
    }
  }
  return { annotations, rest: rest.replace(/\s+/g, ' ').trim() };
}

/** String literals in an annotation's arguments, in order. */
function literals(args) {
  return [...String(args || '').matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]));
}

/**
 * The path of a mapping: a named path argument (value=, path=, or one of the rule's names), or the first string
 * literal when it is not a named argument. No arguments means the empty path.
 */
function mappingPaths(args, pathArguments = ['value', 'path']) {
  if (args === null || args === undefined || args.trim() === '') return [''];
  for (const name of pathArguments) {
    const named = args.match(new RegExp(`\\b${name}\\s*=\\s*(\\{[^}]*\\}|"[^"]*"|'[^']*')`));
    if (named) {
      const found = literals(named[1]);
      return found.length ? found : [''];
    }
  }
  const first = args.split(/,(?=\s*\w+\s*=|\s*\{|\s*")/)[0];
  if (/^\s*\w+\s*=/.test(first)) return [''];
  const strings = literals(first);
  return strings.length ? [strings[0]] : [''];
}

/** The simple type name of a type: List<ItemDto> -> ItemDto, Foo[] -> Foo, pkg.Foo -> Foo. */
function typeName(type) {
  const cleaned = String(type || '').replace(/\bfinal\b/g, '').replace(/@\w+/g, '').trim();
  const inner = cleaned.match(/<\s*([\w.]+)\s*>\s*$/) || cleaned.match(/<\s*(?:[\w.]+\s*,\s*)?([\w.]+)\s*>/);
  const base = (inner ? inner[1] : cleaned.replace(/<.*$/, '')).replace(/\[\]/g, '').trim();
  return base.split('.').pop();
}

function schemaFor(type) {
  const t = typeName(type);
  if (/^(int|Integer|long|Long|short|Short|byte|Byte|number)$/.test(t)) return { type: 'integer' };
  if (/^(double|Double|float|Float|BigDecimal)$/.test(t)) return { type: 'number' };
  if (/^(boolean|Boolean)$/.test(t)) return { type: 'boolean' };
  if (/^(String|string|char|Character|UUID|LocalDate|LocalDateTime|Instant|Date)$/.test(t)) return { type: 'string' };
  return { type: 'object' };
}

/**
 * One parameter: its annotations, its type and its name. Handles Java ("String id") and TypeScript ("id: string").
 */
function parseParam(text) {
  const { annotations, rest } = readAnnotations(text);
  const colon = rest.indexOf(':');
  if (colon !== -1) {
    const name = rest.slice(0, colon).replace(/\?/g, '').trim();
    return { annotations, type: rest.slice(colon + 1).trim(), name };
  }
  const parts = rest.split(' ').filter((p) => p && p !== 'final');
  const name = parts.pop() || '';
  return { annotations, type: parts.join(' '), name };
}

/** Reads a required=true/false style argument, or returns the fallback when the argument is not given. */
function flagArg(args, argName, fallback) {
  if (!argName) return fallback;
  const m = String(args || '').match(new RegExp(`\\b${argName}\\s*=\\s*(true|false)`));
  return m ? m[1] === 'true' : fallback;
}

/** The name of a parameter given by its marker: value=/name= or the first literal. Falls back to the parameter's name. */
function nameArg(args, fallback) {
  const named = String(args || '').match(/\b(?:value|name)\s*=\s*"([^"]*)"/);
  if (named) return named[1];
  const first = literals(args)[0];
  return first || fallback;
}

/** The HTTP methods named in a method argument: RequestMethod.GET, {GET, POST}, 'get' and so on. */
function methodsIn(text) {
  return [...String(text).toUpperCase().matchAll(/\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g)].map((x) => x[1]);
}

/** Reads the members of a class body: { header, start, hasBody, bodyStart, bodyEnd }. */
function members(clean, bodyOpen, bodyClose) {
  const out = [];
  let i = bodyOpen + 1;
  let start = i;
  while (i < bodyClose) {
    const c = clean[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < bodyClose && clean[j] !== c) j += clean[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (c === '(') {
      const close = closing(clean, i);
      i = close === -1 ? bodyClose : close + 1;
      continue;
    }
    if (c === '{') {
      const close = closing(clean, i);
      out.push({ header: clean.slice(start, i), start, hasBody: true, bodyStart: i, bodyEnd: close });
      i = close === -1 ? bodyClose : close + 1;
      start = i;
      continue;
    }
    if (c === ';') {
      out.push({ header: clean.slice(start, i), start, hasBody: false });
      i++;
      start = i;
      continue;
    }
    i++;
  }
  return out;
}

/** Joins the base and sub paths and writes path parameters in the style the rules use ({id} or :id). */
/** The API version from the path (for example v1 in /sample/v1/items), using the rule set's pattern. */
function versionOf(full, pattern) {
  if (!pattern) return '';
  const m = String(full).match(new RegExp(pattern));
  return m && m[1] ? m[1] : '';
}

function fullPath(base, sub, style) {
  const joined = `/${[base, sub].map((p) => String(p).replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
  return style === 'colon' ? joined.replace(/:(\w+)/g, '{$1}') : joined;
}

/**
 * Reads the operations of every controller in one source file, using the rule set.
 * Returns { controllers: [names], operations, problems }. A file with no controller returns no operations and no problems.
 */
function scanControllerSource(source, { file, serviceName, serviceId, rules: savedRules } = {}) {
  const rules = savedRules || activeRules(SPRING);
  const problems = [];
  const operations = [];
  const controllers = [];
  const mappingByName = new Map(rules.mappings.map((m) => [m.annotation, m]));
  const paramByName = new Map(rules.parameters.map((p) => [p.annotation, p]));
  const classMarkers = new Set(rules.classMarkers);
  const deprecatedMarkers = new Set(rules.deprecatedMarkers);
  const versionPattern = rules.versionPattern || '';
  const visibilityByName = new Map((rules.visibilityMarkers || []).map((v) => [v.annotation, v.visibility]));
  // The most restrictive visibility wins: HIDDEN over INTERNAL over PUBLIC.
  const RANK = { PUBLIC: 0, INTERNAL: 1, HIDDEN: 2 };
  const visibilityOf = (annotations) => {
    let best = null;
    for (const a of annotations) {
      const v = visibilityByName.get(a.name);
      if (v && (best === null || RANK[v] > RANK[best])) best = v;
    }
    return best;
  };
  const { clean, docs } = stripComments(String(source || ''));
  const classRe = /\bclass\s+(\w+)/g;
  let m;
  while ((m = classRe.exec(clean)) !== null) {
    const before = clean.slice(Math.max(0, m.index - 600), m.index);
    const lastBoundary = Math.max(before.lastIndexOf('}'), before.lastIndexOf(';'));
    const annText = before.slice(lastBoundary + 1);
    const { annotations: classAnnotations } = readAnnotations(annText.trim());
    const isController = classAnnotations.some((a) => classMarkers.has(a.name));
    if (!isController) continue;
    const className = m[1];
    controllers.push(className);
    const open = clean.indexOf('{', m.index + m[0].length);
    const close = open === -1 ? -1 : closing(clean, open);
    if (open === -1 || close === -1) {
      problems.push(`${className}: the class body could not be read.`);
      continue;
    }
    const classBase = rules.basePathAnnotation ? classAnnotations.find((a) => a.name === rules.basePathAnnotation) : null;
    const basePaths = classBase ? mappingPaths(classBase.args, rules.pathArguments) : [''];
    const classDeprecated = classAnnotations.some((a) => deprecatedMarkers.has(a.name));
    const classVisibility = visibilityOf(classAnnotations);

    let lastEnd = open;
    for (const mem of members(clean, open, close)) {
      const memStart = mem.start;
      const { annotations, rest } = readAnnotations(mem.header.trim());
      const doc = docs.filter((d) => d.end > lastEnd && d.end <= memStart + mem.header.length).pop();
      lastEnd = mem.bodyEnd !== undefined && mem.bodyEnd !== -1 ? mem.bodyEnd : memStart + mem.header.length;
      if (!mem.hasBody) continue;
      const sig = rest.match(/^(.*?)\s*(\w+)\s*\((.*)$/);
      if (!sig || /^new\b/.test(rest)) continue;
      const methodName = sig[2];
      const returnType = sig[1].replace(/\b(public|protected|private|static|final|synchronized|abstract|async)\b/g, '').trim();
      const paramsText = sig[3].slice(0, sig[3].lastIndexOf(')'));
      const mapping = annotations.find((a) => mappingByName.has(a.name));
      if (!mapping) continue;
      const rule = mappingByName.get(mapping.name);
      let methods;
      if (rule.method) {
        methods = [rule.method];
      } else {
        const methodArg = rules.methodArgument ? String(mapping.args || '').match(new RegExp(`\\b${rules.methodArgument}\\s*=\\s*(\\{[^}]*\\}|[\\w.]+)`)) : null;
        methods = methodArg ? methodsIn(methodArg[1]) : [];
        if (methods.length === 0) {
          methods = [rules.defaultMethod];
          problems.push(`${className}.${methodName}: no HTTP method was given, ${rules.defaultMethod} is assumed.`);
        }
      }
      const subPaths = mappingPaths(mapping.args, rules.pathArguments);
      const params = splitTop(paramsText).map(parseParam);
      const parameters = [];
      let bodyType = '';
      for (const p of params) {
        const pa = p.annotations.find((a) => paramByName.has(a.name));
        if (!pa) continue;
        const pr = paramByName.get(pa.name);
        const name = nameArg(pa.args, p.name);
        if (pr.in === 'body') {
          bodyType = typeName(p.type);
        } else if (pr.in === 'path') {
          parameters.push({ name, in: 'path', required: true, schema: schemaFor(p.type) });
        } else {
          const required = flagArg(pa.args, pr.requiredArgument, pr.requiredDefault);
          parameters.push({ name, in: pr.in, required, schema: schemaFor(p.type) });
        }
      }
      const deprecated = classDeprecated || annotations.some((a) => deprecatedMarkers.has(a.name));
      const methodVisibility = visibilityOf(annotations);
      const visibility = [classVisibility, methodVisibility].filter(Boolean).sort((a, b) => RANK[b] - RANK[a])[0] || 'PUBLIC';
      const visibilitySource = classVisibility && (!methodVisibility || RANK[classVisibility] >= RANK[methodVisibility]) ? 'class' : methodVisibility ? 'method' : 'none';
      const sourceSummary = doc ? doc.text.replace(/^\/\*\*|\*\/$/g, '').split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trim()).filter((l) => l && !l.startsWith('@')).join(' ').slice(0, 300) : '';
      const handlerName = methodName.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
      const summary = sourceSummary || `${handlerName[0] ? handlerName[0].toUpperCase() + handlerName.slice(1) : methodName}`;
      const description = sourceSummary || `${summary}. Identified from ${rules.name || 'controller'} source.`;
      for (const base of basePaths) {
        for (const sub of subPaths) {
          const full = fullPath(base, sub, rules.pathParamStyle);
          for (const httpMethod of methods) {
            const key = `${httpMethod} ${full}`;
            const operation = {
              operationId: methodName,
              summary,
              description,
              tags: [className],
              parameters,
              responses: { 200: { description: 'OK' } },
            };
            if (bodyType) {
              operation.requestBody = { required: true, content: { 'application/json': { schema: { type: 'object', 'x-source-type': bodyType } } } };
            }
            const unresolved = bodyType && !PRIMITIVES.has(bodyType) ? [bodyType] : [];
            operations.push({
              operationId: stableId(`src:${serviceName}:${file}:${className}.${methodName}:${key}`),
              revisionId: stableId(`src-rev:${serviceName}:${file}:${className}.${methodName}:${key}`),
              serviceId,
              serviceName,
              contractVersion: versionOf(full, versionPattern),
              httpMethod,
              pathTemplate: full,
              visibility,
              lifecycleStatus: deprecated ? 'DEPRECATED' : 'ACTIVE',
              schemaComplete: unresolved.length === 0,
              summary: operation.summary,
              description,
              definition: {
                path: full,
                method: httpMethod,
                servers: [],
                operation,
                pathParameters: parameters.filter((x) => x.in === 'path'),
                'x-apiexplorer': {
                  origin: 'SOURCE_CONTROLLER',
                  visibilitySource,
                  rules: rules.name,
                  source: file,
                  controller: className,
                  method: methodName,
                  returnType: typeName(returnType),
                  schemaComplete: unresolved.length === 0,
                  unresolvedTypes: unresolved,
                },
              },
            });
          }
        }
      }
    }
  }
  return { controllers, operations, problems };
}

module.exports = { scanControllerSource, stripComments, typeName, mappingPaths, readAnnotations };
