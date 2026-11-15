const test = require('node:test');
const assert = require('node:assert/strict');
const gh = require('../lib/githubScan');

const controller = `
package com.example;
@RestController
@RequestMapping("/sample/v1/items")
public class ItemController {
    @GetMapping
    public List<ItemDto> list() { return null; }
    @Deprecated
    @DeleteMapping("/{id}")
    public void delete(@PathVariable String id) { }
}
`;
const plain = `package com.example;\n@Service\npublic class ItemService {\n  @GetMapping("/hidden")\n  public String h() { return ""; }\n}\n`;
const legacy = `@Controller\n@RequestMapping("/sample/v0/old")\npublic class OldController {\n  @GetMapping("/a")\n  public String a() { return ""; }\n}\n`;
const RAW = 'https://raw.githubusercontent.com/example-org/sample-api/main/';

/** A fake GitHub: folder listings for api.github.com and file bodies for raw downloads. */
function fakeGitHub(calls) {
  const listings = {
    'repos/example-org/sample-api/contents/services/sample': [
      { type: 'file', name: 'ItemController.java', path: 'services/sample/ItemController.java', size: 300, download_url: `${RAW}services/sample/ItemController.java` },
      { type: 'file', name: 'ItemService.java', path: 'services/sample/ItemService.java', size: 120, download_url: `${RAW}services/sample/ItemService.java` },
      { type: 'file', name: 'ItemControllerTest.java', path: 'services/sample/ItemControllerTest.java', size: 50, download_url: 'x' },
      { type: 'file', name: 'README.md', path: 'services/sample/README.md', size: 10, download_url: 'x' },
      { type: 'dir', name: 'legacy', path: 'services/sample/legacy' },
    ],
    'repos/example-org/sample-api/contents/services/sample/legacy': [
      { type: 'file', name: 'OldController.java', path: 'services/sample/legacy/OldController.java', size: 200, download_url: `${RAW}services/sample/legacy/OldController.java` },
    ],
    'repos/example-org/sample-api/contents/missing': null,
  };
  const files = {
    [`${RAW}services/sample/ItemController.java`]: controller,
    [`${RAW}services/sample/ItemService.java`]: plain,
    [`${RAW}services/sample/legacy/OldController.java`]: legacy,
  };
  return async (url, headers) => {
    calls.push({ url, auth: headers.Authorization || '' });
    const m = url.match(/^https:\/\/api\.github\.com\/(.*?)(\?.*)?$/);
    if (m) {
      const body = listings[m[1]];
      if (body === undefined || body === null) return { status: 404, headers: {}, body: '{"message":"Not Found"}' };
      return { status: 200, headers: {}, body: JSON.stringify(body) };
    }
    if (files[url]) return { status: 200, headers: {}, body: files[url] };
    return { status: 404, headers: {}, body: '' };
  };
}

test('repository addresses are read from owner/repo, GitHub URLs and tree URLs', () => {
  assert.deepEqual(gh.parseRepo('example-org/sample-api'), { owner: 'example-org', repo: 'sample-api', ref: '', path: '' });
  assert.deepEqual(gh.parseRepo('https://github.com/example-org/sample-api.git'), { owner: 'example-org', repo: 'sample-api', ref: '', path: '' });
  assert.deepEqual(gh.parseRepo('https://github.com/example-org/sample-api/tree/dev/services/sample'), { owner: 'example-org', repo: 'sample-api', ref: 'dev', path: 'services/sample' });
  assert.equal(gh.parseRepo('not a repo'), null);
});

test('folder paths that climb out or contain odd characters are refused', () => {
  assert.equal(gh.cleanPath('services/sample'), 'services/sample');
  assert.equal(gh.cleanPath('../secret'), null);
  assert.equal(gh.cleanPath('a b/c'), null);
});

