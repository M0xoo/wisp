// The edge: a user's own wisp at <handle>, or a sandbox at sb-<id>--<handle>. A box hostd runs:
// signed in, woken, then proxied in trusted-proxy mode.

import type { ApiKeyRow, BoxUser, SandboxRow, UserRow } from '../rows.ts';
import { clientIp, cookies, html, json, redirect, safePath, wantsHtml, type Req, type Res } from '../http.ts';
import { messagePage, wakingPage } from '../pages/index.ts';
import { isShare, SHARE_LANDING, shareNoWorker } from '../shared/share-landing.ts';
import { may, type Credential, type Reach } from '../trust.ts';
import { IN_PREFIX, isUnder } from '../hosts.ts';
import type { Ctx } from './context.ts';
import { channelIn } from './hooks-in.ts';
import { manageKeys } from './lifecycle.ts';
import { previewLink } from './preview.ts';
import { proxy } from './proxy.ts';
import { statusOr, msg } from './util.ts';

const QUICK_MS = 1500;
const HOOK = /^\/api\/hooks\/[\w-]{20,64}$/;

export interface Who {
  via: Credential;
  user: UserRow;
  key?: ApiKeyRow;
}

interface BoxTarget {
  user: UserRow;
  box: BoxUser;
  row: SandboxRow | null;
  origin: string;
  back: string;
  secret: string;
}

export async function edge(x: Ctx, req: Req, res: Res, url: URL, handle: string): Promise<void> {
  if (isUnder(url.pathname, IN_PREFIX)) return channelIn(x, req, res, url, handle);
  const user = x.accounts.byHandle(handle);
  if (!user) return html(res, 404, messagePage({ cfg: x.cfg, title: 'No such wisp', text: `Nobody here is called ${handle}.`, link: [x.cfg.publicUrl, 'Home'] }));
  return boxEdge(x, req, res, url, { user, box: user, row: null, origin: x.cfg.instanceUrl(user.handle), back: `${x.cfg.publicUrl}/go`, secret: x.secrets.ensure(user.id, 'wisp-proxy') });
}

export async function sandboxEdge(x: Ctx, req: Req, res: Res, url: URL, row: SandboxRow): Promise<void> {
  const user = x.accounts.userById(row.user_id);
  if (!user || user.disabled) return html(res, 404, messagePage({ cfg: x.cfg, title: 'No such sandbox', text: 'Nothing answers at this address.', link: [x.cfg.publicUrl, 'Home'] }));
  return boxEdge(x, req, res, url, { user, box: x.sandboxes.box(row, user), row, origin: x.cfg.instanceUrl(row.label), back: `${x.cfg.publicUrl}/go?sandbox=${row.id}`, secret: x.sandboxes.proxySecret(row) });
}

// Who is asking, at the address of `box` (reach 'box' or 'sandbox'). A sandbox also opens with its
// own token, and never with a cookie from the user's own address (cookies are per address anyway).
// An API key opens only the user's own wisp (trust.ts). Another user's device or key is refused
// outright, even beside a good cookie for this one.
export function edgeAuth(x: Ctx, req: Req, user: UserRow, box: BoxUser, row: SandboxRow | null, reach: Reach): Who | null {
  const auth = req.headers.authorization;
  if (row && may('sandbox', reach).ok && x.sandboxes.byBearer(auth)?.id === row.id) return { via: 'sandbox', user };
  const d = x.accounts.device(auth);
  if (d) return d.user.id === user.id && may('device', reach).ok ? { via: 'device', user: d.user } : null;
  const k = may('key', reach).ok ? x.accounts.apiKey(auth) : null;
  if (k) return k.user.id === user.id ? { via: 'key', user: k.user, key: k.key } : null;
  const s = may('cookie', reach).ok ? x.accounts.session(cookies(req)[x.names.wisp], `i:${box.id}`) : null;
  return s ? { via: 'cookie', user: s.user } : null;
}

/** /_grid/auth and /_grid/signout at a box's or computer's address: the cookie for that address. */
export function addressAuth(x: Ctx, req: Req, res: Res, url: URL, user: UserRow, scope: string, back: string): boolean {
  if (url.pathname === '/_grid/auth') {
    const u = x.accounts.useTicket(url.searchParams.get('t'));
    if (!u || u.id !== user.id) return redirect(res, back), true;
    const t = x.accounts.createSession(user.id, scope, req.headers['user-agent']);
    redirect(res, safePath(url.searchParams.get('r')), { 'set-cookie': x.setCookie(x.names.wisp, t, x.cfg.sessionDays * 86400) });
    return true;
  }
  if (url.pathname === '/_grid/signout') {
    x.accounts.endSession(cookies(req)[x.names.wisp]);
    redirect(res, x.cfg.publicUrl, { 'set-cookie': x.setCookie(x.names.wisp, '', 0) });
    return true;
  }
  return false;
}

