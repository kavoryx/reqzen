const test = require('node:test');
const assert = require('node:assert/strict');

const search = import('../ui/src/apiSearch.mjs');
const candidates = [
  { id: 'list', method: 'GET', path: '/v1/users', summary: 'List accounts', version: 'v1', service: 'Identity' },
  { id: 'one', method: 'GET', path: '/v1/users/{userId}', summary: 'Get account', version: 'v1', service: 'Identity' },
  { id: 'delete', method: 'DELETE', path: '/v1/users/{userId}', summary: 'Remove account', version: 'v1', service: 'Identity' },
  { id: 'v2', method: 'GET', path: '/v2/users', summary: 'List accounts', version: 'v2', service: 'Identity' },
  { id: 'other', method: 'GET', path: '/v1/orders', summary: 'Orders', description: 'Retrieve purchase history', version: 'v1', service: 'Sales' },
];

test('natural-language searches rank resource, method, version and collection intent', async () => {
  const { rankApiSearch } = await search;
  assert.equal(rankApiSearch('list all users v2', candidates)[0].candidate.id, 'v2');
  assert.equal(rankApiSearch('delete a user', candidates)[0].candidate.id, 'delete');
  assert.equal(rankApiSearch('get a single user', candidates)[0].candidate.id, 'one');
  assert.equal(rankApiSearch('GET /v1/users', candidates)[0].candidate.id, 'list');
});

test('search uses generated descriptions and does not return unrelated lexical results', async () => {
  const { rankApiSearch } = await search;
  assert.equal(rankApiSearch('purchase history', candidates)[0].candidate.id, 'other');
  assert.deepEqual(rankApiSearch('unrelated elephants', candidates), []);
});

test('matching tolerates word order, case, plurals and long ID values', async () => {
  const { rankApiSearch } = await search;
  assert.equal(rankApiSearch('USERS list', candidates)[0].candidate.id, 'list');
  assert.equal(rankApiSearch('get user by id 6aed518cc9d52fa901b034ae', candidates)[0].candidate.id, 'one');
  assert.equal(rankApiSearch('identity users', candidates)[0].candidate.id, 'list');
});

test('minor versions are matched as complete versions', async () => {
  const { rankApiSearch } = await search;
  const versions = [
    { id: 'one', method: 'GET', path: '/v1.1/users', version: 'v1.1' },
    { id: 'two', method: 'GET', path: '/v1.2/users', version: '1.2' },
  ];
  assert.equal(rankApiSearch('list users v1.2', versions)[0].candidate.id, 'two');
  assert.equal(rankApiSearch('v1.2', versions).length, 1);
});

test('AI reranking cannot overpower a clear method and version match', async () => {
  const { scoreApiSearch, combinedSearchScore } = await search;
  const right = scoreApiSearch('delete user v2', { id: 'right', method: 'DELETE', path: '/v2/users/{id}', version: 'v2' });
  const wrong = scoreApiSearch('delete user v2', { id: 'wrong', method: 'GET', path: '/v1/users', version: 'v1' });
  assert.ok(combinedSearchScore(right, undefined) > combinedSearchScore(wrong, 0));
  assert.ok(combinedSearchScore(0, 0) > combinedSearchScore(0, 1));
});

test('custom metadata is searchable even when it is the only matching text', async () => {
  const { rankApiSearch } = await search;
  const rows = [...candidates, { id: 'custom', method: 'GET', path: '/v1/reports', metadata: 'Team owner Platform Engineering' }];
  assert.equal(rankApiSearch('platform engineering', rows)[0].candidate.id, 'custom');
});
