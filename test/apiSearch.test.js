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
  assert.equal(rankApiSearch('get users for productId product-123', candidates)[0].candidate.id, 'list');
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
    { id: 'product-list', method: 'GET', path: '/v3/products', summary: 'List products' },
    { id: 'product-item', method: 'GET', path: '/v3/products/{productId}', summary: 'Get product' },
    { id: 'product-put', method: 'PUT', path: '/v3/products/{productId}', summary: 'Update product' },
    { id: 'product-patch', method: 'PATCH', path: '/v3/products/{productId}', summary: 'Patch product' },
    { id: 'product-delete', method: 'DELETE', path: '/v3/products/{productId}', summary: 'Delete product' },
    { id: 'order-list', method: 'GET', path: '/v3/orders', summary: 'List orders' },
  ];
  assert.deepEqual(rankApiSearch('fetch all products', rows).map(({ candidate }) => candidate.id), ['product-list']);
  assert.deepEqual(rankApiSearch('get product by id abc', rows).map(({ candidate }) => candidate.id), ['product-item']);
  assert.deepEqual(rankApiSearch('update product', rows).map(({ candidate }) => candidate.id), ['product-put', 'product-patch']);
  assert.deepEqual(rankApiSearch('patch product', rows).map(({ candidate }) => candidate.id), ['product-patch']);
  assert.deepEqual(rankApiSearch('delete product', rows).map(({ candidate }) => candidate.id), ['product-delete']);
  assert.equal(matchesApiSearchIntent('delete product', rows[1]), false);
});

test('configured entity groups treat related names consistently', async () => {
  const { rankApiSearch } = await search;
  const rows = [
    { id: 'product', method: 'GET', path: '/v1/products', summary: 'List products' },
    { id: 'group', method: 'GET', path: '/v1/product-groups', summary: 'List product groups' },
    { id: 'template', method: 'GET', path: '/v1/templates', summary: 'List templates' },
  ];
  const entityGroups = ['product, products, product group, product groups, template, templates'];
  assert.deepEqual(rankApiSearch('fetch all product groups', rows, { entityGroups }).map(({ candidate }) => candidate.id).sort(), ['group', 'product', 'template']);
  assert.deepEqual(rankApiSearch('get all templates/products', rows, { entityGroups }).map(({ candidate }) => candidate.id).sort(), ['group', 'product', 'template']);
  assert.deepEqual(rankApiSearch('fetch all products', rows, { entityGroups: [] }).map(({ candidate }) => candidate.id), ['product']);
});

test('one hint document provides entity aliases without separate controls', async () => {
  const { entityGroupsFromInstructions, rankApiSearch } = await search;
  const instructions = [
    'Match exact method and entity.',
    'Equivalent entity names:',
    'vehicle, automobile',
  ].join('\n');
  const rows = [
    { id: 'vehicle', method: 'GET', path: '/v1/vehicles' },
    { id: 'order', method: 'GET', path: '/v1/orders' },
  ];
  assert.deepEqual(entityGroupsFromInstructions(instructions), ['vehicle, automobile']);
  assert.deepEqual(rankApiSearch('get all automobiles', rows, { instructions })
    .map(({ candidate }) => candidate.id), ['vehicle']);
});

test('inline alias hints provide reliable local entity matching', async () => {
  const { entityGroupsFromInstructions, rankApiSearch } = await search;
  const rows = [
    { id: 'vehicle', method: 'GET', path: '/v1/vehicles' },
  ];
  const instructions = 'Aliases: vehicle, automobile, car';
  assert.deepEqual(entityGroupsFromInstructions(instructions), ['vehicle, automobile, car']);
  assert.deepEqual(rankApiSearch('get all cars', rows, { instructions })
    .map(({ candidate }) => candidate.id), ['vehicle']);
});

test('search scope includes only the selected service', async () => {
  const { inApiSearchScope } = await search;
  const rows = [
    { serviceId: 'inventory', serviceName: 'Inventory' },
    { serviceId: 'orders', serviceName: 'Orders' },
  ];
  assert.equal(rows.filter((row) => inApiSearchScope(row, '')).length, 2);
  assert.deepEqual(
    rows.filter((row) => inApiSearchScope(row, 'orders', 'Orders')),
    [rows[1]],
  );
});

test('strict entity matching supports nested paths while preferring the final resource segment', async () => {
  const { rankApiSearch } = await search;
  const rows = [
    { id: 'product-variants', method: 'GET', path: '/v3/products/{productId}/variants', summary: 'List product variants' },
    { id: 'product-orders', method: 'GET', path: '/v3/products/{productId}/orders', summary: 'List product orders' },
  ];
  assert.deepEqual(rankApiSearch('get variants for productId product-123', rows)
    .map(({ candidate }) => candidate.id), ['product-variants']);
  assert.deepEqual(rankApiSearch('get all variants by productId 123243456', rows)
    .map(({ candidate }) => candidate.id), ['product-variants']);
});

test('request documents populate parameter fields from natural language', async () => {
  const { requestValuesFromDocument, updateRequestValuesFromDocument } = await search;
  assert.deepEqual(
    requestValuesFromDocument('get products for productId product-123', ['productId', 'relatedProductId']),
    { productId: 'product-123' },
  );
  assert.deepEqual(
    requestValuesFromDocument('fetch product with productId="product-42" and parentProductId: product-7', ['productId', 'parentProductId']),
    { productId: 'product-42', parentProductId: 'product-7' },
  );
  assert.deepEqual(
    requestValuesFromDocument('productId=product-7&relatedProductId=product-42', ['productId', 'relatedProductId']),
    { productId: 'product-7', relatedProductId: 'product-42' },
  );
  assert.deepEqual(
    requestValuesFromDocument('get all products by product product-123', ['productId', 'relatedProductId']),
    { productId: 'product-123' },
  );
  assert.deepEqual(
    requestValuesFromDocument('get all products by product_id product-123', ['productId']),
    { productId: 'product-123' },
  );
  assert.deepEqual(
    requestValuesFromDocument('get all products by productId=123243456', ['product']),
    { product: '123243456' },
  );
  assert.deepEqual(
    updateRequestValuesFromDocument(
      { productId: 'product-7', relatedProductId: 'manually-entered' },
      'get products for productId product-7',
      'get products',
      ['productId', 'relatedProductId'],
    ),
    { relatedProductId: 'manually-entered' },
  );
  assert.deepEqual(
    updateRequestValuesFromDocument(
      { productId: 'product-7' },
      'get products for productId product-7',
      'get products for productId product-8',
      ['productId'],
    ),
    { productId: 'product-8' },
  );
});
