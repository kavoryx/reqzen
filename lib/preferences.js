// Appearance preferences: light, dark or the system setting, and a colour palette. Stored on this computer.
const fs = require('fs');
const path = require('path');

const MODES = ['system', 'light', 'dark'];
const PALETTES = ['blue', 'teal', 'violet', 'amber', 'graphite'];
const SHORTCUTS = {
  command: 'Mod+K',
  settings: 'Mod+,',
  find: 'Mod+F',
  snapshot: 'Mod+O',
  newRequest: 'Mod+N',
  send: 'Mod+Enter',
};
const DEFAULTS = {
  mode: 'system',
  palette: 'blue',
  wrapText: false,
  columnWidths: null,
  textScale: 100,
  shortcuts: { ...SHORTCUTS },
  acceptAllIncompleteContracts: false,
  acceptedIncompleteServices: [],
};
const COLUMNS = 5;
const MIN_WIDTH = 60;
const MAX_WIDTH = 1200;

/** Column widths in pixels for the API list, or null when they are not all valid. */
function validWidths(raw) {
  if (!Array.isArray(raw) || raw.length !== COLUMNS) return null;
  const ok = raw.every((w) => Number.isInteger(w) && w >= MIN_WIDTH && w <= MAX_WIDTH);
  return ok ? raw.slice() : null;
}

function validShortcut(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const value = raw.trim();
  if (!/^(?:(?:Mod|Ctrl|Meta|Alt|Shift)\+)*(?:[A-Za-z0-9]|,|Enter)$/.test(value)) return fallback;
  const keys = value.split('+');
  if (keys.length === 0 || new Set(keys.slice(0, -1)).size !== keys.length - 1) return fallback;
  return value;
}

function sanitizeShortcuts(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  return Object.fromEntries(Object.entries(SHORTCUTS).map(([action, fallback]) =>
    [action, validShortcut(data[action], fallback)]));
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
    shortcuts: sanitizeShortcuts(data.shortcuts),
    acceptAllIncompleteContracts: data.acceptAllIncompleteContracts === true,
    acceptedIncompleteServices: Array.isArray(data.acceptedIncompleteServices)
      ? [...new Set(data.acceptedIncompleteServices.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))].slice(0, 1000)
      : [],
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

module.exports = { sanitize, load, save, MODES, PALETTES, SHORTCUTS, DEFAULTS, validWidths, sanitizeShortcuts };
