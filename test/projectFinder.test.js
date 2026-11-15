const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findProjects } = require('../lib/projectFinder');

const ctl = (route) => `@RestController
@RequestMapping("${route}")
public class C {
  @GetMapping("/x") public String x() { return ""; }
}
`;

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'find-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test('each folder with a manifest that holds endpoints is a project, named after the folder', () => {
  const root = tree({
    'inventory/pom.xml': '<project/>',
    'inventory/src/main/java/Ctl.java': ctl('/inventory/v1'),
    'sample/package.json': '{}',
    'sample/src/Ctl.java': ctl('/sample/v1'),
    'docs/readme.md': '# docs',
  });
  const r = findProjects(root);
  assert.deepEqual(r.projects.map((p) => [p.path, p.name, p.buildFile]), [['inventory', 'inventory', 'pom.xml'], ['sample', 'sample', 'package.json']]);
  assert.ok(r.projects.every((p) => p.manifest.includes('Spring Boot')), 'the project picker displays the detected framework');
  assert.ok(r.projects.every((p) => p.operations === 1));
  assert.deepEqual(r.notes, []); // docs has no source files, so it is not a candidate at all
});

test('a nested module with its own manifest is its own project, not part of the parent', () => {
  const root = tree({
    'shop/pom.xml': '<project/>',
    'shop/web/pom.xml': '<project/>',
    'shop/web/src/Ctl.java': ctl('/shop/web'),
    'shop/src/Ctl.java': ctl('/shop/core'),
  });
  const r = findProjects(root);
  assert.deepEqual(r.projects.map((p) => p.path).sort(), ['shop', 'shop/web']);
});

test('without manifests, top-level folders with endpoints are the projects', () => {
  const root = tree({
    'alpha/src/Ctl.java': ctl('/alpha/v1'),
    'beta/src/Ctl.java': ctl('/beta/v1'),
  });
  assert.deepEqual(findProjects(root).projects.map((p) => p.name), ['alpha', 'beta']);
});

test('test folders are not projects', () => {
  const root = tree({
    'svc/pom.xml': '<project/>',
    'svc/src/test/java/Ctl.java': ctl('/svc/fake'),
    'svc/src/main/java/Real.java': ctl('/svc/real'),
  });
  const r = findProjects(root);
  assert.equal(r.projects.length, 1);
  assert.equal(r.projects[0].operations, 1);
});
