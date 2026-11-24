const MAX_FIELDS = 12;
const MAX_VALUE = 1000;
const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

function validateDefinitions(definitions) {
  if (!Array.isArray(definitions) || definitions.length > MAX_FIELDS) return `Use up to ${MAX_FIELDS} custom fields.`;
  const keys = new Set();
  for (const field of definitions) {
    if (!field || typeof field !== 'object' || typeof field.key !== 'string' || !KEY.test(field.key)
      || Object.prototype.hasOwnProperty.call(Object.prototype, field.key)
      || typeof field.label !== 'string' || !field.label.trim() || field.label.length > 60
      || typeof field.visible !== 'boolean') return 'Each custom field needs a valid key, label and visibility.';
    const key = field.key.toLowerCase();
    if (keys.has(key)) return `Custom field key ${field.key} is duplicated.`;
    keys.add(key);
  }
  return '';
}

function validateValues(values, definitions) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return 'Custom field values must be an object.';
  const allowed = new Set(definitions.map((field) => field.key));
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.has(key) || typeof value !== 'string' || value.length > MAX_VALUE) {
      return `Custom field ${key} is unknown or has an invalid value.`;
    }
  }
  return '';
}

function applyMetadata(snapshot, definitions, values) {
  const problem = validateDefinitions(definitions);
  if (problem) throw new Error(problem);
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Custom field values must be an object.');
  const ids = new Set(snapshot.operations.map((operation) => operation.operationId));
  for (const [id, fields] of Object.entries(values)) {
    if (!ids.has(id)) throw new Error('A custom field refers to an API that is no longer in this snapshot.');
    const valueProblem = validateValues(fields, definitions);
    if (valueProblem) throw new Error(valueProblem);
  }
  return {
    ...snapshot,
    customFieldDefinitions: definitions.map((field) => ({ key: field.key, label: field.label.trim(), visible: field.visible })),
    operations: snapshot.operations.map((operation) => ({
      ...operation,
      customFields: Object.prototype.hasOwnProperty.call(values, operation.operationId) ? { ...values[operation.operationId] } : {},
    })),
  };
}

module.exports = { MAX_FIELDS, MAX_VALUE, validateDefinitions, validateValues, applyMetadata };
