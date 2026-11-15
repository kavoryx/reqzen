// The documentation agent: writes a short description for each API and an overview for each service. It reads only the
// facts of an operation (method, path, parameter names and types, body and return type names, the doc-comment summary),
// never request values or full source. The model's answer is checked before use. When the model fails or its answer is
// not usable, a factual template is used instead, so nothing is invented. Generated text is labelled with its source.
const fs = require('fs');
const path = require('path');
const assist = require('./assist');

const MAX_DESCRIPTION = 1200;
const MAX_OVERVIEW = 1500;
const MAX_INSTRUCTIONS = 3000;

// The default writing instructions, shown in the Documentation window and editable there. The app always adds RULES below,
// so an edited instruction cannot switch off the no-invention rule.
const DEFAULT_INSTRUCTIONS = [
  'Write for a developer who will call this API from a client.',
  'For each API, write two to four sentences: what it does for the business, the main inputs (path, query and body) by name and what they select or filter,',
  'and what the response returns, using the return type name. Mention the version if it is given. If the API is deprecated, say so.',
  'If the API is hidden or internal, say it is for internal use only. Do not start with the HTTP method or the path, and do not say "this endpoint" or "this method".',
  'For each service, write an overview of what the service is for, in two to four sentences, based on its APIs.',
].join(' ');
const RULES = 'Use only the facts given. Do not invent behaviour, limits, permissions or responses. If a fact is missing, leave it out.';

/** The writing instructions to use: the user's text if it has any, otherwise the default. Trimmed and limited in length. */
function instructionsOrDefault(text) {
  const t = typeof text === 'string' ? text.trim().slice(0, MAX_INSTRUCTIONS) : '';
  return t || DEFAULT_INSTRUCTIONS;
}
const MAX_LIST = 60;

/** The facts about one operation that the model may use. */
function facts(op) {
  const d = op.definition || {};
  const x = d['x-apiexplorer'] || {};
  const operation = d.operation || {};
  const params = Array.isArray(operation.parameters) ? operation.parameters : [];
  const content = operation.requestBody && operation.requestBody.content && operation.requestBody.content['application/json'];
  return {
    revisionId: op.revisionId,
    method: op.httpMethod || '',
    path: op.pathTemplate || '',
    serviceName: op.serviceName || '',
    controller: x.controller || '',
    methodName: x.method || operation.operationId || '',
    summary: String(op.summary || '').trim(),
    version: op.contractVersion || '',
    deprecated: op.lifecycleStatus === 'DEPRECATED',
    visibility: op.visibility || 'PUBLIC',
    parameters: params.map((p) => ({ name: p.name, in: p.in, required: p.required === true, type: (p.schema && p.schema.type) || 'string' })),
    bodyType: (content && content.schema && content.schema['x-source-type']) || '',
    returnType: x.returnType || '',
  };
}

/** The facts as plain lines for the model. Values from requests are never included. */
function factLines(f) {
  const lines = [`Method: ${f.method}`, `Path: ${f.path}`];
  if (f.controller) lines.push(`Controller: ${f.controller}, method: ${f.methodName}`);
  if (f.version) lines.push(`Version: ${f.version}`);
  if (f.summary) lines.push(`Doc comment: ${f.summary}`);
  if (f.deprecated) lines.push('Deprecated: yes');
  if (f.visibility && f.visibility !== 'PUBLIC') lines.push(`Visibility: ${f.visibility === 'HIDDEN' ? 'hidden, for internal use' : 'internal'}`);
  const by = (where) => f.parameters.filter((p) => p.in === where).map((p) => `${p.name} (${p.type}${p.required ? ', required' : ''})`);
  if (by('path').length) lines.push(`Path parameters: ${by('path').join(', ')}`);
  if (by('query').length) lines.push(`Query parameters: ${by('query').join(', ')}`);
  if (by('header').length) lines.push(`Header parameters: ${by('header').join(', ')}`);
  if (f.bodyType) lines.push(`Request body type: ${f.bodyType}`);
  if (f.returnType) lines.push(`Returns: ${f.returnType}`);
  return lines;
}

/** The prompt for one API description, with the user's writing instructions. */
function describePrompt(op, instructions) {
  return {
    system: [instructionsOrDefault(instructions), RULES, 'Reply with JSON only: {"description": "..."}'].join(' '),
    user: assist.redact(factLines(facts(op)).join('\n')),
  };
}

/**
 * The JSON object in a model answer. Small local models sometimes add a sentence or a code fence around it, so the
 * text between the first "{" and the last "}" is tried when the whole answer is not JSON.
 */
