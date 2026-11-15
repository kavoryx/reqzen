const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { yamlName, propertiesName, readSpringName } = require('../lib/springName');
const { findProjects } = require('../lib/projectFinder');
const { serviceFromFolder } = require('../lib/localScan');

const CONTROLLER = (cls, route) => `@RestController\n@RequestMapping("${route}")\npublic class ${cls} {\n  @GetMapping("/x")\n  public String x() { return ""; }\n}\n`;
function write(root, rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spring-'));

test('reads spring.application.name from YAML', () => {
  assert.equal(yamlName('spring:\n  application:\n    name: inventory\n'), 'inventory');
  assert.equal(yamlName('server:\n  port: 8080\nspring:\n  application:\n    name: "ad-twin" # service\n'), 'ad-twin');
  assert.equal(yamlName('spring:\n  profiles: dev\n'), null);
  assert.equal(yamlName('other:\n  name: wrong\n'), null);
  assert.equal(yamlName('spring:\n  application:\n    name: ${APP_NAME:x}\n'), null);
});

test('reads spring.application.name from .properties', () => {
  assert.equal(propertiesName('server.port=8080\nspring.application.name=inventory\n'), 'inventory');
  assert.equal(propertiesName('spring.application.name: vm-manager # comment\n'), 'vm-manager');
  assert.equal(propertiesName('# spring.application.name=old\n'), null);
});

test('prefers src/main/resources and ignores test resources', () => {
  const root = tmp();
  write(root, 'svc/src/test/resources/application.yml', 'spring:\n  application:\n    name: from-test\n');
  write(root, 'svc/src/main/resources/application.properties', 'spring.application.name=right\n');
  write(root, 'svc/config/application.yml', 'spring:\n  application:\n    name: elsewhere\n');
  assert.equal(readSpringName(path.join(root, 'svc')), 'right');
});

test('project finder names each project by its spring name, not by src', () => {
  const root = tmp();
  write(root, 'svcA/pom.xml', '<project/>');
  write(root, 'svcA/src/main/resources/application.yml', 'spring:\n  application:\n    name: inventory\n');
  write(root, 'svcA/src/main/java/com/x/AController.java', CONTROLLER('AController', '/a'));
  write(root, 'svcB/src/main/java/com/x/BController.java', CONTROLLER('BController', '/b'));
  write(root, 'svcB/src/main/resources/application.properties', 'spring.application.name=sample\n');
  const { projects } = findProjects(root, null);
  assert.deepEqual(projects.map((p) => p.name).sort(), ['inventory', 'sample']);
  assert.ok(!projects.some((p) => p.name === 'src'));
});

test('a folder with no name uses spring.application.name, then its own name (never src)', () => {
  const root = tmp();
  write(root, 'billing/src/main/resources/application.yml', 'spring:\n  application:\n    name: billing-api\n');
  write(root, 'orders/src/main/java/Keep.java', 'class Keep {}\n');
  assert.equal(serviceFromFolder(path.join(root, 'billing')), 'billing-api');
  assert.equal(serviceFromFolder(path.join(root, 'orders', 'src')), 'orders');
});
