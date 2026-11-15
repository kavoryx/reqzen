// Clones only the folders a scan needs, using the git already installed on this computer. The app never handles a login:
// git uses the credentials the user already has. Git is never asked for a password (a missing login fails at once).
// A token, if given, is passed in an environment variable, never on the command line or in the clone's settings, and
// it is never shown in messages. Names are checked before they reach git, so nothing is read as a git option.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_BASE = 'https://github.com';
const TIMEOUT_MS = 180000;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const REF = /^[A-Za-z0-9._/-]{1,100}$/;

function validRepo(owner, repo) {
  const ok = (n) => NAME.test(n) && !n.startsWith('-') && n !== '.' && n !== '..';
  return ok(owner) && ok(repo);
}

function validRef(ref) {
  if (!ref) return true;
  return REF.test(ref) && !ref.startsWith('-') && !ref.startsWith('/') && !ref.endsWith('/') && !ref.includes('..');
}

/** A folder for sparse checkout: relative, no "..", no leading "-". */
function validFolder(folder) {
  if (folder === '') return true;
  const parts = folder.split('/');
  return parts.every((p) => p !== '' && p !== '.' && p !== '..' && !p.startsWith('-') && /^[A-Za-z0-9._-]+$/.test(p));
}

function buildCloneArgs({ url, dest, ref, filter }) {
  const args = ['clone', '--no-tags', '--depth', '1'];
  if (filter) args.push('--filter=blob:none', '--sparse');
  if (ref) args.push('--branch', ref);
  args.push('--', url, dest);
  return args;
}

function buildSparseArgs({ dest, folders }) {
  return ['-C', dest, 'sparse-checkout', 'set', '--cone', ...folders];
}

/** The environment for git: no prompts, no credential windows, no large-file downloads, and the token if given. */
function gitEnv({ token, base }) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_LFS_SKIP_SMUDGE: '1' };
  if (token) {
    // Needs git 2.31 or later. Older git ignores this and the clone fails with an access message.
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = `http.${base}/.extraheader`;
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  return env;
}

function runGit(args, { env, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve) => {
    execFile('git', args, { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, _stdout, stderr) => {
      if (!err) {
        resolve({ ok: true });
        return;
      }
      if (err.code === 'ENOENT') {
        resolve({ ok: false, missing: true });
        return;
      }
      resolve({ ok: false, killed: err.killed === true, stderr: String(stderr || '') });
    });
  });
}

/** Whether git is installed and runs. */
async function gitAvailable() {
  const r = await runGit(['--version'], { env: process.env, timeoutMs: 15000 });
  return { available: r.ok === true };
}

/** A plain message for a failed git step. Git's own text is not shown, because it can echo addresses or credentials. */
function classify(r) {
  if (r.killed) return { code: 'timeout', problem: 'Cloning took too long and was stopped. Try a smaller folder, or use the GitHub API option.' };
  if (/could not read|Authentication failed|terminal prompts disabled|403|401|not found|does not appear to be a git repository/i.test(r.stderr || '')) {
    return { code: 'access', problem: 'The repository could not be cloned. Check the name, that you can open it in git, and that git has your login. Otherwise use the GitHub API option or clone it yourself and choose Local folder.' };
  }
  if (/Remote branch .* not found|couldn't find remote ref/i.test(r.stderr || '')) return { code: 'ref', problem: 'The branch or tag was not found in the repository.' };
  return { code: 'failed', problem: 'Git could not clone the repository.' };
}

/**
 * Clones one repository into parentDir (which must exist and be empty), with only `folders` checked out.
 * An empty folder list, or a folder '', means the whole repository. Returns { ok, dir } or { ok: false, code, problem }.
 */
async function cloneRepo({ owner, repo, ref = '', folders = [], token = '', base = DEFAULT_BASE, parentDir, timeoutMs }) {
  if (!validRepo(owner, repo)) return { ok: false, code: 'invalid', problem: 'The repository name is not valid.' };
  if (!validRef(ref)) return { ok: false, code: 'invalid', problem: 'The branch or tag name is not valid.' };
  if (!folders.every(validFolder)) return { ok: false, code: 'invalid', problem: 'A folder path is not valid.' };
  const wholeRepo = folders.length === 0 || folders.includes('');
  const dest = path.join(parentDir, 'repo');
  const url = `${base}/${owner}/${repo}.git`;
  const env = gitEnv({ token, base });
  const timeout = timeoutMs || TIMEOUT_MS;

  const clone = await runGit(buildCloneArgs({ url, dest, ref, filter: !wholeRepo }), { env, timeoutMs: timeout });
  if (!clone.ok) return { ok: false, ...(clone.missing ? { code: 'no-git', problem: 'Git is not installed.' } : classify(clone)) };
  if (!wholeRepo) {
    const sparse = await runGit(buildSparseArgs({ dest, folders }), { env, timeoutMs: timeout });
    if (!sparse.ok) return { ok: false, ...classify(sparse) };
  }
  return { ok: true, dir: dest };
}

/** Whether target is inside root (the folder itself is not "inside"). */
function isInside(root, target) {
  const r = path.resolve(root) + path.sep;
  return path.resolve(target).startsWith(r);
}

function makeWritable(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.isDirectory()) {
      fs.chmodSync(p, 0o700);
      for (const name of fs.readdirSync(p)) makeWritable(path.join(p, name));
    } else if (!st.isSymbolicLink()) {
      fs.chmodSync(p, 0o600);
    }
  } catch {
    // Keep going: the delete below reports whatever is left.
  }
}

/** Deletes a folder. Git marks some files read-only on Windows, so a second try makes them writable first. Returns true if gone. */
function removeDir(dir) {
  const opts = { recursive: true, force: true, maxRetries: 3, retryDelay: 200 };
  try {
    fs.rmSync(dir, opts);
    return true;
  } catch {
    // Fall through to the second try.
  }
  makeWritable(dir);
  try {
    fs.rmSync(dir, opts);
    return true;
  } catch {
    return !fs.existsSync(dir);
  }
}

/** Empties a folder and makes it again, so a crashed scan never leaves files behind. */
function resetDir(dir) {
  removeDir(dir);
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = {
  DEFAULT_BASE, validRepo, validRef, validFolder, buildCloneArgs, buildSparseArgs, gitEnv, classify,
  gitAvailable, cloneRepo, isInside, removeDir, resetDir,
};
