// A page in the user's box, or on a computer they added, at p<port>--<label>: its own cookie
// (scope p:<label>), then on to it: through the box's wisp (x-wisp-preview: the port) or the
// computer's tunnel. Only cookies sign in here: a frame can't send a device's token, and the page
// there never sees one (trust.ts: preview).

import http from 'node:http';
import net from 'node:net';
import type { PreviewKind } from '../hosts.ts';
import { clientIp, cookies, html, json, redirect, safePath, wantsHtml, type Req, type Res } from '../http.ts';
import { messagePage } from '../pages/index.ts';
import type { UserRow } from '../rows.ts';
import { hostOnly } from '../tunnels.ts';
import { fromOutside } from '../trust.ts';
import type { Ctx } from './context.ts';
import { answerHeaders } from './proxy.ts';
import { msg } from './util.ts';

// A one-time link into p<port>--<label> (an app launched from My Stuff), asked by wisp's own page.
// The phone app's page is signed in to that wisp only, not to the grid, so /go would stop at the
// grid's sign-in inside the frame.
export function previewLink(x: Ctx, res: Res, url: URL, user: UserRow, label: string, allowed: boolean): void {
  const raw = url.searchParams.get('port') || '';
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : 0;
  if (!allowed || port < 1 || port > 65535) return json(res, 400, { error: 'No preview for that port here.' });
  json(res, 200, { url: `${x.previewUrl(label, port)}/_grid/auth?t=${x.accounts.ticket(user.id, `preview:${label}`)}&r=${encodeURIComponent(safePath(url.searchParams.get('path')))}` });
}

// The user whose page this is, if the request carries their preview cookie for this label.
function previewAuth(x: Ctx, req: Req, h: PreviewKind): { user: UserRow | null; ok: boolean } {
  const user = 'computer' in h ? x.accounts.userById(h.computer.user_id) : 'sandbox' in h ? x.accounts.userById(h.sandbox.user_id) : x.accounts.byHandle(h.handle);
  if (!user || user.disabled) return { user: null, ok: false };
  const s = x.accounts.session(cookies(req)[x.names.wisp], `p:${h.label}`); // this box or computer only
  return { user, ok: s?.user.id === user.id };
}

// What it gets: the page's own cookies and headers without the grid's sign-in, and the port. Every
// x-wisp-* header from outside is dropped here, as v1 did (a page's own may not claim the grid's).
// A box's wisp also gets the proxy secret; a computer is reached through its own tunnel.
function previewHeaders(x: Ctx, req: Req, user: UserRow, h: PreviewKind): Record<string, string | string[]> {
  const headers = fromOutside(req.headers, { authorization: true });
  for (const k of Object.keys(headers)) if (k.startsWith('x-wisp-')) delete headers[k];
  const rest = String(req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(`${x.names.wisp}=`));
  if (rest.length) headers['cookie'] = rest.join('; ');
  if (!('computer' in h)) headers['x-wisp-proxy-secret'] = 'sandbox' in h ? x.sandboxes.proxySecret(h.sandbox) : x.secrets.ensure(user.id, 'wisp-proxy');
  return { ...headers, 'x-wisp-preview': String(h.port), 'x-forwarded-host': String(req.headers.host ?? ''), 'x-forwarded-proto': x.cfg.scheme, 'x-forwarded-for': clientIp(req) };
}

const boxIdOf = (x: Ctx, h: PreviewKind, user: UserRow): string => ('sandbox' in h ? x.sandboxes.box(h.sandbox, user).id : user.id);

