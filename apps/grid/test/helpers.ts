// Shared scaffolding for the grid's tests: temp folders, waiting for a condition, a free port, and a
// cookie-keeping browser that talks to any address on the grid's one port (Host decides where it goes).

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

process.env['WISP_TELEMETRY'] = '0'; // tests never report to PostHog
process.env['WISP_FEEDBACK'] = '0';

export const win = process.platform === 'win32';
export const tmp = (prefix: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `wisp-${prefix}-`)));
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const fixture = (name: string): string => new URL(`./fixtures/${name}`, import.meta.url).pathname;

export async function until<T>(fn: () => T | Promise<T>, { timeout = 20_000, every = 50, what = '' }: { timeout?: number; every?: number; what?: string } = {}): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (err) {
      last = err;
    }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what || 'a condition'}${last instanceof Error ? `: ${last.message}` : ''}`);
}

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer().once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });

export const listen = (srv: http.Server): Promise<string> =>
  new Promise((r) =>
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      r(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`);
    }),
  );

export interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: unknown;
  location: string | undefined;
}

/** A JSON answer's field, for asserts: `field(r, 'error')`. */
export const field = (r: { json: unknown }, k: string): unknown => (typeof r.json === 'object' && r.json !== null ? (r.json as Record<string, unknown>)[k] : undefined);

export interface GoOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  form?: Record<string, string>;
}

/** Any address on the grid's one port: `call(port, 'ada.wisp.localhost', '/x')`. */
export function call(port: number, host: string, p: string, { method = 'POST', headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders; json: () => unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `${host}:${port}`, connection: 'close', ...headers } }, (res) => {
      let t = '';
      res.on('data', (d: Buffer) => (t += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: t, headers: res.headers, json: () => JSON.parse(t) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Keeps cookies per host, like a browser; follow() follows redirects. */
export function browser() {
  const jar = new Map<string, Map<string, string>>();
  function keep(host: string, setCookie: string[] | undefined): void {
    for (const sc of setCookie ?? []) {
      const [kv = '', ...attrs] = sc.split(';');
      const i = kv.indexOf('=');
      const name = kv.slice(0, i).trim();
      const val = kv.slice(i + 1).trim();
      let m = jar.get(host);
      if (!m) jar.set(host, (m = new Map()));
      if (attrs.some((a) => /max-age=0/i.test(a))) m.delete(name);
      else m.set(name, val);
    }
  }
  function go(url: string, { method = 'GET', headers = {}, body, form }: GoOptions = {}): Promise<Answer> {
    const u = new URL(url);
    const c = jar.get(u.host);
    const data = form ? new URLSearchParams(form).toString() : body !== undefined ? JSON.stringify(body) : undefined;
    const h: Record<string, string> = {
      accept: 'text/html',
      ...(c && c.size && { cookie: [...c].map(([k, v]) => `${k}=${v}`).join('; ') }),
      ...(form && { 'content-type': 'application/x-www-form-urlencoded' }),
      ...(body !== undefined && { 'content-type': 'application/json', accept: 'application/json' }),
      ...headers,
    };
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method, headers: { host: u.host, ...h } }, (res) => {
        keep(u.host, res.headers['set-cookie']);
        let t = '';
        res.on('data', (d: Buffer) => (t += d));
        res.on('end', () => {
          let j: unknown = null;
          try {
            j = JSON.parse(t);
          } catch {
            // not JSON: a page
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: t, json: j, location: res.headers.location });
        });
      });
      req.on('error', reject);
      req.end(data);
    });
  }
  async function follow(url: string, opts: GoOptions = {}, hops = 8): Promise<Answer & { at: string }> {
    let r = await go(url, opts);
    let at = url;
    while (r.status >= 300 && r.status < 400 && r.location && hops--) {
      at = new URL(r.location, at).toString();
      if (!at.startsWith('http://')) return { ...r, at };
      r = await go(at);
    }
    return { ...r, at };
  }
  return { go, follow, jar };
}
