const test = require('node:test');
const assert = require('node:assert/strict');
const { scanControllerSource, typeName, mappingPaths } = require('../lib/javaControllers');

const controller = `
package com.example.sample;

import org.springframework.web.bind.annotation.*;

/** Items for the sample. */
@RestController
@RequestMapping("/sample/v1/items")
public class ItemController {

    // A comment with @GetMapping("/not-real") should be ignored
    private final ItemService service = new ItemService();

    /**
     * Lists items for one org.
     */
    @GetMapping
    public List<ItemDto> list(@RequestParam(value = "orgId", required = true) String orgId,
                              @RequestParam(required = false) Integer page) {
        return service.list(orgId, page);
    }

    @GetMapping("/{itemId}")
    public ItemDto get(@PathVariable("itemId") String itemId) {
        return null;
    }

    @PostMapping(value = {"", "/create"})
    public ResponseEntity<ItemDto> create(@RequestBody CreateItemRequest body, @RequestHeader("X-Trace") String trace) {
        return null;
    }

    @Deprecated
    @DeleteMapping("/{itemId}")
    public void delete(@PathVariable String itemId) {
    }

    @RequestMapping(value = "/sync", method = {RequestMethod.PUT, RequestMethod.PATCH})
    public void sync() {
    }
}
`;

const plainService = `
package com.example.sample;

@Service
public class ItemService {
    @GetMapping("/should-not-appear")
    public String hidden() { return ""; }
}
`;

test('only classes marked @RestController or @Controller are read', () => {
  const r = scanControllerSource(plainService, { file: 'ItemService.java', serviceName: 'sample', serviceId: 's' });
  assert.equal(r.controllers.length, 0);
  assert.equal(r.operations.length, 0);
});

test('mappings become operations with the class path, method path and parameters', () => {
  const r = scanControllerSource(controller, { file: 'ItemController.java', serviceName: 'sample', serviceId: 's' });
  assert.deepEqual(r.controllers, ['ItemController']);
  const keys = r.operations.map((o) => `${o.httpMethod} ${o.pathTemplate}`).sort();
  assert.deepEqual(keys, [
    'DELETE /sample/v1/items/{itemId}',
    'GET /sample/v1/items',
    'GET /sample/v1/items/{itemId}',
    'PATCH /sample/v1/items/sync',
    'POST /sample/v1/items',
    'POST /sample/v1/items/create',
    'PUT /sample/v1/items/sync',
  ]);
  const list = r.operations.find((o) => o.httpMethod === 'GET' && o.pathTemplate === '/sample/v1/items');
  assert.deepEqual(list.definition.operation.parameters.map((p) => [p.name, p.in, p.required]), [['orgId', 'query', true], ['page', 'query', false]]);
  assert.equal(list.summary, 'Lists items for one org.');
  const get = r.operations.find((o) => o.httpMethod === 'GET' && o.pathTemplate === '/sample/v1/items/{itemId}');
  assert.deepEqual(get.definition.operation.parameters.map((p) => [p.name, p.in]), [['itemId', 'path']]);
  assert.equal(get.definition['x-apiexplorer'].controller, 'ItemController');
  assert.equal(get.definition['x-apiexplorer'].method, 'get');
});

test('a body type is named and the operation is marked incomplete until the class is read', () => {
  const r = scanControllerSource(controller, { file: 'ItemController.java', serviceName: 'sample', serviceId: 's' });
  const post = r.operations.find((o) => o.httpMethod === 'POST' && o.pathTemplate === '/sample/v1/items');
  assert.equal(post.schemaComplete, false);
  assert.deepEqual(post.definition['x-apiexplorer'].unresolvedTypes, ['CreateItemRequest']);
  assert.ok(post.definition.operation.parameters.some((p) => p.name === 'X-Trace' && p.in === 'header'));
});

test('@Deprecated on a method or the class marks the operation deprecated', () => {
  const r = scanControllerSource(controller, { file: 'ItemController.java', serviceName: 'sample', serviceId: 's' });
  assert.equal(r.operations.find((o) => o.httpMethod === 'DELETE').lifecycleStatus, 'DEPRECATED');
  assert.equal(r.operations.find((o) => o.httpMethod === 'GET' && o.pathTemplate === '/sample/v1/items').lifecycleStatus, 'ACTIVE');
});

test('a RequestMapping without a method is reported, and GET is assumed', () => {
  const src = `@Controller\npublic class A {\n  @RequestMapping("/x")\n  public String x() { return ""; }\n}`;
  const r = scanControllerSource(src, { file: 'A.java', serviceName: 's', serviceId: 'i' });
  assert.equal(r.operations[0].httpMethod, 'GET');
  assert.ok(r.problems[0].includes('GET is assumed'));
});

test('helpers read type names and mapping paths', () => {
  assert.equal(typeName('List<ItemDto>'), 'ItemDto');
  assert.equal(typeName('Map<String, Foo>'), 'Foo');
  assert.deepEqual(mappingPaths('value = {"a", "b"}'), ['a', 'b']);
  assert.deepEqual(mappingPaths('"/x"'), ['/x']);
});
