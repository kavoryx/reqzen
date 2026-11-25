const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const doc = require('../lib/docAgent');

const op = (over = {}) => ({
  revisionId: 'rev-1',
  httpMethod: 'GET',
  pathTemplate: '/sample/v1/items/{itemId}',
  serviceName: 'sample',
  summary: 'Gets one item.',
  lifecycleStatus: 'ACTIVE',
  definition: {
    operation: {
      operationId: 'get',
      parameters: [
        { name: 'itemId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'expand', in: 'query', required: false, schema: { type: 'boolean' } },
      ],
    },
    'x-apiexplorer': { controller: 'ItemController', method: 'get', returnType: 'ItemDto' },
  },
  ...over,
});

test('the facts include names and types, not values, and the prompt is redacted', () => {
  const o = op({ summary: 'Uses password=hunter2 and Bearer abc.def.ghi' });
  const p = doc.describePrompt(o);
  assert.match(p.user, /Path parameters: itemId \(string, required\)/);
  assert.match(p.user, /Returns: ItemDto/);
  assert.doesNotMatch(p.user, /hunter2/);
  assert.doesNotMatch(p.user, /abc\.def\.ghi/);
});

test('a usable model answer is used, labelled with its source', async () => {
  const chat = async () => '{"description": "Returns one item by its identifier, with an optional expanded view."}';
  const r = await doc.runDocAgent({ operations: [op()], chat, source: 'local' });
  assert.equal(r.modelFailures, 0);
  assert.equal(r.results[0].source, 'local');
  assert.match(r.results[0].description, /Returns one item/);
});

test('an unusable answer falls back to the factual template, with no invented text', async () => {
  const chat = async () => 'Sure! Here is a poem about items.';
  const r = await doc.runDocAgent({ operations: [op()], chat, source: 'local' });
  assert.equal(r.results[0].source, 'template');
  assert.equal(r.results[0].description, 'Gets one item.');
  assert.equal(r.modelFailures, 0);
});

test('a failing model is counted, and the template is used without a summary', async () => {
  const chat = async () => { throw new Error('down'); };
  const noSummary = op({ summary: '' });
  const r = await doc.runDocAgent({ operations: [noSummary, op({ revisionId: 'rev-2' })], chat, source: 'claude' });
  assert.equal(r.modelFailures, 2);
  assert.equal(r.results[0].description, 'Retrieves items using itemId, expand.');
  assert.equal(r.results[0].summary, 'Retrieves items using itemId, expand.');
  assert.equal(r.results[0].source, 'template');
});

test('a description that is too short or too long is refused', () => {
  assert.equal(doc.parseDescription('{"description": "Hi"}'), null);
  assert.equal(doc.parseDescription(JSON.stringify({ description: 'x'.repeat(1201) })), null);
  assert.equal(doc.parseDescription('not json'), null);
  assert.equal(doc.parseDescription('{"description": "A fine one-line description."}'), 'A fine one-line description.');
});

test('the overview uses a model answer or says data is unavailable', async () => {
  const ops = [op(), op({ revisionId: 'rev-2', httpMethod: 'POST', pathTemplate: '/items', summary: '' })];
  const good = await doc.runOverview({ serviceName: 'sample', operations: ops, chat: async () => '{"overview": "Manages resource items for organisations."}', source: 'local' });
  assert.equal(good.source, 'local');
  const bad = await doc.runOverview({ serviceName: 'sample', operations: ops, chat: async () => { throw new Error('down'); }, source: 'local' });
  assert.equal(bad.source, 'template');
  assert.equal(bad.modelFailed, true);
  assert.match(bad.overview, /^2 APIs for sample\. Data unavailable/);
});

test('an overview is saved next to the descriptions without removing them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-'));
  const file = path.join(dir, 'api-docs.json');
  doc.merge(file, [{ revisionId: 'a', description: 'First text here.', source: 'local' }]);
  const overviews = doc.saveOverview(file, 'sample', 'Manages items for organisations.', 'local');
  assert.equal(overviews.sample.overview, 'Manages items for organisations.');
  assert.deepEqual(Object.keys(doc.load(file)), ['a']);
  assert.equal(doc.loadOverviews(file).sample.source, 'local');
});

