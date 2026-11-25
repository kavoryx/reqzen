const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanSource, sourceExtensions } = require('../lib/sourceScanner');
const localScan = require('../lib/localScan');
const projectFinder = require('../lib/projectFinder');
const githubScan = require('../lib/githubScan');

const spring = `@RestController
@RequestMapping("/items/v1")
class ItemController {
  @GetMapping("/{itemId}") public String get(@PathVariable String itemId) { return ""; }
}`;

const fastApi = `from fastapi import FastAPI, APIRouter
app = FastAPI()
router = APIRouter(prefix="/v1/items")
# @app.get("/comment-only")
"""
@app.get("/string-only")
def fake(): pass
"""
@router.get("/{item_id}")
def get_item(item_id: int): pass
@router.api_route("/", methods=["GET", "POST"])
async def list_items(): pass
`;

const flask = `from flask import Flask
app = Flask(__name__)
@app.route("/items/<int:item_id>", methods=["GET", "PATCH"])
def item(item_id): pass
`;

const express = `const express = require('express');
const app = express();
const ignored = "app.get('/string-only', handler)";
// app.post('/comment-only', handler)
app.get('/items/:itemId', getItem);
app.route('/items').get(listItems).post(createItem);
axios.get('/not-a-route');
`;

test('auto-detects Spring, NestJS, FastAPI, Flask, and Express routes', () => {
  const springResult = scanSource(spring, { file: 'ItemController.java', serviceName: 'sample', serviceId: 's' });
  assert.equal(springResult.framework, 'Spring Boot');
  assert.deepEqual(springResult.operations.map((o) => `${o.httpMethod} ${o.pathTemplate}`), ['GET /items/v1/{itemId}']);

  const nest = `@Controller('users')
export class UsersController {
  @Get(':id') findOne(@Param('id') id: string) { return null; }
}`;
  const nestResult = scanSource(nest, { file: 'users.controller.ts', serviceName: 'sample', serviceId: 's' });
  assert.equal(nestResult.framework, 'NestJS');
  assert.deepEqual(nestResult.operations.map((o) => `${o.httpMethod} ${o.pathTemplate}`), ['GET /users/{id}']);

  const fastApiResult = scanSource(fastApi, { file: 'routes.py', serviceName: 'sample', serviceId: 's' });
  assert.equal(fastApiResult.framework, 'FastAPI');
  assert.deepEqual(fastApiResult.operations.map((o) => `${o.httpMethod} ${o.pathTemplate}`), [
    'GET /v1/items/{item_id}',
    'GET /v1/items',
    'POST /v1/items',
  ]);
  assert.equal(fastApiResult.operations[0].contractVersion, 'v1');
  assert.deepEqual(fastApiResult.operations[0].definition.pathParameters.map((p) => p.name), ['item_id']);

  const flaskResult = scanSource(flask, { file: 'app.py', serviceName: 'sample', serviceId: 's' });
  assert.equal(flaskResult.framework, 'Flask');
  assert.deepEqual(flaskResult.operations.map((o) => `${o.httpMethod} ${o.pathTemplate}`), [
    'GET /items/{item_id}',
    'PATCH /items/{item_id}',
  ]);

  const expressResult = scanSource(express, { file: 'server.js', serviceName: 'sample', serviceId: 's' });
  assert.equal(expressResult.framework, 'Express');
  assert.deepEqual(expressResult.operations.map((o) => `${o.httpMethod} ${o.pathTemplate}`), [
    'GET /items/{itemId}',
    'GET /items',
    'POST /items',
  ]);
});

test('source scans produce grounded documentation without a separate AI pass', () => {
  const documentedSpring = `@RestController
class ItemController {
  /** Finds an item by its identifier. */
  @GetMapping("/items/{itemId}")
  public String getItem(@PathVariable String itemId) { return ""; }
}`;
  const documentedSpringResult = scanSource(documentedSpring, {
    file: 'ItemController.java', serviceName: 'sample', serviceId: 's',
  });
  assert.equal(documentedSpringResult.operations[0].summary, 'Finds an item by its identifier.');
  assert.equal(documentedSpringResult.operations[0].description, 'Finds an item by its identifier.');

  const documentedPython = `from fastapi import FastAPI
app = FastAPI()
@app.get("/items/{item_id}")
async def read_item(item_id: int):
    """Reads one item from the inventory by ID."""
    pass
`;
  const documentedPythonResult = scanSource(documentedPython, {
    file: 'routes.py', serviceName: 'sample', serviceId: 's',
  });
  assert.equal(documentedPythonResult.operations[0].summary, 'Reads one item from the inventory by ID.');
  assert.equal(documentedPythonResult.operations[0].description, 'Reads one item from the inventory by ID.');

  const undocumentedExpressResult = scanSource(`const express = require('express');
const app = express();
app.post('/items', createItem);
`, { file: 'server.js', serviceName: 'sample', serviceId: 's' });
  assert.equal(undocumentedExpressResult.operations[0].summary, 'Create Item');
  assert.match(undocumentedExpressResult.operations[0].description, /Identified from Express source for POST \/items/);
});

