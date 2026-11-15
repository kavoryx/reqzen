const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../lib/scanRules');
const { scanControllerSource } = require('../lib/controllerScanner');

const spring = rules.validate(rules.SPRING).value;
const scan = (src, r = spring) => scanControllerSource(src, { file: 'C.java', serviceName: 's', serviceId: 'x', rules: r }).operations;
const vis = (ops) => ops.map((o) => `${o.httpMethod} ${o.pathTemplate} ${o.visibility}`);

test('a class marked @Hidden hides every API in it', () => {
  const ops = scan(`@RestController
@Hidden
@RequestMapping("/a")
public class A {
  @GetMapping("/one") public String one() { return ""; }
  @PostMapping("/two") public String two() { return ""; }
}`);
  assert.deepEqual(vis(ops), ['GET /a/one HIDDEN', 'POST /a/two HIDDEN']);
  assert.equal(ops[0].definition['x-apiexplorer'].visibilitySource, 'class');
});

test('a class marked @InternalApi hides every API in it', () => {
  const ops = scan(`@RestController
@InternalApi
@RequestMapping("/b")
public class B {
  @GetMapping("/x") public String x() { return ""; }
}`);
  assert.deepEqual(vis(ops), ['GET /b/x HIDDEN']);
});

test('a method marked @Hidden hides only that API', () => {
  const ops = scan(`@RestController
@RequestMapping("/c")
public class C {
  @GetMapping("/open") public String open() { return ""; }
  @Hidden
  @GetMapping("/secret") public String secret() { return ""; }
}`);
  assert.deepEqual(vis(ops), ['GET /c/open PUBLIC', 'GET /c/secret HIDDEN']);
  assert.equal(ops[1].definition['x-apiexplorer'].visibilitySource, 'method');
});

test('a method marked @InternalApi hides only that API, even with other methods in the class', () => {
  const ops = scan(`@RestController
@RequestMapping("/d")
public class D {
  @InternalApi
  @PutMapping("/only") public String only() { return ""; }
  @DeleteMapping("/other") public String other() { return ""; }
}`);
  assert.deepEqual(vis(ops), ['PUT /d/only HIDDEN', 'DELETE /d/other PUBLIC']);
});

test('when both the class and a method are marked, the more restrictive one wins', () => {
  const ops = scan(`@RestController
@InternalApi
@RequestMapping("/e")
public class E {
  @Hidden
  @GetMapping("/a") public String a() { return ""; }
  @GetMapping("/b") public String b() { return ""; }
}`);
  assert.deepEqual(vis(ops), ['GET /e/a HIDDEN', 'GET /e/b HIDDEN']);
});

test('the markers come from the rule set, so a custom annotation can be used', () => {
  const custom = rules.validate({ ...spring, visibilityMarkers: [{ annotation: 'Partner', visibility: 'INTERNAL' }] }).value;
  const ops = scan(`@RestController
@RequestMapping("/f")
public class F {
  @Partner
  @GetMapping("/p") public String p() { return ""; }
  @GetMapping("/q") public String q() { return ""; }
}`, custom);
  assert.deepEqual(vis(ops), ['GET /f/p INTERNAL', 'GET /f/q PUBLIC']);
});

test('visibility markers are checked when rules are saved', () => {
  assert.ok(rules.validate({ ...spring, visibilityMarkers: [{ annotation: 'X', visibility: 'SECRET' }] }).problems.length > 0);
  assert.ok(rules.validate({ ...spring, visibilityMarkers: [{ annotation: 'bad name', visibility: 'HIDDEN' }] }).problems.length > 0);
});

test('an API marked @Deprecated is deprecated, at class or method level, and keeps its visibility', () => {
  const ops = scan(`@RestController
@RequestMapping("/g")
public class G {
  @Deprecated
  @GetMapping("/old") public String old() { return ""; }
  @Deprecated
  @InternalApi
  @PostMapping("/both") public String both() { return ""; }
  @GetMapping("/new") public String fresh() { return ""; }
}`);
  assert.deepEqual(ops.map((o) => `${o.httpMethod} ${o.pathTemplate} ${o.lifecycleStatus} ${o.visibility}`), [
    'GET /g/old DEPRECATED PUBLIC',
    'POST /g/both DEPRECATED HIDDEN',
    'GET /g/new ACTIVE PUBLIC',
  ]);
});
