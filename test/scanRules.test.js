const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../lib/scanRules');
const { scanControllerSource } = require('../lib/controllerScanner');
const gh = require('../lib/githubScan');

// A made-up framework with its own annotation names, to prove nothing is tied to Spring or Java.
const CUSTOM = {
  name: 'Example RPC',
  fileExtensions: ['.rpc'],
  skipFilePattern: '_test\\.rpc$',
  classMarkers: ['Resource'],
  basePathAnnotation: 'Resource',
  mappings: [
    { annotation: 'Fetch', method: 'GET' },
    { annotation: 'Store', method: 'POST' },
    { annotation: 'Route', method: null },
  ],
  defaultMethod: 'GET',
  methodArgument: 'verb',
  pathArguments: ['at'],
  pathParamStyle: 'colon',
  parameters: [
    { annotation: 'FromPath', in: 'path', requiredArgument: null, requiredDefault: true },
    { annotation: 'FromQuery', in: 'query', requiredArgument: 'mandatory', requiredDefault: false },
    { annotation: 'Payload', in: 'body', requiredArgument: null, requiredDefault: true },
  ],
  deprecatedMarkers: ['Obsolete'],
};

const source = `
@Resource(at = "/rpc/orders")
class OrderResource {
  @Fetch("/:orderId")
  Order get(@FromPath("orderId") String orderId, @FromQuery(name = "expand", mandatory = true) String expand) { return null; }

  @Store("")
  void put(@Payload OrderDto body) {}

  @Obsolete
  @Route(at = "/legacy", verb = {POST, DELETE})
  void legacy() {}
}
`;

test('a custom annotation set reads endpoints, parameters and deprecation', () => {
  const r = scanControllerSource(source, { file: 'OrderResource.rpc', serviceName: 'orders', serviceId: 's', rules: rules.validate(CUSTOM).value });
  assert.deepEqual(r.controllers, ['OrderResource']);
  const byKey = r.operations.map((o) => `${o.httpMethod} ${o.pathTemplate} ${o.lifecycleStatus}`);
  assert.deepEqual(byKey, [
    'GET /rpc/orders/{orderId} ACTIVE',
    'POST /rpc/orders ACTIVE',
    'POST /rpc/orders/legacy DEPRECATED',
    'DELETE /rpc/orders/legacy DEPRECATED',
  ]);
  const get = r.operations[0].definition.operation.parameters;
  assert.deepEqual(get, [
    { name: 'orderId', in: 'path', required: true, schema: { type: 'string' } },
    { name: 'expand', in: 'query', required: true, schema: { type: 'string' } },
  ]);
  assert.equal(r.operations[1].schemaComplete, false, 'a body type that is not primitive stays incomplete');
});

test('the default rules are Spring and do not change existing behaviour', () => {
  const spring = rules.validate(rules.SPRING).value;
  const r = scanControllerSource('@RestController\n@RequestMapping("/a")\nclass A { @GetMapping("/b") public String b(@RequestParam String q) { return ""; } }', { file: 'A.java', serviceName: 's', serviceId: 's', rules: spring });
  assert.equal(r.operations[0].pathTemplate, '/a/b');
  assert.equal(r.operations[0].definition.operation.parameters[0].in, 'query');
});

test('NestJS decorators map to endpoints with :id paths written as {id}', () => {
  const nest = `@Controller('users')
export class UsersController {
  @Get(':id')
  findOne(@Param('id') id: string, @Query('page') page?: number): Promise<User> { return null; }
  @Post()
  create(@Body() dto: CreateUserDto) {}
}`;
  const r = scanControllerSource(nest, { file: 'users.controller.ts', serviceName: 'users', serviceId: 's', rules: rules.validate(rules.NESTJS).value });
  assert.deepEqual(r.operations.map((o) => `${o.httpMethod} ${o.pathTemplate}`), ['GET /users/{id}', 'POST /users']);
  assert.equal(r.operations[0].definition.operation.parameters[0].name, 'id');
});

test('rule validation rejects bad names and unknown methods', () => {
  const bad = rules.validate({ ...CUSTOM, classMarkers: ['bad name!'], mappings: [{ annotation: 'Fetch', method: 'FETCH' }], skipFilePattern: '(' });
  assert.ok(bad.problems.some((p) => p.includes('Controller markers')));
  assert.ok(bad.problems.some((p) => p.includes('HTTP method')));
  assert.ok(bad.problems.some((p) => p.includes('regular expression')));
  assert.ok(rules.validate({ ...CUSTOM, name: '' }).problems.length > 0);
});

test('a catalog built with custom rules finds the custom file type only', async () => {
  const RAW = 'https://raw.githubusercontent.com/example-org/rpc/main/';
  const get = async (url) => {
    if (url.includes('/contents/')) {
      return { status: 200, headers: {}, body: JSON.stringify([
        { type: 'file', name: 'OrderResource.rpc', path: 'orders/OrderResource.rpc', size: 400, download_url: `${RAW}orders/OrderResource.rpc` },
        { type: 'file', name: 'OrderResource.java', path: 'orders/OrderResource.java', size: 400, download_url: `${RAW}orders/OrderResource.java` },
      ]) };
    }
    return { status: 200, headers: {}, body: source };
  };
  const r = await gh.buildCatalog([{ repo: 'example-org/rpc', path: 'orders', service: 'orders' }], { get, token: '', rules: CUSTOM });
  const snapshot = JSON.parse(r.text);
  assert.equal(snapshot.operations.length, 4);
  assert.equal(r.report.sources[0].files.length, 1);
  assert.notEqual(gh.cacheKey([{ repo: 'example-org/rpc', path: 'orders', service: 'orders' }], CUSTOM), gh.cacheKey([{ repo: 'example-org/rpc', path: 'orders', service: 'orders' }], rules.SPRING));
});

test('files under src/test are skipped by default, and the pattern is checked', () => {
  const spring = rules.validate(rules.SPRING).value;
  assert.equal(spring.skipPathPattern, rules.DEFAULT_SKIP_PATH);
  assert.equal(rules.isSkippedPath(spring, 'services/sample/src/test/java/ItemController.java'), true);
  assert.equal(rules.isSkippedPath(spring, 'services/sample/src/main/java/ItemController.java'), false);
  assert.equal(rules.isSkippedPath(spring, 'src\\test\\java\\X.java'), true, 'Windows separators are read too');
  // A saved rule set from before this setting existed gets the default.
  const { skipPathPattern, ...old } = rules.SPRING;
  assert.equal(rules.validate(old).value.skipPathPattern, rules.DEFAULT_SKIP_PATH);
  assert.ok(rules.validate({ ...rules.SPRING, skipPathPattern: '(' }).problems.length > 0);
});
