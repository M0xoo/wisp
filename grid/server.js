// wisp Grid's HTTP server: one process, two kinds of address.
//
//   <domain>            the grid itself: sign in (Google, GitHub, any OIDC), your account, approve a
//                       device, and the device API (/api/device/*) wisp on computers and phones use
//   <handle>.<domain>   the edge: that user's own wisp, started on demand by hostd and proxied
//                       (HTTP + SSE) in trusted-proxy mode. Signed in by a host-only cookie (set
//                       from a one-time ticket) or a device's bearer token.
//   <name>--<handle>.<domain>
//                       a computer the user added (wisp on their desktop), signed in the same way
//                       and sent through the tunnel that computer holds open (grid/tunnels.js).
//
// Cookies never span subdomains, so one user's wisp page can't read or set another's.

import fs from 'node:fs';
import http from 'node:http';
import { createAccounts, bad } from './accounts.js';
import { createProviders, newFlow } from './auth/providers.js';
import { openDb } from './db.js';
import { Hostd } from './hostd.js';
import { APP_URL, accountPage, activatePage, devSignInPage, messagePage, signInPage, wakingPage } from './pages.js';
import { createSecrets, ensureMaster } from './secrets.js';
import { createGridTelemetry } from './telemetry.js';
import { TUNNEL_PROTOCOL, createTunnels } from './tunnels.js';

const BODY_LIMIT = 64 * 1024;
const ASSETS = new URL('./assets/', import.meta.url);
const TYPES = { webp: 'image/webp', svg: 'image/svg+xml', png: 'image/png' };
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

// --- small HTTP helpers --------------------------------------------------------------------

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, { secure, maxAge, path = '/' }) {
  return [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax', secure && 'Secure', maxAge !== undefined && `Max-Age=${maxAge}`].filter(Boolean).join('; ');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(bad('Too much data.', 413));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const ct = String(req.headers['content-type'] || '');
      try {
        if (ct.startsWith('application/json')) return resolve(text ? JSON.parse(text) : {});
        resolve(Object.fromEntries(new URLSearchParams(text)));
      } catch {
        reject(bad('Bad JSON.'));
      }
    });
    req.on('error', reject);
  });
}

const SECURITY = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY' };
const html = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SECURITY, ...headers });
  res.end(body);
};
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};
const redirect = (res, to, headers = {}) => {
  res.writeHead(302, { location: to, 'cache-control': 'no-store', ...headers });
  res.end();
};
// Only paths on the same site: never an absolute URL or //host.
const safePath = (p, d = '/') => (typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !p.startsWith('/\\') ? p : d);
const wantsHtml = (req) => req.method === 'GET' && /text\/html/.test(String(req.headers.accept || '')) && req.headers['sec-fetch-dest'] !== 'empty';
const clientIp = (req) => req.socket.remoteAddress || '';

// A sliding window per key: n requests per minute.
function limiter() {
  const hits = new Map();
  setInterval(() => hits.clear(), 60_000).unref();
  return (key, n) => {
    const c = (hits.get(key) || 0) + 1;
    hits.set(key, c);
    if (c > n) throw bad('Too many requests. Wait a minute.', 429);
  };
}

// --- the grid ------------------------------------------------------------------------------

