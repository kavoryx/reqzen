const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const env = require('../lib/environments');

const taken = [{ id: 'snap-1', name: 'Development' }];

test('accepts an https host and keeps only the origin', () => {
  const r = env.validate({ name: ' Lab ', baseUrl: 'https://lab.example.test/' }, taken);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.value, { name: 'Lab', baseUrl: 'https://lab.example.test', production: false, enabled: true });
});

test('accepts an http local development host', () => {
  const r = env.validate({ name: ' Local ', baseUrl: 'http://localhost:3000/' }, taken);
  assert.deepEqual(r.problems, []);
  assert.equal(r.value.baseUrl, 'http://localhost:3000');
});

test('refuses unsupported protocols, credentials, paths, queries and duplicate names', () => {
  const r = env.validate({ name: 'development', baseUrl: 'http://u:p@host.example.com/x?y=1' }, taken);
  assert.ok(r.problems.includes('An environment with this name already exists.'));
  assert.ok(r.problems.includes('The address must not contain a user name or password.'));
  assert.ok(r.problems.includes('Enter only the host part, for example https://host.example.com or http://localhost:3000.'));
  assert.ok(r.problems.includes('The address must not contain a query or fragment.'));
  assert.ok(env.validate({ name: 'FTP', baseUrl: 'ftp://host.example.com' }, taken).problems
    .includes('The address must use http:// or https://.'));
});

test('editing keeps the same name without a duplicate error', () => {
  const r = env.validate({ name: 'Development', baseUrl: 'https://dev.example.test' }, taken, 'snap-1');
  assert.deepEqual(r.problems, []);
});

test('a missing or damaged file loads as an empty list, and a saved list round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envs-'));
  const file = path.join(dir, 'environments.json');
  assert.deepEqual(env.load(file), []);
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(env.load(file), []);
  const list = [{ id: env.newId(), name: 'Lab', baseUrl: 'https://lab.example.test', production: false, enabled: true }];
  env.save(file, list);
  assert.deepEqual(env.load(file), list);
});

test('merged list puts snapshot environments first and marks the user’s ones', () => {
  const merged = env.mergeEnvironments(
    [{ environmentId: 's', name: 'Development', production: false, enabled: true, baseUrl: 'https://dev.example.test' }],
    [{ id: 'yours:1', name: 'Lab', baseUrl: 'https://lab.example.test', production: true, enabled: true }],
  );
  assert.deepEqual(merged.map((e) => [e.name, e.yours]), [['Development', false], ['Lab', true]]);
  assert.equal(merged[1].production, true);
});

test('an address override replaces only the host of a built-in environment and keeps its name and flags', () => {
  const snap = [
    { environmentId: 'p', name: 'Production', production: true, enabled: true, baseUrl: 'https://prod.example.test' },
    { environmentId: 'i', name: 'Integration', production: false, enabled: true, baseUrl: 'https://integration.example.test' },
  ];
  const merged = env.mergeEnvironments(snap, [], { i: { baseUrl: 'https://my-integration.example.test' } });
  assert.equal(merged[1].baseUrl, 'https://my-integration.example.test');
  assert.equal(merged[1].snapshotBaseUrl, 'https://integration.example.test');
  assert.equal(merged[1].overridden, true);
  assert.equal(merged[1].name, 'Integration');
  assert.equal(merged[1].production, false);
  assert.equal(merged[0].baseUrl, 'https://prod.example.test');
  assert.equal(merged[0].overridden, false);
});

test('overrides for unknown environments are ignored and a damaged override file loads as empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overrides-'));
  const file = path.join(dir, 'environment-overrides.json');
  assert.deepEqual(env.loadOverrides(file), {});
  fs.writeFileSync(file, '[1,2');
  assert.deepEqual(env.loadOverrides(file), {});
  env.saveOverrides(file, { i: { baseUrl: 'https://my-integration.example.test' }, bad: 'x' });
  assert.deepEqual(env.loadOverrides(file), { i: { baseUrl: 'https://my-integration.example.test' } });
  const merged = env.mergeEnvironments([{ environmentId: 'p', name: 'Production', production: true, enabled: true, baseUrl: 'https://prod.example.test' }], [], env.loadOverrides(file));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].overridden, false);
});
