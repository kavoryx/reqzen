const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const git = require('../lib/gitClone');
const local = require('../lib/localScan');

const controller = `@RestController
@RequestMapping("/sample/v1/items")
public class ItemController {
  @GetMapping("/{itemId}")
  public ItemDto get(@PathVariable("itemId") String itemId) { return null; }
}
`;

test('repository, branch and folder names are checked before git is called', () => {
  assert.equal(git.validRepo('example-org', 'platform'), true);
  assert.equal(git.validRepo('-o', 'platform'), false, 'an owner that looks like a git option is refused');
  assert.equal(git.validRepo('example-org', '../x'), false);
  assert.equal(git.validRef('main'), true);
  assert.equal(git.validRef('--upload-pack=evil'), false);
  assert.equal(git.validFolder('services/sample'), true);
  assert.equal(git.validFolder('services/../etc'), false);
  assert.equal(git.validFolder('-rf'), false);
});

test('the clone command is shallow and sparse, and never contains the token', () => {
  const env = git.gitEnv({ token: 'fake-github-token', base: 'https://github.com' });
  const args = git.buildCloneArgs({ url: 'https://github.com/a/b.git', dest: '/tmp/x/repo', ref: '', filter: true });
  assert.ok(args.includes('--depth') && args.includes('--sparse') && args.includes('--filter=blob:none'));
  assert.ok(!args.join(' ').includes('fake-github-token'));
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.match(env.GIT_CONFIG_VALUE_0, /^AUTHORIZATION: basic /);
});

test('git errors are turned into plain messages without git’s text', () => {
  const r = git.classify({ stderr: 'fatal: could not read Username for https://github.com: terminal prompts disabled' });
  assert.equal(r.code, 'access');
  assert.ok(!r.problem.includes('fatal'));
  assert.equal(git.classify({ killed: true, stderr: '' }).code, 'timeout');
});

test('a folder is deleted even when git left read-only files behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-'));
  const file = path.join(dir, 'pack');
  fs.writeFileSync(file, 'x');
  fs.chmodSync(file, 0o400);
  assert.equal(git.removeDir(dir), true);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(git.isInside('/a/b', '/a/b/c'), true);
  assert.equal(git.isInside('/a/b', '/a/bc'), false);
});

// Real git: a local bare repository stands in for GitHub. Skipped when git is not installed.
const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('a sparse clone checks out only the service folder, and the folder scans', { skip: !hasGit && 'git is not installed' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-src-'));
  const bare = path.join(root, 'example-org', 'platform.git');
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' });
  execFileSync('git', ['--git-dir', bare, 'config', 'uploadpack.allowFilter', 'true']);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-work-'));
  execFileSync('git', ['init', '-b', 'main', work], { stdio: 'ignore' });
  fs.mkdirSync(path.join(work, 'services', 'sample'), { recursive: true });
  fs.mkdirSync(path.join(work, 'services', 'other'), { recursive: true });
  fs.writeFileSync(path.join(work, 'services', 'sample', 'ItemController.java'), controller);
  fs.writeFileSync(path.join(work, 'services', 'other', 'Other.java'), 'class Other {}');
  const id = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
  execFileSync('git', ['-C', work, ...id, 'add', '.']);
  execFileSync('git', ['-C', work, ...id, 'commit', '-m', 'init'], { stdio: 'ignore' });
  execFileSync('git', ['-C', work, 'push', bare, 'main'], { stdio: 'ignore' });
  execFileSync('git', ['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-dest-'));
  const r = await git.cloneRepo({ owner: 'example-org', repo: 'platform', folders: ['services/sample'], base: `file://${root}`, parentDir: parent });
  assert.equal(r.ok, true, r.problem);
  assert.ok(fs.existsSync(path.join(r.dir, 'services', 'sample', 'ItemController.java')));
  assert.ok(!fs.existsSync(path.join(r.dir, 'services', 'other')), 'other folders are not checked out');

  const scanned = local.buildFromFolders([{ folder: path.join(r.dir, 'services', 'sample'), service: 'sample', label: 'example-org/sample-api/services/sample' }]);
  assert.equal(JSON.parse(scanned.text).operations.length, 1);
  assert.equal(git.removeDir(parent), true);
  assert.equal(fs.existsSync(parent), false);
});

test('a repository that does not exist fails with a plain message', { skip: !hasGit && 'git is not installed' }, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-missing-'));
  const r = await git.cloneRepo({ owner: 'example-org', repo: 'nope', folders: ['x'], base: 'file:///no/such/place', parentDir: parent });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'access');
  git.removeDir(parent);
});