export async function startGrid(cfg, { log = (m) => console.log(m) } = {}) {
  const db = await openDb(cfg.dataDir);
  if (cfg.auth.dev) ensureMaster(cfg.dataDir);
  const secrets = createSecrets(db, { dataDir: cfg.dataDir });
  const providers = createProviders(cfg);
  const stats = createGridTelemetry(cfg);
  const accounts = createAccounts({ db, cfg, secrets, onAudit: stats.audit });
  const limit = limiter();
  const tunnels = createTunnels({
    log,
    onChange: (id, up) => {
      if (accounts.computer(id)) accounts.seenComputer(id);
      if (!up) return;
      const c = accounts.computer(id);
      if (c) log(`grid: computer ${c.label} connected`);
    },
  });
  const interval = cfg.auth.dev ? 2 : 5; // device-code polling, seconds

  const hostd = new Hostd({
    ...cfg.hostd,
    dataDir: cfg.dataDir,
    secretFor: (u) => secrets.ensure(u.id, 'wisp-proxy'),
    urlFor: (u) => cfg.instanceUrl(u.handle),
    exists: (u) => !!accounts.userById(u.id),
    gridUrl: cfg.publicUrl,
    telemetry: stats.on,
    log,
  });
  hostd.on('change', (e) => {
    stats.box(e);
    const t = Date.now();
    // A box can stop after its account is gone (deleted from the command line, maybe between
    // these two lines): nothing to record, and nothing to throw from a child's exit handler.
    if (accounts.userById(e.user.id)) {
      try {
        db.run(
          `INSERT INTO instances (user_id, state, created_at, started_at, stopped_at, last_active_at, next_wake_at, stop_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, started_at = coalesce(excluded.started_at, started_at), stopped_at = coalesce(excluded.stopped_at, stopped_at),
             last_active_at = coalesce(excluded.last_active_at, last_active_at), next_wake_at = excluded.next_wake_at, stop_reason = excluded.stop_reason`,
          e.user.id,
          e.state,
          t,
          e.startedAt,
          e.state === 'stopped' ? e.stoppedAt || t : null,
          e.lastActiveAt,
          e.nextWakeAt,
          e.state === 'stopped' ? e.event : null,
        );
      } catch (err) {
        log(`grid: ${e.user.handle} ${e.event}: ${err.message}`);
      }
    }
    if (e.event === 'started' || e.event === 'idle' || e.event === 'failed') log(`grid: ${e.user.handle} ${e.event}${e.error ? `: ${e.error}` : ''}`);
  });
  // After a restart: nothing runs, but scheduled tasks still wake their wisp.
  db.run("UPDATE instances SET state = 'stopped' WHERE state != 'stopped'");
  for (const row of db.all('SELECT u.id, u.handle, i.next_wake_at FROM instances i JOIN users u ON u.id = i.user_id WHERE i.next_wake_at IS NOT NULL')) hostd.restore({ id: row.id, handle: row.handle }, row.next_wake_at);

  const names = { grid: cfg.secure ? '__Host-grid' : 'grid', wisp: cfg.secure ? '__Host-wisp' : 'wisp_grid', oauth: cfg.secure ? '__Host-grid_oauth' : 'grid_oauth' };
  const setCookie = (name, value, maxAge) => cookie(name, value, { secure: cfg.secure, maxAge });
  const csrfFor = (s) => secrets.sign(`csrf|${s.hash}`);
  const userView = (u) => ({ id: u.id, handle: u.handle, name: u.name || '', email: u.email || '', avatar: u.avatar || '' });
  const instanceView = (u) => {
    const row = accounts.instance(u.id);
    return { url: cfg.instanceUrl(u.handle), name: cfg.name, state: hostd.state(u.id), startedAt: row.started_at || null, stoppedAt: row.stopped_at || null, nextWakeAt: row.next_wake_at || null };
  };
  // dev: the device asking, so a computer can tell itself apart in the list.
  const computerView = (c, dev = null) => ({ id: c.id, name: c.name, url: cfg.instanceUrl(c.label), online: tunnels.online(c.id), lastSeenAt: tunnels.online(c.id) ? Date.now() : c.last_seen_at || null, mine: !!dev && c.device_id === dev.device.id });
  // A user's computer, or a 404.
  const ownComputer = (userId, id) => {
    const c = accounts.computer(id);
    if (!c || c.user_id !== userId) throw bad('No such computer.', 404);
    return c;
  };

  // Which part of the grid a Host header is for: the grid itself, or a handle.
  const rootHosts = new Set([cfg.domain, `${cfg.domain}${cfg.portSuffix}`, `${cfg.domain}:${cfg.listen.port}`]);
  function hostKind(req) {
    const host = String(req.headers.host || '').toLowerCase();
    if (rootHosts.has(host)) return { kind: 'root' };
    const bare = host.replace(/:\d+$/, '');
    if (bare.endsWith(`.${cfg.domain}`)) {
      const handle = bare.slice(0, -cfg.domain.length - 1);
      const computer = handle.includes('--') ? accounts.computerByLabel(handle) : null;
      if (computer) return { kind: 'computer', computer };
      if (/^[a-z0-9-]+$/.test(handle)) return { kind: 'edge', handle };
    }
    return { kind: 'unknown' };
  }

  // ---- the grid's own pages and API ----

  async function root(req, res, url) {
    const p = url.pathname;
    const c = cookies(req);
    const s = accounts.session(c[names.grid], 'grid');
    const page = (body, status = 200, headers) => html(res, status, body, headers);
    const needCsrf = async () => {
      const body = await readBody(req);
      if (req.headers.origin && req.headers.origin !== cfg.publicUrl) throw bad('This form came from another site.', 403);
      if (!s || !secrets.verify(`csrf|${s.hash}`, String(body.csrf || ''))) throw bad('The page was out of date. Go back and try again.', 403);
      return body;
    };
    const signInFirst = (ret) => redirect(res, `/signin?return=${encodeURIComponent(ret)}`);

    // Device API: other origins (the phone app) call it with a bearer token, so CORS is open
    // and cookies are never involved.
    if (p.startsWith('/api/')) {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-max-age': '600' };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        return res.end();
      }
      const send = (status, body) => json(res, status, body, cors);
      // Public: how many accounts are left, for the site that links here (trywisp.dev/cloud.html).
      if (req.method === 'GET' && p === '/api/seats') return send(200, accounts.seats());
      if (req.method === 'POST' && p === '/api/device/code') {
        limit(`code|${clientIp(req)}`, 20);
        const body = await readBody(req);
        const d = accounts.deviceCode(body.name);
        return send(200, { ...d, verification_uri: `${cfg.publicUrl}/activate`, verification_uri_complete: `${cfg.publicUrl}/activate?code=${d.user_code}`, interval });
      }
      if (req.method === 'POST' && p === '/api/device/token') {
        limit(`token|${clientIp(req)}`, 120);
        const body = await readBody(req);
        const r = accounts.pollCode(body.device_code, interval);
        if (r.error) return send(400, { error: r.error });
        return send(200, { token: r.token, token_type: 'Bearer', user: userView(r.user), instance: instanceView(r.user) });
      }
      const dev = accounts.device(req.headers.authorization);
      if (!dev) return send(401, { error: 'Sign in again: this device isn’t known here (removed, or a typo in the token).' });
      if (req.method === 'GET' && p === '/api/me') return send(200, { user: userView(dev.user), instance: instanceView(dev.user), device: { id: dev.device.id, name: dev.device.name } });
      // A one-time link that signs a browser (the phone app's page) in to the user's wisp, or to
      // one of their computers (computer: its id).
      if (req.method === 'POST' && p === '/api/device/link') {
        const body = await readBody(req).catch(() => ({}));
        const to = body.computer ? cfg.instanceUrl(ownComputer(dev.user.id, body.computer).label) : cfg.instanceUrl(dev.user.handle);
        return send(200, { url: `${to}/_grid/auth?t=${accounts.ticket(dev.user.id)}&r=${encodeURIComponent(safePath(body.path))}` });
      }
      // Computers: wisp on a desktop adds itself (POST, named after the computer), every device
      // lists them (GET), and any of them can take one off (DELETE).
      if (req.method === 'GET' && p === '/api/computers') return send(200, { computers: accounts.computers(dev.user.id).map((c) => computerView(c, dev)) });
      if (req.method === 'POST' && p === '/api/computers') {
        const body = await readBody(req);
        return send(200, computerView(accounts.addComputer(dev, body.name), dev));
      }
      const del = req.method === 'DELETE' && /^\/api\/computers\/([a-f0-9]+)$/.exec(p);
      if (del) {
        const c = ownComputer(dev.user.id, del[1]);
        accounts.removeComputer(dev.user.id, c.id);
        tunnels.close(c.id);
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/device/revoke') {
        revokeDevice(dev.user.id, dev.device.id);
        return send(200, { ok: true });
      }
      return send(404, { error: 'not found' });
    }

    if (p === '/healthz') return json(res, 200, { ok: true });
    if (req.method === 'GET' && (p === '/' || p === '/account')) {
      if (!s) return page(signInPage({ cfg, providers, seats: accounts.seats(), ret: url.searchParams.get('return') || '', analytics: stats.pages }));
      const u = s.user;
      return page(accountPage({ cfg, user: u, instance: { ...accounts.instance(u.id), state: hostd.state(u.id) }, devices: accounts.devices(u.id), computers: accounts.computers(u.id).map((c) => ({ ...computerView(c), deviceId: c.device_id })), identities: accounts.identities(u.id), providers, csrf: csrfFor(s), flash: url.searchParams.get('m') || '' }));
    }
    if (req.method === 'GET' && p === '/signin') {
      if (s && !url.searchParams.get('link')) return redirect(res, safePath(url.searchParams.get('return')));
      return page(signInPage({ cfg, providers, seats: accounts.seats(), ret: safePath(url.searchParams.get('return'), ''), analytics: stats.pages }));
    }

    // Sign in with a provider: out to it with state + PKCE (+ nonce), back with a code.
    let m = /^\/auth\/([^/]+)\/start$/.exec(p);
    if (m && req.method === 'GET') {
      limit(`auth|${clientIp(req)}`, 60);
      const prov = providers.get(decodeURIComponent(m[1]));
      if (!prov) return page(messagePage({ cfg, title: 'Not available', text: 'That way of signing in isn’t set up on this grid.', link: ['/signin', 'Back'] }), 404);
      const link = url.searchParams.get('link') === '1';
      if (link && !s) return signInFirst('/');
      const ret = safePath(url.searchParams.get('return'), '/');
      if (prov.kind === 'dev') return page(devSignInPage({ cfg, ret, csrf: secrets.sign('dev-signin') }));
      const f = newFlow();
      const visitor = stats.visitorId(c);
      const st = { p: prov.id, s: f.state, v: f.verifier, n: f.nonce, r: ret, l: link ? s.user.id : null, t: Date.now(), a: visitor };
      const raw = Buffer.from(JSON.stringify(st)).toString('base64url');
      const to = await prov.start({ redirectUri: `${cfg.publicUrl}/auth/${encodeURIComponent(prov.id)}/callback`, state: f.state, verifier: f.verifier, nonce: f.nonce });
      if (!link) stats.funnel('grid_auth_started', visitor, { provider: prov.id });
      return redirect(res, to, { 'set-cookie': setCookie(names.oauth, `${raw}.${secrets.sign(raw)}`, 600) });
    }
    m = /^\/auth\/([^/]+)\/callback$/.exec(p);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const prov = providers.get(id);
      if (!prov) return page(messagePage({ cfg, title: 'Not available', text: 'That way of signing in isn’t set up on this grid.' }), 404);
      let identity;
      let ret = '/';
      let linkTo = null;
      let visitor = null;
      const clear = setCookie(names.oauth, '', 0);
      try {
        if (prov.kind === 'dev') {
          if (req.method !== 'POST') throw bad('Use the form.');
          const body = await readBody(req);
          if (!secrets.verify('dev-signin', String(body.csrf || ''))) throw bad('The page was out of date. Try again.', 403);
          const email = String(body.email || '').trim().toLowerCase();
          if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw bad('An email address, please.');
          identity = { provider: 'dev', subject: email, email, emailVerified: true, name: String(body.name || '').trim() || email.split('@')[0], login: email.split('@')[0] };
          ret = safePath(body.return);
        } else {
          const [raw, sig] = String(cookies(req)[names.oauth] || '').split('.');
          if (!raw || !secrets.verify(raw, sig || '')) throw bad('This sign-in timed out or was started elsewhere. Start again.');
          const st = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
          if (st.p !== id || st.s !== url.searchParams.get('state') || Date.now() - st.t > 600_000) throw bad('This sign-in timed out or was started elsewhere. Start again.');
          if (url.searchParams.get('error')) throw bad(url.searchParams.get('error_description') || `${prov.label} said: ${url.searchParams.get('error')}`);
          identity = await prov.finish({ code: url.searchParams.get('code'), redirectUri: `${cfg.publicUrl}/auth/${encodeURIComponent(id)}/callback`, verifier: st.v, nonce: st.n });
          ret = safePath(st.r);
          linkTo = st.l;
          visitor = st.a || null;
        }
        if (linkTo && s?.user.id !== linkTo) throw bad('You were signed out while connecting it. Sign in and try again.');
        const t0 = Date.now();
        const user = accounts.signIn(identity, { linkTo });
        if (!linkTo) stats.funnel('grid_auth_finished', visitor, { provider: id, signup: user.created_at >= t0 });
        const headers = { 'set-cookie': [clear] };
        if (!linkTo) {
          if (s) accounts.endSession(cookies(req)[names.grid]);
          headers['set-cookie'].push(setCookie(names.grid, accounts.createSession(user.id, 'grid', req.headers['user-agent']), cfg.sessionDays * 86400));
        }
        return redirect(res, linkTo ? `/?m=${encodeURIComponent(`${prov.label} connected.`)}` : ret, headers);
      } catch (err) {
        log(`grid: sign-in with ${id} failed: ${err.message}`);
        if (!linkTo) stats.funnel('grid_auth_failed', visitor, { provider: id, reason: err.full ? 'full' : err.status === 403 ? 'refused' : 'error' });
        return page(signInPage({ cfg, providers, seats: accounts.seats(), error: err.full ? '' : err.message, linking: !!linkTo, analytics: stats.pages }), err.status && err.status < 500 ? err.status : 400, { 'set-cookie': clear });
      }
    }

    // Into the user's own wisp (or ?computer=<id>, one of their computers): a one-time ticket to
    // its address, which sets that address's cookie.
    if (req.method === 'GET' && p === '/go') {
      if (!s) return signInFirst(`/go${url.search}`);
      const cid = url.searchParams.get('computer');
      const c = cid ? accounts.computer(cid) : null;
      const to = c && c.user_id === s.user.id ? cfg.instanceUrl(c.label) : cfg.instanceUrl(s.user.handle);
      return redirect(res, `${to}/_grid/auth?t=${accounts.ticket(s.user.id)}&r=${encodeURIComponent(safePath(url.searchParams.get('path')))}`);
    }

    if (p === '/activate') {
      if (!s) return signInFirst(`/activate${url.search}`);
      limit(`activate|${s.user.id}`, 30);
      if (req.method === 'GET') {
        const code = url.searchParams.get('code') || '';
        const device = code ? accounts.pendingCode(code) : null;
        const app = url.searchParams.get('app') === 'android';
        return page(activatePage({ cfg, user: s.user, code, device, app, csrf: csrfFor(s), error: code && !device ? 'That code expired or was already used. Start again on the device.' : '' }));
      }
      const body = await needCsrf();
      const allow = body.answer === 'allow';
      const c2 = accounts.answerCode(body.code, s.user.id, allow);
      // From the phone app: the way back is to the app, which is waiting to open your wisp. 'Your
      // account' would open it here in the browser instead.
      const app = body.app === 'android';
      const back = app ? [APP_URL, 'Back to the wisp app'] : ['/', 'Your account'];
      const done = app ? `${c2.name} can use your wisp now. Go back to the app: it opens your wisp there.` : `${c2.name} can use your wisp now. You can close this tab.`;
      return page(messagePage({ cfg, title: allow ? 'Device connected' : 'Not allowed', text: allow ? done : `${c2.name} wasn’t let in.`, link: back }));
    }

    if (req.method === 'POST') {
      if (!s) return signInFirst('/');
      if (p === '/instance/stop') {
        await needCsrf();
        await hostd.stop(s.user.id, 'put to sleep');
        return redirect(res, '/');
      }
      if ((m = /^\/devices\/([a-f0-9]+)\/revoke$/.exec(p))) {
        await needCsrf();
        revokeDevice(s.user.id, m[1]);
        return redirect(res, `/?m=${encodeURIComponent('Device removed.')}`);
      }
      if ((m = /^\/computers\/([a-f0-9]+)\/remove$/.exec(p))) {
        await needCsrf();
        const c = ownComputer(s.user.id, m[1]);
        accounts.removeComputer(s.user.id, c.id);
        tunnels.close(c.id);
        return redirect(res, `/?m=${encodeURIComponent(`${c.name} removed.`)}`);
      }
      if (p === '/identities/unlink') {
        const body = await needCsrf();
        accounts.unlink(s.user.id, String(body.provider || ''));
        return redirect(res, '/');
      }
      if (p === '/account/delete') {
        const body = await needCsrf();
        const u = s.user;
        if (String(body.confirm || '').trim().toLowerCase() !== u.handle) throw bad(`Type ${u.handle} to delete your account.`);
        await deleteAccount(u);
        return page(messagePage({ cfg, title: 'Account deleted', text: 'Your wisp, its files and your agents’ sign-ins are gone from this grid. To revoke those sign-ins as well, sign out of them at Anthropic, OpenAI or GitHub.', link: ['/', 'Done'] }), 200, { 'set-cookie': setCookie(names.grid, '', 0) });
      }
      if (p === '/signout') {
        await needCsrf();
        if (url.searchParams.get('all')) accounts.endAll(s.user.id);
        else accounts.endSession(c[names.grid]);
        return redirect(res, '/signin', { 'set-cookie': setCookie(names.grid, '', 0) });
      }
    }
    return page(messagePage({ cfg, title: 'Not found', text: 'There’s nothing here.', link: ['/', 'Home'] }), 404);
  }

  // A device removed: its computer too, and the tunnel that computer holds.
  function revokeDevice(userId, deviceId) {
    const gone = accounts.computers(userId).filter((c) => c.device_id === deviceId);
    accounts.revokeDevice(userId, deviceId);
    for (const c of gone) tunnels.close(c.id);
  }

  // Delete an account: disabled first, so no session or device starts its box again meanwhile; then
  // the box and its files (agent logins included); then the account and its sealed secrets.
  async function deleteAccount(u) {
    accounts.setDisabled(u.id, true);
    try {
      await hostd.remove(u);
    } catch (err) {
      accounts.setDisabled(u.id, !!u.disabled);
      log(`grid: deleting ${u.handle}: ${err.message}`);
      throw bad('Your files couldn’t be deleted just now, so your account is still here. Try again in a minute.', 409);
    }
    const gone = accounts.computers(u.id);
    accounts.remove(u.id);
    for (const c of gone) tunnels.close(c.id);
    log(`grid: ${u.handle} deleted their account`);
  }

  // ---- the edge: a user's own wisp ----

  function edgeAuth(req, user) {
    const d = accounts.device(req.headers.authorization);
    if (d) return d.user.id === user.id ? { via: 'device', user: d.user } : null;
    const s = accounts.session(cookies(req)[names.wisp], `i:${user.id}`);
    return s ? { via: 'cookie', user: s.user } : null;
  }

  async function edge(req, res, url, handle) {
    const user = accounts.byHandle(handle);
    if (!user) return html(res, 404, messagePage({ cfg, title: 'No such wisp', text: `Nobody here is called ${handle}.`, link: [cfg.publicUrl, 'Home'] }));
    const origin = cfg.instanceUrl(user.handle);
    const p = url.pathname;

    if (p === '/_grid/auth') {
      const u = accounts.useTicket(url.searchParams.get('t'));
      if (!u || u.id !== user.id) return redirect(res, `${cfg.publicUrl}/go`);
      const t = accounts.createSession(user.id, `i:${user.id}`, req.headers['user-agent']);
      return redirect(res, safePath(url.searchParams.get('r')), { 'set-cookie': setCookie(names.wisp, t, cfg.sessionDays * 86400) });
    }
    if (p === '/_grid/signout') {
      accounts.endSession(cookies(req)[names.wisp]);
      return redirect(res, cfg.publicUrl, { 'set-cookie': setCookie(names.wisp, '', 0) });
    }

    const who = edgeAuth(req, user);
    if (!who) {
      if (wantsHtml(req)) return redirect(res, `${cfg.publicUrl}/go?path=${encodeURIComponent(p + url.search)}`);
      return json(res, 401, { error: 'Sign in again.' });
    }
    // A page elsewhere can't post to someone's wisp with their cookie.
    if (req.method !== 'GET' && req.method !== 'HEAD' && who.via === 'cookie' && req.headers.origin !== origin) return json(res, 403, { error: 'forbidden origin' });

    if (p === '/_grid/state') {
      const i = hostd.inst.get(user.id);
      return json(res, 200, { state: hostd.state(user.id), error: i?.error || '' });
    }
    if (p === '/_grid/stop' && req.method === 'POST') {
      await hostd.stop(user.id, 'put to sleep');
      return json(res, 200, { ok: true, state: hostd.state(user.id) });
    }

    hostd.touch(user.id);
    if (hostd.state(user.id) !== 'running') {
      const ready = hostd.ensure(user);
      ready.catch(() => {});
      if (wantsHtml(req)) {
        // Quick starts go straight through; slower ones get the waking page, which reloads.
        const quick = await Promise.race([ready.then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 1500))]);
        if (!quick) return html(res, 200, wakingPage({ cfg, user }));
      } else {
        try {
          await ready;
        } catch (err) {
          return json(res, err.status || 503, { error: err.message, waking: true }, { 'retry-after': '2' });
        }
      }
    }
    const port = hostd.port(user.id);
    if (!port) return json(res, 503, { error: 'It’s still waking up.', waking: true }, { 'retry-after': '2' });
    proxy(req, res, port, user);
  }

  // ---- a computer the user added: the same sign-in as their wisp, then through its tunnel ----

  async function computerEdge(req, res, url, c) {
    const user = accounts.userById(c.user_id);
    if (!user || user.disabled) return html(res, 404, messagePage({ cfg, title: 'No such computer', text: 'Nothing answers at this address.', link: [cfg.publicUrl, 'Home'] }));
    const origin = cfg.instanceUrl(c.label);
    const p = url.pathname;
    const back = `${cfg.publicUrl}/go?computer=${c.id}`;
    if (p === '/_grid/auth') {
      const u = accounts.useTicket(url.searchParams.get('t'));
      if (!u || u.id !== user.id) return redirect(res, back);
      const t = accounts.createSession(user.id, `i:${user.id}`, req.headers['user-agent']);
      return redirect(res, safePath(url.searchParams.get('r')), { 'set-cookie': setCookie(names.wisp, t, cfg.sessionDays * 86400) });
    }
    if (p === '/_grid/signout') {
      accounts.endSession(cookies(req)[names.wisp]);
      return redirect(res, cfg.publicUrl, { 'set-cookie': setCookie(names.wisp, '', 0) });
    }
    const who = edgeAuth(req, user);
    if (!who) {
      if (wantsHtml(req)) return redirect(res, `${back}&path=${encodeURIComponent(p + url.search)}`);
      return json(res, 401, { error: 'Sign in again.' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && who.via === 'cookie' && req.headers.origin !== origin) return json(res, 403, { error: 'forbidden origin' });
    // Whether it's connected, without asking it anything (what wisp elsewhere polls while it's off).
    if (p === '/_grid/state') return json(res, 200, { state: tunnels.online(c.id) ? 'running' : 'offline', name: c.name });
    // Like the wisp edge: the grid's own sign-in stays here; the computer only learns who asked where.
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (k !== 'cookie' && k !== 'authorization' && !k.startsWith('x-wisp-proxy') && !k.startsWith('x-forwarded')) headers[k] = v;
    Object.assign(headers, { 'x-forwarded-host': String(req.headers.host || ''), 'x-forwarded-proto': cfg.scheme, 'x-forwarded-for': clientIp(req) });
    if (tunnels.forward(c.id, req, res, headers)) return;
    const text = `wisp on ${c.name} isn’t connected to the grid right now. It comes back when that computer is on and wisp runs there.`;
    if (wantsHtml(req)) return html(res, 503, messagePage({ cfg, title: `${c.name} is offline`, text, link: [cfg.publicUrl, 'Your account'] }), { 'retry-after': '10' });
    return json(res, 503, { error: `${c.name} is offline.`, offline: true }, { 'retry-after': '10' });
  }

  function proxy(req, res, port, user) {
    // A request on its way keeps its wisp up; a page's event stream doesn't (it stays open for
    // hours): wisp counts open pages itself, and leaves out a desktop relaying them (/api/status).
    if (!req.url.startsWith('/api/events')) res.on('close', hostd.begin(user.id));
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && k !== 'cookie' && k !== 'authorization' && !k.startsWith('x-wisp-proxy') && !k.startsWith('x-forwarded')) headers[k] = v;
    Object.assign(headers, {
      'x-wisp-proxy-secret': secrets.ensure(user.id, 'wisp-proxy'),
      'x-forwarded-host': req.headers.host,
      'x-forwarded-proto': cfg.scheme,
      'x-forwarded-for': clientIp(req),
    });
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers }, (r) => {
      const out = {};
      for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) out[k] = v;
      res.writeHead(r.statusCode, out);
      r.pipe(res);
      r.on('end', () => hostd.touch(user.id));
      // Its wisp went away mid-stream (stopped): end the page's stream too, so it notices.
      r.on('close', () => {
        if (!res.writableEnded) res.destroy();
      });
    });
    up.on('error', (err) => {
      if (!res.headersSent) json(res, 502, { error: `Its wisp didn’t answer: ${err.message}` });
      else res.destroy();
    });
    // The page went away (an SSE stream closed): let the wisp see it, so it can go idle.
    res.on('close', () => up.destroy());
    req.pipe(up);
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://grid');
    try {
      // Caddy's on-demand TLS asks before getting a certificate for a name (grid/deploy/Caddyfile):
      // only the grid itself and existing users. Loopback only.
      if (url.pathname === '/_grid/tls-ask' && /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(clientIp(req))) {
        const d = String(url.searchParams.get('domain') || '').toLowerCase();
        const label = d.slice(0, -cfg.domain.length - 1);
        const ok = d === cfg.domain || (d.endsWith(`.${cfg.domain}`) && !!(accounts.byHandle(label) || accounts.computerByLabel(label)));
        return json(res, ok ? 200 : 404, { ok });
      }
      // The grid's own images (screenshots, logos), on every address it answers.
      const asset = /^\/_grid\/a\/([a-z0-9-]+)\.(webp|svg|png)$/.exec(url.pathname);
      if (asset && req.method === 'GET') {
        const file = new URL(`${asset[1]}.${asset[2]}`, ASSETS);
        if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': TYPES[asset[2]], 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
        return fs.createReadStream(file).pipe(res);
      }
      const h = hostKind(req);
      if (h.kind === 'root') return await root(req, res, url);
      if (h.kind === 'edge') return await edge(req, res, url, h.handle);
      if (h.kind === 'computer') return await computerEdge(req, res, url, h.computer);
      json(res, 421, { error: `This grid answers at ${cfg.domain}.` });
    } catch (err) {
      const status = err.status && err.status < 600 ? err.status : 500;
      if (status >= 500) log(`grid: ${req.method} ${url.pathname}: ${err.stack || err.message}`);
      if (res.headersSent) return res.end();
      if (wantsHtml(req) || /^application\/x-www-form-urlencoded/.test(String(req.headers['content-type'] || ''))) return html(res, status, messagePage({ cfg, title: status === 429 ? 'Slow down' : 'That didn’t work', text: status >= 500 ? 'Something went wrong on the grid.' : err.message, link: ['/', 'Back'], tone: 'bad' }));
      json(res, status, { error: status >= 500 ? 'Something went wrong on the grid.' : err.message });
    }
  };

  // A computer opening its tunnel: GET /api/computers/:id/tunnel on the grid's own address, with
  // the token of the device that added it (only that computer can be it).
  function upgrade(req, socket, head) {
    const refuse = (status, error) => {
      socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${JSON.stringify({ error })}`);
    };
    socket.on('error', () => {});
    try {
      const url = new URL(req.url, 'http://grid');
      const m = /^\/api\/computers\/([a-f0-9]+)\/tunnel$/.exec(url.pathname);
      if (hostKind(req).kind !== 'root' || !m || String(req.headers.upgrade || '').toLowerCase() !== TUNNEL_PROTOCOL) return refuse(404, 'not found');
      limit(`tunnel|${clientIp(req)}`, 60);
      const dev = accounts.device(req.headers.authorization);
      if (!dev) return refuse(401, 'Sign in again: this device isn’t known here.');
      const c = accounts.computer(m[1]);
      if (!c || c.device_id !== dev.device.id) return refuse(404, 'This computer was removed from the grid.');
      tunnels.accept(c.id, socket, head);
    } catch (err) {
      refuse(err.status || 500, err.status ? err.message : 'Something went wrong on the grid.');
    }
  }

  // "loopback": both 127.0.0.1 and ::1 (Node and browsers resolve *.localhost to either).
  const hosts = cfg.listen.host === 'loopback' ? ['127.0.0.1', '::1'] : [cfg.listen.host];
  const servers = [];
  for (const host of hosts) {
    const srv = http.createServer(handler);
    srv.on('upgrade', upgrade);
    srv.keepAliveTimeout = 65_000;
    srv.headersTimeout = 66_000;
    srv.requestTimeout = 0; // SSE streams stay open
    try {
      await new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(cfg.listen.port, host, resolve);
      });
      servers.push(srv);
    } catch (err) {
      if (host === '::1' && err.code === 'EADDRNOTAVAIL') continue; // no IPv6 loopback here
      for (const x of servers) x.close();
      throw err;
    }
  }
  const server = servers[0];

  return {
    cfg,
    db,
    accounts,
    secrets,
    hostd,
    tunnels,
    server,
    url: cfg.publicUrl,
    async close() {
      const closed = Promise.all(servers.map((x) => new Promise((r) => x.close(r))));
      tunnels.closeAll();
      for (const x of servers) x.closeAllConnections?.();
      await hostd.close();
      stats.close();
      await closed;
      db.close();
    },
  };
}
