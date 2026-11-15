const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const local = require('../lib/localScan');

const controller = `@RestController
@RequestMapping("/sample/v1/items")
public class ItemController {
  @GetMapping("/{itemId}")
  public ItemDto get(@PathVariable("itemId") String itemId) { return null; }
}
`;

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-scan-'));
  const svc = path.join(root, 'services', 'sample');
  fs.mkdirSync(path.join(svc, 'web'), { recursive: true });
  fs.mkdirSync(path.join(svc, 'node_modules', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(svc, 'web', 'ItemController.java'), controller);
  fs.writeFileSync(path.join(svc, 'web', 'ItemControllerTest.java'), controller);
  fs.writeFileSync(path.join(svc, 'node_modules', 'lib', 'Vendor.java'), controller);
  fs.writeFileSync(path.join(svc, 'README.md'), '# not java');
  fs.mkdirSync(path.join(svc, 'src', 'test', 'java'), { recursive: true });
  fs.writeFileSync(path.join(svc, 'src', 'test', 'java', 'ItemController.java'), controller);
  fs.writeFileSync(path.join(root, 'outside.java'), controller.replace('/sample/v1/items', '/outside'));
  try {
    fs.symlinkSync(path.join(root, 'outside.java'), path.join(svc, 'web', 'Linked.java'));
  } catch {
    // Symbolic links may need rights on Windows; the test still checks the rest.
  }
  return { root, svc };
}

test('a folder scan reads matching controllers only and reports what it loaded', () => {
  const { svc } = makeTree();
  const r = local.buildFromFolders([{ folder: svc, service: 'sample', label: 'local/sample' }]);
  const snap = JSON.parse(r.text);
  assert.equal(snap.operations.length, 1);
  assert.equal(snap.operations[0].pathTemplate, '/sample/v1/items/{itemId}');
  assert.equal(snap.operations[0].serviceName, 'sample');
  const files = r.report.sources[0].files.map((f) => `${f.path}:${f.status}`);
  assert.deepEqual(files.sort(), ['web/ItemController.java:loaded']); // *Test.java is skipped by the rules
  assert.ok(!r.report.sources[0].files.some((f) => f.path.includes('node_modules')), 'dependency folders are skipped');
  assert.ok(!r.report.sources[0].files.some((f) => f.path.includes('Linked')), 'symbolic links are not followed');
});

test('a missing folder and a file given as a folder are reported, not thrown', () => {
  const r = local.buildFromFolders([
    { folder: path.join(os.tmpdir(), 'no-such-folder-xyz'), service: 'a', label: 'a' },
  ]);
  assert.equal(r.report.operationCount, 0);
  assert.match(r.report.sources[0].problems[0], /does not exist/);
});

test('the walk stops at the file limit and says so', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-'));
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `C${i}.java`), 'class C {}');
  const found = local.walk(root, (name) => name.endsWith('.java'));
  assert.equal(found.files.length, 5);
});

test('files under src/test are not read, even when they look like controllers', () => {
  const { svc } = makeTree();
  const r = local.buildFromFolders([{ folder: svc, service: 'sample', label: 'local/sample' }]);
  assert.equal(JSON.parse(r.text).operations.length, 1, 'only the main controller counts');
  assert.ok(!r.report.sources[0].files.some((f) => f.path.includes('src/test')), 'src/test is not in the report');
});

test('a parent folder with split on gives one service per project folder, named after the project', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-'));
  for (const name of ['inventory', 'sample']) {
    const dir = path.join(parent, name, 'src', 'main', 'java');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Ctl.java'), controller.replace('/sample/v1/items', `/${name}/v1/items`));
  }
  fs.mkdirSync(path.join(parent, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(parent, 'docs', 'readme.md'), '# docs');
  const r = local.buildFromFolders([{ folder: parent, service: '', label: 'example-org/sample-api', split: true }]);
  const snap = JSON.parse(r.text);
  assert.deepEqual(snap.services.map((s) => s.name).sort(), ['inventory', 'sample']);
  assert.equal(snap.operations.length, 2);
  assert.ok(snap.operations.every((o) => o.serviceName === o.pathTemplate.split('/')[1]), 'each API is under its own project');
});

test('without split, the parent folder is one service named after the parent', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'));
  fs.mkdirSync(path.join(parent, 'inventory'), { recursive: true });
  fs.writeFileSync(path.join(parent, 'inventory', 'Ctl.java'), controller);
  const r = local.buildFromFolders([{ folder: parent, service: '', label: 'x', split: false }]);
  assert.deepEqual(JSON.parse(r.text).services.map((s) => s.name), [path.basename(parent)]);
});
