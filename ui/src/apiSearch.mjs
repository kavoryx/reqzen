const STOP = new Set(['a', 'an', 'the', 'to', 'for', 'of', 'with', 'by', 'in', 'on', 'and', 'or', 'from', 'api', 'endpoint', 'please', 'show', 'me', 'all']);
const ACTIONS = {
  get: ['GET'], fetch: ['GET'], find: ['GET'], retrieve: ['GET'], list: ['GET'], read: ['GET'],
  create: ['POST'], add: ['POST'], post: ['POST'],
  update: ['PUT', 'PATCH'], edit: ['PUT', 'PATCH'], put: ['PUT'], patch: ['PATCH'],
  delete: ['DELETE'], remove: ['DELETE'],
};
const METHOD_NAMES = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const IDENTIFIER_VALUES = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9a-z]+[0-9][0-9a-z_-]{15,})\b/gi;

function stem(word) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function words(value) {
  return String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]+/g)?.map(stem) || [];
}

function parsedQuery(query) {
  const version = String(query).match(/\bv(\d+(?:\.\d+)*)\b/i)?.[1] || '';
  const raw = words(String(query).replace(IDENTIFIER_VALUES, ' ').replace(/\bv\d+(?:\.\d+)*\b/gi, ' '));
  const explicitMethod = String(query).toUpperCase().match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/)?.[1];
  const action = raw.find((term) => ACTIONS[term]);
  const methods = explicitMethod ? [explicitMethod] : (ACTIONS[action] || []);
  const terms = [...new Set(raw.filter((term) => !STOP.has(term) && !ACTIONS[term] && !METHOD_NAMES.has(term.toUpperCase()) && !/^[0-9a-f]{16,}$/.test(term)))];
  const collection = /\b(all|list|collection)\b/i.test(query);
  const single = /\b(one|single|specific|by id)\b/i.test(query) || /\{[^}]+\}/.test(query);
  return { methods, version, terms, collection, single };
}

export function scoreApiSearch(query, operation) {
  const parsed = parsedQuery(query);
  const path = String(operation.path || '');
  const method = String(operation.method || '').toUpperCase();
  const resource = words(path.replace(/\{[^}]+\}/g, ' '));
  const summary = words(operation.summary);
  const description = words(operation.description);
  const metadata = words(operation.metadata);
  const service = words(operation.service);
  const explicitVersion = String(operation.version || '').trim().match(/^v?(\d+(?:\.\d+)*)$/i)?.[1];
  const pathVersions = [...path.matchAll(/(?:^|\/)v(\d+(?:\.\d+)*)(?=\/|$)/gi)].map((match) => match[1]);
  const fields = [resource, summary, service, metadata, description];
  let score = 0;
  let matched = 0;
  for (const term of parsed.terms) {
    let best = 0;
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      const weight = [8, 6, 4, 3, 2][i];
      if (field.includes(term)) best = Math.max(best, weight);
      else if (term.length >= 3 && field.some((word) => word.startsWith(term))) best = Math.max(best, weight * 0.6);
    }
    if (best) { matched++; score += best; }
  }
  if (parsed.terms.length && !matched) return 0;
  if (parsed.terms.length) score += 4 * matched / parsed.terms.length;
  if (parsed.methods.length) score += parsed.methods.includes(method) ? 5 : -5;
  if (parsed.version) score += explicitVersion === parsed.version || pathVersions.includes(parsed.version) ? 5 : -5;
  if (parsed.collection && method === 'GET') score += /\{[^}]+\}\/?$/.test(path) ? -2 : 2;
  if (parsed.single && method === 'GET') score += /\{[^}]+\}\/?$/.test(path) ? 2 : 0;
  if (!parsed.terms.length && !parsed.methods.length && !parsed.version) return 0;
  return Math.max(0, score);
}

export function rankApiSearch(query, candidates) {
  return candidates.map((candidate, index) => ({ candidate, index, score: scoreApiSearch(query, candidate) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
}

export function combinedSearchScore(localScore, aiRank) {
  return localScore + (aiRank === undefined ? 0 : 5 / (aiRank + 1));
}

function escapedParameterPattern(name) {
  const spaced = String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return [...spaced].map((character) => /[a-z0-9]/i.test(character)
    ? character
    : character === ' ' ? '[\\s_-]*'
      : `\\${character}`).join('');
}

export function requestValuesFromDocument(document, parameterNames) {
  const text = String(document || '').trim();
  const values = {};
  if (!text) return values;

  for (const parameterName of parameterNames) {
    const name = escapedParameterPattern(parameterName);
    const quoted = text.match(new RegExp(`(?:^|\\W)["']?${name}["']?\\s*(?:=|:|\\bis\\b)?\\s*["']([^"']+)["']`, 'i'));
    const unquoted = text.match(new RegExp(`(?:^|\\W)["']?${name}["']?\\s*(?:(?:=|:)\\s*|\\bis\\b\\s+|\\s+)([^\\s,;&]+)`, 'i'));
    let value = quoted?.[1] || unquoted?.[1] || '';
    value = value.replace(/[)\]}]+$/, '');
    if (!value || /^(?:for|with|and|then|please)$/i.test(value)) continue;
    values[parameterName] = value;
  }
  return values;
}
