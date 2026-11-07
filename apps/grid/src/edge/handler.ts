// The one request handler for every address on the grid's port, and the one upgrade handler (a
// computer opening its tunnel, a preview's websocket). hosts.ts says which part a Host is for; the
// handlers in this folder answer. Errors become a page for a browser and JSON for anything else.

import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import { ASSET_PATH, hostKind, rootHosts, tlsAllowed, type HostKind, type HostLookups } from '../hosts.ts';
import { clientIp, html, json, LOOPBACK, wantsHtml, type Req, type Res } from '../http.ts';
import { MAIL_PATH } from '../mail.ts';
import { messagePage } from '../pages/index.ts';
import { TUNNEL_PROTOCOL } from '../tunnels.ts';
import { may } from '../trust.ts';
import { edge, sandboxEdge } from './box.ts';
import { computerEdge } from './computer.ts';
import type { Ctx } from './context.ts';
import { mailIn } from './hooks-in.ts';
import { previewEdge, previewSocket, type Refuse } from './preview.ts';
import { root } from './root.ts';
import { msg, statusOr } from './util.ts';

const ASSETS = new URL('../../assets/', import.meta.url);
const TYPES: Record<string, string> = { webp: 'image/webp', svg: 'image/svg+xml', png: 'image/png' };

export function lookups(x: Ctx): HostLookups & { handle(label: string): boolean } {
  return {
    domain: x.cfg.domain,
    rootHosts: rootHosts(x.cfg),
    previews: x.previews,
    site: (l) => x.sites.byLabel(l),
    sandbox: (l) => x.sandboxes.byLabel(l),
    computer: (l) => x.accounts.computerByLabel(l),
    handle: (l) => !!x.accounts.byHandle(l),
  };
}

// The grid's own images (screenshots, logos), on every address it answers.
function asset(res: Res, name: string, ext: string): void {
  const file = new URL(`${name}.${ext}`, ASSETS);
  const s = fs.createReadStream(file);
  s.once('open', () => {
    res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
    s.pipe(res);
  });
  s.once('error', () => json(res, 404, { error: 'not found' }));
}

const ROBOTS_ROOT = 'User-agent: *\nDisallow: /api/\nDisallow: /auth/\nDisallow: /activate\nDisallow: /go\n';

// What every address answers the same way: Caddy's TLS check, assets, robots.txt. True if answered.
function common(x: Ctx, req: Req, res: Res, url: URL, h: () => HostKind): boolean {
  // Caddy's on-demand TLS asks before getting a certificate for a name (deploy/Caddyfile): only the
  // grid itself and existing users. Loopback only: Caddy itself, not a request it passed on (that
  // would tell anyone which handles and computers exist).
  if (url.pathname === '/_grid/tls-ask' && LOOPBACK.test(clientIp(req))) {
    const ok = tlsAllowed(x.cfg.domain, String(url.searchParams.get('domain') || ''), lookups(x));
    return json(res, ok ? 200 : 404, { ok }), true;
  }
  const a = ASSET_PATH.exec(url.pathname);
  if (a?.[1] && a[2] && req.method === 'GET') return asset(res, a[1], a[2]), true;
  // People's wisps and computers are private: keep every answer from them, the sign-in redirects
  // included, out of search engines, and tell crawlers so up front.
  const kind = h().kind;
  if (kind !== 'root') res.setHeader('x-robots-tag', 'noindex, nofollow');
  if (url.pathname === '/robots.txt' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' });
    res.end(kind === 'root' ? ROBOTS_ROOT : 'User-agent: *\nDisallow: /\n');
    return true;
  }
  return false;
}

async function route(x: Ctx, req: Req, res: Res, url: URL, h: HostKind): Promise<void> {
  if (h.kind === 'root') {
    const mail = MAIL_PATH.exec(url.pathname);
    return mail?.[1] ? mailIn(x, req, res, mail[1]) : root(x, req, res, url);
  }
  if (h.kind === 'edge') return edge(x, req, res, url, h.handle);
  if (h.kind === 'computer') return computerEdge(x, req, res, url, h.computer);
  if (h.kind === 'sandbox') return sandboxEdge(x, req, res, url, h.sandbox);
  if (h.kind === 'preview') return previewEdge(x, req, res, url, h);
  if (h.kind === 'site') {
    if (!h.site) return html(res, 404, messagePage({ cfg: x.cfg, title: 'Nothing here', text: 'This app was unpublished, or its link has a typo.', link: [x.cfg.publicUrl, 'Home'] }));
    if (url.pathname === '/_wisp/db') x.limit(`sitedb|${clientIp(req)}`, 600);
    return x.sites.serve(req, res, h.site);
  }
  json(res, 421, { error: `This grid answers at ${x.cfg.domain}.` });
}

function failed(x: Ctx, req: Req, res: Res, url: URL, err: unknown): void {
  const s = statusOr(err, 500);
  const status = s < 600 ? s : 500;
  if (status >= 500) x.log(`grid: ${req.method} ${url.pathname}: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  if (res.headersSent) return void res.end();
  const text = status >= 500 ? 'Something went wrong on the grid.' : msg(err);
  if (wantsHtml(req) || /^application\/x-www-form-urlencoded/.test(String(req.headers['content-type'] || ''))) return html(res, status, messagePage({ cfg: x.cfg, title: status === 429 ? 'Slow down' : 'That didn’t work', text, link: ['/', 'Back'], tone: 'bad' }));
  json(res, status, { error: text });
}

export function handler(x: Ctx): (req: Req, res: Res) => Promise<void> {
  return async (req, res) => {
    const url = new URL(String(req.url), 'http://grid');
    try {
      let h: HostKind | null = null;
      const kind = (): HostKind => (h ??= hostKind(req.headers.host, lookups(x)));
      if (common(x, req, res, url, kind)) return;
      await route(x, req, res, url, kind());
    } catch (err) {
      failed(x, req, res, url, err);
    }
  };
}

// A computer opening its tunnel: GET /api/computers/:id/tunnel on the grid's own address, with the
// token of the device that added it (only that computer can be it; trust.ts: grid:tunnel).
export function upgrader(x: Ctx): (req: Req, socket: net.Socket, head: Buffer) => void {
  return (req, socket, head) => {
    const refuse: Refuse = (status, error) => {
      socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${JSON.stringify({ error })}`);
    };
    socket.on('error', () => {});
    try {
      const url = new URL(String(req.url), 'http://grid');
      const h = hostKind(req.headers.host, lookups(x));
      if (h.kind === 'preview') return previewSocket(x, req, socket, head, h, refuse);
      const m = /^\/api\/computers\/([a-f0-9]+)\/tunnel$/.exec(url.pathname);
      if (h.kind !== 'root' || !m || String(req.headers.upgrade || '').toLowerCase() !== TUNNEL_PROTOCOL) return refuse(404, 'not found');
      x.limit(`tunnel|${clientIp(req)}`, 60);
      const dev = x.accounts.device(req.headers.authorization);
      if (!dev || !may('device', 'grid:tunnel').ok) return refuse(401, 'Sign in again: this device isn’t known here.');
      const c = x.accounts.computer(m[1]);
      if (!c || c.device_id !== dev.device.id) return refuse(404, 'This computer was removed from the grid.');
      x.tunnels.accept(c.id, socket, head);
    } catch (err) {
      const status = statusOr(err, 0);
      refuse(status || 500, status ? msg(err) : 'Something went wrong on the grid.');
    }
  };
}
