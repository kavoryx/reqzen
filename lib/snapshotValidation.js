const customFields = require('./customFields');

function parseJsonDocument(text) {
  if (typeof text !== 'string') return null;
  const source = text.replace(/^\uFEFF/, '').trim();
  if (!source) return null;
  try {
    return JSON.parse(source);
  } catch {
    // Claude and similar tools sometimes save their answer as a fenced JSON document.
  }
  const fence = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      return null;
    }
  }
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeSnapshot(value) {
  let snapshot = value;
  const wrappers = new Set(['snapshot', 'catalog', 'catalogue', 'data', 'result', 'output', 'content', 'apiSnapshot']);
  for (let depth = 0; depth < 3 && snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot); depth++) {
    const entries = Object.entries(snapshot);
    const wrapped = entries.find(([key, child]) =>
      wrappers.has(key) && child && typeof child === 'object' && !Array.isArray(child)
      && Array.isArray(child.services) && Array.isArray(child.operations));
    if (!wrapped) break;
    snapshot = wrapped[1];
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
  snapshot = { ...snapshot };
  const aliases = new Set([
    'api-explorer-snapshot', 'reqzen-api-snapshot', 'reqzen-snapshot',
  ]);
  if (snapshot.format === undefined && Array.isArray(snapshot.operations) && Array.isArray(snapshot.services)) {
    snapshot.format = 'api-explorer-snapshot';
  } else if (typeof snapshot.format === 'string' && aliases.has(snapshot.format.toLowerCase())) {
    snapshot.format = 'api-explorer-snapshot';
  }
  if (snapshot.formatVersion === '1') snapshot.formatVersion = 1;
  if (!Array.isArray(snapshot.operations) && Array.isArray(snapshot.services)
    && snapshot.services.some((service) => service && Array.isArray(service.operations))) {
    const operations = [];
    snapshot.services = snapshot.services.map((service, serviceIndex) => {
      if (!service || typeof service !== 'object' || Array.isArray(service)) return service;
      const { operations: serviceOperations, ...serviceFields } = service;
      const serviceId = typeof service.serviceId === 'string' ? service.serviceId
        : typeof service.id === 'string' ? service.id
          : typeof service.name === 'string' ? service.name
            : `service-${serviceIndex + 1}`;
      if (Array.isArray(serviceOperations)) {
        for (const operation of serviceOperations) {
          if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
            operations.push(operation);
            continue;
          }
          operations.push({
            ...operation,
            operationId: typeof operation.operationId === 'string' ? operation.operationId : operation.id,
            serviceId: typeof operation.serviceId === 'string' ? operation.serviceId : serviceId,
            serviceName: typeof operation.serviceName === 'string' ? operation.serviceName : service.name,
            httpMethod: typeof operation.httpMethod === 'string' ? operation.httpMethod : operation.method,
            pathTemplate: typeof operation.pathTemplate === 'string' ? operation.pathTemplate : operation.path,
            contractVersion: typeof operation.contractVersion === 'string' ? operation.contractVersion
              : operation.version == null ? ''
                : operation.version,
            revisionId: typeof operation.revisionId === 'string' ? operation.revisionId : operation.id,
          });
        }
      }
      return { ...serviceFields, serviceId };
    });
    snapshot.operations = operations;
  }
  if (Array.isArray(snapshot.operations)) {
    snapshot.operations = snapshot.operations.map((operation) => {
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return operation;
      const detail = operation.definition && typeof operation.definition === 'object'
        && operation.definition.operation && typeof operation.definition.operation === 'object'
        ? operation.definition.operation
        : {};
      const lifecycle = String(operation.lifecycleStatus || operation.status || '').toUpperCase();
      const deprecated = lifecycle === 'DEPRECATED'
        || operation.deprecated === true || operation.deprecated === 'true'
        || detail.deprecated === true || detail.deprecated === 'true';
      const visibility = String(operation.visibility || '').toUpperCase();
      const hidden = visibility === 'HIDDEN' || visibility === 'INTERNAL'
        || operation.hidden === true || operation.internal === true
        || detail.hidden === true || detail.internal === true
        || detail['x-hidden'] === true || detail['x-internal'] === true;
      const normalizedLifecycle = deprecated ? 'DEPRECATED' : lifecycle === 'ACTIVE' ? 'ACTIVE' : null;
      const normalizedVisibility = hidden ? (visibility === 'INTERNAL' ? 'INTERNAL' : 'HIDDEN')
        : visibility === 'PUBLIC' ? 'PUBLIC' : null;
      return {
        ...operation,
        ...(normalizedLifecycle ? { lifecycleStatus: normalizedLifecycle } : {}),
        ...(normalizedVisibility ? { visibility: normalizedVisibility } : {}),
      };
    });
  }
  return snapshot;
}

