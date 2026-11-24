const customFields = require('./customFields');

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.format !== 'api-explorer-snapshot'
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

module.exports = { validateSnapshot };
