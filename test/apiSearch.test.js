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
  assert.equal(rankApiSearch('get users for orgId ce080c13-da92-4e54-b375-517875018920', candidates)[0].candidate.id, 'list');
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

test('search intent hard-filters method, entity and GET item shape', async () => {
  const { matchesApiSearchIntent, rankApiSearch } = await search;
  const rows = [
    { id: 'pool-list', method: 'GET', path: '/v3/pools', summary: 'List pools' },
    { id: 'pool-item', method: 'GET', path: '/v3/pools/{poolId}', summary: 'Get pool' },
    { id: 'pool-put', method: 'PUT', path: '/v3/pools/{poolId}', summary: 'Update pool' },
    { id: 'pool-patch', method: 'PATCH', path: '/v3/pools/{poolId}', summary: 'Patch pool' },
    { id: 'pool-delete', method: 'DELETE', path: '/v3/pools/{poolId}', summary: 'Delete pool' },
    { id: 'order-list', method: 'GET', path: '/v3/orders', summary: 'List orders' },
  ];
  assert.deepEqual(rankApiSearch('fetch all pools', rows).map(({ candidate }) => candidate.id), ['pool-list']);
  assert.deepEqual(rankApiSearch('get pool by id abc', rows).map(({ candidate }) => candidate.id), ['pool-item']);
  assert.deepEqual(rankApiSearch('update pool', rows).map(({ candidate }) => candidate.id), ['pool-put', 'pool-patch']);
  assert.deepEqual(rankApiSearch('patch pool', rows).map(({ candidate }) => candidate.id), ['pool-patch']);
  assert.deepEqual(rankApiSearch('delete pool', rows).map(({ candidate }) => candidate.id), ['pool-delete']);
  assert.equal(matchesApiSearchIntent('delete pool', rows[1]), false);
});

test('configured entity groups treat related names consistently', async () => {
  const { rankApiSearch } = await search;
  const rows = [
    { id: 'pool', method: 'GET', path: '/v1/pools', summary: 'List pools' },
    { id: 'group', method: 'GET', path: '/v1/pool-groups', summary: 'List pool groups' },
    { id: 'template', method: 'GET', path: '/v1/templates', summary: 'List templates' },
  ];
  assert.deepEqual(rankApiSearch('fetch all pool groups', rows).map(({ candidate }) => candidate.id).sort(), ['group', 'pool', 'template']);
  assert.deepEqual(rankApiSearch('get all templates/pools', rows).map(({ candidate }) => candidate.id).sort(), ['group', 'pool', 'template']);
  assert.deepEqual(rankApiSearch('fetch all pools', rows, { entityGroups: [] }).map(({ candidate }) => candidate.id), ['pool']);
});

test('strict entity matching supports nested paths while preferring the final resource segment', async () => {
  const { rankApiSearch } = await search;
  const rows = [
    { id: 'org-pools', method: 'GET', path: '/v3/organizations/{orgId}/pools', summary: 'List organization pools' },
    { id: 'org-orders', method: 'GET', path: '/v3/organizations/{orgId}/orders', summary: 'List organization orders' },
  ];
  assert.deepEqual(rankApiSearch('get pools for orgId ce080c13-da92-4e54-b375-517875018920', rows)
    .map(({ candidate }) => candidate.id), ['org-pools']);
  assert.deepEqual(rankApiSearch('get all pools by orgId 123243456', rows)
    .map(({ candidate }) => candidate.id), ['org-pools']);
});

test('request documents populate parameter fields from natural language', async () => {
  const { requestValuesFromDocument, updateRequestValuesFromDocument } = await search;
  assert.deepEqual(
    requestValuesFromDocument('get pools for orgId ce080c13-da92-4e54-b375-517875018920', ['orgId', 'poolId']),
    { orgId: 'ce080c13-da92-4e54-b375-517875018920' },
  );
  assert.deepEqual(
    requestValuesFromDocument('fetch pool with poolId="pool-42" and orgId: org-7', ['orgId', 'poolId']),
    { orgId: 'org-7', poolId: 'pool-42' },
  );
  assert.deepEqual(
    requestValuesFromDocument('orgId=org-7&poolId=pool-42', ['orgId', 'poolId']),
    { orgId: 'org-7', poolId: 'pool-42' },
  );
  assert.deepEqual(
    requestValuesFromDocument('get all pools by org ce080c13-da92-4e54-b375-517875018920', ['orgId', 'poolId']),
    { orgId: 'ce080c13-da92-4e54-b375-517875018920' },
  );
  assert.deepEqual(
    requestValuesFromDocument('get all pools by org_id ce080c13-da92-4e54-b375-517875018920', ['orgId']),
    { orgId: 'ce080c13-da92-4e54-b375-517875018920' },
  );
  assert.deepEqual(
    requestValuesFromDocument('get all pools by orgId=123243456', ['org']),
    { org: '123243456' },
  );
  assert.deepEqual(
    updateRequestValuesFromDocument(
      { orgId: 'org-7', poolId: 'manually-entered' },
      'get pools for orgId org-7',
      'get pools',
      ['orgId', 'poolId'],
    ),
    { poolId: 'manually-entered' },
  );
  assert.deepEqual(
    updateRequestValuesFromDocument(
      { orgId: 'org-7' },
      'get pools for orgId org-7',
      'get pools for orgId org-8',
      ['orgId'],
    ),
    { orgId: 'org-8' },
  );
});
