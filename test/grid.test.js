// wisp Grid end to end: sign in (dev, OpenID Connect, GitHub), a user's wisp started on demand
// behind the edge, cookies that stay on their own address, CSRF, the device flow, idle stop and
// waking, envelope-encrypted secrets, and wisp on a desktop signing in to it (Settings → Cloud).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { installFakeBins, tmp } from './helpers.js';

const fakeBin = installFakeBins();
process.env.WISP_HOME = tmp('grid-desktop');
process.env.WISP_UPDATE_CHECK = '0';
process.env.FAKE_DELAY = '200';

const { loadConfig } = await import('../grid/config.js');
const { startGrid } = await import('../grid/server.js');
const { createSecrets, addMasterKey, ensureMaster } = await import('../grid/secrets.js');
const { openDb } = await import('../grid/db.js');
const { trustedProxy } = await import('../server/http/trust.js');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeout = 20_000, every = 150, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A tiny browser: *.localhost goes to 127.0.0.1, cookies per host, no redirect following.
function browser() {
  const jar = new Map(); // host -> Map(name -> value)
  async function go(url, { method = 'GET', headers = {}, body, form } = {}) {
    const u = new URL(url);
    const c = jar.get(u.host);
    const data = form ? new URLSearchParams(form).toString() : body !== undefined ? JSON.stringify(body) : undefined;
    const h = {
      accept: 'text/html',
      ...(c && c.size && { cookie: [...c].map(([k, v]) => `${k}=${v}`).join('; ') }),
      ...(form && { 'content-type': 'application/x-www-form-urlencoded' }),
      ...(body !== undefined && { 'content-type': 'application/json', accept: 'application/json' }),
      ...headers,
    };
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method, headers: { host: u.host, ...h } }, (res) => {
        for (const sc of [].concat(res.headers['set-cookie'] || [])) {
          const [kv, ...attrs] = sc.split(';');
          const i = kv.indexOf('=');
          const name = kv.slice(0, i).trim();
          const val = kv.slice(i + 1).trim();
          if (!jar.has(u.host)) jar.set(u.host, new Map());
          if (attrs.some((a) => /max-age=0/i.test(a))) jar.get(u.host).delete(name);
          else jar.get(u.host).set(name, val);
        }
        let t = '';
        res.on('data', (d) => (t += d));
        res.on('end', () => {
          let j = null;
          try {
            j = JSON.parse(t);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text: t, json: j, location: res.headers.location });
        });
      });
      req.on('error', reject);
      req.end(data);
    });
  }
  // Follow redirects (absolute or relative), like a browser does.
  async function follow(url, opts = {}, hops = 8) {
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
const csrfOf = (html) => /name="csrf" value="([^"]+)"/.exec(html)?.[1];

// --- fake providers ----------------------------------------------------------------------

function fakeOidc() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  const st = { base: '', tamper: null };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, st.base);
    const send = (s, o) => (res.writeHead(s, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
    if (u.pathname === '/.well-known/openid-configuration') return send(200, { issuer: st.base, authorization_endpoint: `${st.base}/authorize`, token_endpoint: `${st.base}/token`, jwks_uri: `${st.base}/jwks` });
    if (u.pathname === '/jwks') return send(200, { keys: [jwk] });
    if (u.pathname === '/authorize') {
      const code = `c${codes.size}`;
      codes.set(code, { nonce: u.searchParams.get('nonce'), challenge: u.searchParams.get('code_challenge'), redirect: u.searchParams.get('redirect_uri') });
      res.writeHead(302, { location: `${u.searchParams.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(u.searchParams.get('state'))}` });
      return res.end();
    }
    if (u.pathname === '/token') {
      let t = '';
      req.on('data', (d) => (t += d));
      req.on('end', () => {
        const f = new URLSearchParams(t);
        const c = codes.get(f.get('code'));
        if (!c || createHash('sha256').update(f.get('code_verifier')).digest('base64url') !== c.challenge || f.get('client_secret') !== 'oidc-secret') return send(400, { error: 'invalid_grant' });
        const now = Math.floor(Date.now() / 1000);
        const claims = { iss: st.base, aud: 'oidc-client', sub: 'oidc-user-1', email: 'grace@corp.test', email_verified: true, name: 'Grace', nonce: c.nonce, iat: now, exp: now + 300, ...(st.tamper || {}) };
        const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
        const body = b64(claims);
        let sig = rsaSign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
        if (st.badSig) sig = sig.slice(0, -4) + (sig.endsWith('AAAA') ? 'BBBB' : 'AAAA');
        send(200, { access_token: 'at', id_token: `${head}.${body}.${sig}`, token_type: 'Bearer' });
      });
      return;
    }
    send(404, {});
  });
  return { srv, st };
}

