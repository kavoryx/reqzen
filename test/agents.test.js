const test = require('node:test');
const assert = require('node:assert/strict');
const { runAgents, parseDecision } = require('../lib/agents');

const candidates = [
  { id: 'a', method: 'GET', path: '/sample/v4/items', summary: 'Get all items' },
  { id: 'b', method: 'POST', path: '/sample/v4/items', summary: 'Create a item' },
];

/** A fake model: answers the Supervisor first, then Discovery, from the lists given. */
function fakeModel(...answers) {
  const calls = [];
  const chat = async (system, user) => {
    calls.push({ system, user });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { chat, calls };
}

test('a clean search decision runs Discovery and returns the ranked ids', async () => {
  const m = fakeModel('{"action":"search","message":""}', '{"ids":["b","a"]}');
  const r = await runAgents({ question: 'get items', candidates, chat: m.chat });
  assert.equal(r.action, 'search');
  assert.deepEqual(r.ids, ['b', 'a']);
  assert.deepEqual(r.steps.map((s) => s.agent), ['Supervisor', 'Discovery']);
  assert.equal(r.degraded, false);
});

test('clarify and reject return the message and do not search', async () => {
  const clar = fakeModel('{"action":"clarify","message":"Which item do you mean?"}');
  const c = await runAgents({ question: 'item', candidates, chat: clar.chat });
  assert.equal(c.action, 'clarify');
  assert.equal(c.message, 'Which item do you mean?');
  assert.equal(clar.calls.length, 1);

  const rej = fakeModel('{"action":"reject","message":"That is not about the APIs."}');
  const r = await runAgents({ question: 'write a poem', candidates, chat: rej.chat });
  assert.equal(r.action, 'reject');
  assert.deepEqual(r.ids, []);
});

test('an unusable supervisor answer falls back to search and says so', async () => {
  const m = fakeModel('not json', '{"ids":["a"]}');
  const r = await runAgents({ question: 'get items', candidates, chat: m.chat });
  assert.equal(r.action, 'search');
  assert.equal(r.degraded, true);
  assert.deepEqual(r.ids, ['a']);
});

test('a model that is not running gives plain search, without an error to the user', async () => {
  const down = new Error('The local model is not running.');
  const m = fakeModel(down, down);
  const r = await runAgents({ question: 'get items', candidates, chat: m.chat });
  assert.equal(r.action, 'search');
  assert.deepEqual(r.ids, []);
  assert.equal(r.degraded, true);
  assert.equal(r.steps[1].result, 'unavailable, showing the offline order');
});

test('Discovery ignores ids it was not offered', async () => {
  const m = fakeModel('{"action":"search","message":""}', '{"ids":["zzz","a","a"]}');
  const r = await runAgents({ question: 'get items', candidates, chat: m.chat });
  assert.deepEqual(r.ids, ['a']);
});

test('parseDecision refuses unknown actions and empty clarify or reject messages', () => {
  assert.equal(parseDecision('{"action":"delete everything","message":""}').action, 'search');
  assert.equal(parseDecision('{"action":"clarify","message":""}').valid, false);
  assert.equal(parseDecision('{"action":"SEARCH"}').action, 'search');
});
