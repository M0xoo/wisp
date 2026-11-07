// wisp Grid's HTTP server: one process, two kinds of address.
//
//   <domain>            the grid itself: sign in (Google, GitHub, any OIDC), your account, approve a
//                       device, and the device API (/api/device/*) wisp on computers and phones use
//   <handle>.<domain>   the edge: that user's own wisp, started on demand by hostd and proxied
//                       (HTTP + SSE) in trusted-proxy mode. Signed in by a host-only cookie (set
//                       from a one-time ticket), a device's bearer token, or an API key (wgk_…,
//                       made in wisp's Settings: this address only, for scripts).
//   <name>--<handle>.<domain>
//                       a computer the user added (wisp on their desktop), signed in the same way
//                       and sent through the tunnel that computer holds open (grid/tunnels.js).
//   p<port>--<handle>.<domain>
//                       a page the agent left running in that user's box (localhost:<port> there),
//                       for the preview block: its own sign-in (scope p:<label>), then through
//                       their wisp, which passes it on to that port (server/http/preview.js).
//                       Boxes only (hostd.previews): a process wisp's loopback is the grid's own.
//   p<port>--<name>--<handle>.<domain>
//                       the same for a computer they added, through its tunnel; the computer
//                       answers only while its Show local pages in previews is on.
//   <handle>.<domain>/_in/<token>
//                       a channel's webhook, for that user's box (grid/inbox.js): answered and held
//                       by the grid, then delivered. Off unless grid.json has channels.
//   <domain>/_mail/<provider>
//                       the mail provider's webhook, for every user's address (grid/mail.js). Off
//                       unless grid.json has mail.
//   sb-<id>--<handle>.<domain>
//                       a sandbox (grid/sandboxes.js): a box of its own for one task, started and
//                       stopped like the user's own, opened with its own token (or a ticket).
//                       p<port>--sb-<id>--<handle> are its pages, like a box's.
//   <slug>--app--<handle>.<domain>
//                       an app they published from My Stuff (grid/sites.js): open to anyone with
//                       the link, served by the grid itself, so it answers while their wisp sleeps.
//
// Cookies never span subdomains, so one user's wisp page can't read or set another's.

import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { MACHINE_WANTS, createAccounts, bad } from './accounts.js';
import { createProviders, newFlow } from './auth/providers.js';
import { openDb } from './db.js';
import { Hostd } from './hostd.js';
import { IN_PATH, createInbox } from './inbox.js';
import { MAIL_PATH, createMail } from './mail.js';
import { APP_URL, accountPage, activatePage, devSignInPage, messagePage, sharePassPage, shareViewPage, signInPage, wakingPage } from './pages.js';
import { createSecrets, ensureMaster } from './secrets.js';
import { MEDIA_TYPES, SHARE_ID, createShares } from './shares.js';
import { SANDBOX_LABEL, createSandboxes } from './sandboxes.js';
import { SITE_LABEL, createSites, readRaw } from './sites.js';
import { createGridTelemetry } from './telemetry.js';
import { TUNNEL_PROTOCOL, createTunnels, hostOnly } from './tunnels.js';
import { SHARE_LANDING, isShare, shareNoWorker } from '../server/http/share.js';

