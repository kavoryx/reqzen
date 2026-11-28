// Builds the catalogue a second user can open directly: the same snapshot format the app already reads, with each API's
// summary and description (from the spec, or the documentation agent's draft), its details, the service overviews and the
// default environment. Also builds a flat CSV for spreadsheets.
const tokenTypes = require('./tokenTypes');
const variables = require('./variables');

const FORMAT = 'api-explorer-snapshot';
const VERSION = 1;

/** The default environment for the export or import: the one named, or the first available. */
function pickDefaultEnvironment(environments, preferredId) {
  const list = Array.isArray(environments) ? environments : [];
  const byId = list.find((e) => e.environmentId === preferredId);
  if (byId) return byId.environmentId;
  return list[0] ? list[0].environmentId : '';
}

/** Adds the generated description where the spec has none, and says where each description came from. */
function withDescriptions(op, docs, includeGenerated) {
  const saved = docs[op.revisionId];
  const generated = includeGenerated && saved && saved.source !== 'template' ? saved.description : '';
  const generatedSummary = includeGenerated && saved && saved.source !== 'template' ? saved.summary : '';
  const description = op.description || generated || '';
  const source = op.description ? 'spec' : generated ? saved.source : '';
  const definition = { ...(op.definition || {}) };
  definition['x-apiexplorer'] = { ...(definition['x-apiexplorer'] || {}), descriptionSource: source };
  return { ...op, summary: op.summary || generatedSummary || '', description, definition };
}

/**
 * The export as a snapshot object. `snapshot` is the open catalogue; `docs` and `overviews` are the saved agent output.
 * Options: `services` is the list of service ids to export (null for all); `includeEnvironments` leaves the environments
 * out when false; `tokenTypes` adds the token type settings (already without values) when given.
 * Operations keep their order; services get the overview when there is one.
 */
function buildCatalog({ snapshot, docs = {}, overviews = {}, defaultEnvironmentId, includeGenerated = true, exportedBy = 'Reqzen',
  services = null, includeEnvironments = true, tokenTypes = null }) {
  if (!snapshot || !Array.isArray(snapshot.operations)) throw new Error('There is no API list to export.');
  const keep = (serviceId) => !Array.isArray(services) || services.includes(serviceId);
  const operations = snapshot.operations
    .filter((op) => keep(op.serviceId))
    .map((op) => withDescriptions(op, docs, includeGenerated));
  const chosenServices = (snapshot.services || []).filter((s) => keep(s.serviceId)).map((s) => {
    const o = overviews[s.name];
    return o && o.source !== 'template' && includeGenerated ? { ...s, overview: o.overview } : { ...s };
  });
  const environments = includeEnvironments ? (snapshot.environments || []).map((e) => ({ ...e })) : [];
  const out = {
    format: FORMAT,
    formatVersion: VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy,
    defaultEnvironmentId: environments.length > 0 ? pickDefaultEnvironment(environments, defaultEnvironmentId) : '',
    services: chosenServices,
    environments,
    // Overrides name an environment and its address, so they leave with the environments.
    serviceOverrides: includeEnvironments ? (snapshot.serviceOverrides || []).filter((o) => keep(o.serviceId)) : [],
    operations,
  };
  if (Array.isArray(tokenTypes)) out.tokenTypes = tokenTypes;
  if (Array.isArray(snapshot.customFieldDefinitions)) out.customFieldDefinitions = snapshot.customFieldDefinitions;
  if (Array.isArray(snapshot.apiFieldDefinitions)) out.apiFieldDefinitions = snapshot.apiFieldDefinitions;
  return out;
}

function selected(items, ids, key, label) {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw new Error(`Choose valid ${label}.`);
  const available = new Set(items.map((item) => item[key]));
  if (ids.some((id) => !available.has(id))) throw new Error(`A selected ${label} is no longer available. Reopen export and try again.`);
  const wanted = new Set(ids);
  return items.filter((item) => wanted.has(item[key]));
}