test('a scan reads Java files in the folder and subfolders and keeps only controllers', async () => {
  const calls = [];
  const r = await gh.buildCatalog([{ repo: 'example-org/sample-api', path: 'services/sample', service: 'sample' }], { get: fakeGitHub(calls), token: '' });
  const snap = JSON.parse(r.text);
  assert.equal(snap.format, 'api-explorer-snapshot');
  assert.deepEqual(snap.services.map((s) => s.name), ['sample']);
  const ops = snap.operations.map((o) => `${o.httpMethod} ${o.pathTemplate} ${o.lifecycleStatus}`).sort();
  assert.deepEqual(ops, ['DELETE /sample/v1/items/{id} DEPRECATED', 'GET /sample/v0/old/a ACTIVE', 'GET /sample/v1/items ACTIVE']);
  assert.equal(r.report.operationCount, 3);
  const statuses = Object.fromEntries(r.report.sources[0].files.map((f) => [f.path.split('/').pop(), f.status]));
  assert.equal(statuses['ItemController.java'], 'loaded');
  assert.equal(statuses['ItemService.java'], 'no controller');
  assert.ok(!calls.some((c) => c.url.includes('README')));
  assert.ok(!calls.some((c) => c.url.includes('ItemControllerTest')));
});

test('the token is sent only to GitHub and never appears in the catalog or report', async () => {
  const calls = [];
  const r = await gh.buildCatalog([{ repo: 'example-org/sample-api', path: 'services/sample', service: 'sample' }], { get: fakeGitHub(calls), token: 'fake-github-token' });
  assert.ok(calls.some((c) => c.auth === 'Bearer fake-github-token'));
  assert.ok(!r.text.includes('fake-github-token'));
  assert.ok(!JSON.stringify(r.report).includes('fake-github-token'));
});

test('a missing folder is reported as a problem for that source only', async () => {
  const r = await gh.buildCatalog([{ repo: 'example-org/sample-api', path: 'missing', service: 'x' }], { get: fakeGitHub([]), token: '' });
  assert.ok(r.report.sources[0].problems[0].includes('not found'));
  assert.equal(r.report.operationCount, 0);
});

test('other hosts are refused before any request is made', async () => {
  await assert.rejects(gh.httpGet('https://evil.example.com/x.java', {}, 1000), /not allowed/);
  await assert.rejects(gh.httpGet('http://api.github.com/x', {}, 1000), /not allowed/);
});

test('the cache key does not depend on the token and changes with the sources', () => {
  const a = gh.cacheKey([{ repo: 'example-org/sample-api', path: 'services/sample', service: 'sample' }]);
  assert.equal(a, gh.cacheKey([{ repo: 'example-org/sample-api', path: 'services/sample', service: 'sample' }]));
  assert.notEqual(a, gh.cacheKey([{ repo: 'example-org/sample-api', path: 'services/other', service: 'sample' }]));
});

test('the GitHub listing skips src/test folders too', async () => {
  const RAW = 'https://raw.githubusercontent.com/example-org/sample-api/main/';
  const get = async (url) => {
    if (url.includes('/contents/services/sample/src/test')) {
      return { status: 200, headers: {}, body: JSON.stringify([
        { type: 'file', name: 'FakeController.java', path: 'services/sample/src/test/FakeController.java', size: 300, download_url: `${RAW}services/sample/src/test/FakeController.java` },
      ]) };
    }
    if (url.includes('/contents/services/sample/src')) {
      return { status: 200, headers: {}, body: JSON.stringify([
        { type: 'dir', name: 'test', path: 'services/sample/src/test' },
      ]) };
    }
    if (url.includes('/contents/services/sample')) {
      return { status: 200, headers: {}, body: JSON.stringify([
        { type: 'file', name: 'ItemController.java', path: 'services/sample/ItemController.java', size: 300, download_url: `${RAW}services/sample/ItemController.java` },
        { type: 'dir', name: 'src', path: 'services/sample/src' },
      ]) };
    }
    return { status: 200, headers: {}, body: controller };
  };
  const requested = [];
  const r = await gh.buildCatalog([{ repo: 'example-org/sample-api', path: 'services/sample', service: 'sample' }], {
    get: async (url, h, m) => { requested.push(url); return get(url, h, m); }, token: '',
  });
  // The shared fixture has two endpoints; the decoy controller under src/test must not appear.
  const ops = JSON.parse(r.text).operations;
  assert.equal(ops.length, 2);
  assert.ok(!ops.some((o) => o.definition['x-apiexplorer'].controller === 'FakeController'));
  assert.ok(!requested.some((u) => u.includes('/src/test')), 'the src/test folder is never listed');
});
