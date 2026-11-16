// Sends one request from the main process. No redirects (3xx is returned as-is), time and size limits.
const http = require('http');
const https = require('https');

const TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DROP_RESPONSE_HEADERS = new Set(['set-cookie', 'authorization', 'proxy-authorization']);

function send({ method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const transport = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!transport) throw new Error('Only http and https requests can be sent.');
    const req = transport.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method,
        headers: body !== null && body !== undefined ? { ...headers, 'Content-Length': Buffer.byteLength(body) } : headers,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error('The response is larger than 2 MB, so it was stopped.'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const outHeaders = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (!DROP_RESPONSE_HEADERS.has(k.toLowerCase())) outHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
          }
          resolve({ status: res.statusCode, headers: outHeaders, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('The server did not answer in time.')));
    req.on('error', reject);
    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

module.exports = { send, TIMEOUT_MS, MAX_RESPONSE_BYTES };