function fakeGithub() {
  const st = { base: '' };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, st.base);
    const send = (s, o) => (res.writeHead(s, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
    if (u.pathname === '/login/oauth/authorize') {
      res.writeHead(302, { location: `${u.searchParams.get('redirect_uri')}?code=gh1&state=${encodeURIComponent(u.searchParams.get('state'))}` });
      return res.end();
    }
    if (u.pathname === '/login/oauth/access_token') return send(200, { access_token: 'gho_x', token_type: 'bearer' });
    if (req.headers.authorization !== 'Bearer gho_x') return send(401, { message: 'Bad credentials' });
    if (u.pathname === '/user') return send(200, { id: 4242, login: 'Octo-Cat', name: 'Octo Cat', avatar_url: 'https://x/a.png' });
    if (u.pathname === '/user/emails') return send(200, [{ email: 'octo@github.test', primary: true, verified: true }]);
    send(404, {});
  });
  return { srv, st };
}

// --- the grid under test ------------------------------------------------------------------

let grid;
let cfg;
let base;
const oidc = fakeOidc();
const gh = fakeGithub();
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));

before(async () => {
  oidc.st.base = await listen(oidc.srv);
  gh.st.base = await listen(gh.srv);
  const port = await freePort();
  const dataDir = tmp('grid');
  ensureMaster(dataDir);
  cfg = loadConfig({
    dataDir,
    env: {},
    overrides: {
      domain: 'wisp.localhost',
      listen: { host: '127.0.0.1', port },
      auth: { dev: true, providers: { 'oidc:corp': { issuer: oidc.st.base, clientId: 'oidc-client', clientSecret: 'oidc-secret', label: 'Corp SSO' }, github: { clientId: 'gh-client', clientSecret: 'gh-secret', authBase: gh.st.base, apiBase: gh.st.base } } },
      hostd: { idleMs: 1500, checkMs: 250, path: fakeBin },
    },
  });
  grid = await startGrid(cfg, { log: () => {} });
  base = cfg.publicUrl;
});
after(async () => {
  await grid?.close();
  oidc.srv.close();
  gh.srv.close();
});

async function devSignIn(b, email) {
  const start = await b.go(`${base}/auth/dev/start`);
  const csrf = csrfOf(start.text);
  const r = await b.go(`${base}/auth/dev/callback`, { method: 'POST', form: { csrf, email, name: email.split('@')[0], return: '/' }, headers: { origin: base } });
  assert.equal(r.status, 302, r.text);
  return r;
}

// Into the user's wisp: /go → ticket → cookie on its own address. Returns its origin.
async function openWisp(b) {
  const r = await b.follow(`${base}/go`);
  const origin = new URL(r.at).origin;
  return { origin, first: r };
}

test('dev sign-in, then /go opens the user’s own wisp at <handle>.<domain>, started on demand', async () => {
  const b = browser();
  await devSignIn(b, 'ada@example.com');
  const home = await b.go(`${base}/`);
  assert.match(home.text, /Hi ada/);
  assert.match(home.text, /ada\.wisp\.localhost/);
  const { origin, first } = await openWisp(b);
  assert.equal(origin, cfg.instanceUrl('ada'));
  assert.equal(first.status, 200);
  // Either straight in, or the waking page while it starts.
  assert.ok(/Waking your wisp/.test(first.text) || /<!doctype html>/i.test(first.text));
  const health = await until(async () => {
    const r = await b.go(`${origin}/api/health`, { headers: { accept: 'application/json' } });
    return r.status === 200 && r.json;
  }, { what: 'its wisp' });
  assert.equal(health.name, 'wisp');
  assert.equal(health.url, origin, 'the wisp reports its public address (trusted-proxy mode)');
  const page = await b.go(`${origin}/`);
  assert.match(page.text, /<!doctype html>/i);
  assert.equal(grid.hostd.state(grid.accounts.byHandle('ada').id), 'running');
});

