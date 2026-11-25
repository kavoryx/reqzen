// Runs the documentation agent over a list of APIs in small chunks, saving each chunk before the next one starts, so a
// stop or a crash keeps the work already done. It stops early when the model fails for a whole chunk, so a model that is
// not running does not keep the app busy for hours. Progress is reported after every chunk.
const docAgent = require('./docAgent');

/** Whether an API still needs a model description: none in the spec, and none saved except a factual fallback. */
function needsDescription(op, docs) {
  if (op.description) return false;
  const saved = docs[op.revisionId];
  return !saved || saved.source === 'template';
}

async function runDocumentation({ operations, chat, source, instructions, save, shouldStop = () => false, onProgress = () => {}, chunkSize = 10 }) {
  const status = { state: 'running', total: operations.length, done: 0, fromModel: 0, factual: 0, reason: '' };
  onProgress({ ...status });
  for (let i = 0; i < operations.length; i += chunkSize) {
    if (shouldStop()) {
      status.state = 'stopped';
      break;
    }
    const chunk = operations.slice(i, i + chunkSize);
    const { results, modelFailures } = await docAgent.runDocAgent({
      operations: chunk, chat, source, instructions, shouldStop,
    });
    if (shouldStop()) {
      status.state = 'stopped';
      break;
    }
    if (modelFailures === chunk.length) {
      status.state = 'failed';
      status.reason = 'The model did not answer. Check that it is running or that the key is valid.';
      onProgress({ ...status });
      break;
    }
    save(results);
    const fromModel = results.filter((r) => r.source !== 'template').length;
    status.done += chunk.length;
    status.fromModel += fromModel;
    status.factual += chunk.length - fromModel;
    onProgress({ ...status });
  }
  if (status.state === 'running') status.state = 'done';
  return status;
}

module.exports = { needsDescription, runDocumentation };
