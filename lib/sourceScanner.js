const path = require('path');
const { stableId } = require('./openapi');
const { scanControllerSource, stripComments } = require('./controllerScanner');
const { SPRING, NESTJS, DEFAULT_VERSION_PATTERN, activeRules } = require('./scanRules');

const SOURCE_EXTENSIONS = ['.java', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py'];
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
const CONTROLLER_RULES = new Set([JSON.stringify(activeRules(SPRING)), JSON.stringify(activeRules(NESTJS))]);

function isBuiltInRules(rules) {
  return CONTROLLER_RULES.has(JSON.stringify(rules));
}

function sourceExtensions(rules) {
  const extensions = isBuiltInRules(rules) ? SOURCE_EXTENSIONS : [];
  return [...new Set([...extensions, ...(rules.fileExtensions || [])])];
}

function joinPaths(prefix, route) {
  return `/${[prefix, route].map((part) => String(part || '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
}

function languageFor(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  return ({
    '.java': 'Java',
    '.js': 'JavaScript',
    '.jsx': 'JavaScript',
    '.mjs': 'JavaScript',
    '.cjs': 'JavaScript',
    '.ts': 'TypeScript',
    '.tsx': 'TypeScript',
    '.py': 'Python',
  })[ext] || '';
}

function readCall(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++;
        i++;
      }
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return { args: source.slice(open + 1, i), end: i };
  }
  return null;
}

function readString(source, start) {
  let i = start;
  if (source[i] === 'r' && (source[i + 1] === '"' || source[i + 1] === "'")) i++;
  const quote = source[i];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let value = '';
  for (i++; i < source.length; i++) {
    if (source[i] === '\\') {
      if (i + 1 >= source.length) return null;
      value += source[++i];
    } else if (source[i] === quote) {
      if (quote === '`' && value.includes('${')) return null;
      return { value, end: i + 1 };
    } else {
      value += source[i];
    }
  }
  return null;
}

function normalisePath(value) {
  let route = String(value || '').trim();
  route = route.replace(/<(?:(?:[A-Za-z_]\w*):)?([A-Za-z_]\w*)>/g, '{$1}');
  route = route.replace(/:(\w+)\??(?=[/}]|$)/g, '{$1}');
  route = route.replace(/\/+/g, '/');
  if (!route.startsWith('/')) route = `/${route}`;
  if (route.length > 1) route = route.replace(/\/+$/, '');
  return route || '/';
}

