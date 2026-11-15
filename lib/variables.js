// Variables the user defines once and that any API can use, such as orgId. Kept in the app's data folder on this
// computer, never in a snapshot. A variable has one shared value and may have a different value per environment.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_VARIABLES = 100;
const MAX_VALUE_CHARS = 500;
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;

/** Checks one variable and returns the cleaned values. `existing` lists saved variables; `envIds` the known environments. */
function validate(input, existing, selfId, envIds) {
  const problems = [];
  const name = String((input && input.name) || '').trim();
  if (!NAME_PATTERN.test(name)) {
    problems.push('Name must start with a letter and use only letters, digits, _, . or - (up to 40 characters).');
  } else if (existing.some((v) => v.id !== selfId && v.name.toLowerCase() === name.toLowerCase())) {
    problems.push('A variable with this name already exists.');
  }

  const value = String((input && input.value) || '').trim();
  if (value.length > MAX_VALUE_CHARS) problems.push(`Values must be ${MAX_VALUE_CHARS} characters or fewer.`);

  const byEnvironment = {};
  const given = (input && input.byEnvironment) || {};
  for (const envId of envIds) {
    const v = typeof given[envId] === 'string' ? given[envId].trim() : '';
    if (v === '') continue;
    if (v.length > MAX_VALUE_CHARS) problems.push(`Values must be ${MAX_VALUE_CHARS} characters or fewer.`);
    byEnvironment[envId] = v;
  }
  if (value === '' && Object.keys(byEnvironment).length === 0) {
    problems.push('Enter a value, or a value for at least one environment.');
  }
  return { problems, value: { name, value, byEnvironment } };
}

/** Reads the saved list. A missing or damaged file gives an empty list rather than an error. */
function load(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data)) return [];
    return data
      .filter((v) => v && typeof v.id === 'string' && typeof v.name === 'string' && NAME_PATTERN.test(v.name))
      .map((v) => ({
        id: v.id,
        name: v.name,
        value: typeof v.value === 'string' ? v.value : '',
        byEnvironment: v.byEnvironment && typeof v.byEnvironment === 'object' ? { ...v.byEnvironment } : {},
      }));
  } catch {
    return [];
  }
}

function save(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2), { mode: 0o600 });
}

/** Same rule as the desktop builder: letters and digits only, so orgId, org_id and org-id match. */
function variableKey(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function newId() {
  return `var:${crypto.randomUUID()}`;
}

/**
 * The values that apply in one environment, keyed by lower-case name. An environment value wins over the shared value;
 * a variable with no value here is left out.
 */
function valuesFor(list, envId) {
  const out = {};
  for (const v of list) {
    const value = (envId && v.byEnvironment[envId]) || v.value || '';
    if (value !== '') out[variableKey(v.name)] = { name: v.name, value };
  }
  return out;
}

module.exports = { validate, load, save, newId, valuesFor, variableKey, MAX_VARIABLES, MAX_VALUE_CHARS };
