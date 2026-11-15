const test = require('node:test');
const assert = require('node:assert/strict');
const { redact, rankPrompt, parseRank, parsePlan, extractKnown, planPrompt } = require('../lib/assist');

const op = {
  method: 'GET',
  path: '/sample/v4/items/{itemId}',
  hasBody: false,
  parameters: [
    { name: 'itemId', in: 'path', required: true },
    { name: 'org_id', in: 'query' },
    { name: 'page', in: 'query' },
    { name: 'X-Tenant', in: 'header' },
    { name: 'Authorization', in: 'header' },
  ],
};

test('redact removes bearer tokens and key=value secrets', () => {
  assert.equal(redact('use Bearer abc.def-123 now'), 'use Bearer [REDACTED] now');
  assert.equal(redact('password=hunter2 and api_key: xyz'), 'password=[REDACTED] and api_key: [REDACTED]');
});

test('rank prompt includes the candidates and no secrets from the question', () => {
  const p = rankPrompt('items for Bearer sekret', [{ id: 'a', method: 'GET', path: '/x', summary: 'List' }]);
  assert.ok(p.user.includes('a | GET /x | List'));
  assert.ok(!p.user.includes('sekret'));
});

test('parseRank keeps only offered ids, in order, without duplicates', () => {
  assert.deepEqual(parseRank('{"ids":["b","zz","a","b"]}', ['a', 'b']), ['b', 'a']);
  assert.deepEqual(parseRank('{"nope":1}', ['a']), []);
  assert.throws(() => parseRank('not json', ['a']));
});

test('parsePlan fills only declared parameters, reports the rest, and drops forbidden headers', () => {
  const text = JSON.stringify({
    path: { item_id: 'p-1' },
    query: { orgId: 'o-9', unknownThing: 'x' },
    headers: { 'x-tenant': 'example-org', Authorization: 'Bearer leaked' },
    body: null,
    notes: 'filled from text',
  });
  const r = parsePlan(text, op, 'item p-1 for orgId o-9 with x-tenant example-org');
  assert.deepEqual(r.values.path, { itemId: 'p-1' });
  assert.deepEqual(r.values.query, { org_id: 'o-9' });
  assert.deepEqual(r.values.headers, { 'X-Tenant': 'example-org' });
  assert.deepEqual(r.ignored.sort(), ['Authorization', 'unknownThing']);
  assert.equal(r.notes, 'filled from text');
});

test('parsePlan turns numbers into strings and only keeps a body when the operation has one', () => {
  const r = parsePlan(JSON.stringify({ query: { page: 2 }, body: { a: 1 } }), op, 'page 2');
  assert.equal(r.values.query.page, '2');
  assert.equal(r.values.body, null);
  const withBody = parsePlan(JSON.stringify({ body: { a: 1 } }), { ...op, hasBody: true });
  assert.equal(withBody.values.body, '{\n  "a": 1\n}');
});

const ITEM_ID = '6aed518cc9d52fa901b034ae';
const ORG_ID = 'ce080c13-da92-4e54-b375-517875018920';
const sentence = `get item with id ${ITEM_ID} for org ${ORG_ID}`;

test('IDs in the sentence go to the parameter named before them', () => {
  const known = extractKnown(sentence, op);
  assert.deepEqual(known.path, { itemId: ITEM_ID });
  assert.deepEqual(known.query, { org_id: ORG_ID });
});

test('"org or orgId or org_id" phrasing still reaches org_id', () => {
  const known = extractKnown(`item ${ITEM_ID} for org or orgId or org_id ${ORG_ID}`, op);
  assert.deepEqual(known.query, { org_id: ORG_ID });
});

test('an ambiguous ID is left alone for the model', () => {
  const twoIds = { ...op, parameters: [{ name: 'itemId', in: 'path' }, { name: 'zoneId', in: 'path' }] };
  assert.deepEqual(extractKnown(`thing ${ITEM_ID}`, twoIds).path, {});
});

test('an ID the model invents is dropped, and the ID from the sentence is used instead', () => {
  const invented = JSON.stringify({ path: { itemId: 'deadbeefdeadbeefdeadbeef' }, query: {} });
  const r = parsePlan(invented, op, sentence);
  assert.equal(r.values.path.itemId, ITEM_ID);
  assert.ok(r.ignored.includes('itemId (value not in the description)'));
});

test('an ID the model adds for a parameter the sentence does not mention is dropped', () => {
  const r = parsePlan(JSON.stringify({ query: { page: '1', org_id: 'ffffffffffffffffffffffff' } }), op, 'get item page 1');
  assert.equal(r.values.query.org_id, undefined);
  assert.equal(r.values.query.page, '1');
});

test('a value the sentence does not contain is dropped, even when it is not an ID', () => {
  const r = parsePlan(JSON.stringify({ query: { page: '1', sort: 'name' } }), op, 'get item for the org');
  assert.equal(r.values.query.page, undefined);
  assert.equal(r.values.query.sort, undefined);
  assert.ok(r.ignored.includes('page (value not in the description)'));
});

test('top-level body text the sentence does not contain is blanked so a variable can fill it', () => {
  const body = { orgId: 'org-made-up', name: 'Item A' };
  const r = parsePlan(JSON.stringify({ body }), { ...op, hasBody: true }, 'create a item named Item A');
  assert.deepEqual(JSON.parse(r.values.body), { orgId: '', name: 'Item A' });
});

test('the prompt tells the model which values were already read', () => {
  const p = planPrompt(sentence, op);
  assert.ok(p.user.includes(`"itemId":"${ITEM_ID}"`));
  assert.ok(p.system.includes('must be left as they are'));
});