function parseSnapshot(text, options = {}) {
  let parsed = normalizeSnapshot(parseJsonDocument(text));
  if (options.showAllFields === true && parsed && Array.isArray(parsed.customFieldDefinitions)) {
    parsed = {
      ...parsed,
      customFieldDefinitions: parsed.customFieldDefinitions.map((field) =>
        field && typeof field === 'object' && !Array.isArray(field) ? { ...field, visible: true } : field),
    };
  }
  const problem = validateSnapshot(parsed);
  return { snapshot: problem ? null : parsed, problem };
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return 'The file does not contain a valid JSON snapshot. Save the complete JSON object and try again.';
  }
  if (snapshot.format !== 'api-explorer-snapshot'
    || !Array.isArray(snapshot.operations) || !Array.isArray(snapshot.services)) {
    return 'This file is not a supported Reqzen API snapshot.';
  }
  if (snapshot.formatVersion !== undefined && snapshot.formatVersion !== 1) {
    return 'This snapshot format version is not supported.';
  }
  for (const key of ['environments', 'serviceOverrides', 'tokenTypes', 'variables']) {
    if (snapshot[key] !== undefined && (!Array.isArray(snapshot[key])
      || snapshot[key].some((item) => !item || typeof item !== 'object' || Array.isArray(item)))) {
      return `The snapshot ${key} must be a list of objects.`;
    }
  }
  if (snapshot.tokenTypes && snapshot.tokenTypes.some((type) => typeof type.name !== 'string')) {
    return 'Each token type needs a name.';
  }
  if (snapshot.variables && snapshot.variables.some((variable) => typeof variable.name !== 'string'
    || typeof variable.value !== 'string' || !variable.byEnvironment || typeof variable.byEnvironment !== 'object'
    || Array.isArray(variable.byEnvironment)
    || Object.values(variable.byEnvironment).some((value) => typeof value !== 'string'))) {
    return 'Each variable needs a name, value, and environment values.';
  }
  const definitions = snapshot.customFieldDefinitions === undefined ? [] : snapshot.customFieldDefinitions;
  const fieldProblem = customFields.validateDefinitions(definitions);
  if (fieldProblem) return fieldProblem;
  for (let i = 0; i < snapshot.services.length; i++) {
    const service = snapshot.services[i];
    if (!service || typeof service.name !== 'string' || !service.name.trim()) {
      return `Service ${i + 1} needs a name.`;
    }
  }
  const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
  const ids = new Set();
  for (let i = 0; i < snapshot.operations.length; i++) {
    const operation = snapshot.operations[i];
    if (!operation || typeof operation.operationId !== 'string' || !operation.operationId.trim()
      || typeof operation.serviceName !== 'string' || !operation.serviceName.trim()
      || typeof operation.httpMethod !== 'string' || !methods.has(operation.httpMethod.toUpperCase())
      || typeof operation.pathTemplate !== 'string' || !operation.pathTemplate.startsWith('/')) {
      return `Operation ${i + 1} needs an ID, service name, supported HTTP method, and absolute path.`;
    }
    if (ids.has(operation.operationId)) return `Operation ${i + 1} has a duplicate operation ID.`;
    ids.add(operation.operationId);
    if (operation.customFields !== undefined) {
      const problem = customFields.validateValues(operation.customFields, definitions);
      if (problem) return `Operation ${i + 1}: ${problem}`;
    }
    for (const key of ['revisionId', 'serviceId', 'contractVersion', 'summary', 'description']) {
      if (operation[key] !== undefined && typeof operation[key] !== 'string') {
        return `Operation ${i + 1} has an invalid ${key}; it must be text.`;
      }
    }
    if (operation.definition !== undefined && (!operation.definition || typeof operation.definition !== 'object' || Array.isArray(operation.definition))) {
      return `Operation ${i + 1} has an invalid definition.`;
    }
    const detail = operation.definition && operation.definition.operation;
    if (detail !== undefined && (!detail || typeof detail !== 'object' || Array.isArray(detail))) {
      return `Operation ${i + 1} has invalid operation details.`;
    }
    if (detail && detail.parameters !== undefined && (!Array.isArray(detail.parameters)
      || detail.parameters.some((parameter) => !parameter || typeof parameter !== 'object' || Array.isArray(parameter)))) {
      return `Operation ${i + 1} has invalid parameters.`;
    }
    for (const parameters of [operation.parameters, operation.definition && operation.definition.pathParameters]) {
      if (parameters !== undefined && (!Array.isArray(parameters)
        || parameters.some((parameter) => !parameter || typeof parameter !== 'object' || Array.isArray(parameter)))) {
        return `Operation ${i + 1} has invalid parameters.`;
      }
    }
  }
  return '';
}

module.exports = { parseJsonDocument, parseSnapshot, validateSnapshot };
