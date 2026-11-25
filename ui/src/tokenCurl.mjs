function words(command) {
  const input = command
    .replace(/\\\r?\n/g, ' ')
    .replace(/`\r?\n/g, ' ')
    .replace(/\^\r?\n/g, ' ');
  const result = [];
  let word = '';
  let started = false;
  let quote = '';
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote === "'") {
      if (c === "'") quote = '';
      else word += c;
    } else if (c === '"' && quote === '"') {
      quote = '';
    } else if (c === "'" && !quote || c === '"' && !quote) {
      quote = c;
      started = true;
    } else if (c === '\\' && quote !== "'") {
      if (++i >= input.length) throw new Error('The curl command ends with an incomplete escape.');
      if (quote === '"' && !'"\\$`'.includes(input[i])) word += '\\';
      word += input[i];
      started = true;
    } else if ((c === '$' || c === '`') && quote !== "'") {
      throw new Error('Shell expansion is not supported. Replace variables and substitutions with their values first.');
    } else if (!quote && /[;|&<>]/.test(c)) {
      throw new Error('Shell operators are not supported in a curl command.');
    } else if (!quote && /\s/.test(c)) {
      if (started) result.push(word);
      word = '';
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (quote) throw new Error('The curl command has an unclosed quote.');
  if (started) result.push(word);
  return result;
}

function basicCredential(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

export function parseTokenCurl(command) {
  const args = words(command.trim());
  if (!/^curl(?:\.exe)?$/i.test(args.shift() || '')) throw new Error('Enter a curl command.');
  let url = '';
  let method = '';
  let basic = '';
  let auth = 'none';
  let contentType = '';
  const headers = [];
  const data = [];
  let json = false;
  let form = false;
  let droppedBearer = false;
  let securityWarning = false;
  const next = (option, index) => {
    if (index + 1 >= args.length) throw new Error(`${option} needs a value.`);
    return args[index + 1];
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const equalsOption = arg.match(/^(--request|--header|--data|--data-raw|--data-binary|--data-ascii|--data-urlencode|--json|--user|--url)=(.*)$/s);
    if (equalsOption) args.splice(i, 1, equalsOption[1], equalsOption[2]);
    const option = args[i];
    if (['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--json', '-u', '--user', '--url'].includes(option)) {
      const value = next(arg, i++);
      if (option === '-X' || option === '--request') method = value.toUpperCase();
      else if (option === '--url') {
        if (url) throw new Error('Only one token endpoint can be imported.');
        url = value;
      } else if (option === '-u' || option === '--user') {
        if (!value.includes(':')) throw new Error('The Basic credential must contain a client ID and secret separated by a colon.');
        basic = basicCredential(value);
        auth = 'basic';
      } else if (option === '-H' || option === '--header') {
        const colon = value.indexOf(':');
        if (colon <= 0) throw new Error('Each header must have a name and value separated by a colon.');
        const name = value.slice(0, colon).trim();
        const headerValue = value.slice(colon + 1).trim();
        if (name.toLowerCase() === 'authorization') {
          if (/^Basic [A-Za-z0-9+/]+=*$/i.test(headerValue)) {
            basic = `Basic ${headerValue.slice(6)}`;
            auth = 'basic';
          } else if (/^Bearer\s+\S+/i.test(headerValue)) {
            auth = 'bearer';
            basic = '';
            droppedBearer = true;
          } else throw new Error('Only Basic or Bearer authorization can be imported.');
        } else {
          if (name.toLowerCase() === 'content-type') contentType = headerValue;
          headers.push(`${name}: ${headerValue}`);
        }
      } else {
        if (value.startsWith('@') && option !== '--data-raw') throw new Error('Importing request bodies from files is not supported.');
        if (data.length && (json || option === '--json')) throw new Error('Combining --json with other data options is not supported.');
        if (option === '--data-urlencode') {
          if (value.includes('@')) throw new Error('Importing form data from files is not supported.');
          const equal = value.indexOf('=');
          data.push(equal < 0 ? encodeURIComponent(value) : `${value.slice(0, equal)}=${encodeURIComponent(value.slice(equal + 1))}`);
          form = true;
        } else {
          data.push(value);
          if (option === '--json') json = true;
        }
      }
    } else if (['-s', '-S', '-sS', '-Ss', '-L', '--silent', '--show-error', '--location', '--compressed'].includes(arg)) {
      continue;
    } else if (arg === '-k' || arg === '--insecure') {
      securityWarning = true;
      continue;
    } else if (arg.startsWith('-')) {
      throw new Error(`The curl option ${arg} is not supported. Remove it before importing.`);
    } else if (!url) url = arg;
    else throw new Error('Only one token endpoint can be imported.');
  }
  if (!url) throw new Error('The curl command needs a token endpoint.');
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { throw new Error('The curl command has an invalid token endpoint.'); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw new Error('Use an HTTP(S) token endpoint without credentials in the address.');
  }
  method ||= data.length ? 'POST' : 'GET';
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error(`The ${method} method is not supported for token requests.`);
  if (json && form) throw new Error('JSON and form data cannot be combined.');
  if (contentType && !/json|x-www-form-urlencoded/i.test(contentType)) throw new Error('Only JSON and URL-encoded form content types are supported.');
  return {
    url, method, headers: headers.join('\n'), body: data.join('&'),
    contentType: /x-www-form-urlencoded/i.test(contentType) || form || (!contentType && data.length > 0 && !json) ? 'form' : 'json',
    auth, basic, droppedBearer, securityWarning,
  };
}

const shellQuote = (value) => `'${value.replace(/'/g, "'\\''")}'`;

export function tokenCurl(config) {
  const args = ['curl', '--request', config.method, shellQuote(config.url.trim())];
  let hasContentType = false;
  for (const line of config.headers.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^\s*content-type\s*:/i.test(line)) hasContentType = true;
    args.push('--header', shellQuote(line.trim()));
  }
  if (config.auth === 'basic' && config.basic.trim()) args.push('--header', shellQuote(`Authorization: ${config.basic.trim()}`));
  if (config.auth === 'bearer') args.push('--header', shellQuote('Authorization: Bearer <paste the access token here>'));
  if (!hasContentType) args.push('--header', shellQuote(config.contentType === 'form' ? 'Content-Type: application/x-www-form-urlencoded' : 'Content-Type: application/json'));
  args.push('--data-raw', shellQuote(config.body));
  return args.join(' \\\n  ');
}
