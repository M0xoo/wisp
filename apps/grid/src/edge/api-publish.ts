// Publishing an app from My Stuff (sites.ts), sharing a task (shares.ts) and sandboxes
// (sandboxes.ts): from wisp on a computer (its device token) or the cloud wisp itself (its Box
// secret); never from a sandbox, which has neither (trust.ts: grid:publish).

import { readBody, str, type Req, type Res } from '../http.ts';
import type { UserRow as User } from '../rows.ts';
import { readRaw } from '../sites.ts';
import { SIGN_IN_AGAIN, type Ctx } from './context.ts';
import { caller } from './caller.ts';
import { removeSandbox, type Send } from './lifecycle.ts';
import { msg, statusOr } from './util.ts';

const SITE = /^\/api\/sites(?:\/([A-Za-z0-9_-]{1,64}))?$/;
const SHARE = /^\/api\/shares(?:\/(mine)(?:\/([A-Za-z0-9_-]{1,64}))?|\/([A-Za-z0-9_-]{16})(\/pack)?)$/;
const SANDBOX = /^\/api\/sandboxes(?:\/(logins)\/([a-z]{1,20})|\/([a-f0-9]{8})|\/env(?:\/([A-Za-z_][A-Za-z0-9_]{0,63}))?)?$/;

const passkeyOf = (req: Req): string | undefined => {
  const v = req.headers['x-wisp-passkey'];
  return v === undefined ? undefined : decodeURIComponent(String(v));
};

export async function publishApi(x: Ctx, req: Req, res: Res, url: URL, send: Send, cors: Record<string, string>): Promise<boolean> {
  const p = url.pathname;
  const site = SITE.exec(p);
  const sh = site ? null : SHARE.exec(p);
  const sbx = site || sh ? null : SANDBOX.exec(p);
  if (!site && !sh && !sbx) return false;
  const who = caller(x, req, 'grid:publish');
  if (!who) return send(401, { error: SIGN_IN_AGAIN }), true;
  if (site) await sites(x, req, url, who.user, site[1], send);
  else if (sh) await shares(x, req, res, who.user, sh, send, cors);
  else if (sbx) await sandboxes(x, req, p, who.user, sbx, send);
  return true;
}

async function sites(x: Ctx, req: Req, url: URL, who: User, key: string | undefined, send: Send): Promise<void> {
  if (req.method === 'GET' && !key) return send(200, { enabled: x.sites.opts.enabled, maxBytes: x.sites.opts.maxBytes, sites: x.sites.list(who.id).map(x.sites.view) });
  if (req.method === 'PUT' && key) {
    x.limit(`site|${who.id}`, 30);
    if (!x.sites.opts.enabled) return send(403, { error: 'This grid doesn’t publish apps.' });
    const buf = await readRaw(req, x.sites.opts.maxBytes);
    const out = await x.sites.publish(who, key, buf, { title: url.searchParams.get('title'), entry: url.searchParams.get('entry') });
    x.notify(who.id);
    return send(200, out);
  }
  if (req.method === 'DELETE' && key) {
    const ok = await x.sites.remove(who.id, key);
    x.notify(who.id);
    return send(200, { ok });
  }
  return send(404, { error: 'not found' });
}

// Shared tasks. PUT/DELETE /api/shares/mine/<task key> from the sharer's wisp, GET /api/shares/<id>
// (the card) and /api/shares/<id>/pack (everything) from whoever imports it, passkey in x-wisp-passkey.
async function shares(x: Ctx, req: Req, res: Res, who: User, sh: RegExpExecArray, send: Send, cors: Record<string, string>): Promise<void> {
  try {
    if (sh[1]) return await mine(x, req, who, sh[2], send);
    if (req.method !== 'GET') return send(404, { error: 'not found' });
    const row = x.shares.get(sh[3] ?? '');
    if (!row) return send(404, { error: 'This task isn’t shared any more, or its link has a typo.' });
    const pass = passkeyOf(req) ?? '';
    if (!(await x.shares.unlocks(row, pass))) {
      if (pass) x.limit(`sharepk|${row.id}|${who.id}`, 10);
      const c = x.shareCard(row);
      return send(pass ? 403 : 401, { error: pass ? 'That passkey isn’t right.' : 'This task is locked with a passkey.', locked: true, from: c.from, id: c.id, url: c.url });
    }
    if (!sh[4]) return send(200, { ...x.shareCard(row), mine: row.user_id === who.id });
    x.limit(`sharepack|${who.id}`, 30);
    const buf = await x.shares.pack(row);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length, 'cache-control': 'no-store', ...cors });
    res.end(buf);
  } catch (err) {
    send(statusOr(err, 400), { error: msg(err) });
  }
}

