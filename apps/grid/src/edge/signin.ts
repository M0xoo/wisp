// Sign in with a provider (Google, GitHub, any OIDC, or dev): out to it with state + PKCE (+ nonce)
// in a signed cookie, back with a code. Linking another provider to the signed-in user is the same
// round trip with `link`. The session cookie only ever lands on the grid's own address.

import type { Identity } from '../accounts.ts';
import { newFlow } from '../auth/providers.ts';
import { bad } from '../errors.ts';
import { clientIp, cookies, readBody, redirect, safePath, str } from '../http.ts';
import { devSignInPage, messagePage, signInPage } from '../pages/index.ts';
import type { Root } from './root.ts';
import { flag, msg, statusOr } from './util.ts';

const FLOW_MS = 600_000;
const TIMED_OUT = 'This sign-in timed out or was started elsewhere. Start again.';

/** What the oauth cookie carries between start and callback (signed). */
interface Flow {
  p: string;
  s: string;
  v: string;
  n: string;
  r: string;
  l: string | null;
  t: number;
  a: string | null;
}

export async function auth(r: Root): Promise<boolean> {
  const p = r.url.pathname;
  const start = /^\/auth\/([^/]+)\/start$/.exec(p);
  if (start?.[1] && r.req.method === 'GET') return startFlow(r, decodeURIComponent(start[1])), true;
  const back = /^\/auth\/([^/]+)\/callback$/.exec(p);
  if (back?.[1]) return callback(r, decodeURIComponent(back[1])), true;
  return false;
}

const callbackUri = (r: Root, id: string): string => `${r.x.cfg.publicUrl}/auth/${encodeURIComponent(id)}/callback`;

async function startFlow(r: Root, id: string): Promise<void> {
  const { x, req, url, s } = r;
  x.limit(`auth|${clientIp(req)}`, 60);
  const prov = x.providers.get(id);
  if (!prov) return r.page(messagePage({ cfg: x.cfg, title: 'Not available', text: 'That way of signing in isn’t set up on this grid.', link: ['/signin', 'Back'] }), 404);
  const link = url.searchParams.get('link') === '1';
  if (link && !s) return r.signInFirst('/');
  const ret = safePath(url.searchParams.get('return'), '/');
  if (prov.kind === 'dev') return r.page(devSignInPage({ cfg: x.cfg, ret, csrf: x.secrets.sign('dev-signin') }));
  const f = newFlow();
  const visitor = x.stats.visitorId(cookies(req));
  const st: Flow = { p: prov.id, s: f.state, v: f.verifier, n: f.nonce, r: ret, l: link && s ? s.user.id : null, t: Date.now(), a: visitor };
  const raw = Buffer.from(JSON.stringify(st)).toString('base64url');
  const to = await prov.start({ redirectUri: callbackUri(r, prov.id), state: f.state, verifier: f.verifier, nonce: f.nonce });
  if (!link) x.stats.funnel('grid_auth_started', visitor, { provider: prov.id });
  redirect(r.res, to, { 'set-cookie': x.setCookie(x.names.oauth, `${raw}.${x.secrets.sign(raw)}`, 600) });
}

function readFlow(r: Root, id: string): Flow {
  const [raw, sig] = String(cookies(r.req)[r.x.names.oauth] || '').split('.');
  if (!raw || !r.x.secrets.verify(raw, sig || '')) throw bad(TIMED_OUT);
  const st = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Flow;
  if (st.p !== id || st.s !== r.url.searchParams.get('state') || Date.now() - st.t > FLOW_MS) throw bad(TIMED_OUT);
  return st;
}

async function devIdentity(r: Root): Promise<{ identity: Identity; ret: string }> {
  if (r.req.method !== 'POST') throw bad('Use the form.');
  const body = await readBody(r.req);
  if (!r.x.secrets.verify('dev-signin', str(body['csrf']))) throw bad('The page was out of date. Try again.', 403);
  const email = str(body['email']).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw bad('An email address, please.');
  const local = email.split('@')[0] ?? email;
  return { identity: { provider: 'dev', subject: email, email, emailVerified: true, name: str(body['name']).trim() || local, login: local }, ret: safePath(body['return']) };
}

async function callback(r: Root, id: string): Promise<void> {
  const { x, req, url, s } = r;
  const prov = x.providers.get(id);
  if (!prov) return r.page(messagePage({ cfg: x.cfg, title: 'Not available', text: 'That way of signing in isn’t set up on this grid.' }), 404);
  let linkTo: string | null = null;
  let visitor: string | null = null;
  const clear = x.setCookie(x.names.oauth, '', 0);
  try {
    let identity: Identity;
    let ret = '/';
    if (prov.kind === 'dev') ({ identity, ret } = await devIdentity(r));
    else {
      const st = readFlow(r, id);
      const error = url.searchParams.get('error');
      if (error) throw bad(url.searchParams.get('error_description') || `${prov.label} said: ${error}`);
      identity = await prov.finish({ code: url.searchParams.get('code'), redirectUri: callbackUri(r, id), verifier: st.v, nonce: st.n });
      ret = safePath(st.r);
      linkTo = st.l;
      visitor = st.a || null;
    }
    if (linkTo && s?.user.id !== linkTo) throw bad('You were signed out while connecting it. Sign in and try again.');
    const t0 = Date.now();
    const user = x.accounts.signIn(identity, { linkTo });
    if (!linkTo) x.stats.funnel('grid_auth_finished', visitor, { provider: id, signup: user.created_at >= t0 });
    const set = [clear];
    if (!linkTo) {
      if (s) x.accounts.endSession(cookies(req)[x.names.grid]);
      set.push(x.setCookie(x.names.grid, x.accounts.createSession(user.id, 'grid', req.headers['user-agent']), x.cfg.sessionDays * 86400));
    }
    redirect(r.res, linkTo ? `/account?m=${encodeURIComponent(`${prov.label} connected.`)}` : ret, { 'set-cookie': set });
  } catch (err) {
    x.log(`grid: sign-in with ${id} failed: ${msg(err)}`);
    const status = statusOr(err, 0);
    if (!linkTo) x.stats.funnel('grid_auth_failed', visitor, { provider: id, reason: flag(err, 'full') ? 'full' : status === 403 ? 'refused' : 'error' });
    const page = signInPage({ cfg: x.cfg, providers: x.providers, seats: x.accounts.seats(), error: flag(err, 'full') ? '' : msg(err), waitlisted: flag(err, 'waitlisted'), linking: !!linkTo, analytics: x.stats.pages, ua: String(req.headers['user-agent'] || '') });
    r.page(page, status && status < 500 ? status : 400, { 'set-cookie': clear });
  }
}