test('default project scans include common language files but custom rules stay scoped', () => {
  const scanRules = require('../lib/scanRules');
  const exts = sourceExtensions(scanRules.activeRules(scanRules.SPRING));
  for (const ext of ['.java', '.js', '.ts', '.py']) assert.ok(exts.includes(ext));
  assert.deepEqual(sourceExtensions({
    name: 'Example',
    fileExtensions: ['.rpc'],
  }), ['.rpc']);
});

test('local scans list APIs from Java, JavaScript, and Python in one project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-language-scan-'));
  const files = {
    'src/main/java/ItemController.java': spring,
    'src/server.js': express,
    'src/routes.py': fastApi,
  };
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  const result = localScan.buildFromFolders([{ folder: root, service: 'sample', label: 'sample' }]);
  const snapshot = JSON.parse(result.text);
  assert.equal(snapshot.operations.length, 7);
  assert.deepEqual(result.report.sources[0].languages.sort(), ['Java', 'JavaScript', 'Python']);
  assert.deepEqual(result.report.sources[0].frameworks.sort(), ['Express', 'FastAPI', 'Spring Boot']);
});

test('default scans skip Python test sources and test folders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'python-test-scan-'));
  fs.writeFileSync(path.join(root, 'routes.py'), fastApi);
  fs.writeFileSync(path.join(root, 'test_routes.py'), fastApi);
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests', 'routes.py'), fastApi);
  const result = localScan.buildFromFolders([{ folder: root, service: 'sample', label: 'sample' }]);
  assert.equal(JSON.parse(result.text).operations.length, 3);
  assert.deepEqual(result.report.sources[0].files.map((file) => file.path), ['routes.py']);
});

test('project discovery recognizes Java, JavaScript, and Python API projects', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-language-projects-'));
  const files = {
    'inventory/pom.xml': '<project/>',
    'inventory/src/main/java/ItemController.java': spring,
    'web/package.json': JSON.stringify({ dependencies: { express: '1' } }),
    'web/server.js': express,
    'service/pyproject.toml': '[project]\ndependencies = ["fastapi"]',
    'service/routes.py': fastApi,
  };
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  const result = projectFinder.findProjects(root);
  assert.deepEqual(result.projects.map((p) => [p.path, p.operations]), [
    ['inventory', 1],
    ['service', 3],
    ['web', 3],
  ]);
  assert.deepEqual(result.projects.map((p) => p.languages.join(',')), ['Java', 'Python', 'JavaScript']);
  assert.deepEqual(result.projects.map((p) => p.frameworks.join(',')), ['Spring Boot', 'FastAPI', 'Express']);
  assert.ok(result.projects[1].manifest.includes('Python · FastAPI'), 'the project picker displays the detected stack');
});

test('GitHub API scans accept mixed source-language files', async () => {
  const raw = 'https://raw.githubusercontent.com/example-org/sample/main/';
  const get = async (url) => {
    if (url.includes('/contents/')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify([
          { type: 'file', name: 'routes.py', path: 'routes.py', size: 400, download_url: `${raw}routes.py` },
          { type: 'file', name: 'server.js', path: 'server.js', size: 400, download_url: `${raw}server.js` },
        ]),
      };
    }
    return { status: 200, headers: {}, body: url.endsWith('.py') ? fastApi : express };
  };
  const result = await githubScan.buildCatalog([{ repo: 'example-org/sample', service: 'sample' }], { get });
  const snapshot = JSON.parse(result.text);
  assert.equal(snapshot.operations.length, 6);
  assert.equal(result.report.sources[0].files.length, 2);
  assert.ok(result.report.sources[0].files.every((file) => file.status === 'loaded'));
});