/** Not signed in: a browser's page goes to sign in and comes back; anything else is a 401. */
export function signInAgain(req: Req, res: Res, url: URL, back: string): void {
  // A share with no worker (share-landing.ts) is a browser's page too: signed in, the same answer.
  if (wantsHtml(req) || isShare(req)) return redirect(res, `${back}${back.includes('?') ? '&' : '?'}path=${encodeURIComponent(isShare(req) ? SHARE_LANDING : url.pathname + url.search)}`);
  json(res, 401, { error: 'Sign in again.' });
}

const tooMany = (res: Res, err: unknown): void => json(res, statusOr(err, 429), { error: msg(err) });

async function boxEdge(x: Ctx, req: Req, res: Res, url: URL, t: BoxTarget): Promise<void> {
  if (addressAuth(x, req, res, url, t.user, `i:${t.box.id}`, t.back)) return;
  const reach: Reach = t.row ? 'sandbox' : 'box';
  // A trigger's secret URL (wisp's POST /api/hooks/<token>): Slack, Linear or anything else calls it
  // without signing in. It goes through (waking the wisp), and wisp checks the token and the
  // signature itself; at most 120 a minute from one address.
  const hook = req.method === 'POST' && HOOK.test(url.pathname) && may('hook', reach).ok;
  if (hook) {
    try {
      x.limit(`hook|${clientIp(req)}`, 120);
    } catch (err) {
      return tooMany(res, err);
    }
  }
  const who: Who | null = hook ? { via: 'hook', user: t.user } : edgeAuth(x, req, t.user, t.box, t.row, reach);
  if (!who) return signInAgain(req, res, url, t.back);
  if (who.via === 'key' && who.key) {
    try {
      x.limit(`apikeyuse|${who.key.id}`, 600);
    } catch (err) {
      return tooMany(res, err);
    }
  }
  if (isShare(req)) return shareNoWorker(req, res); // never wakes the box, and may carry no Origin
  // A page elsewhere can't post to someone's wisp with their cookie.
  if (req.method !== 'GET' && req.method !== 'HEAD' && who.via === 'cookie' && req.headers.origin !== t.origin) return json(res, 403, { error: 'forbidden origin' });
  if (await gridPaths(x, req, res, url, t, who)) return;
  await wake(x, req, res, t, who.via);
}

// The edge's own paths at a box's address, answered by the grid while the box sleeps.
async function gridPaths(x: Ctx, req: Req, res: Res, url: URL, t: BoxTarget, who: Who): Promise<boolean> {
  const p = url.pathname;
  // API keys, from the person's browser only: its cookie stays here, and the box never hears of
  // it. Answered by the grid, so it works while the box sleeps, and never wakes it.
  const kp = /^\/_grid\/keys(?:\/(.*))?$/.exec(p);
  if (kp) {
    const send = (status: number, body: unknown): void => json(res, status, body);
    if (t.row) return send(404, { error: 'not found' }), true;
    if (!may(who.via, 'edge:keys').ok) return send(403, { error: 'API keys are made from Settings, in a browser.' }), true;
    if (kp[1] !== undefined && !/^[a-f0-9]{1,32}$/.test(kp[1])) return send(404, { error: 'No such key.' }), true;
    await manageKeys(x, req, t.user, kp[1], send);
    return true;
  }
  if (p === '/_grid/preview' && req.method === 'POST') return previewLink(x, res, url, t.user, t.box.handle, x.previews), true;
  if (p === '/_grid/state') {
    const i = x.hostd.inst.get(t.box.id);
    return json(res, 200, { state: x.hostd.state(t.box.id), error: i?.error || '' }), true;
  }
  if (p === '/_grid/stop' && req.method === 'POST') {
    await x.hostd.stop(t.box.id, 'put to sleep');
    return json(res, 200, { ok: true, state: x.hostd.state(t.box.id) }), true;
  }
  return false;
}

async function wake(x: Ctx, req: Req, res: Res, t: BoxTarget, via: Credential): Promise<void> {
  x.hostd.touch(t.box.id);
  if (x.hostd.state(t.box.id) !== 'running') {
    const ready = x.hostd.ensure(t.box);
    ready.catch(() => {});
    if (wantsHtml(req)) {
      // Quick starts go straight through; slower ones get the waking page, which reloads.
      let timer: NodeJS.Timeout | undefined;
      const quick = await Promise.race([ready.then(() => true, () => false), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), QUICK_MS)))]);
      clearTimeout(timer);
      if (!quick) return html(res, 200, wakingPage({ cfg: x.cfg, user: t.user }));
    } else {
      try {
        await ready;
      } catch (err) {
        return json(res, statusOr(err, 503), { error: msg(err), waking: true }, { 'retry-after': '2' });
      }
    }
  }
  const port = x.hostd.port(t.box.id);
  if (!port) return json(res, 503, { error: 'It’s still waking up.', waking: true }, { 'retry-after': '2' });
  proxy(x, req, res, port, t.box, t.secret, via);
}
