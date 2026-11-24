const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vars = require('../lib/variables');

const ENVS = ['env-prod', 'env-int'];

test('accepts a name with a value, and keeps only known environments with real values', () => {
  const r = vars.validate({ name: ' orgId ', value: ' org-1 ', byEnvironment: { 'env-int': ' org-int ', 'env-x': 'drop', 'env-prod': '  ' } }, [], null, ENVS);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.value, { name: 'orgId', value: 'org-1', byEnvironment: { 'env-int': 'org-int' } });
});

test('refuses bad names, duplicate names (any case), and a variable with no value at all', () => {
  const existing = [{ id: 'var:1', name: 'OrgId', value: 'a', byEnvironment: {} }];
  assert.ok(vars.validate({ name: 'orgid', value: 'b' }, existing, null, ENVS).problems.includes('A variable with this name already exists.'));
  assert.equal(vars.validate({ name: '1org', value: 'b' }, [], null, ENVS).problems.length, 1);
  assert.equal(vars.validate({ name: 'org id', value: 'b' }, [], null, ENVS).problems.length, 1);
  assert.ok(vars.validate({ name: 'team', value: '' }, [], null, ENVS).problems.includes('Enter a value, or a value for at least one environment.'));
});

test('editing keeps its own name without a duplicate error', () => {
  const existing = [{ id: 'var:1', name: 'orgId', value: 'a', byEnvironment: {} }];
  assert.deepEqual(vars.validate({ name: 'orgId', value: 'b' }, existing, 'var:1', ENVS).problems, []);
});

test('an environment value wins, the shared value fills the rest, and a missing value is left out', () => {
  const list = [
    { id: 'var:1', name: 'orgId', value: 'shared', byEnvironment: { 'env-int': 'int-org' } },
    { id: 'var:2', name: 'teamId', value: '', byEnvironment: { 'env-prod': 'prod-team' } },
  ];
  assert.deepEqual(vars.valuesFor(list, 'env-int'), { orgid: { name: 'orgId', value: 'int-org' } });
  assert.deepEqual(vars.valuesFor(list, 'env-prod'), {
    orgid: { name: 'orgId', value: 'shared' },
    teamid: { name: 'teamId', value: 'prod-team' },
  });
  assert.deepEqual(vars.valuesFor(list, 'unknown'), { orgid: { name: 'orgId', value: 'shared' } });
});

test('a missing or damaged file loads as an empty list, and a saved list round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vars-'));
  const file = path.join(dir, 'variables.json');
  assert.deepEqual(vars.load(file), []);
  fs.writeFileSync(file, '{oops');
  assert.deepEqual(vars.load(file), []);
  const list = [{ id: vars.newId(), name: 'orgId', value: 'x', byEnvironment: { 'env-int': 'y' } }];
  vars.save(file, list);
  assert.deepEqual(vars.load(file), list);
});

test('a variable matches a parameter whatever the spelling: orgId, org_id, org-id and OrgID are one name', () => {
  const list = [{ id: 'var:1', name: 'orgId', value: 'org-1', byEnvironment: {} }];
  for (const key of ['org_id', 'org-id', 'OrgID', 'ORGID']) {
    assert.equal(vars.valuesFor(list, 'x')[vars.variableKey(key)].value, 'org-1', key);
  }
});

test('snapshot variables preserve existing values and report conflicts, invalid values and unavailable environments', () => {
  const existing = [{ id: 'var:1', name: 'orgId', value: 'original', byEnvironment: {} }];
  const merged = vars.mergeRows(existing, [
    { name: 'ORGID', value: 'replacement', byEnvironment: {} },
    { name: 'region', value: 'shared', byEnvironment: { 'env-int': 'int', 'env-other': 'secret' } },
    { name: 'empty', value: '', byEnvironment: { 'env-other': 'secret' } },
    { name: 'invalid name', value: 'x', byEnvironment: {} },
  ], ENVS);
  assert.equal(merged.variables[0].value, 'original');
  assert.deepEqual(merged.variables[1].byEnvironment, { 'env-int': 'int' });
  assert.equal(merged.variables.length, 2);
  assert.equal(merged.skipped.length, 5);
  assert.ok(merged.skipped.some((message) => message.includes('already exists')));
  assert.ok(merged.skipped.some((message) => message.includes('unavailable environments')));
  assert.ok(merged.skipped.some((message) => message.includes('invalid name')));
});
