// Talking to a wisp Grid (grid/): the cloud computers' sign-in and their edge. Plain http/https, so
// names under .localhost (a grid running on this computer: `wisp grid dev`) reach 127.0.0.1 even
// where the system resolver doesn't know them.

import http from 'node:http';
import https from 'node:https';
import { bad } from './util.js';

const LOCAL = /(^|\.)localhost$/i;
const lookup = (host, opts, cb) => (opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4));

// Request options for a URL: the right module, and loopback for *.localhost.
export function target(url) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  return { lib, opts: { protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), ...(LOCAL.test(u.hostname) && { lookup }) } };
}

// A grid's address as typed: "wisp.example.com" → https://wisp.example.com, no trailing slash.
export function gridUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) throw bad('The address of your wisp Grid, like wisp.example.com.');
  if (!/^https?:\/\//i.test(s)) s = `${LOCAL.test(s.split(/[:/]/)[0]) ? 'http' : 'https'}://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw bad('That doesn’t look like an address: try wisp.example.com.');
  }
  if (u.protocol === 'http:' && !LOCAL.test(u.hostname) && u.hostname !== '127.0.0.1') throw bad('Use https:// for a grid on another computer: your sign-in token goes over it.');
  return u.origin;
}

// JSON request (or raw bytes: a Buffer as raw). Resolves { status, body }; network errors reject
// with a 502.
export function gridJson(url, { method = 'GET', body, raw, token, headers = {}, timeout = 30_000 } = {}) {
  const { lib, opts } = target(url);
  const u = new URL(url);
  const data = raw || (body === undefined ? undefined : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        ...opts,
        path: u.pathname + u.search,
        method,
        timeout,
        headers: {
          accept: 'application/json',
          ...(data && { 'content-type': raw ? 'application/octet-stream' : 'application/json', 'content-length': Buffer.byteLength(data) }),
          ...(token && { authorization: `Bearer ${token}` }),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let j;
          try {
            j = text ? JSON.parse(text) : {};
          } catch {
            j = { error: text.slice(0, 200) };
          }
          resolve({ status: res.statusCode, body: j, headers: res.headers });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(bad(`${u.host} didn’t answer in time.`, 504)));
    req.on('error', (err) => reject(Object.assign(err, { status: err.status || 502 })));
    req.end(data);
  });
}
