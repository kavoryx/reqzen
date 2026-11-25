const test = require('node:test');
const assert = require('node:assert/strict');
const job = require('../lib/docJob');

const op = (id, extra = {}) => ({ revisionId: id, httpMethod: 'GET', pathTemplate: `/a/${id}`, summary: '', definition: { operation: { parameters: [] } }, ...extra });
const okChat = async () => '{"description": "Returns the item for the given identifier."}';

test('an API needs a description when it has none in the spec and none saved, or only a factual one', () => {
  assert.equal(job.needsDescription(op('a'), {}), true);
  assert.equal(job.needsDescription(op('a'), { a: { description: 'Real text here.', source: 'local' } }), false);
  assert.equal(job.needsDescription(op('a'), { a: { description: 'Data unavailable.', source: 'template' } }), true);
  assert.equal(job.needsDescription(op('a', { description: 'From the spec.' }), {}), false);
});

test('a run describes every API in chunks, saving each chunk and reporting progress', async () => {
  const ops = Array.from({ length: 65 }, (_, i) => op(`r${i}`));
  const saved = [];
  const seen = [];
  const status = await job.runDocumentation({
    operations: ops, chat: okChat, source: 'local', instructions: '', chunkSize: 10,
    save: (results) => saved.push(...results), onProgress: (s) => seen.push(s.done),
  });
  assert.equal(status.state, 'done');
  assert.equal(status.done, 65);
  assert.equal(status.fromModel, 65);
  assert.equal(saved.length, 65);
  assert.deepEqual(seen.slice(-1), [65]);
});

test('a stop request keeps the chunks already saved', async () => {
  const ops = Array.from({ length: 30 }, (_, i) => op(`s${i}`));
  let stop = false;
  const saved = [];
  const status = await job.runDocumentation({
    operations: ops, chat: okChat, source: 'local', instructions: '', chunkSize: 10,
    save: (results) => { saved.push(...results); stop = true; }, shouldStop: () => stop,
  });
  assert.equal(status.state, 'stopped');
  assert.equal(saved.length, 10, 'only the first chunk was written');
});

test('a stop request during a model call discards the unfinished chunk', async () => {
  let stop = false;
  let finish;
  const saved = [];
  const started = new Promise((resolve) => {
    finish = resolve;
  });
  const running = job.runDocumentation({
    operations: [op('in-flight')],
    chat: () => started,
    source: 'local',
    instructions: '',
    save: (results) => saved.push(...results),
    shouldStop: () => stop,
  });
  await new Promise((resolve) => setImmediate(resolve));
  stop = true;
  finish('{"description":"Returns an item for the requested identifier."}');
  const status = await running;
  assert.equal(status.state, 'stopped');
  assert.equal(status.done, 0);
  assert.equal(saved.length, 0);
});

test('a model that fails a whole chunk stops the run, and the failure is reported', async () => {
  const ops = Array.from({ length: 30 }, (_, i) => op(`f${i}`));
  let calls = 0;
  const status = await job.runDocumentation({
    operations: ops, chat: async () => { calls++; throw new Error('down'); }, source: 'local', instructions: '',
    chunkSize: 10, save: () => {},
  });
  assert.equal(status.state, 'failed');
  assert.match(status.reason, /did not answer/);
  assert.equal(calls, 10, 'it does not keep calling the model after a whole chunk failed');
});