function buildShareCatalog({ snapshot, environments, types, savedVariables, selections, docs, overviews }) {
  if (!snapshot) throw new Error('Open a catalog before exporting.');
  if (!selections || typeof selections !== 'object') throw new Error('Choose what to export.');
  const services = (snapshot.services || []).map((service) => ({
    ...service, serviceId: service.serviceId || service.name,
  }));
  const chosenServices = selected(services, selections.services, 'serviceId', 'service');
  if (chosenServices.length === 0) throw new Error('Choose at least one service.');
  const chosenEnvironments = selected(environments, selections.environments, 'environmentId', 'environment');
  const chosenTypes = selected(types, selections.tokenTypes, 'id', 'token type');
  const chosenVariables = selected(savedVariables, selections.variables, 'id', 'variable');
  if (chosenVariables.length && selections.includeVariableValues !== true) throw new Error('Confirm that variable values may be included.');
  const envIds = chosenEnvironments.map((env) => env.environmentId);
  const safeTypes = tokenTypes.exportRows(chosenTypes, {}, selections.includeTokenSecrets === true ? {} : null);
  if (selections.includeTokenSecrets !== true) {
    for (const type of safeTypes) {
      type.headers = '';
      type.body = '';
      if (type.operation) type.operation = { ...type.operation, defaultBody: '' };
      if (type.url) {
        const url = new URL(type.url);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        type.url = url.toString();
      }
    }
  }
  const filtered = {
    ...snapshot,
    services,
    operations: snapshot.operations.map((operation) => ({
      ...operation,
      serviceId: services.some((service) => service.serviceId === operation.serviceId)
        ? operation.serviceId : services.find((service) => service.name === operation.serviceName)?.serviceId || operation.serviceId,
    })),
    environments: chosenEnvironments.map(({ yours, overridden, snapshotBaseUrl, ...environment }) => environment),
    serviceOverrides: (snapshot.serviceOverrides || []).filter((entry) => envIds.includes(entry.environmentId)),
  };
  const catalog = buildCatalog({
    snapshot: filtered, docs, overviews, services: chosenServices.map((service) => service.serviceId),
    defaultEnvironmentId: selections.defaultEnvironmentId, tokenTypes: safeTypes,
  });
  catalog.variables = variables.exportRows(chosenVariables, envIds);
  return catalog;
}

/** One CSV cell: quoted when it has a comma, quote or line break, with quotes doubled. */
function cell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parameterText(params) {
  return (params || []).map((p) => `${p.name} (${p.in}, ${p.schema && p.schema.type ? p.schema.type : 'string'}${p.required ? ', required' : ''})`).join('; ');
}

const CSV_HEADER = ['Service', 'Method', 'Path', 'Version', 'Visibility', 'Lifecycle', 'Summary', 'Description', 'Description source', 'Parameters', 'Body type', 'Return type', 'Source file', 'Controller'];

/** The catalogue as CSV with a byte-order mark, so spreadsheets open the accents and symbols correctly. */
function toCsv(catalog) {
  const rows = [CSV_HEADER.join(',')];
  for (const op of catalog.operations) {
    const x = (op.definition && op.definition['x-apiexplorer']) || {};
    const body = op.definition && op.definition.operation && op.definition.operation.requestBody;
    const bodyType = body && body.content && body.content['application/json'] && body.content['application/json'].schema
      ? body.content['application/json'].schema['x-source-type'] || '' : '';
    rows.push([
      op.serviceName, op.httpMethod, op.pathTemplate, op.contractVersion, op.visibility, op.lifecycleStatus,
      op.summary, op.description, (x.descriptionSource || ''), parameterText(op.definition && op.definition.operation && op.definition.operation.parameters),
      bodyType, x.returnType || '', x.source || '', x.controller || '',
    ].map(cell).join(','));
  }
  return '﻿' + rows.join('\r\n') + '\r\n';
}

module.exports = { buildCatalog, buildShareCatalog, toCsv, pickDefaultEnvironment, FORMAT, VERSION };