const BODY_LIMIT = 64 * 1024;
const ANSWER_MAX = 4096; // a box's answer to a channel's check
const ASSETS = new URL('./assets/', import.meta.url);
const TYPES = { webp: 'image/webp', svg: 'image/svg+xml', png: 'image/png' };
const WEB_TYPES = { css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml' };
// wisp's page's look, from web/index.html: its stylesheets in order and its icon sprite.
let look = null;
const webLook = () =>
  (look ||= (() => {
    const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
    return { styles: [...html.matchAll(/<link rel="stylesheet" href="(\/css\/[\w.-]+\.css)">/g)].map((m) => m[1]), sprite: /<svg width="0" height="0"[\s\S]*?<\/svg>\n/.exec(html)?.[0] || '' };
  })());
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

// framed: a preview's cookie, set inside a frame of another site (wisp on a computer shows a box's
// page in its own window): SameSite=None, which needs Secure (https, or *.localhost that browsers
// count as secure), and Partitioned, so it's kept for that one page and third-party cookie blocking
// leaves it alone. Previews check Origin on anything but GET.
function cookie(name, value, { secure, maxAge, path = '/', framed = false }) {
  const same = framed ? ['SameSite=None', 'Secure', 'Partitioned'] : ['SameSite=Lax', secure && 'Secure'];
  return [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', ...same, maxAge !== undefined && `Max-Age=${maxAge}`].filter(Boolean).join('; ');
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
// headers: null drops one of SECURITY's (a shared task's page may be framed).
const html = (res, status, body, headers = {}) => {
  res.writeHead(status, Object.fromEntries(Object.entries({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SECURITY, ...headers }).filter(([, v]) => v !== null)));
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
// Only paths on the same site: never an absolute URL or //host. Browsers drop tabs and newlines
// from a Location before reading it, so "/\t/evil.example" would be //evil.example: no control
// characters at all.
const safePath = (p, d = '/') => (typeof p === 'string' && /^\/(?![/\\])/.test(p) && !/[\x00-\x1f\x7f]/.test(p) ? p : d);
const wantsHtml = (req) => req.method === 'GET' && /text\/html/.test(String(req.headers.accept || '')) && req.headers['sec-fetch-dest'] !== 'empty';
const LOOPBACK = /^(::ffff:)?127\.0\.0\.1$|^::1$/;
// Behind Caddy (grid/deploy/Caddyfile) every request comes from loopback: who's asking is the
// address Caddy put last in X-Forwarded-For. Without this, everyone shares one rate limit, and
// anyone can use up the tunnels' (or sign-ins') for all.
const clientIp = (req) => {
  const at = req.socket.remoteAddress || '';
  const fwd = LOOPBACK.test(at) && String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
  return fwd || at;
};

// A sliding window per key: n requests in any minute. Refused ones aren't kept, so a key holds n at most.
const LIMIT_WINDOW = 60_000;
export function limiter() {
  const hits = new Map();
  setInterval(() => {
    for (const [key, at] of hits) if (Date.now() - at.at(-1) >= LIMIT_WINDOW) hits.delete(key);
  }, LIMIT_WINDOW).unref();
  return (key, n) => {
    const now = Date.now();
    const at = (hits.get(key) || []).filter((t) => now - t < LIMIT_WINDOW);
    if (at.length >= n) throw bad('Too many requests. Wait a minute.', 429);
    at.push(now);
    hits.set(key, at);
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
  const sites = createSites({ db, cfg, log });
  const shares = createShares({ db, cfg, log });
  const sandboxes = createSandboxes({ db, cfg, secrets });
  const shareCard = (row) => shares.card(row, accounts.userById(row.user_id));
  // Account pages open in a browser, each with an event stream (GET /events): told when something
  // on the page changed (a computer came online, the cloud wisp woke), they fetch it again.
  const watchers = new Map(); // user id -> Set of responses
  const notify = (userId) => {
    for (const res of watchers.get(userId) || []) res.write('event: change\ndata: {}\n\n');
  };
  let shut = false; // the database is closed: a late socket or exit handler has nothing to record
  const tunnels = createTunnels({
    log,
    onChange: (id, up) => {
      if (shut) return;
      const c = accounts.computer(id);
      if (!c) return;
      accounts.seenComputer(id);
      notify(c.user_id);
      if (up) log(`grid: computer ${c.label} connected`);
    },
  });
  const interval = cfg.auth.dev ? 2 : 5; // device-code polling, seconds

  const previews = cfg.hostd.previews ?? cfg.hostd.driver === 'container';
  const previewUrl = (handle, port) => cfg.instanceUrl(`p${port}--${handle}`);
  const hostd = new Hostd({
    ...cfg.hostd,
    dataDir: cfg.dataDir,
    // A sandbox's box (grid/sandboxes.js): its secrets are sealed under its owner.
    secretFor: (u) => (u.sandbox ? sandboxes.proxySecret({ id: u.sandbox, user_id: u.owner }) : secrets.ensure(u.id, 'wisp-proxy')),
    urlFor: (u) => cfg.instanceUrl(u.handle),
    previewFor: (u) => (previews ? previewUrl(u.handle, '{port}') : ''),
    envFor: (u) => (u.sandbox ? { ...sandboxes.envFor(u.owner), WISP_SANDBOX: '1' } : {}),
    exists: (u) => (u.sandbox ? !!sandboxes.get(u.sandbox) : !!accounts.userById(u.id)),
    gridUrl: cfg.publicUrl,
    telemetry: stats.on,
    log,
  });
  // A channel's message on its way to a box: over the same trust path as proxy(), with a mark of
  // its own that proxy() and previews drop from anything coming in from outside. → { status, body }:
  // the box's own short answer, which only a sender's live check goes back with.
  const toBox = (port, user, payload, { timeout = cfg.channels?.deliverMs || 30_000 } = {}) =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);
      const up = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/channels/inbound',
          timeout,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-wisp-proxy-secret': secrets.ensure(user.id, 'wisp-proxy'), 'x-wisp-proxy-via': 'inbox', 'x-forwarded-host': new URL(cfg.instanceUrl(user.handle)).host, 'x-forwarded-proto': cfg.scheme },
        },
        (r) => {
          const chunks = [];
          let size = 0;
          r.on('data', (c) => {
            size += c.length;
            if (size <= ANSWER_MAX) chunks.push(c);
          });
          r.on('end', () => {
            let body = {};
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {}
            resolve({ status: r.statusCode, body });
          });
          r.on('error', reject);
        },
      );
      up.on('timeout', () => up.destroy(new Error('timeout')));
      up.on('error', reject);
      up.end(data);
    });
  const inbox = createInbox({ db, cfg, secrets, accounts, hostd, deliver: toBox, delivered: (row) => row.channel === 'email' && mail?.delivered(row), log });
  const mail = inbox.on && cfg.mail ? createMail({ db, cfg, inbox, accounts, log }) : null;
  hostd.on('change', (e) => {
    if (shut) return;
    if (e.state === 'running' && !e.user.sandbox) inbox.drain(e.user);
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
    notify(e.user.owner || e.user.id);
    if (e.event === 'started' || e.event === 'idle' || e.event === 'failed' || e.event === 'out of memory') log(`grid: ${e.user.handle} ${e.event}${e.error ? `: ${e.error}` : ''}`);
  });
  // How busy the host is, every few minutes: what auth.maxUsers "auto" opens seats from, and when
  // a seat frees up the waitlist gets it.
  const sampleMs = cfg.hostd.sampleMs || 5 * 60_000;
  const sampler = setInterval(() => {
    try {
      const { peak, waits } = hostd.takePeak();
      if (accounts.sample({ running: peak, capacity: hostd.capacity(), waits })) log(`grid: one more seat (${accounts.seats().max})`);
    } catch (err) {
      log(`grid: load sample: ${err.message}`);
    }
  }, sampleMs);
  sampler.unref();

  // After a restart: nothing runs, but scheduled tasks still wake their wisp.
  db.run("UPDATE instances SET state = 'stopped' WHERE state != 'stopped'");
  for (const row of db.all('SELECT u.id, u.handle, i.next_wake_at FROM instances i JOIN users u ON u.id = i.user_id WHERE i.next_wake_at IS NOT NULL')) hostd.restore({ id: row.id, handle: row.handle }, row.next_wake_at);

  const names = { grid: cfg.secure ? '__Host-grid' : 'grid', wisp: cfg.secure ? '__Host-wisp' : 'wisp_grid', oauth: cfg.secure ? '__Host-grid_oauth' : 'grid_oauth' };
  const setCookie = (name, value, maxAge) => cookie(name, value, { secure: cfg.secure, maxAge });
  // Previews show in frames of other sites (wisp on a computer): framed where browsers allow it.
  const framable = cfg.secure || cfg.domain === 'localhost' || cfg.domain.endsWith('.localhost');
  const previewCookie = (name, value, maxAge) => cookie(name, value, { secure: cfg.secure, maxAge, framed: framable });
  const csrfFor = (s) => secrets.sign(`csrf|${s.hash}`);
  // identities: how they sign in (GitHub, Google…), so the phone app can say which account each one is.
  const userView = (u) => ({ id: u.id, handle: u.handle, name: u.name || '', email: u.email || '', avatar: u.avatar || '', identities: accounts.identities(u.id).map(({ provider, email, login }) => ({ provider, email: email || '', login: login || '' })) });
  const instanceView = (u) => {
    const row = accounts.instance(u.id);
    return { url: cfg.instanceUrl(u.handle), name: cfg.name, state: hostd.state(u.id), startedAt: row.started_at || null, stoppedAt: row.stopped_at || null, nextWakeAt: row.next_wake_at || null };
  };
  // dev: the device asking, so a computer can tell itself apart in the list.
  const computerView = (c, dev = null) => ({ id: c.id, name: c.name, url: cfg.instanceUrl(c.label), online: tunnels.online(c.id), lastSeenAt: tunnels.online(c.id) ? Date.now() : c.last_seen_at || null, mine: !!dev && c.device_id === dev.device.id });
  // The cloud wisp asking for itself: "Box <handle> <its trusted-proxy secret>" (hostd gave it both).
  const boxUser = (auth) => {
    const m = /^Box\s+([a-z0-9-]+)\s+(\S+)$/.exec(String(auth || ''));
    const u = m && accounts.byHandle(m[1]);
    if (!u || u.disabled) return null;
    const want = Buffer.from(secrets.ensure(u.id, 'wisp-proxy'));
    const got = Buffer.from(m[2]);
    return got.length === want.length && timingSafeEqual(got, want) ? u : null;
  };
  const keyView = (k) => ({ id: k.id, name: k.name, hint: k.hint, createdAt: k.created_at, lastUsedAt: k.last_used_at ?? null });
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
      if (SITE_LABEL.test(handle)) return { kind: 'site', site: sites.byLabel(handle) };
      const sandbox = SANDBOX_LABEL.test(handle) ? sandboxes.byLabel(handle) : null;
      if (sandbox) return { kind: 'sandbox', sandbox };
      const computer = handle.includes('--') ? accounts.computerByLabel(handle) : null;
      if (computer) return { kind: 'computer', computer };
      const pv = /^p(\d{1,5})--([a-z0-9-]+)$/.exec(handle);
      if (pv && +pv[1] >= 1 && +pv[1] <= 65535) {
        const sb = SANDBOX_LABEL.test(pv[2]) ? sandboxes.byLabel(pv[2]) : null;
        if (sb && previews) return { kind: 'preview', port: +pv[1], label: pv[2], sandbox: sb };
        const c = pv[2].includes('--') ? accounts.computerByLabel(pv[2]) : null;
        if (c) return { kind: 'preview', port: +pv[1], label: pv[2], computer: c };
        if (previews && !pv[2].includes('--')) return { kind: 'preview', port: +pv[1], label: pv[2], handle: pv[2] };
      }
      if (/^[a-z0-9-]+$/.test(handle)) return { kind: 'edge', handle };
    }
    return { kind: 'unknown' };
  }

  // The mail provider's webhook. It never signs in: its signature does that, checked in grid/mail.js.
  async function mailIn(req, res, provider) {
    if (!mail || req.method !== 'POST' || provider !== cfg.mail.inbound.provider) return json(res, 404, { error: 'not found' });
    limit(`mailin|${clientIp(req)}`, 600);
    const out = await mail.webhook(req);
    return json(res, out.status, out.body);
  }

  // ---- the grid's own pages and API ----

  async function root(req, res, url) {
    const p = url.pathname;
    const c = cookies(req);
    const s = accounts.session(c[names.grid], 'grid');
    // Only the landing page belongs in search results; sign-in steps, messages and the account page don't.
    const page = (body, status = 200, headers) => html(res, status, body, p === '/' ? headers : { 'x-robots-tag': 'noindex', ...headers });
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
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, x-wisp-passkey', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-max-age': '600' };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        return res.end();
      }
      const send = (status, body) => json(res, status, body, cors);
      // Public: how many accounts are left, for the site that links here (trywisp.dev/cloud.html).
      if (req.method === 'GET' && p === '/api/seats') return send(200, accounts.seats());
      // Public too: the site's "get the next seat" form, and "email me the link" from an in-app browser.
      if (req.method === 'POST' && p === '/api/waitlist') {
        try {
          limit(`wait|${clientIp(req)}`, 10);
          const body = await readBody(req);
          // in-app: "email me the link" from a phone stuck in X's (or another app's) browser.
          return send(200, { ok: true, ...accounts.waitFor(body.email, body.source === 'in-app' ? 'in-app' : 'site') });
        } catch (err) {
          return send(err.status || 400, { error: err.message }); // with CORS, so the site can read it
        }
      }
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
        notify(r.user.id);
        return send(200, { token: r.token, token_type: 'Bearer', user: userView(r.user), instance: instanceView(r.user) });
      }
      // A cloud wisp asking where its channel's webhook goes (grid/inbox.js). Only its Box secret, and
      // only ever its own URL: that secret can be read on the box, and this reaches nothing past it.
      if (inbox.on && req.method === 'GET' && p === '/api/channels/url') {
        const who = boxUser(req.headers.authorization);
        if (!who) return send(401, { error: 'Sign in again: this device isn’t known here (removed, or a typo in the token).' });
        const channel = url.searchParams.get('channel');
        if (!inbox.knows(channel)) return send(404, { error: 'not found' });
        limit(`inurl|${who.id}`, 60);
        return send(200, inbox.urlFor(who, channel));
      }
      if (inbox.on && req.method === 'POST' && p === '/api/channels/url/rotate') {
        const who = boxUser(req.headers.authorization);
        if (!who) return send(401, { error: 'Sign in again: this device isn’t known here (removed, or a typo in the token).' });
        const channel = url.searchParams.get('channel');
        if (!inbox.knows(channel)) return send(404, { error: 'not found' });
        limit(`inrot|${who.id}`, 10);
        return send(200, inbox.rotate(who, channel));
      }
      // A cloud wisp answering a message its box accepted. It can't name an address (grid/mail.js).
      if (mail && req.method === 'POST' && p === '/api/channels/mail/reply') {
        const who = boxUser(req.headers.authorization);
        if (!who) return send(401, { error: 'Sign in again: this device isn’t known here (removed, or a typo in the token).' });
        limit(`mailout|${who.id}`, 120);
        return send(200, await mail.reply(who, await readBody(req)));
      }
      // Publishing an app from My Stuff (grid/sites.js): from wisp on a computer (its device token),
      // or from the cloud wisp itself, which has no device but has its trusted-proxy secret.
      const site = /^\/api\/sites(?:\/([A-Za-z0-9_-]{1,64}))?$/.exec(p);
      if (site) {
        const who = accounts.device(req.headers.authorization)?.user || boxUser(req.headers.authorization);
        if (!who) return send(401, { error: 'Sign in again: this device isn’t known here (removed, or a typo in the token).' });
        if (req.method === 'GET' && !site[1]) return send(200, { enabled: sites.opts.enabled, maxBytes: sites.opts.maxBytes, sites: sites.list(who.id).map(sites.view) });
        if (req.method === 'PUT' && site[1]) {
          limit(`site|${who.id}`, 30);
          if (!sites.opts.enabled) return send(403, { error: 'This grid doesn’t publish apps.' });
          const buf = await readRaw(req, sites.opts.maxBytes);
          const out = await sites.publish(who, site[1], buf, { title: url.searchParams.get('title'), entry: url.searchParams.get('entry') });
          notify(who.id);
          return send(200, out);
        }
        if (req.method === 'DELETE' && site[1]) {
          const ok = sites.remove(who.id, site[1]);
          notify(who.id);
          return send(200, { ok });
        }
        return send(404, { error: 'not found' });
      }
      // Shared tasks (grid/shares.js). Only wisp signed in to this grid shares and imports them:
      // PUT/DELETE /api/shares/mine/<task key> from the sharer's wisp, GET /api/shares/<id> (the
      // card) and /api/shares/<id>/pack (everything) from whoever imports it, passkey in x-wisp-passkey.
      const sh = /^\/api\/shares(?:\/(mine)(?:\/([A-Za-z0-9_-]{1,64}))?|\/([A-Za-z0-9_-]{16})(\/pack)?)$/.exec(p);
      if (sh) {
        const who = accounts.device(req.headers.authorization)?.user || boxUser(req.headers.authorization);
        if (!who) return send(401, { error: 'Sign in again: this device isn’t known here (removed, or a typo in the token).' });
        try {
          if (sh[1]) {
            if (req.method === 'GET' && !sh[2]) return send(200, { enabled: shares.opts.enabled, maxBytes: shares.opts.maxBytes, shares: shares.list(who.id).map(shares.view) });
            if (req.method === 'PUT' && sh[2]) {
              limit(`share|${who.id}`, 30);
              const buf = await readRaw(req, shares.opts.maxBytes);
              const pass = req.headers['x-wisp-passkey'];
              const out = shares.share(who, sh[2], buf, { passkey: pass === undefined ? undefined : decodeURIComponent(String(pass)) });
              notify(who.id);
              return send(200, out);
            }
            if (req.method === 'DELETE' && sh[2]) {
              const ok = shares.remove(who.id, sh[2]);
              notify(who.id);
              return send(200, { ok });
            }
            return send(404, { error: 'not found' });
          }
          if (req.method !== 'GET') return send(404, { error: 'not found' });
          const row = shares.get(sh[3]);
          if (!row) return send(404, { error: 'This task isn’t shared any more, or its link has a typo.' });
          const pass = req.headers['x-wisp-passkey'] === undefined ? '' : decodeURIComponent(String(req.headers['x-wisp-passkey']));
          if (!shares.unlocks(row, pass)) {
            if (pass) limit(`sharepk|${row.id}|${who.id}`, 10);
            const c = shareCard(row);
            return send(pass ? 403 : 401, { error: pass ? 'That passkey isn’t right.' : 'This task is locked with a passkey.', locked: true, from: c.from, id: c.id, url: c.url });
          }
          if (!sh[4]) return send(200, { ...shareCard(row), mine: row.user_id === who.id });
          limit(`sharepack|${who.id}`, 30);
          const buf = shares.pack(row);
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length, 'cache-control': 'no-store', ...cors });
          return res.end(buf);
        } catch (err) {
          return send(err.status || 400, { error: err.message });
        }
      }
      // Sandboxes (grid/sandboxes.js): from wisp on a computer (its device token) or the cloud wisp
      // (its Box secret); never from a sandbox, which has neither.
      const sbx = /^\/api\/sandboxes(?:\/(logins)\/([a-z]{1,20})|\/([a-f0-9]{8})|\/env(?:\/([A-Za-z_][A-Za-z0-9_]{0,63}))?)?$/.exec(p);
      const envPath = /^\/api\/sandboxes\/env(\/|$)/.test(p);
      if (sbx) {
        const who = accounts.device(req.headers.authorization)?.user || boxUser(req.headers.authorization);
        if (!who) return send(401, { error: 'Sign in again: this device isn’t known here (removed, or a typo in the token).' });
        try {
          // Env vars every sandbox of theirs starts with (names back, never values).
          if (envPath && req.method === 'PUT' && !sbx[4]) {
            limit(`sandboxenv|${who.id}`, 60);
            const body = await readBody(req);
            sandboxes.setEnv(who.id, body.key, body.value);
            accounts.audit(who.id, 'sandbox.env', { key: String(body.key || '').slice(0, 64) });
            return send(200, { env: sandboxes.envKeys(who.id) });
          }
          if (envPath && req.method === 'DELETE' && sbx[4]) {
            sandboxes.dropEnv(who.id, sbx[4]);
            return send(200, { env: sandboxes.envKeys(who.id) });
          }
          if (envPath) return send(404, { error: 'not found' });
          if (req.method === 'GET' && !sbx[1] && !sbx[3]) return send(200, { enabled: sandboxes.opts.enabled, logins: sandboxes.logins(who.id), env: sandboxes.envKeys(who.id), sandboxes: sandboxes.list(who.id).map(sandboxes.view) });
          if (req.method === 'POST' && !sbx[1] && !sbx[3]) {
            limit(`sandbox|${who.id}`, 30);
            const body = await readBody(req);
            const { row } = sandboxes.create(who, body.name, { taken: (label) => !!(accounts.computerByLabel(label) || accounts.byHandle(label)) });
            notify(who.id);
            log(`grid: ${who.handle} made sandbox ${row.id}`);
            return send(201, { ...sandboxes.view(row), token: sandboxes.bearer(row) });
          }
          if (sbx[1] && req.method === 'PUT') {
            limit(`sandboxlogin|${who.id}`, 30);
            sandboxes.setLogin(who.id, sbx[2], (await readBody(req)).token);
            accounts.audit(who.id, 'sandbox.login', { agent: sbx[2] });
            return send(200, { logins: sandboxes.logins(who.id) });
          }
          if (sbx[1] && req.method === 'DELETE') {
            sandboxes.dropLogin(who.id, sbx[2]);
            accounts.audit(who.id, 'sandbox.logout', { agent: sbx[2] });
            return send(200, { logins: sandboxes.logins(who.id) });
          }
          if (sbx[3] && req.method === 'DELETE') {
            const row = sandboxes.get(sbx[3]);
            if (!row || row.user_id !== who.id) return send(200, { ok: true, gone: true }); // already gone
            await removeSandbox(row, who);
            notify(who.id);
            return send(200, { ok: true });
          }
        } catch (err) {
          return send(err.status || 400, { error: err.message });
        }
        return send(404, { error: 'not found' });
      }
      // API keys, for scripts, from wisp on a computer: a device token only. Not the Box secret, which
      // anything on the box can read; a cloud wisp's person makes keys at its edge (/_grid/keys).
      const ak = /^\/api\/keys(?:\/([a-f0-9]{1,32}))?$/.exec(p);
      if (ak) {
        const who = accounts.device(req.headers.authorization)?.user;
        if (!who) return send(401, { error: 'Sign in again: this device isn’t known here (removed, or a typo in the token).' });
        return manageKeys(req, who, ak[1], send);
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
        const added = computerView(accounts.addComputer(dev, body.name), dev);
        notify(dev.user.id);
        return send(200, added);
      }
      const del = req.method === 'DELETE' && /^\/api\/computers\/([a-f0-9]+)$/.exec(p);
      if (del) {
        const c = ownComputer(dev.user.id, del[1]);
        accounts.removeComputer(dev.user.id, c.id);
        tunnels.close(c.id);
        notify(dev.user.id);
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/device/revoke') {
        revokeDevice(dev.user.id, dev.device.id);
        return send(200, { ok: true });
      }
      return send(404, { error: 'not found' });
    }

    if (p === '/healthz') return json(res, 200, { ok: true });
    // wisp's own stylesheets, scripts and logos (web/), for a shared task's page: it's drawn the
    // way wisp draws a task. Public files from the repo, nothing of anyone's.
    if ((req.method === 'GET' || req.method === 'HEAD') && /^\/(css|js|logos)\/[\w./-]+\.(css|js|svg)$|^\/favicon\.svg$/.test(p) && !p.includes('..')) {
      const file = new URL(`../web${p}`, import.meta.url);
      if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
      const body = fs.readFileSync(file);
      res.writeHead(200, { 'content-type': WEB_TYPES[p.split('.').pop()], 'content-length': body.length, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    // A shared task's page, and its delegates' (/s/<id>/r/<run>): open to anyone with the link, or
    // only with its passkey (POSTed here). Opened once, a cookie for that share keeps it open a
    // while, so its delegates' pages don't ask again; a new passkey shuts it.
    // Its pictures and videos (/s/<id>/m/<n>.<ext>), behind the same passkey as the page. A range
    // for a video, so it seeks (and plays at all in Safari).
    const sm = /^\/s\/([A-Za-z0-9_-]{16})\/m\/([\w.-]{1,40})$/.exec(p);
    if (sm && (req.method === 'GET' || req.method === 'HEAD')) {
      const row = shares.get(sm[1]);
      const file = row && (!row.pass || secrets.verify(`share|${row.id}|${row.pass}`, cookies(req)[`wsh_${row.id}`] || '')) && shares.media(row, sm[2]);
      if (!file) return json(res, 404, { error: 'not found' });
      const size = fs.statSync(file).size;
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      let [start, end] = [0, size - 1];
      if (m && (m[1] || m[2])) {
        [start, end] = m[1] ? [Number(m[1]), m[2] ? Math.min(Number(m[2]), size - 1) : size - 1] : [Math.max(0, size - Number(m[2])), size - 1];
        if (start > end || start >= size) {
          res.writeHead(416, { 'content-range': `bytes */${size}` });
          return res.end();
        }
      }
      const head = { 'content-type': MEDIA_TYPES[sm[2].split('.').pop().toLowerCase()], 'content-length': end - start + 1, 'accept-ranges': 'bytes', 'cache-control': row.pass ? 'private, max-age=300' : 'public, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" };
      res.writeHead(m && (m[1] || m[2]) ? 206 : 200, m && (m[1] || m[2]) ? { ...head, 'content-range': `bytes ${start}-${end}/${size}` } : head);
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    const sp = /^\/s\/([A-Za-z0-9_-]+)(?:\/r\/([^/]{1,60}))?$/.exec(p);
    if (sp && (req.method === 'GET' || req.method === 'HEAD' || req.method === 'POST')) {
      const row = SHARE_ID.test(sp[1]) && shares.get(sp[1]);
      if (!row) return page(messagePage({ cfg, title: 'Nothing here', text: 'This task isn’t shared any more, or its link has a typo.', link: [cfg.publicUrl, 'Home'] }), 404);
      const c = shareCard(row);
      const ck = `wsh_${row.id}`;
      const opened = !!row.pass && secrets.verify(`share|${row.id}|${row.pass}`, cookies(req)[ck] || '');
      let pass = '';
      if (req.method === 'POST') {
        limit(`sharepk|${row.id}|${clientIp(req)}`, 10);
        pass = String((await readBody(req)).passkey || '');
      }
      // Framed anywhere (wisp's preview block, a doc, a wiki): it's meant to be shown, and the page
      // has nothing to click that acts for anyone. Every other grid page stays DENY.
      const framed = { 'x-frame-options': null };
      if (!opened && !shares.unlocks(row, pass)) return page(sharePassPage({ cfg, share: c, wrong: !!pass }), pass ? 403 : 200, framed);
      const task = shares.task(row);
      let run = null;
      if (sp[2]) {
        try {
          run = decodeURIComponent(sp[2]);
        } catch {}
        if (!run || !task.runs?.[run]) return page(messagePage({ cfg, title: 'Nothing here', text: 'That delegated task isn’t in this share.', link: [`/s/${row.id}`, 'Back to the task'] }), 404);
      }
      const keep = row.pass && pass ? { 'set-cookie': cookie(ck, secrets.sign(`share|${row.id}|${row.pass}`), { secure: cfg.publicUrl.startsWith('https:'), maxAge: 12 * 3600, path: `/s/${row.id}` }) } : {};
      return page(shareViewPage({ share: c, task, run, look: webLook() }), 200, { 'content-security-policy': "default-src 'none'; img-src 'self' https: data:; media-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; connect-src 'none'; frame-src https:; form-action 'self'; base-uri 'none'; frame-ancestors *", ...framed, ...keep });
    }
    // HEAD too: link checkers (ad review, unfurlers) probe with it, and a 404 there reads as a dead page
    if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/' || p === '/account')) {
      if (!s) return page(signInPage({ cfg, providers, seats: accounts.seats(), ret: url.searchParams.get('return') || (p === '/account' ? '/account' : ''), analytics: stats.pages, ua: req.headers['user-agent'] }));
      const u = s.user;
      return page(accountPage({ cfg, view: p === '/account' ? 'account' : 'home', offers: { sites: sites.opts.enabled, sandboxes: sandboxes.opts.enabled }, user: u, instance: { ...accounts.instance(u.id), state: hostd.state(u.id) }, machine: { cpus: hostd.container.cpus, memory: hostd.container.memory, wish: accounts.machineWish(u.id) }, devices: accounts.devices(u.id), computers: accounts.computers(u.id).map((c) => ({ ...computerView(c), deviceId: c.device_id })), sites: sites.list(u.id).map(sites.view), identities: accounts.identities(u.id), providers, csrf: csrfFor(s), flash: url.searchParams.get('m') || '' }));
    }
    if (req.method === 'GET' && p === '/events') {
      if (!s) return json(res, 401, { error: 'Sign in again.' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', ...SECURITY });
      res.write('retry: 3000\n\n');
      const set = watchers.get(s.user.id) || new Set();
      watchers.set(s.user.id, set.add(res));
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000); // keeps proxies from dropping it
      res.on('close', () => {
        clearInterval(ping);
        set.delete(res);
        if (!set.size && watchers.get(s.user.id) === set) watchers.delete(s.user.id);
      });
      return;
    }
    if (req.method === 'GET' && p === '/signin') {
      if (s && !url.searchParams.get('link')) return redirect(res, safePath(url.searchParams.get('return')));
      return page(signInPage({ cfg, providers, seats: accounts.seats(), ret: safePath(url.searchParams.get('return'), ''), analytics: stats.pages, ua: req.headers['user-agent'] }));
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
        return redirect(res, linkTo ? `/account?m=${encodeURIComponent(`${prov.label} connected.`)}` : ret, headers);
      } catch (err) {
        log(`grid: sign-in with ${id} failed: ${err.message}`);
        if (!linkTo) stats.funnel('grid_auth_failed', visitor, { provider: id, reason: err.full ? 'full' : err.status === 403 ? 'refused' : 'error' });
        return page(signInPage({ cfg, providers, seats: accounts.seats(), error: err.full ? '' : err.message, waitlisted: !!err.waitlisted, linking: !!linkTo, analytics: stats.pages, ua: req.headers['user-agent'] }), err.status && err.status < 500 ? err.status : 400, { 'set-cookie': clear });
      }
    }

    // Into the user's own wisp (or ?computer=<id>, one of their computers; with ?preview=<port>, a
    // page in that box or on that computer): a one-time ticket to its address, which sets that
    // address's cookie.
    if (req.method === 'GET' && p === '/go') {
      if (!s) return signInFirst(`/go${url.search}`);
      const cid = url.searchParams.get('computer');
      const c = cid ? accounts.computer(cid) : null;
      const sb = sandboxes.get(url.searchParams.get('sandbox'));
      const label = c && c.user_id === s.user.id ? c.label : sb && sb.user_id === s.user.id ? sb.label : s.user.handle;
      const pport = /^\d{1,5}$/.test(url.searchParams.get('preview') || '') && (previews || (!!c && label === c.label)) ? Number(url.searchParams.get('preview')) : 0;
      const to = pport ? previewUrl(label, pport) : cfg.instanceUrl(label);
      return redirect(res, `${to}/_grid/auth?t=${accounts.ticket(s.user.id, pport ? `preview:${label}` : null)}&r=${encodeURIComponent(safePath(url.searchParams.get('path')))}`);
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
      // More cloud machines, bigger ones, GPUs: on the list for when they come. The page posts
      // JSON and answers at once; without script, the form posts and comes back here.
      if (p === '/machines/waitlist') {
        const body = await needCsrf();
        const wish = accounts.wishMachines(s.user.id, body.wants ?? MACHINE_WANTS.filter((w) => body[`want_${w}`]), body.note);
        notify(s.user.id);
        if (String(req.headers.accept || '').includes('application/json')) return json(res, 200, { ok: true, wish });
        return redirect(res, `/?m=${encodeURIComponent(wish ? 'You’re on the list. We’ll write when it’s ready.' : 'You’re off the list.')}`);
      }
      if ((m = /^\/devices\/([a-f0-9]+)\/revoke$/.exec(p))) {
        await needCsrf();
        revokeDevice(s.user.id, m[1]);
        return redirect(res, `/account?m=${encodeURIComponent('Device removed.')}`);
      }
      if ((m = /^\/computers\/([a-f0-9]+)\/remove$/.exec(p))) {
        await needCsrf();
        const c = ownComputer(s.user.id, m[1]);
        accounts.removeComputer(s.user.id, c.id);
        tunnels.close(c.id);
        notify(s.user.id);
        return redirect(res, `/?m=${encodeURIComponent(`${c.name} removed.`)}`);
      }
      if ((m = /^\/sites\/([A-Za-z0-9_-]{1,64})\/remove$/.exec(p))) {
        await needCsrf();
        sites.remove(s.user.id, m[1]);
        notify(s.user.id);
        return redirect(res, `/?m=${encodeURIComponent('Unpublished: that link no longer works.')}`);
      }
      if (p === '/identities/unlink') {
        const body = await needCsrf();
        accounts.unlink(s.user.id, String(body.provider || ''));
        return redirect(res, '/account');
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
        // Use another account (the device approval page): back to sign-in, then to that same code.
        const ret = safePath(url.searchParams.get('return'), '');
        return redirect(res, ret ? `/signin?return=${encodeURIComponent(ret)}` : '/signin', { 'set-cookie': setCookie(names.grid, '', 0) });
      }
    }
    return page(messagePage({ cfg, title: 'Not found', text: 'There’s nothing here.', link: ['/', 'Home'] }), 404);
  }

  // Listing, making and revoking API keys, for /api/keys and /_grid/keys. send answers no-store
  // (json()): a new key is in the POST's answer.
  async function manageKeys(req, user, id, send) {
    try {
      if (req.method === 'GET' && !id) return send(200, { keys: accounts.apiKeys(user.id).map(keyView) });
      if (req.method === 'POST' && !id) {
        limit(`apikey|${user.id}`, 30);
        const made = accounts.createApiKey(user.id, (await readBody(req)).name);
        return send(201, { ...keyView(made), key: made.key });
      }
      if (req.method === 'DELETE' && id) return accounts.revokeApiKey(user.id, id) ? send(200, { ok: true }) : send(404, { error: 'No such key.' });
    } catch (err) {
      return send(err.status || 400, { error: err.message });
    }
    return send(404, { error: 'not found' });
  }

  // A device removed: its computer too, and the tunnel that computer holds.
  function revokeDevice(userId, deviceId) {
    const gone = accounts.computers(userId).filter((c) => c.device_id === deviceId);
    accounts.revokeDevice(userId, deviceId);
    for (const c of gone) tunnels.close(c.id);
    notify(userId);
  }

  // A sandbox gone: its box and home (hostd → boxd), then its row and secrets.
  async function removeSandbox(row, user) {
    await hostd.remove(sandboxes.box(row, user));
    sandboxes.remove(row);
    log(`grid: ${user.handle} removed sandbox ${row.id}`);
  }

  // Delete an account: disabled first, so no session or device starts its box again meanwhile; then
  // the box and its files (agent logins included); then the account and its sealed secrets.
  async function deleteAccount(u) {
    accounts.setDisabled(u.id, true);
    try {
      for (const row of sandboxes.list(u.id)) await removeSandbox(row, u);
      await hostd.remove(u);
    } catch (err) {
      accounts.setDisabled(u.id, !!u.disabled);
      log(`grid: deleting ${u.handle}: ${err.message}`);
      throw bad('Your files couldn’t be deleted just now, so your account is still here. Try again in a minute.', 409);
    }
    const gone = accounts.computers(u.id);
    sites.removeAll(u.id);
    shares.removeAll(u.id);
    accounts.remove(u.id);
    for (const c of gone) tunnels.close(c.id);
    log(`grid: ${u.handle} deleted their account`);
  }

  // ---- the edge: a user's own wisp ----

  // box: what hostd runs (the user, or one of their sandboxes). A sandbox also opens with its own
  // token, and never with a cookie from the user's own address (cookies are per address anyway).
  // keys: whether an API key opens it: only the user's own wisp, never a computer or a sandbox.
  // Another user's key is refused outright, even beside a good cookie, like a device's token.
  function edgeAuth(req, user, box = user, row = null, keys = false) {
    if (row && sandboxes.byBearer(req.headers.authorization)?.id === row.id) return { via: 'sandbox', user };
    const d = accounts.device(req.headers.authorization);
    if (d) return d.user.id === user.id ? { via: 'device', user: d.user } : null;
    const k = keys && accounts.apiKey(req.headers.authorization);
    if (k) return k.user.id === user.id ? { via: 'key', user: k.user, key: k.key } : null;
    const s = accounts.session(cookies(req)[names.wisp], `i:${box.id}`);
    return s ? { via: 'cookie', user: s.user } : null;
  }

  // A channel's webhook: answered here, whatever the box is doing. It never signs in, its unguessable
  // token does that, and only at its owner's address. Nothing here logs the path: it holds the token.
  async function channelIn(req, res, url, handle) {
    const none = () => json(res, 404, { error: 'not found' });
    if (!inbox.on || req.method !== 'POST') return none();
    try {
      const m = IN_PATH.exec(url.pathname);
      const hit = m && inbox.byToken(m[1]);
      const user = hit && accounts.byHandle(handle);
      // By address only for what no one knows: a sender like Telegram posts every user's webhook
      // from a few addresses, so a known token has its own limit and doesn't count here.
      if (!user || user.disabled || user.id !== hit.user_id) {
        limit(`in|${clientIp(req)}`, 600);
        return none();
      }
      limit(`intok|${user.id}|${hit.channel}`, 120);
      const answer = await inbox.accept(user, hit.channel, req);
      return answer ? json(res, answer.status, answer.body) : json(res, 200, { ok: true });
    } catch (err) {
      if (err.status === 429) return json(res, 429, { error: err.message });
      log(`grid: inbox for ${handle}: ${err.message}`);
      return res.headersSent ? res.end() : json(res, 500, { error: 'Something went wrong on the grid.' });
    }
  }

  async function edge(req, res, url, handle) {
    if (url.pathname === '/_in' || url.pathname.startsWith('/_in/')) return channelIn(req, res, url, handle);
    const user = accounts.byHandle(handle);
    if (!user) return html(res, 404, messagePage({ cfg, title: 'No such wisp', text: `Nobody here is called ${handle}.`, link: [cfg.publicUrl, 'Home'] }));
    return boxEdge(req, res, url, { user, box: user, origin: cfg.instanceUrl(user.handle), back: `${cfg.publicUrl}/go`, secret: secrets.ensure(user.id, 'wisp-proxy') });
  }

  async function sandboxEdge(req, res, url, row) {
    const user = accounts.userById(row.user_id);
    if (!user || user.disabled) return html(res, 404, messagePage({ cfg, title: 'No such sandbox', text: 'Nothing answers at this address.', link: [cfg.publicUrl, 'Home'] }));
    return boxEdge(req, res, url, { user, box: sandboxes.box(row, user), row, origin: cfg.instanceUrl(row.label), back: `${cfg.publicUrl}/go?sandbox=${row.id}`, secret: sandboxes.proxySecret(row) });
  }

  // A box hostd runs (the user's own wisp, or a sandbox): signed in, woken, then proxied.
  async function boxEdge(req, res, url, { user, box, row = null, origin, back, secret }) {
    const p = url.pathname;
    if (p === '/_grid/auth') {
      const u = accounts.useTicket(url.searchParams.get('t'));
      if (!u || u.id !== user.id) return redirect(res, back);
      const t = accounts.createSession(user.id, `i:${box.id}`, req.headers['user-agent']);
      return redirect(res, safePath(url.searchParams.get('r')), { 'set-cookie': setCookie(names.wisp, t, cfg.sessionDays * 86400) });
    }
    if (p === '/_grid/signout') {
      accounts.endSession(cookies(req)[names.wisp]);
      return redirect(res, cfg.publicUrl, { 'set-cookie': setCookie(names.wisp, '', 0) });
    }

    // A trigger's secret URL (wisp's POST /api/hooks/<token>): Slack, Linear or anything else
    // calls it without signing in. It goes through (waking the wisp), and wisp checks the token
    // and the signature itself; at most 120 a minute from one address.
    const hook = req.method === 'POST' && /^\/api\/hooks\/[\w-]{20,64}$/.test(p);
    if (hook) {
      try {
        limit(`hook|${clientIp(req)}`, 120);
      } catch (err) {
        return json(res, err.status || 429, { error: err.message });
      }
    }
    const who = hook ? { via: 'hook', user } : edgeAuth(req, user, box, row, row === null);
    if (!who) {
      // A share with no worker (server/http/share.js) is a browser's page too: signed in, the same answer.
      if (wantsHtml(req) || isShare(req)) return redirect(res, `${back}${back.includes('?') ? '&' : '?'}path=${encodeURIComponent(isShare(req) ? SHARE_LANDING : p + url.search)}`);
      return json(res, 401, { error: 'Sign in again.' });
    }
    if (who.via === 'key') {
      try {
        limit(`apikeyuse|${who.key.id}`, 600);
      } catch (err) {
        return json(res, err.status || 429, { error: err.message });
      }
    }
    if (isShare(req)) return shareNoWorker(req, res); // never wakes the box, and may carry no Origin
    // A page elsewhere can't post to someone's wisp with their cookie.
    if (req.method !== 'GET' && req.method !== 'HEAD' && who.via === 'cookie' && req.headers.origin !== origin) return json(res, 403, { error: 'forbidden origin' });
    // API keys, from the person's browser only: its cookie stays here, and the box never hears of
    // it. Answered by the grid, so it works while the box sleeps, and never wakes it.
    const kp = /^\/_grid\/keys(?:\/(.*))?$/.exec(p);
    if (kp) {
      const send = (status, body) => json(res, status, body);
      if (row) return send(404, { error: 'not found' });
      if (who.via !== 'cookie') return send(403, { error: 'API keys are made from Settings, in a browser.' });
      if (kp[1] !== undefined && !/^[a-f0-9]{1,32}$/.test(kp[1])) return send(404, { error: 'No such key.' });
      return manageKeys(req, user, kp[1], send);
    }
    if (p === '/_grid/preview' && req.method === 'POST') return previewLink(res, url, user, box.handle, previews);

    if (p === '/_grid/state') {
      const i = hostd.inst.get(box.id);
      return json(res, 200, { state: hostd.state(box.id), error: i?.error || '' });
    }
    if (p === '/_grid/stop' && req.method === 'POST') {
      await hostd.stop(box.id, 'put to sleep');
      return json(res, 200, { ok: true, state: hostd.state(box.id) });
    }

    hostd.touch(box.id);
    if (hostd.state(box.id) !== 'running') {
      const ready = hostd.ensure(box);
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
    const port = hostd.port(box.id);
    if (!port) return json(res, 503, { error: 'It’s still waking up.', waking: true }, { 'retry-after': '2' });
    proxy(req, res, port, box, secret, who.via);
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
      if (wantsHtml(req) || isShare(req)) return redirect(res, `${back}&path=${encodeURIComponent(isShare(req) ? SHARE_LANDING : p + url.search)}`);
      return json(res, 401, { error: 'Sign in again.' });
    }
    if (isShare(req)) return shareNoWorker(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD' && who.via === 'cookie' && req.headers.origin !== origin) return json(res, 403, { error: 'forbidden origin' });
    // The computer decides whether it shows its local pages (Show local pages in previews).
    if (p === '/_grid/preview' && req.method === 'POST') return previewLink(res, url, user, c.label, true);
    // Whether it's connected, without asking it anything (what wisp elsewhere polls while it's off).
    if (p === '/_grid/state') return json(res, 200, { state: tunnels.online(c.id) ? 'running' : 'offline', name: c.name });
    // Like the wisp edge: the grid's own sign-in stays here; the computer only learns who asked where.
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (k !== 'cookie' && k !== 'authorization' && !k.startsWith('x-wisp-proxy') && k !== 'x-wisp-preview' && k !== 'x-wisp-upgrade' && !k.startsWith('x-forwarded')) headers[k] = v;
    Object.assign(headers, { 'x-forwarded-host': String(req.headers.host || ''), 'x-forwarded-proto': cfg.scheme, 'x-forwarded-for': clientIp(req) });
    if (tunnels.forward(c.id, req, res, headers)) return;
    const text = `wisp on ${c.name} isn’t connected to the grid right now. It comes back when that computer is on and wisp runs there.`;
    if (wantsHtml(req)) return html(res, 503, messagePage({ cfg, title: `${c.name} is offline`, text, link: [cfg.publicUrl, 'Your account'] }), { 'retry-after': '10' });
    return json(res, 503, { error: `${c.name} is offline.`, offline: true }, { 'retry-after': '10' });
  }

  // ---- a page in the user's box, or on a computer they added: its own cookie, then on to it ----

  // A one-time link into p<port>--<label> (an app launched from My Stuff), asked by wisp's own page.
  // The phone app's page is signed in to that wisp only, not to the grid, so /go would stop at the
  // grid's sign-in inside the frame.
  function previewLink(res, url, user, label, allowed) {
    const raw = url.searchParams.get('port') || '';
    const port = /^\d{1,5}$/.test(raw) ? Number(raw) : 0;
    if (!allowed || port < 1 || port > 65535) return json(res, 400, { error: 'No preview for that port here.' });
    return json(res, 200, { url: `${previewUrl(label, port)}/_grid/auth?t=${accounts.ticket(user.id, `preview:${label}`)}&r=${encodeURIComponent(safePath(url.searchParams.get('path')))}` });
  }

  // The user whose page this is, if the request carries their preview cookie. Only cookies: a
  // frame can't send a device's token, and the page there never sees one.
  function previewAuth(req, h) {
    const user = h.computer ? accounts.userById(h.computer.user_id) : h.sandbox ? accounts.userById(h.sandbox.user_id) : accounts.byHandle(h.handle);
    if (!user || user.disabled) return { user: null, ok: false };
    const s = accounts.session(cookies(req)[names.wisp], `p:${h.label}`); // this box or computer only
    return { user, ok: s?.user.id === user.id };
  }

  // What it gets: the page's own cookies and headers without the grid's sign-in, and the port.
  // A box's wisp also gets the proxy secret; a computer is reached through its own tunnel.
  function previewHeaders(req, user, h) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && k !== 'cookie' && !k.startsWith('x-wisp-') && !k.startsWith('x-forwarded')) headers[k] = v;
    const rest = String(req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim())
      .filter((c) => c && !c.startsWith(`${names.wisp}=`));
    if (rest.length) headers.cookie = rest.join('; ');
    Object.assign(headers, {
      ...(!h.computer && { 'x-wisp-proxy-secret': h.sandbox ? sandboxes.proxySecret(h.sandbox) : secrets.ensure(user.id, 'wisp-proxy') }),
      'x-wisp-preview': String(h.port),
      'x-forwarded-host': req.headers.host,
      'x-forwarded-proto': cfg.scheme,
      'x-forwarded-for': clientIp(req),
    });
    return headers;
  }

  async function previewEdge(req, res, url, h) {
    const origin = previewUrl(h.label, h.port);
    const p = url.pathname;
    const { user, ok } = previewAuth(req, h);
    if (!user) return html(res, 404, messagePage({ cfg, title: 'No such page', text: 'Nothing answers at this address.', link: [cfg.publicUrl, 'Home'] }));
    const back = `${cfg.publicUrl}/go?preview=${h.port}${h.computer ? `&computer=${h.computer.id}` : h.sandbox ? `&sandbox=${h.sandbox.id}` : ''}`;
    if (p === '/_grid/auth') {
      const u = accounts.useTicket(url.searchParams.get('t'), { preview: h.label });
      if (!u || u.id !== user.id) return redirect(res, back);
      const t = accounts.createSession(user.id, `p:${h.label}`, req.headers['user-agent']);
      return redirect(res, safePath(url.searchParams.get('r')), { 'set-cookie': previewCookie(names.wisp, t, cfg.sessionDays * 86400) });
    }
    if (!ok) {
      if (wantsHtml(req)) return redirect(res, `${back}&path=${encodeURIComponent(p + url.search)}`);
      return json(res, 401, { error: 'Sign in again.' });
    }
    // A page elsewhere can't post to it with the cookie.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: 'forbidden origin' });
    if (h.computer) {
      if (tunnels.forward(h.computer.id, req, res, previewHeaders(req, user, h), { cookies: true })) return;
      return html(res, 503, messagePage({ cfg, title: `${h.computer.name} is offline`, text: `Port ${h.port} is on ${h.computer.name}, which isn’t connected to the grid right now. It comes back when that computer is on and wisp runs there.`, link: [cfg.publicUrl, 'Your account'] }), { 'retry-after': '10' });
    }
    // Its server runs in the box: asleep, there's nothing to show (waking it wouldn't start it).
    const boxId = h.sandbox ? sandboxes.box(h.sandbox, user).id : user.id;
    const port = hostd.port(boxId);
    if (!port) return html(res, 503, messagePage({ cfg, title: 'Your wisp is asleep', text: `Port ${h.port} lives in your wisp, which is asleep, so whatever ran there has stopped. Open your wisp and ask the agent to start it again.`, link: [cfg.instanceUrl(user.handle), 'Open your wisp'] }), { 'retry-after': '10' });
    hostd.touch(boxId);
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: previewHeaders(req, user, h) }, (r) => {
      const out = {};
      for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) out[k] = v;
      if (out['set-cookie']) out['set-cookie'] = hostOnly(out['set-cookie']);
      res.writeHead(r.statusCode, out);
      r.pipe(res);
    });
    up.on('error', (err) => {
      if (!res.headersSent) json(res, 502, { error: `Its wisp didn’t answer: ${err.message}` });
      else res.destroy();
    });
    res.on('close', () => up.destroy());
    req.pipe(up);
  }

  // A websocket to the page (a dev server's live reload): the same checks, then the socket goes
  // through to the box's wisp as it is, or over the computer's tunnel.
  function previewSocket(req, socket, head, h, refuse) {
    const { user, ok } = previewAuth(req, h);
    if (!user || !ok) return refuse(401, 'Sign in again.');
    if (req.headers.origin && req.headers.origin !== previewUrl(h.label, h.port)) return refuse(403, 'forbidden origin');
    if (h.computer) {
      if (!tunnels.upgrade(h.computer.id, req, socket, head, previewHeaders(req, user, h))) refuse(503, `${h.computer.name} is offline.`);
      return;
    }
    const boxId = h.sandbox ? sandboxes.box(h.sandbox, user).id : user.id;
    const port = hostd.port(boxId);
    if (!port) return refuse(503, 'Your wisp is asleep.');
    hostd.touch(boxId);
    const headers = { ...previewHeaders(req, user, h), connection: 'Upgrade', upgrade: req.headers.upgrade };
    const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headers).flatMap(([k, v]) => [].concat(v).map((x) => `${k}: ${x}`))];
    const up = net.connect(port, '127.0.0.1', () => {
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('close', () => up.destroy());
  }

  // via: how the grid signed them in. Only 'key' is passed on, for what wisp won't do for a key
  // (server/services/api-keys.js); x-wisp-proxy* from outside is dropped, so it can't be claimed.
  function proxy(req, res, port, box, secret, via) {
    // A request on its way keeps its wisp up; a page's event stream doesn't (it stays open for
    // hours): wisp counts open pages itself, and leaves out a desktop relaying them (/api/status).
    if (!req.url.startsWith('/api/events')) res.on('close', hostd.begin(box.id));
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && k !== 'cookie' && k !== 'authorization' && !k.startsWith('x-wisp-proxy') && !k.startsWith('x-forwarded')) headers[k] = v;
    Object.assign(headers, {
      'x-wisp-proxy-secret': secret,
      'x-forwarded-host': req.headers.host,
      'x-forwarded-proto': cfg.scheme,
      'x-forwarded-for': clientIp(req),
      ...(via === 'key' && { 'x-wisp-proxy-via': 'key' }),
    });
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers }, (r) => {
      const out = {};
      for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) out[k] = v;
      res.writeHead(r.statusCode, out);
      r.pipe(res);
      r.on('end', () => hostd.touch(box.id));
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
      // only the grid itself and existing users. Loopback only: Caddy itself, not a request it
      // passed on (that would tell anyone which handles and computers exist).
      if (url.pathname === '/_grid/tls-ask' && LOOPBACK.test(clientIp(req))) {
        const d = String(url.searchParams.get('domain') || '').toLowerCase();
        const label = d.slice(0, -cfg.domain.length - 1);
        const pv = /^p\d{1,5}--([a-z0-9-]+)$/.exec(label);
        const ok = d === cfg.domain || (d.endsWith(`.${cfg.domain}`) && !!(accounts.byHandle(label) || sites.byLabel(label) || accounts.computerByLabel(label) || sandboxes.byLabel(label) || (pv && ((previews && (accounts.byHandle(pv[1]) || sandboxes.byLabel(pv[1]))) || accounts.computerByLabel(pv[1])))));
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
      // People's wisps and computers are private: keep every answer from them, the sign-in
      // redirects included, out of search engines, and tell crawlers so up front.
      if (h.kind !== 'root') res.setHeader('x-robots-tag', 'noindex, nofollow');
      if (url.pathname === '/robots.txt' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' });
        return res.end(h.kind === 'root' ? 'User-agent: *\nDisallow: /api/\nDisallow: /auth/\nDisallow: /activate\nDisallow: /go\n' : 'User-agent: *\nDisallow: /\n');
      }
      const mailPath = h.kind === 'root' && MAIL_PATH.exec(url.pathname);
      if (mailPath) return await mailIn(req, res, mailPath[1]);
      if (h.kind === 'root') return await root(req, res, url);
      if (h.kind === 'edge') return await edge(req, res, url, h.handle);
      if (h.kind === 'computer') return await computerEdge(req, res, url, h.computer);
      if (h.kind === 'sandbox') return await sandboxEdge(req, res, url, h.sandbox);
      if (h.kind === 'preview') return await previewEdge(req, res, url, h);
      if (h.kind === 'site' && h.site && url.pathname === '/_wisp/db') limit(`sitedb|${clientIp(req)}`, 600);
      if (h.kind === 'site') return h.site ? sites.serve(req, res, h.site) : html(res, 404, messagePage({ cfg, title: 'Nothing here', text: 'This app was unpublished, or its link has a typo.', link: [cfg.publicUrl, 'Home'] }));
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
      const h = hostKind(req);
      if (h.kind === 'preview') return previewSocket(req, socket, head, h, refuse);
      const m = /^\/api\/computers\/([a-f0-9]+)\/tunnel$/.exec(url.pathname);
      if (h.kind !== 'root' || !m || String(req.headers.upgrade || '').toLowerCase() !== TUNNEL_PROTOCOL) return refuse(404, 'not found');
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
  inbox.resume(); // what a restart left held

  return {
    cfg,
    db,
    accounts,
    secrets,
    hostd,
    inbox,
    sandboxes,
    tunnels,
    server,
    url: cfg.publicUrl,
    async close() {
      clearInterval(sampler);
      inbox.stop();
      sites.close();
      const closed = Promise.all(servers.map((x) => new Promise((r) => x.close(r))));
      tunnels.closeAll();
      for (const set of watchers.values()) for (const res of set) res.end();
      for (const x of servers) x.closeAllConnections?.();
      await hostd.close();
      await inbox.settled();
      stats.close();
      await closed;
      shut = true;
      db.close();
    },
  };
}
