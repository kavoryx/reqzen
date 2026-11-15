// Default request payloads that the user saves for an API. Kept in the app's data folder on this computer, keyed by
// operation id, never in a snapshot.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 200 * 1024;

/** Checks one payload. Saving an empty payload removes the saved default, so it is not checked here. */
function validate(text) {
  const problems = [];
  if (typeof text !== 'string') return { problems: ['The payload must be text.'] };
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) problems.push('The payload is larger than 200 KB.');
  try {
    JSON.parse(text);
  } catch {
    problems.push('The payload is not valid JSON.');
  }
  return { problems };
}

/** Reads the saved map. A missing or damaged file gives an empty map rather than an error. */
function load(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const out = {};
    for (const [id, text] of Object.entries(data)) {
      if (typeof text === 'string' && text.trim() !== '') out[id] = text;
    }
    return out;
  } catch {
    return {};
  }
}

function save(file, map) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(map, null, 2), { mode: 0o600 });
}

module.exports = { validate, load, save, MAX_BYTES };
