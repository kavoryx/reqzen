// Appearance preferences: light, dark or the system setting, and a colour palette. Stored on this computer.
const fs = require('fs');
const path = require('path');

const MODES = ['system', 'light', 'dark'];
const PALETTES = ['blue', 'teal', 'violet', 'amber', 'graphite'];
const DEFAULTS = { mode: 'system', palette: 'blue', wrapText: false, columnWidths: null, textScale: 100 };
const COLUMNS = 5;
const MIN_WIDTH = 60;
const MAX_WIDTH = 1200;

/** Column widths in pixels for the API list, or null when they are not all valid. */
function validWidths(raw) {
  if (!Array.isArray(raw) || raw.length !== COLUMNS) return null;
  const ok = raw.every((w) => Number.isInteger(w) && w >= MIN_WIDTH && w <= MAX_WIDTH);
  return ok ? raw.slice() : null;
}

/** Keeps only known values; anything else falls back to the default. */
function sanitize(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  return {
    mode: MODES.includes(data.mode) ? data.mode : DEFAULTS.mode,
    palette: PALETTES.includes(data.palette) ? data.palette : DEFAULTS.palette,
    wrapText: data.wrapText === true,
    columnWidths: validWidths(data.columnWidths),
    textScale: Number.isInteger(data.textScale) && data.textScale >= 80 && data.textScale <= 150 && data.textScale % 10 === 0 ? data.textScale : DEFAULTS.textScale,
  };
}

function load(file) {
  try {
    return sanitize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return { ...DEFAULTS };
  }
}

function save(file, prefs) {
  const clean = sanitize(prefs);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(clean, null, 2), { mode: 0o600 });
  return clean;
}

module.exports = { sanitize, load, save, MODES, PALETTES, DEFAULTS, validWidths };