test('saved descriptions merge with the earlier ones, and a damaged file is an empty map', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-'));
  const file = path.join(dir, 'api-docs.json');
  assert.deepEqual(doc.load(file), {});
  doc.merge(file, [{ revisionId: 'a', description: 'First text here.', source: 'local' }]);
  const docs = doc.merge(file, [{ revisionId: 'b', description: 'Second text here.', source: 'template' }]);
  assert.deepEqual(Object.keys(docs).sort(), ['a', 'b']);
  fs.writeFileSync(file, '{broken');
  assert.deepEqual(doc.load(file), {});
});

test('the writing instructions come from the user, and the no-invention rule is always added', () => {
  const custom = doc.describePrompt(op(), 'Write one sentence in plain English.').system;
  assert.match(custom, /Write one sentence in plain English\./);
  assert.ok(custom.includes(doc.RULES), 'the rule is kept even when the user edits the text');
  assert.ok(custom.includes('"summary"') && custom.includes('"description"'), 'the reply format is kept');
  assert.equal(doc.describePrompt(op(), '   ').system.startsWith(doc.DEFAULT_INSTRUCTIONS), true, 'blank text uses the default');
});

test('the version and a real summary reach the model, and the method name is not used as a summary', () => {
  const o = op({ summary: '', contractVersion: 'v3' });
  const p = doc.describePrompt(o, '');
  assert.match(p.user, /Version: v3/);
  assert.doesNotMatch(p.user, /Doc comment/);
  assert.match(doc.templateDescription(o), /^Retrieves items/);
});

test('external prompts share the documentation rules and specify an importable snapshot', () => {
  const prompts = doc.externalPrompts('Use concise terminology.');
  for (const prompt of [prompts.source, prompts.enrich]) {
    assert.match(prompt, /Use concise terminology/);
    assert.ok(prompt.includes(doc.RULES));
    assert.match(prompt, /HTTP method/);
    assert.match(prompt, /complete valid JSON/);
    assert.match(prompt, /customFieldDefinitions/);
    assert.match(prompt, /customFields/);
    assert.match(prompt, /at most 12 fields/);
  }
  const example = prompts.source.match(/\{"format":"api-explorer-snapshot".*\}/)[0];
  const data = JSON.parse(example);
  assert.equal(require('../lib/snapshotValidation').validateSnapshot(data), '');
  assert.match(prompts.enrich, /Preserve.*IDs, method, path, version/);
});

test('generated summaries are saved, with a description fallback for older model replies', async () => {
  const withSummary = await doc.runDocAgent({ operations: [op()], chat: async () => '{"summary":"Get an item by ID","description":"Returns one item by its identifier."}', source: 'local' });
  assert.equal(withSummary.results[0].summary, 'Get an item by ID');
  const older = await doc.runDocAgent({ operations: [op()], chat: async () => '{"description":"Returns one item by its identifier. It accepts a query."}', source: 'local' });
  assert.equal(older.results[0].summary, 'Returns one item by its identifier.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-summary-'));
  const saved = doc.merge(path.join(dir, 'docs.json'), withSummary.results);
  assert.equal(saved['rev-1'].summary, 'Get an item by ID');
});

test('a model answer with a sentence or a code fence around the JSON is still used', () => {
  assert.equal(doc.parseDescription('Here you go:\n```json\n{"description": "Returns one item by its identifier."}\n```'), 'Returns one item by its identifier.');
  assert.equal(doc.parseOverview('Sure. {"overview": "Manages resource items for organisations."} Done.'), 'Manages resource items for organisations.');
  assert.equal(doc.parseDescription('no json at all'), null);
});