export async function previewEdge(x: Ctx, req: Req, res: Res, url: URL, h: PreviewKind): Promise<void> {
  const origin = x.previewUrl(h.label, h.port);
  const p = url.pathname;
  const { user, ok } = previewAuth(x, req, h);
  if (!user) return html(res, 404, messagePage({ cfg: x.cfg, title: 'No such page', text: 'Nothing answers at this address.', link: [x.cfg.publicUrl, 'Home'] }));
  const back = `${x.cfg.publicUrl}/go?preview=${h.port}${'computer' in h ? `&computer=${h.computer.id}` : 'sandbox' in h ? `&sandbox=${h.sandbox.id}` : ''}`;
  if (p === '/_grid/auth') {
    const u = x.accounts.useTicket(url.searchParams.get('t'), { preview: h.label });
    if (!u || u.id !== user.id) return redirect(res, back);
    const t = x.accounts.createSession(user.id, `p:${h.label}`, req.headers['user-agent']);
    return redirect(res, safePath(url.searchParams.get('r')), { 'set-cookie': x.previewCookie(x.names.wisp, t, x.cfg.sessionDays * 86400) });
  }
  if (!ok) {
    if (wantsHtml(req)) return redirect(res, `${back}&path=${encodeURIComponent(p + url.search)}`);
    return json(res, 401, { error: 'Sign in again.' });
  }
  // A page elsewhere can't post to it with the cookie.
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: 'forbidden origin' });
  if ('computer' in h) {
    if (x.tunnels.forward(h.computer.id, req, res, previewHeaders(x, req, user, h), { cookies: true })) return;
    return html(res, 503, messagePage({ cfg: x.cfg, title: `${h.computer.name} is offline`, text: `Port ${h.port} is on ${h.computer.name}, which isn’t connected to the grid right now. It comes back when that computer is on and wisp runs there.`, link: [x.cfg.publicUrl, 'Your account'] }), { 'retry-after': '10' });
  }
  // Its server runs in the box: asleep, there's nothing to show (waking it wouldn't start it).
  const boxId = boxIdOf(x, h, user);
  const port = x.hostd.port(boxId);
  if (!port) return html(res, 503, messagePage({ cfg: x.cfg, title: 'Your wisp is asleep', text: `Port ${h.port} lives in your wisp, which is asleep, so whatever ran there has stopped. Open your wisp and ask the agent to start it again.`, link: [x.cfg.instanceUrl(user.handle), 'Open your wisp'] }), { 'retry-after': '10' });
  x.hostd.touch(boxId);
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: previewHeaders(x, req, user, h) }, (r) => {
    const out = answerHeaders(r.headers);
    if (out['set-cookie']) out['set-cookie'] = hostOnly(out['set-cookie']);
    res.writeHead(r.statusCode ?? 502, out);
    r.pipe(res);
  });
  up.on('error', (err) => {
    if (!res.headersSent) json(res, 502, { error: `Its wisp didn’t answer: ${msg(err)}` });
    else res.destroy();
  });
  res.on('close', () => up.destroy());
  req.pipe(up);
}

export type Refuse = (status: number, error: string) => void;

// A websocket to the page (a dev server's live reload): the same checks, then the socket goes
// through to the box's wisp as it is, or over the computer's tunnel.
export function previewSocket(x: Ctx, req: Req, socket: net.Socket, head: Buffer, h: PreviewKind, refuse: Refuse): void {
  const { user, ok } = previewAuth(x, req, h);
  if (!user || !ok) return refuse(401, 'Sign in again.');
  if (req.headers.origin && req.headers.origin !== x.previewUrl(h.label, h.port)) return refuse(403, 'forbidden origin');
  if ('computer' in h) {
    if (!x.tunnels.upgrade(h.computer.id, req, socket, head, previewHeaders(x, req, user, h))) refuse(503, `${h.computer.name} is offline.`);
    return;
  }
  const boxId = boxIdOf(x, h, user);
  const port = x.hostd.port(boxId);
  if (!port) return refuse(503, 'Your wisp is asleep.');
  x.hostd.touch(boxId);
  const headers: Record<string, string | string[]> = { ...previewHeaders(x, req, user, h), connection: 'Upgrade', upgrade: String(req.headers.upgrade ?? '') };
  const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((one) => `${k}: ${one}`))];
  const up = net.connect(port, '127.0.0.1', () => {
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('close', () => up.destroy());
}
