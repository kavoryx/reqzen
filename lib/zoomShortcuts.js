const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;

function zoomAction(input, platform = process.platform) {
  const modifier = platform === 'darwin' ? input.meta === true : input.control === true;
  if (!modifier || input.alt === true) return null;
  const key = String(input.key || '').toLowerCase();
  const code = String(input.code || '').toLowerCase();
  if (key === '+' || key === '=' || code === 'equal' || code === 'numpadadd') return 'in';
  if (key === '-' || key === '_' || key === 'subtract' || code === 'minus' || code === 'numpadsubtract') return 'out';
  if (key === '0' || code === 'digit0' || code === 'numpad0') return 'reset';
  return null;
}

function nextZoomFactor(current, action) {
  if (action === 'reset') return 1;
  const factor = Number.isFinite(current) && current > 0 ? current : 1;
  const direction = action === 'in' ? 1 : action === 'out' ? -1 : 0;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((factor + direction * ZOOM_STEP) * 10) / 10));
}

module.exports = { MAX_ZOOM, MIN_ZOOM, ZOOM_STEP, nextZoomFactor, zoomAction };
