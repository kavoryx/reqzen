const DEFAULTS = Object.freeze({
  search: true,
  requestPlanning: true,
  documentation: true,
});

function sanitize(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  return {
    search: typeof data.search === 'boolean' ? data.search : DEFAULTS.search,
    requestPlanning: typeof data.requestPlanning === 'boolean' ? data.requestPlanning : DEFAULTS.requestPlanning,
    documentation: typeof data.documentation === 'boolean' ? data.documentation : DEFAULTS.documentation,
  };
}

function enabled(settings, feature) {
  return sanitize(settings && settings.aiFeatures)[feature] === true;
}

module.exports = { DEFAULTS, sanitize, enabled };
