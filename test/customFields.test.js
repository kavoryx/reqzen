const test = require('node:test');
const assert = require('node:assert/strict');
const fields = require('../lib/customFields');
const { validateSnapshot } = require('../lib/snapshotValidation');
const { buildCatalog } = require('../lib/catalogExport');

const snapshot = {
  format: 'api-explorer-snapshot', formatVersion: 1,
  services: [{ serviceId: 's', name: 'Reports' }],
  operations: [
    { operationId: 'one', serviceId: 's', serviceName: 'Reports', httpMethod: 'GET', pathTemplate: '/reports' },
    { operationId: 'two', serviceId: 's', serviceName: 'Reports', httpMethod: 'POST', pathTemplate: '/reports' },
  ],
};

test('custom fields survive an overlay and export, while removing a field removes its values', () => {
  const definitions = [{ key: 'owner', label: ' Team owner ', visible: true }, { key: 'tier', label: 'Tier', visible: false }];
  const values = { one: { owner: 'Platform', tier: 'critical' }, two: { owner: 'Finance' } };
  const updated = fields.applyMetadata(snapshot, definitions, values);
  assert.equal(updated.customFieldDefinitions[0].label, 'Team owner');
  assert.equal(snapshot.operations[0].customFields, undefined);
  const overlay = JSON.parse(JSON.stringify({ definitions: updated.customFieldDefinitions, values }));
  const restored = fields.applyMetadata(snapshot, overlay.definitions, overlay.values);
  const exported = JSON.parse(JSON.stringify(buildCatalog({ snapshot: restored })));
  assert.equal(validateSnapshot(exported), '');
  assert.equal(exported.operations[0].customFields.tier, 'critical');
  assert.equal(exported.customFieldDefinitions[1].visible, false);
  const removed = fields.applyMetadata(restored, [definitions[0]], { one: { owner: 'Platform' }, two: { owner: 'Finance' } });
  assert.deepEqual(removed.operations[0].customFields, { owner: 'Platform' });
});

test('malformed field definitions, values and operation references are rejected', () => {
  const valid = [{ key: 'owner', label: 'Owner', visible: true }];
  assert.match(fields.validateDefinitions([{ key: 'constructor', label: 'Bad', visible: true }]), /valid key/);
  assert.match(fields.validateDefinitions([...valid, { key: 'OWNER', label: 'Duplicate', visible: true }]), /duplicated/);
  assert.match(fields.validateDefinitions([{ key: 'owner', label: '', visible: true }]), /label/);
  assert.throws(() => fields.applyMetadata(snapshot, valid, { missing: { owner: 'x' } }), /no longer/);
  assert.throws(() => fields.applyMetadata(snapshot, valid, { one: { missing: 'x' } }), /unknown/);
  assert.throws(() => fields.applyMetadata(snapshot, valid, { one: { owner: 'x'.repeat(1001) } }), /invalid/);
  assert.match(validateSnapshot({ ...snapshot, customFieldDefinitions: valid, operations: [{ ...snapshot.operations[0], customFields: { owner: 42 } }] }), /invalid value/);
});
