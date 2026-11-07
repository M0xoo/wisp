// Small HTTP helpers every part of the grid answers with: cookies, bodies, the response shapes, the
// caller's address behind Caddy and the rate limiter.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { bad } from './errors.ts';

export type Req = IncomingMessage;
export type Res = ServerResponse;
export type Json = Record<string, unknown>;

export const BODY_LIMIT = 64 * 1024;

export function cookies(req: Req): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // a cookie someone else's page set, badly encoded: not ours to read
    }
  }
  return out;
}

export interface CookieOptions {
  secure: boolean;
  maxAge?: number;
  path?: string;
  framed?: boolean;
}

// framed: a preview's cookie, set inside a frame of another site (wisp on a computer shows a box's
// page in its own window): SameSite=None, which needs Secure (https, or *.localhost that browsers
// count as secure), and Partitioned, so it's kept for that one page and third-party cookie blocking
// leaves it alone. Previews check Origin on anything but GET.
export function cookie(name: string, value: string, { secure, maxAge, path = '/', framed = false }: CookieOptions): string {
  const same = framed ? ['SameSite=None', 'Secure', 'Partitioned'] : ['SameSite=Lax', secure && 'Secure'];
  return [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', ...same, maxAge !== undefined && `Max-Age=${maxAge}`].filter(Boolean).join('; ');
}

/** A form or JSON body, up to BODY_LIMIT. Fields are strings for a form, anything for JSON. */
export function readBody(req: Req, limit = BODY_LIMIT): Promise<Json> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(bad('Too much data.', 413));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const ct = String(req.headers['content-type'] || '');
      try {
        if (ct.startsWith('application/json')) {
          const v: unknown = text ? JSON.parse(text) : {};
          return resolve(typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {});
        }
        resolve(Object.fromEntries(new URLSearchParams(text)));
      } catch {
        reject(bad('Bad JSON.'));
      }
    });
    req.on('error', reject);
  });
}

/** A body field as a string ('' when absent or not a string-like value). */
export const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

export const SECURITY: Readonly<Record<string, string>> = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY' };

/** headers: null drops one of SECURITY's (a shared task's page may be framed). */
export type HeaderMap = Record<string, string | number | string[] | null>;

export function html(res: Res, status: number, body: string, headers: HeaderMap = {}): void {
  const all: HeaderMap = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SECURITY, ...headers };
  res.writeHead(status, Object.fromEntries(Object.entries(all).filter((e): e is [string, string | number | string[]] => e[1] !== null)));
  res.end(body);
}

export function json(res: Res, status: number, body: unknown, headers: Record<string, string | number | string[]> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

export function redirect(res: Res, to: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(302, { location: to, 'cache-control': 'no-store', ...headers });
  res.end();
}

// Only paths on the same site: never an absolute URL or //host. Browsers drop tabs and newlines
// from a Location before reading it, so "/\t/evil.example" would be //evil.example: no control
// characters at all.
export const safePath = (p: unknown, d = '/'): string => (typeof p === 'string' && /^\/(?![/\\])/.test(p) && !/[\x00-\x1f\x7f]/.test(p) ? p : d);

export const wantsHtml = (req: Req): boolean => req.method === 'GET' && /text\/html/.test(String(req.headers.accept || '')) && req.headers['sec-fetch-dest'] !== 'empty';

export const LOOPBACK = /^(::ffff:)?127\.0\.0\.1$|^::1$/;

// Behind Caddy (deploy/Caddyfile) every request comes from loopback: who's asking is the address
// Caddy put last in X-Forwarded-For. Without this, everyone shares one rate limit, and anyone can
// use up the tunnels' (or sign-ins') for all.
export function clientIp(req: Req): string {
  const at = req.socket.remoteAddress || '';
  if (!LOOPBACK.test(at)) return at;
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',').pop()?.trim();
  return fwd || at;
}

export type Limit = (key: string, n: number) => void;

// A sliding window per key: n requests in any minute. Refused ones aren't kept, so a key holds n at most.
export const LIMIT_WINDOW = 60_000;
export function limiter(now: () => number = Date.now): Limit & { close(): void } {
  const hits = new Map<string, number[]>();
  const sweep = setInterval(() => {
    for (const [key, at] of hits) if (now() - (at[at.length - 1] ?? 0) >= LIMIT_WINDOW) hits.delete(key);
  }, LIMIT_WINDOW);
  sweep.unref();
  const limit = (key: string, n: number): void => {
    const t = now();
    const at = (hits.get(key) || []).filter((x) => t - x < LIMIT_WINDOW);
    if (at.length >= n) throw bad('Too many requests. Wait a minute.', 429);
    at.push(t);
    hits.set(key, at);
  };
  return Object.assign(limit, { close: () => clearInterval(sweep) });
}