async function mine(x: Ctx, req: Req, who: User, key: string | undefined, send: Send): Promise<void> {
  if (req.method === 'GET' && !key) return send(200, { enabled: x.shares.opts.enabled, maxBytes: x.shares.opts.maxBytes, shares: x.shares.list(who.id).map(x.shares.view) });
  if (req.method === 'PUT' && key) {
    x.limit(`share|${who.id}`, 30);
    const buf = await readRaw(req, x.shares.opts.maxBytes);
    const out = await x.shares.share(who, key, buf, { passkey: passkeyOf(req) });
    x.notify(who.id);
    return send(200, out);
  }
  if (req.method === 'DELETE' && key) {
    const ok = await x.shares.remove(who.id, key);
    x.notify(who.id);
    return send(200, { ok });
  }
  return send(404, { error: 'not found' });
}

async function sandboxes(x: Ctx, req: Req, p: string, who: User, m: RegExpExecArray, send: Send): Promise<void> {
  const [, logins, agent, id, envKey] = m;
  try {
    // Env vars every sandbox of theirs starts with (names back, never values).
    if (/^\/api\/sandboxes\/env(\/|$)/.test(p)) return await sandboxEnv(x, req, who, envKey, send);
    if (req.method === 'GET' && !logins && !id) return send(200, { enabled: x.sandboxes.opts.enabled, logins: x.sandboxes.logins(who.id), env: x.sandboxes.envKeys(who.id), sandboxes: x.sandboxes.list(who.id).map(x.sandboxes.view) });
    if (req.method === 'POST' && !logins && !id) {
      x.limit(`sandbox|${who.id}`, 30);
      const body = await readBody(req);
      const { row } = x.sandboxes.create(who, body['name'], { taken: (label: string) => !!(x.accounts.computerByLabel(label) || x.accounts.byHandle(label)) });
      x.notify(who.id);
      x.log(`grid: ${who.handle} made sandbox ${row.id}`);
      return send(201, { ...x.sandboxes.view(row), token: x.sandboxes.bearer(row) });
    }
    if (logins && agent && req.method === 'PUT') {
      x.limit(`sandboxlogin|${who.id}`, 30);
      x.sandboxes.setLogin(who.id, agent, (await readBody(req))['token']);
      x.accounts.audit(who.id, 'sandbox.login', { agent });
      return send(200, { logins: x.sandboxes.logins(who.id) });
    }
    if (logins && agent && req.method === 'DELETE') {
      x.sandboxes.dropLogin(who.id, agent);
      x.accounts.audit(who.id, 'sandbox.logout', { agent });
      return send(200, { logins: x.sandboxes.logins(who.id) });
    }
    if (id && req.method === 'DELETE') {
      const row = x.sandboxes.get(id);
      if (!row || row.user_id !== who.id) return send(200, { ok: true, gone: true }); // already gone
      await removeSandbox(x, row, who);
      x.notify(who.id);
      return send(200, { ok: true });
    }
  } catch (err) {
    return send(statusOr(err, 400), { error: msg(err) });
  }
  return send(404, { error: 'not found' });
}

async function sandboxEnv(x: Ctx, req: Req, who: User, key: string | undefined, send: Send): Promise<void> {
  if (req.method === 'PUT' && !key) {
    x.limit(`sandboxenv|${who.id}`, 60);
    const body = await readBody(req);
    x.sandboxes.setEnv(who.id, body['key'], body['value']);
    x.accounts.audit(who.id, 'sandbox.env', { key: str(body['key']).slice(0, 64) });
    return send(200, { env: x.sandboxes.envKeys(who.id) });
  }
  if (req.method === 'DELETE' && key) {
    x.sandboxes.dropEnv(who.id, key);
    return send(200, { env: x.sandboxes.envKeys(who.id) });
  }
  return send(404, { error: 'not found' });
}