function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    // Not plain JSON: try the object inside the text.
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** The model's description if it is usable, otherwise null. */
function parseDescription(text) {
  const data = parseJsonLoose(text);
  if (!data) return null;
  const d = data && typeof data.description === 'string' ? data.description.trim() : '';
  if (d.length < 10 || d.length > MAX_DESCRIPTION) return null;
  return d;
}

/** A factual description with no model: the doc-comment summary, or the method and path with its parameters. */
function templateDescription(op) {
  const f = facts(op);
  if (f.summary) return f.summary.slice(0, MAX_DESCRIPTION);
  const names = f.parameters.map((p) => p.name).join(', ');
  let text = `${f.method} ${f.path}`;
  if (names) text += ` with ${names}`;
  if (f.bodyType) text += `, body ${f.bodyType}`;
  return `${text}. Data unavailable: no model description yet.`;
}

/** The prompt for a service overview, from one line per API. */
function overviewPrompt(serviceName, ops, instructions) {
  const lines = ops.slice(0, MAX_LIST).map((op) => `${op.httpMethod} ${op.pathTemplate}${op.summary ? ` — ${op.summary}` : ''}`);
  return {
    system: [instructionsOrDefault(instructions), RULES, 'Reply with JSON only: {"overview": "..."}'].join(' '),
    user: assist.redact(`Service: ${serviceName}\nAPIs:\n${lines.join('\n')}`),
  };
}

/** The model's overview if usable, otherwise null. */
function parseOverview(text) {
  const data = parseJsonLoose(text);
  if (!data) return null;
  const o = data && typeof data.overview === 'string' ? data.overview.trim() : '';
  if (o.length < 10 || o.length > MAX_OVERVIEW) return null;
  return o;
}

/**
 * Writes descriptions for a list of operations. `chat(system, user)` is the model call (injected for tests).
 * `source` labels the model ('local' or 'claude'). Returns the results and how many model calls failed.
 */
async function runDocAgent({ operations, chat, source, instructions }) {
  const results = [];
  let modelFailures = 0;
  for (const op of operations) {
    let description = null;
    try {
      const prompt = describePrompt(op, instructions);
      description = parseDescription(await chat(prompt.system, prompt.user));
    } catch {
      modelFailures++;
    }
    if (description) {
      results.push({ revisionId: op.revisionId, description, source });
    } else {
      results.push({ revisionId: op.revisionId, description: templateDescription(op), source: 'template' });
    }
  }
  return { results, modelFailures };
}

/** A service overview from the model, or a factual line when the model cannot write one. */
async function runOverview({ serviceName, operations, chat, source, instructions }) {
  try {
    const prompt = overviewPrompt(serviceName, operations, instructions);
    const overview = parseOverview(await chat(prompt.system, prompt.user));
    if (overview) return { overview, source, modelFailed: false };
    return { overview: `${operations.length} APIs for ${serviceName}. Data unavailable: no overview was written.`, source: 'template', modelFailed: false };
  } catch {
    return { overview: `${operations.length} APIs for ${serviceName}. Data unavailable: the model did not answer.`, source: 'template', modelFailed: true };
  }
}

/** The whole saved file: { docs: {revisionId: ...}, overviews: {serviceName: ...} }. A missing or damaged file is empty. */
function read(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      docs: data && data.docs && typeof data.docs === 'object' ? data.docs : {},
      overviews: data && data.overviews && typeof data.overviews === 'object' ? data.overviews : {},
    };
  } catch {
    return { docs: {}, overviews: {} };
  }
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/** The saved descriptions, keyed by revisionId. */
function load(file) {
  return read(file).docs;
}

/** Saves new descriptions into the file, keeping the rest. Returns the whole description map. */
function merge(file, results) {
  const data = read(file);
  const at = new Date().toISOString();
  for (const r of results) data.docs[r.revisionId] = { description: r.description, source: r.source, generatedAt: at };
  write(file, data);
  return data.docs;
}

/** Saves a service overview, keeping everything else in the file. Returns the whole overview map. */
function saveOverview(file, serviceName, overview, source) {
  const data = read(file);
  data.overviews[serviceName] = { overview, source, generatedAt: new Date().toISOString() };
  write(file, data);
  return data.overviews;
}

function loadOverviews(file) {
  return read(file).overviews;
}

module.exports = { facts, factLines, describePrompt, parseDescription, templateDescription, overviewPrompt, parseOverview, runDocAgent, runOverview, load, merge, saveOverview, loadOverviews, DEFAULT_INSTRUCTIONS, instructionsOrDefault, RULES };