function addRouteOperations({ pathTemplate, methods, functionName, file, serviceName, serviceId, framework }) {
  const route = normalisePath(pathTemplate);
  const name = functionName || `${methods[0].toLowerCase()}${route.split('/').filter(Boolean).map((part) => part.replace(/[{}]/g, '')).map((part) => part[0] ? part[0].toUpperCase() + part.slice(1) : '').join('') || 'Root'}`;
  return methods.map((httpMethod) => {
    const key = `${httpMethod} ${route}`;
    const identity = `src:${serviceName}:${file}:${name}:${key}`;
    const version = route.match(new RegExp(DEFAULT_VERSION_PATTERN));
    const pathParameters = [...route.matchAll(/\{([^}]+)\}/g)].map((match) => ({
      name: match[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    const operation = {
      operationId: name,
      summary: '',
      description: '',
      tags: [name],
      parameters: pathParameters,
      responses: { 200: { description: 'OK' } },
    };
    return {
      operationId: stableId(identity),
      revisionId: stableId(`src-rev:${identity}`),
      serviceId,
      serviceName,
      contractVersion: version && version[1] ? version[1] : '',
      httpMethod,
      pathTemplate: route,
      visibility: 'PUBLIC',
      lifecycleStatus: 'ACTIVE',
      schemaComplete: true,
      summary: '',
      description: '',
      definition: {
        path: route,
        method: httpMethod,
        servers: [],
        operation,
        pathParameters,
        'x-apiexplorer': {
          origin: 'SOURCE_CONTROLLER',
          visibilitySource: 'none',
          rules: framework,
          source: file,
          controller: name,
          method: name,
          framework,
          language: languageFor(file),
          schemaComplete: true,
          unresolvedTypes: [],
        },
      },
    };
  });
}

function routeMethods(args, fallback) {
  const match = String(args).match(/\bmethods\s*=\s*(?:\[([^\]]*)\]|\(([^)]*)\))/i);
  if (!match) return fallback;
  const methods = [...(match[1] || match[2]).matchAll(/['"]([A-Za-z]+)['"]/g)]
    .map((m) => m[1].toUpperCase())
    .filter((method) => HTTP_METHODS.has(method));
  return methods.length ? [...new Set(methods)] : fallback;
}

function pythonRoutes(source, context) {
  const clean = stripPythonComments(source);
  const searchable = maskQuotedStrings(clean);
  const operations = [];
  const controllers = [];
  const routeRe = /@([\w.]+)\s*\.\s*(get|post|put|delete|patch|head|options|api_route|route)\s*\(/gi;
  let match;
  while ((match = routeRe.exec(searchable)) !== null) {
    const call = readCall(clean, routeRe.lastIndex - 1);
    if (!call) continue;
    const string = readString(call.args, call.args.search(/\S/));
    if (!string) continue;
    const methodName = clean.slice(call.end + 1).match(/\b(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    const functionName = methodName ? methodName[1] : '';
    if (functionName) controllers.push(functionName);
    const receiver = match[1].split('.').pop();
    const router = new RegExp(`\\b${receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(?:APIRouter|Blueprint)\\s*\\(`).exec(clean);
    let prefix = '';
    if (router) {
      const init = readCall(clean, router.index + router[0].lastIndexOf('('));
      const prefixArg = init && init.args.match(/\b(?:prefix|url_prefix)\s*=\s*/);
      if (prefixArg) {
        const prefixValue = readString(init.args, prefixArg.index + prefixArg[0].length);
        if (prefixValue) prefix = prefixValue.value;
      }
    }
    const annotation = match[2].toLowerCase();
    const methods = annotation === 'route' || annotation === 'api_route'
      ? routeMethods(call.args, ['GET'])
      : [annotation.toUpperCase()];
    operations.push(...addRouteOperations({
      pathTemplate: joinPaths(prefix, string.value),
      methods,
      functionName,
      file: context.file,
      serviceName: context.serviceName,
      serviceId: context.serviceId,
      framework: context.framework,
    }));
    routeRe.lastIndex = call.end + 1;
  }
  return { controllers, operations, problems: [] };
}

function stripPythonComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const triple = source.slice(i, i + 3);
    if (triple === '"""' || triple === "'''") {
      const end = source.indexOf(triple, i + 3);
      const stop = end < 0 ? source.length : end + 3;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === '"' || c === "'") {
      const quote = c;
      let end = i + 1;
      while (end < source.length && source[end] !== quote && source[end] !== '\n') {
        end += source[end] === '\\' ? 2 : 1;
      }
      out += source.slice(i, end + 1);
      i = end + 1;
    } else if (c === '#') {
      const end = source.indexOf('\n', i);
      const stop = end < 0 ? source.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function maskQuotedStrings(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const quote = source[i];
    if (quote !== '"' && quote !== "'" && quote !== '`') {
      out += quote;
      i++;
      continue;
    }
    const triple = source.slice(i, i + 3) === quote.repeat(3);
    const marker = triple ? quote.repeat(3) : quote;
    const start = i;
    i += marker.length;
    while (i < source.length) {
      if (source[i] === '\\') {
        i += 2;
      } else if (source.slice(i, i + marker.length) === marker) {
        i += marker.length;
        break;
      } else {
        i++;
      }
    }
    out += source.slice(start, i).replace(/[^\n]/g, ' ');
  }
  return out;
}

function receiverAllowed(receiver, framework) {
  if (/^(app|router|server|api|bp|blueprint)$/i.test(receiver) || /(?:router|routes)$/i.test(receiver)) return true;
  return framework === 'Express' && !/^(axios|fetch|client|http|request)$/i.test(receiver);
}

function javascriptRoutes(source, context) {
  const clean = stripComments(source).clean;
  const searchable = maskQuotedStrings(clean);
  const operations = [];
  const controllers = [];
  const routeRe = /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|delete|patch|head|options)\s*\(/gi;
  let match;
  while ((match = routeRe.exec(searchable)) !== null) {
    if (!receiverAllowed(match[1], context.framework)) continue;
    const call = readCall(clean, routeRe.lastIndex - 1);
    if (!call) continue;
    const string = readString(call.args, call.args.search(/\S/));
    if (!string) continue;
    const methodName = clean.slice(call.end + 1).match(/^\s*(?:async\s*)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*(?:,|\))/);
    const functionName = methodName ? methodName[1] : '';
    if (functionName) controllers.push(functionName);
    operations.push(...addRouteOperations({
      pathTemplate: string.value,
      methods: [match[2].toUpperCase()],
      functionName,
      file: context.file,
      serviceName: context.serviceName,
      serviceId: context.serviceId,
      framework: context.framework,
    }));
    routeRe.lastIndex = call.end + 1;
  }

  const chainedRouteRe = /\b([A-Za-z_$][\w$]*)\s*\.\s*route\s*\(/gi;
  while ((match = chainedRouteRe.exec(searchable)) !== null) {
    if (!receiverAllowed(match[1], context.framework)) continue;
    const call = readCall(clean, chainedRouteRe.lastIndex - 1);
    if (!call) continue;
    const string = readString(call.args, call.args.search(/\S/));
    if (!string) continue;
    const tail = clean.slice(call.end + 1);
    const methodRe = /^\s*\.\s*(get|post|put|delete|patch|head|options)\s*\(/i;
    const methods = [];
    let offset = 0;
    while (offset < tail.length) {
      const method = methodRe.exec(tail.slice(offset));
      if (!method) break;
      const methodOpen = call.end + 1 + offset + method[0].lastIndexOf('(');
      const methodCall = readCall(clean, methodOpen);
      if (!methodCall) break;
      methods.push(method[1].toUpperCase());
      offset = methodCall.end - call.end;
    }
    if (methods.length === 0) continue;
    operations.push(...addRouteOperations({
      pathTemplate: string.value,
      methods: [...new Set(methods)],
      functionName: '',
      file: context.file,
      serviceName: context.serviceName,
      serviceId: context.serviceId,
      framework: context.framework,
    }));
    chainedRouteRe.lastIndex = call.end + 1;
  }
  return { controllers, operations, problems: [] };
}

function frameworkFor(file, source) {
  const ext = path.extname(String(file || '')).toLowerCase();
  const text = String(source || '');
  if (ext === '.java' && /@(RestController|Controller)\b/.test(text)) return 'Spring Boot';
  if (['.ts', '.tsx', '.js', '.jsx'].includes(ext) && /@Controller\s*\(/.test(text) && /@(Get|Post|Put|Delete|Patch)\s*\(/.test(text)) return 'NestJS';
  if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'].includes(ext)) {
    if (/\bexpress\s*\(|from\s+['"]express['"]|require\s*\(\s*['"]express['"]\s*\)/i.test(text)) return 'Express';
    if (/\b(?:app|router|server|api|[\w$]*(?:Router|Routes))\s*\.\s*(?:get|post|put|delete|patch|head|options|route)\s*\(/i.test(text)) return 'Express-style router';
  }
  if (ext === '.py') {
    if (/\bFastAPI\s*\(|\bfrom\s+fastapi\s+import\b|\bimport\s+fastapi\b/.test(text)) return 'FastAPI';
    if (/\bFlask\s*\(|\bfrom\s+flask\s+import\b|\bimport\s+flask\b/.test(text)) return 'Flask';
    if (/\bfrom\s+django(?:\.urls)?\s+import\b|\burlpatterns\b/.test(text)) return 'Django';
    if (/@[\w.]+\.(?:get|post|put|delete|patch|api_route|route)\s*\(/i.test(text)) return 'Python route decorators';
  }
  return '';
}

function scanSource(source, context = {}) {
  const file = String(context.file || '');
  const language = languageFor(file);
  const rules = activeRules(context.rules);
  const framework = frameworkFor(file, source);
  const scanContext = { ...context, file, framework };
  const results = [];

  if (language === 'Java') {
    results.push(scanControllerSource(source, { ...scanContext, rules: SPRING }));
  } else if (language === 'TypeScript' && framework === 'NestJS') {
    results.push(scanControllerSource(source, { ...scanContext, rules: NESTJS }));
  } else if (language === 'Python' && ['FastAPI', 'Flask', 'Python route decorators'].includes(framework)) {
    results.push(pythonRoutes(source, scanContext));
  } else if (['JavaScript', 'TypeScript'].includes(language) && ['Express', 'Express-style router'].includes(framework)) {
    results.push(javascriptRoutes(source, scanContext));
  }

  if (!isBuiltInRules(rules)) {
    results.push(scanControllerSource(source, { ...scanContext, rules }));
  }
  if (results.length === 0 && language === '') {
    results.push(scanControllerSource(source, { ...scanContext, rules }));
  }

  return {
    language,
    framework,
    controllers: [...new Set(results.flatMap((result) => result.controllers))],
    operations: results.flatMap((result) => result.operations),
    problems: results.flatMap((result) => result.problems),
  };
}

module.exports = {
  SOURCE_EXTENSIONS,
  isBuiltInRules,
  sourceExtensions,
  languageFor,
  frameworkFor,
  scanSource,
  pythonRoutes,
  javascriptRoutes,
  normalisePath,
};
