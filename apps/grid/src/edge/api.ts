// The grid's API at <domain>/api/*. Other origins (the phone app) call it with a bearer token, so
// CORS is open and cookies are never involved. Public: seats and the waitlist. Then the device flow
// (RFC 8628), the Box secret's own routes (api-box.ts), publishing (api-publish.ts), API keys, and
// what a device does (api-device's part below).

import { readBody, safePath, json, clientIp, type Req, type Res } from '../http.ts';
import { may } from '../trust.ts';
import { boxApi } from './api-box.ts';
import { publishApi } from './api-publish.ts';
import { SIGN_IN_AGAIN, type Ctx } from './context.ts';
import { caller } from './caller.ts';
import { manageKeys, revokeDevice, type Send } from './lifecycle.ts';
import { msg, statusOr } from './util.ts';

const CORS: Record<string, string> = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, x-wisp-passkey', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-max-age': '600' };
const KEYS = /^\/api\/keys(?:\/([a-f0-9]{1,32}))?$/;

export async function api(x: Ctx, req: Req, res: Res, url: URL): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return void res.end();
  }
  const send: Send = (status, body) => json(res, status, body, CORS);
  if (await open(x, req, url, send)) return;
  if (await boxApi(x, req, url, send)) return;
  if (await publishApi(x, req, res, url, send, CORS)) return;
  // API keys, for scripts, from wisp on a computer: a device token only. Not the Box secret, which
  // anything on the box can read; a cloud wisp's person makes keys at its edge (/_grid/keys).
  const ak = KEYS.exec(url.pathname);
  if (ak) {
    const who = caller(x, req, 'grid:keys');
    if (!who) return send(401, { error: SIGN_IN_AGAIN });
    return manageKeys(x, req, who.user, ak[1], send);
  }
  return device(x, req, url, send);
}

// Public, and the device flow before a device has a token.
async function open(x: Ctx, req: Req, url: URL, send: Send): Promise<boolean> {
  const p = url.pathname;
  // Public: how many accounts are left, for the site that links here (trywisp.dev/cloud.html).
  if (req.method === 'GET' && p === '/api/seats') return send(200, x.accounts.seats()), true;
  // Public too: the site's "get the next seat" form, and "email me the link" from an in-app browser.
  if (req.method === 'POST' && p === '/api/waitlist') {
    try {
      x.limit(`wait|${clientIp(req)}`, 10);
      const body = await readBody(req);
      send(200, { ok: true, ...x.accounts.waitFor(body['email'], body['source'] === 'in-app' ? 'in-app' : 'site') });
    } catch (err) {
      send(statusOr(err, 400), { error: msg(err) }); // with CORS, so the site can read it
    }
    return true;
  }
  if (req.method === 'POST' && p === '/api/device/code') {
    x.limit(`code|${clientIp(req)}`, 20);
    const body = await readBody(req);
    const d = x.accounts.deviceCode(body['name']);
    send(200, { ...d, verification_uri: `${x.cfg.publicUrl}/activate`, verification_uri_complete: `${x.cfg.publicUrl}/activate?code=${d.user_code}`, interval: x.interval });
    return true;
  }
  if (req.method === 'POST' && p === '/api/device/token') {
    x.limit(`token|${clientIp(req)}`, 120);
    const body = await readBody(req);
    const r = x.accounts.pollCode(body['device_code'], x.interval);
    if (r.error !== undefined) return send(400, { error: r.error }), true;
    x.notify(r.user.id);
    send(200, { token: r.token, token_type: 'Bearer', user: x.userView(r.user), instance: x.instanceView(r.user) });
    return true;
  }
  return false;
}

// What a device does: who it is, a sign-in link, its computers, revoking itself, a routed report.
async function device(x: Ctx, req: Req, url: URL, send: Send): Promise<void> {
  const p = url.pathname;
  const dev = x.accounts.device(req.headers.authorization);
  if (!dev || !may('device', 'grid:device').ok) return send(401, { error: SIGN_IN_AGAIN });
  if (req.method === 'GET' && p === '/api/me') return send(200, { user: x.userView(dev.user), instance: x.instanceView(dev.user), device: { id: dev.device.id, name: dev.device.name } });
  // A one-time link that signs a browser (the phone app's page) in to the user's wisp, or to
  // one of their computers (computer: its id).
  if (req.method === 'POST' && p === '/api/device/link') {
    const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
    const to = body['computer'] ? x.cfg.instanceUrl(x.ownComputer(dev.user.id, body['computer']).label) : x.cfg.instanceUrl(dev.user.handle);
    return send(200, { url: `${to}/_grid/auth?t=${x.accounts.ticket(dev.user.id)}&r=${encodeURIComponent(safePath(body['path']))}` });
  }
  // Computers: wisp on a desktop adds itself (POST, named after the computer), every device
  // lists them (GET), and any of them can take one off (DELETE).
  if (req.method === 'GET' && p === '/api/computers') return send(200, { computers: x.accounts.computers(dev.user.id).map((c) => x.computerView(c, dev)) });
  if (req.method === 'POST' && p === '/api/computers') {
    const body = await readBody(req);
    const added = x.computerView(x.accounts.addComputer(dev, body['name']), dev);
    x.notify(dev.user.id);
    return send(200, added);
  }
  const del = req.method === 'DELETE' ? /^\/api\/computers\/([a-f0-9]+)$/.exec(p) : null;
  if (del) {
    const c = x.ownComputer(dev.user.id, del[1]);
    x.accounts.removeComputer(dev.user.id, c.id);
    x.tunnels.close(c.id);
    x.notify(dev.user.id);
    return send(200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/device/revoke') {
    revokeDevice(x, dev.user.id, dev.device.id);
    return send(200, { ok: true });
  }
  // A computer's report on a routed message (route.ts): past the device check on purpose, so a Box
  // secret, which anything on a box can read, never gets this far (trust.ts: grid:report).
  if (x.routes.on && req.method === 'POST' && p === '/api/channels/reply' && may('device', 'grid:report').ok) {
    await x.routes.reply(dev, await readBody(req));
    return send(200, { ok: true });
  }
  return send(404, { error: 'not found' });
}