test('the edge: no cookie → sign in; another user’s cookie doesn’t open it; posts from another site are refused', async () => {
  const anon = browser();
  const r = await anon.go(`${cfg.instanceUrl('ada')}/`);
  assert.equal(r.status, 302);
  assert.match(r.location, /\/go\?path=/);
  const api = await anon.go(`${cfg.instanceUrl('ada')}/api/sessions`, { headers: { accept: 'application/json' } });
  assert.equal(api.status, 401);

  const bob = browser();
  await devSignIn(bob, 'bob@example.com');
  const bobWisp = await openWisp(bob);
  assert.equal(bobWisp.origin, cfg.instanceUrl('bob'));
  // Bob's cookie belongs to bob.<domain>; replayed on ada's address it means nothing.
  const bobCookie = [...bob.jar.get(new URL(bobWisp.origin).host)][0];
  const stolen = browser();
  stolen.jar.set(new URL(cfg.instanceUrl('ada')).host, new Map([bobCookie]));
  const x = await stolen.go(`${cfg.instanceUrl('ada')}/api/sessions`, { headers: { accept: 'application/json' } });
  assert.equal(x.status, 401);

  const ada = browser();
  await devSignIn(ada, 'ada@example.com');
  const { origin } = await openWisp(ada);
  const evil = await ada.go(`${origin}/api/sessions`, { method: 'POST', body: { prompt: 'x' }, headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
});

test('a task runs in the user’s wisp through the edge; idle, it stops; the next request wakes it', async () => {
  const b = browser();
  await devSignIn(b, 'cyd@example.com');
  const { origin } = await openWisp(b);
  const userId = grid.accounts.byHandle('cyd').id;
  await until(async () => (await b.go(`${origin}/api/health`, { headers: { accept: 'application/json' } })).status === 200, { what: 'cyd’s wisp' });
  const launched = await b.go(`${origin}/api/sessions`, { method: 'POST', body: { prompt: 'fix the bug', agent: 'claude' }, headers: { origin } });
  assert.equal(launched.status, 201, launched.text);
  const id = launched.json.id;
  await until(async () => {
    const r = await b.go(`${origin}/api/sessions/${id}`, { headers: { accept: 'application/json' } });
    return r.json?.state && r.json.state !== 'running' && r.json;
  }, { what: 'the task' });
  // Nothing open, nothing running: hostd stops it.
  await until(() => grid.hostd.state(userId) === 'stopped', { what: 'idle stop', timeout: 15_000 });
  const row = grid.db.get('SELECT state, stop_reason FROM instances WHERE user_id = ?', userId);
  assert.deepEqual({ ...row }, { state: 'stopped', stop_reason: 'idle' });
  // An API call wakes it and waits; the task is still there.
  const again = await b.go(`${origin}/api/sessions/${id}`, { headers: { accept: 'application/json' } });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.id, id);
  assert.equal(grid.hostd.state(userId), 'running');
});

test('device flow: code → approve in the browser → bearer token opens the wisp; slow_down; revoke', async () => {
  const code = await browser().go(`${base}/api/device/code`, { method: 'POST', body: { name: 'Test laptop' } });
  assert.equal(code.status, 200);
  assert.match(code.json.user_code, /^[A-Z]{4}-[A-Z]{4}$/);
  assert.equal(code.headers['access-control-allow-origin'], '*');
  const poll = () => browser().go(`${base}/api/device/token`, { method: 'POST', body: { device_code: code.json.device_code } });
  assert.equal((await poll()).json.error, 'authorization_pending');
  assert.equal((await poll()).json.error, 'slow_down');

  const b = browser();
  await devSignIn(b, 'dee@example.com');
  const page = await b.go(`${base}/activate?code=${code.json.user_code.toLowerCase().replace('-', '')}`);
  assert.match(page.text, /Test laptop/);
  assert.match(page.text, new RegExp(code.json.user_code));
  // Opening the page does nothing by itself; the click does. A forged form is refused.
  const forged = await b.go(`${base}/activate`, { method: 'POST', form: { csrf: 'nope', code: code.json.user_code, answer: 'allow' }, headers: { origin: base } });
  assert.equal(forged.status, 403);
  const allowed = await b.go(`${base}/activate`, { method: 'POST', form: { csrf: csrfOf(page.text), code: code.json.user_code, answer: 'allow' }, headers: { origin: base } });
  assert.match(allowed.text, /Device connected/);

  await sleep(2100);
  const done = await poll();
  assert.equal(done.status, 200, done.text);
  assert.match(done.json.token, /^wgd_/);
  assert.equal(done.json.user.handle, 'dee');
  assert.equal(done.json.instance.url, cfg.instanceUrl('dee'));
  assert.equal((await poll()).json.error, 'invalid_grant', 'a code is used once');

  const auth = { authorization: `Bearer ${done.json.token}`, accept: 'application/json' };
  const me = await browser().go(`${base}/api/me`, { headers: auth });
  assert.equal(me.json.user.handle, 'dee');
  const health = await browser().go(`${cfg.instanceUrl('dee')}/api/health`, { headers: auth });
  assert.equal(health.status, 200, health.text);
  // Someone else's wisp: the token is for dee only.
  assert.equal((await browser().go(`${cfg.instanceUrl('ada')}/api/health`, { headers: auth })).status, 401);
  // The phone app's way in: a one-time link that sets the cookie.
  const link = await browser().go(`${base}/api/device/link`, { method: 'POST', body: { path: '/' }, headers: auth });
  const phone = browser();
  const landed = await phone.go(link.json.url);
  assert.equal(landed.status, 302);
  assert.ok(phone.jar.get(new URL(cfg.instanceUrl('dee')).host)?.size, 'cookie set on dee’s address');
  assert.equal((await phone.go(link.json.url)).location, `${base}/go`, 'the link works once');
  // The account page lists it; Remove revokes it.
  const acct = await b.go(`${base}/`);
  assert.match(acct.text, /Test laptop/);
  const devId = /action="\/devices\/([a-f0-9]+)\/revoke"/.exec(acct.text)[1];
  await b.go(`${base}/devices/${devId}/revoke`, { method: 'POST', form: { csrf: csrfOf(acct.text) }, headers: { origin: base } });
  assert.equal((await browser().go(`${base}/api/me`, { headers: auth })).status, 401);
});

test('OpenID Connect sign-in (Google works the same way): PKCE, state, nonce and signature are checked', async () => {
  const b = browser();
  const r = await b.follow(`${base}/auth/oidc%3Acorp/start`);
  assert.equal(r.at, `${base}/`);
  assert.match((await b.go(`${base}/`)).text, /Hi Grace/);
  const user = grid.accounts.byHandle('grace');
  assert.ok(user, 'handle from the email');

  // A forged signature, a wrong nonce, a wrong audience: refused with a message.
  for (const [what, set] of [
    ['signature', { badSig: true }],
    ['nonce', { tamper: { nonce: 'other' } }],
    ['audience', { tamper: { aud: 'someone-else' } }],
  ]) {
    Object.assign(oidc.st, { badSig: false, tamper: null }, set);
    const x = await browser().follow(`${base}/auth/oidc%3Acorp/start`);
    assert.equal(x.status, 400, what);
    assert.match(x.text, /sign-in token/i, what);
  }
  Object.assign(oidc.st, { badSig: false, tamper: null });
  // A callback with a state that isn't this browser's.
  const c = browser();
  const out = await c.go(`${base}/auth/oidc%3Acorp/start`);
  const back = await c.go(`${new URL(out.location).origin}${new URL(out.location).pathname}${new URL(out.location).search}`);
  const cb = new URL(back.location);
  cb.searchParams.set('state', 'forged');
  assert.equal((await c.go(cb.toString())).status, 400);
});

test('GitHub sign-in: the numeric id is who you are; linking an account used elsewhere is refused', async () => {
  const b = browser();
  await b.follow(`${base}/auth/github/start`);
  const home = await b.go(`${base}/`);
  assert.match(home.text, /Hi Octo/);
  assert.ok(grid.accounts.byHandle('octo-cat'));
  assert.equal(grid.db.get("SELECT subject FROM identities WHERE provider = 'github'").subject, '4242');
  // Ada tries to connect the same GitHub account.
  const ada = browser();
  await devSignIn(ada, 'ada@example.com');
  const r = await ada.follow(`${base}/auth/github/start?link=1`);
  assert.equal(r.status, 409);
  assert.match(r.text, /already signs in to another user/);
});

test('an allow list keeps others out', async () => {
  const dataDir = tmp('grid-closed');
  ensureMaster(dataDir);
  const port = await freePort();
  const c2 = loadConfig({ dataDir, env: {}, overrides: { domain: 'wisp.localhost', listen: { host: '127.0.0.1', port }, auth: { dev: true, allow: { domains: ['corp.test'] } }, hostd: { path: fakeBin } } });
  const g2 = await startGrid(c2, { log: () => {} });
  try {
    const b = browser();
    const start = await b.go(`${c2.publicUrl}/auth/dev/start`);
    const no = await b.go(`${c2.publicUrl}/auth/dev/callback`, { method: 'POST', form: { csrf: csrfOf(start.text), email: 'eve@else.test', return: '/' }, headers: { origin: c2.publicUrl } });
    assert.equal(no.status, 403);
    assert.match(no.text, /only lets in invited accounts/);
    const yes = await b.go(`${c2.publicUrl}/auth/dev/callback`, { method: 'POST', form: { csrf: csrfOf(start.text), email: 'zoe@corp.test', return: '/' }, headers: { origin: c2.publicUrl } });
    assert.equal(yes.status, 302);
    // An account listed by name gets in too.
    assert.equal(g2.accounts.allowed({ provider: 'github', subject: '9', login: 'Octo' }), false);
    c2.auth.allow.accounts = ['github:octo'];
    assert.equal(g2.accounts.allowed({ provider: 'github', subject: '9', login: 'Octo' }), true);
    assert.equal(g2.accounts.allowed({ provider: 'github', subject: '10', login: 'other' }), false);
  } finally {
    await g2.close();
  }
});

test('Caddy’s on-demand TLS check: the grid and existing users only', async () => {
  const ask = async (d) => (await browser().go(`http://127.0.0.1:${cfg.listen.port}/_grid/tls-ask?domain=${d}`, { headers: { host: `127.0.0.1:${cfg.listen.port}` } })).status;
  assert.equal(await ask('wisp.localhost'), 200);
  assert.equal(await ask('ada.wisp.localhost'), 200);
  assert.equal(await ask('nobody.wisp.localhost'), 404);
  assert.equal(await ask('evil.com'), 404);
});

test('secrets: sealed per user, bound to user and purpose, re-wrapped on key rotation, gone with the user', async () => {
  const dataDir = tmp('grid-keys');
  ensureMaster(dataDir);
  const db = await openDb(dataDir);
  db.run("INSERT INTO users (id, handle, created_at) VALUES ('u1', 'one', 0), ('u2', 'two', 0)");
  let s = createSecrets(db, { dataDir, env: {} });
  s.seal('u1', 'api-key', 'sk-123');
  assert.equal(s.open('u1', 'api-key'), 'sk-123');
  const raw = db.get("SELECT sealed FROM user_secrets WHERE user_id = 'u1'").sealed;
  assert.ok(!raw.includes('sk-123'));
  // Moved to another user's row, it doesn't open (AAD binds user and purpose).
  s.seal('u2', 'api-key', 'sk-u2');
  db.run("UPDATE user_secrets SET sealed = ? WHERE user_id = 'u2'", raw);
  assert.throws(() => s.open('u2', 'api-key'));
  assert.equal(fs.statSync(path.join(dataDir, 'secrets', 'master.json')).mode & 0o777, 0o600);
  addMasterKey(dataDir);
  s = createSecrets(db, { dataDir, env: {} });
  assert.equal(s.rewrap(), 2);
  assert.equal(db.get("SELECT kid FROM keys WHERE user_id = 'u1'").kid, 'k2');
  assert.equal(s.open('u1', 'api-key'), 'sk-123');
  s.forget('u1');
  assert.equal(s.open('u1', 'api-key'), null);
  db.close();
});

test('trusted-proxy mode in wisp: off without a long secret; on, it needs the secret and a matching Origin', () => {
  assert.equal(trustedProxy({ WISP_TRUSTED_PROXY_SECRET: 'short' }).on, false);
  const secret = 'x'.repeat(40);
  const p = trustedProxy({ WISP_TRUSTED_PROXY_SECRET: secret, WISP_PUBLIC_URL: 'https://ada.wisp.example.com' });
  const req = (h) => ({ headers: h });
  assert.equal(p.via(req({ 'x-wisp-proxy-secret': secret })), true);
  assert.equal(p.via(req({ 'x-wisp-proxy-secret': 'y'.repeat(40) })), false);
  assert.equal(p.via(req({})), false);
  assert.equal(p.originOk(req({ origin: 'https://ada.wisp.example.com' })), true);
  assert.equal(p.originOk(req({ origin: 'https://evil.example' })), false);
});

test('wisp on a desktop signs in to the grid (Settings → Cloud) and uses the cloud computer as a machine', async () => {
  const { startServer } = await import('../server/index.js');
  const port = await freePort();
  const desk = await startServer({ port, handleSignals: false });
  const api = async (p, opts = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method: opts.method || 'GET', headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  try {
    // Not a grid: a clear message.
    assert.equal((await api('/cloud/signin', { method: 'POST', body: { url: 'http://127.0.0.1:1' } })).status, 400);
    const s = await api('/cloud/signin', { method: 'POST', body: { url: base.replace('http://', '') } });
    assert.equal(s.status, 201, JSON.stringify(s.json));
    assert.equal(s.json.state, 'waiting');
    assert.match(s.json.verifyUrl, /\/activate\?code=/);
    // Approve it in "the browser", signed in as ada.
    const b = browser();
    await devSignIn(b, 'ada@example.com');
    const page = await b.go(s.json.verifyUrl);
    await b.go(`${base}/activate`, { method: 'POST', form: { csrf: csrfOf(page.text), code: s.json.userCode, answer: 'allow' }, headers: { origin: base } });
    const done = await until(async () => {
      const r = await api(`/cloud/signin/${s.json.id}`);
      return r.json.state !== 'waiting' && r.json;
    }, { what: 'the desktop sign-in' });
    assert.equal(done.state, 'done', done.error);
    const mid = done.machineId;
    // The token is in secrets.json (0600), not config.json, and never in what the page gets.
    const secretsFile = path.join(process.env.WISP_HOME, 'secrets.json');
    assert.equal(fs.statSync(secretsFile).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(secretsFile, 'utf8'), /wgd_/);
    assert.doesNotMatch(fs.readFileSync(path.join(process.env.WISP_HOME, 'config.json'), 'utf8'), /wgd_/);
    const online = await until(async () => {
      const list = (await api('/machines')).json;
      const m = list.find((x) => x.id === mid);
      return m?.state === 'online' && m;
    }, { what: 'the cloud machine online' });
    assert.equal(online.kind, 'grid');
    assert.equal(online.url, cfg.instanceUrl('ada'));
    assert.doesNotMatch(JSON.stringify(online), /wgd_/);
    // A task on the cloud computer, from the desktop.
    const l = await api('/sessions', { method: 'POST', body: { prompt: 'add a test', agent: 'claude', machine: mid } });
    assert.equal(l.status, 201, JSON.stringify(l.json));
    assert.match(l.json.id, new RegExp(`@${mid}$`));
    await until(async () => {
      const r = await api(`/sessions/${encodeURIComponent(l.json.id)}`);
      return r.json.state && r.json.state !== 'running';
    }, { what: 'the cloud task' });
    // The desktop watching doesn't keep it awake: idle, the grid stops it and the machine says asleep.
    const adaId = grid.accounts.byHandle('ada').id;
    await until(() => grid.hostd.state(adaId) === 'stopped', { what: 'cloud idle stop', timeout: 20_000 });
    await until(async () => (await api('/machines')).json.find((x) => x.id === mid)?.state === 'asleep', { what: 'asleep' });
    // Its tasks still list (from the last seen copy), and opening one wakes it.
    assert.ok((await api('/sessions')).json.some((x) => x.id === l.json.id));
    const opened = await api(`/sessions/${encodeURIComponent(l.json.id)}`);
    assert.equal(opened.status, 200, JSON.stringify(opened.json));
    await until(() => grid.hostd.state(adaId) === 'running', { what: 'woken by the desktop' });
  } finally {
    desk.shutdown();
    desk.server?.close();
  }
});

test('the container driver: one locked-down container per user, reachable only from this box', async () => {
  const { containerRun, CONTAINER } = await import('../grid/hostd.js');
  const { args } = containerRun({ ...CONTAINER, resolv: '/data/users/1/resolv.conf', name: 'wisp-u-1', port: 47001, home: '/data/users/1/home', env: { WISP_TRUSTED_PROXY_SECRET: 's'.repeat(40) } });
  const s = args.join(' ');
  assert.match(s, /--runtime runsc/);
  assert.match(s, /-v \/data\/users\/1\/resolv\.conf:\/etc\/resolv\.conf:ro/, 'a resolver gVisor can reach');
  assert.match(s, /-p 127\.0\.0\.1:47001:47001/, 'published on loopback only');
  assert.match(s, /--cap-drop ALL/);
  assert.match(s, /--security-opt no-new-privileges/);
  assert.match(s, /--memory 1536m .*--pids-limit 512/);
  assert.match(s, /-v \/data\/users\/1\/home:\/home\/wisp /, 'only its own home');
  assert.doesNotMatch(s, /-v \/data\/users\/1:|docker\.sock|--privileged/);
});
