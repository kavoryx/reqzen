// Converts one OpenAPI 3.x document into the operations of an API Explorer snapshot. Each operation keeps only the
// component schemas it uses, so a catalog stays small. Swagger 2 is not converted yet and is reported as skipped.
const crypto = require('crypto');

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];
const REF_PREFIX = '#/components/';

/** A stable UUID-shaped id from text, so the same API gets the same id every scan. */
function stableId(text) {
  const h = crypto.createHash('sha1').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Every "#/components/<kind>/<name>" reference in a value. */
function refsIn(value, out = new Set()) {
  if (Array.isArray(value)) {
    for (const v of value) refsIn(v, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === '$ref' && typeof v === 'string' && v.startsWith(REF_PREFIX)) out.add(v);
      else refsIn(v, out);
    }
  }
  return out;
}

/**
 * Collects the components an operation needs, following references inside them. Returns the components (only the used
 * ones) and the references that could not be found in the document.
 */
function neededComponents(doc, roots) {
  const components = {};
  const unresolved = new Set();
  const queue = [...roots];
  const seen = new Set();
  while (queue.length > 0) {
    const ref = queue.shift();
    if (seen.has(ref)) continue;
    seen.add(ref);
    const [, , kind, name] = ref.split('/');
    const value = doc.components && doc.components[kind] ? doc.components[kind][name] : undefined;
    if (value === undefined) {
      unresolved.add(ref);
      continue;
    }
    components[kind] = components[kind] || {};
    components[kind][name] = value;
    for (const next of refsIn(value)) queue.push(next);
  }
  return { components, unresolved: [...unresolved] };
}

/**
 * Converts the operations of an OpenAPI 3 document. `source` is a text label (for example "owner/repo/path") kept on each
 * operation. `serviceName` is the service the operations belong to.
 */
function convertOpenApi3(doc, { serviceName, serviceId, source }) {
  const problems = [];
  const operations = [];
  if (!doc || typeof doc !== 'object' || typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3.')) {
    return { operations, problems: ['This is not an OpenAPI 3 document.'] };
  }
  if (!doc.paths || typeof doc.paths !== 'object') return { operations, problems: ['The document has no paths.'] };
  const version = doc.info && typeof doc.info.version === 'string' ? doc.info.version : '';
  const sid = serviceId || stableId(`service:${serviceName}`);
  const seen = new Set();

  for (const [path, item] of Object.entries(doc.paths)) {
    if (!item || typeof item !== 'object') continue;
    if (item.$ref) {
      problems.push(`${path}: a path that is only a reference is not supported yet.`);
      continue;
    }
    for (const method of METHODS) {
      const op = item[method];
      if (!op || typeof op !== 'object') continue;
      const httpMethod = method.toUpperCase();
      const key = `${httpMethod} ${path}`;
      if (seen.has(key)) {
        problems.push(`${key}: defined more than once in ${source}. The first one is kept.`);
        continue;
      }
      seen.add(key);
      const roots = refsIn({ op, pathParameters: item.parameters || [] });
      const { components, unresolved } = neededComponents(doc, roots);
      const definition = {
        path,
        method: httpMethod,
        servers: op.servers || item.servers || doc.servers || [],
        operation: op,
        pathParameters: item.parameters || [],
        'x-apiexplorer': {
          origin: 'GITHUB_SCAN',
          source,
          schemaComplete: unresolved.length === 0,
          unresolvedTypes: unresolved,
        },
      };
      if (Object.keys(components).length > 0) definition.components = components;
      operations.push({
        operationId: stableId(`op:${serviceName}:${key}`),
        revisionId: stableId(`rev:${serviceName}:${key}:${version}`),
        serviceId: sid,
        serviceName,
        contractVersion: version,
        httpMethod,
        pathTemplate: path,
        visibility: 'PUBLIC',
        lifecycleStatus: op.deprecated === true ? 'DEPRECATED' : 'ACTIVE',
        schemaComplete: unresolved.length === 0,
        summary: typeof op.summary === 'string' ? op.summary : '',
        description: typeof op.description === 'string' ? op.description : '',
        definition,
      });
    }
  }
  return { operations, problems };
}

module.exports = { convertOpenApi3, stableId, refsIn, neededComponents };
