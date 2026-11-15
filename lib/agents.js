// The desktop agents, mirroring the web app: Supervisor decides what a question is about, Discovery ranks the
// candidates, and Planning fills a request from a description (lib/assist.js). Agents do not call each other; the
// flow below runs them in order. Every model answer is checked before it is used, and a failed model falls back to
// plain search instead of blocking the user.
const assist = require('./assist');

const ACTIONS = new Set(['search', 'clarify', 'reject']);
const MAX_MESSAGE = 300;

function supervisorPrompt(question) {
  return {
    system: [
      'You route a question about an API catalogue. Reply with JSON only: {"action": "search" | "clarify" | "reject", "message": ""}.',
      'Use "search" when the question asks for an API or how to call one (words such as get, create, update, delete, a resource name, or an ID).',
      'Use "clarify" when the question is about APIs but too vague to search; put one short question in "message".',
      'Use "reject" when the question is not about APIs (for example a poem or a joke); put a one-sentence reason in "message".',
    ].join(' '),
    user: `Question: ${assist.redact(question)}`,
  };
}

/** The Supervisor's decision. Anything that is not a clean answer means "search", so the user still gets results. */
function parseDecision(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { action: 'search', message: '', valid: false };
  }
  const action = data && typeof data.action === 'string' ? data.action.toLowerCase() : '';
  if (!ACTIONS.has(action)) return { action: 'search', message: '', valid: false };
  const message = typeof data.message === 'string' ? data.message.trim().slice(0, MAX_MESSAGE) : '';
  if (action !== 'search' && message === '') return { action: 'search', message: '', valid: false };
  return { action, message, valid: true };
}

/**
 * Runs the agents for one question. `chat(system, user)` is the model call (injected, so tests can use a fake).
 * `candidates` are the operations the offline search found, each {id, method, path, summary}.
 * Returns the action, a message for clarify or reject, the ordered ids for search, and a step-by-step trace.
 */
async function runAgents({ question, candidates, chat }) {
  const steps = [];
  const offered = candidates.slice(0, assist.MAX_CANDIDATES).map((c) => String(c.id));
  let degraded = false;

  let decision;
  try {
    const p = supervisorPrompt(question);
    decision = parseDecision(await chat(p.system, p.user));
  } catch {
    decision = { action: 'search', message: '', valid: false };
  }
  if (!decision.valid) degraded = true;
  steps.push({ agent: 'Supervisor', result: decision.valid ? decision.action : 'search (model answer not usable)' });

  if (decision.action !== 'search') {
    return { action: decision.action, message: decision.message, ids: [], steps, degraded };
  }
  if (offered.length === 0) {
    steps.push({ agent: 'Discovery', result: 'nothing to rank' });
    return { action: 'search', message: '', ids: [], steps, degraded };
  }

  let ids = [];
  try {
    const p = assist.rankPrompt(question, candidates);
    ids = assist.parseRank(await chat(p.system, p.user), offered);
    steps.push({ agent: 'Discovery', result: `ranked ${ids.length} of ${offered.length}` });
  } catch {
    degraded = true;
    steps.push({ agent: 'Discovery', result: 'unavailable, showing the offline order' });
  }
  return { action: 'search', message: '', ids, steps, degraded };
}

module.exports = { runAgents, parseDecision, supervisorPrompt };
