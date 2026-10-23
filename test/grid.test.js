// wisp Grid end to end: sign in (dev, OpenID Connect, GitHub), a user's wisp started on demand
// behind the edge, cookies that stay on their own address, CSRF, the device flow, idle stop and
// waking, envelope-encrypted secrets, and wisp on a desktop signing in to it (Settings → Cloud).

import { test as nodeTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { browser, installFakeBins, sleep, tmp, until, win } from './helpers.js';

// The grid needs node:sqlite (Node 22.13+): on older Node it won't start, and these are skipped.
const sqlite = await import('node:sqlite').then(
  () => true,
  () => false,
);
const test = (name, fn) => nodeTest(name, { skip: !sqlite && 'the grid needs node:sqlite (Node 22.13+)' }, fn);

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
  if (!sqlite) return;
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
  // It knows it's a cloud computer on this grid: the page offers the grid, not SSH, to reach it.
  const conf = await b.go(`${origin}/api/config`, { headers: { accept: 'application/json' } });
  assert.deepEqual(conf.json.grid, { url: cfg.publicUrl, address: origin });
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

test('deleting an account: typed handle and CSRF, then its box, files, secrets, sessions and devices are gone', async () => {
  const b = browser();
  await devSignIn(b, 'eve@example.com');
  const { origin } = await openWisp(b);
  const eve = grid.accounts.byHandle('eve');
  await until(async () => (await b.go(`${origin}/api/health`, { headers: { accept: 'application/json' } })).status === 200, { what: 'eve’s wisp' });
  const folder = path.join(cfg.dataDir, 'users', eve.id);
  assert.ok(fs.existsSync(path.join(folder, 'home')));
  const code = grid.accounts.deviceCode('Eve’s laptop');
  grid.accounts.answerCode(code.user_code, eve.id, true);
  const token = grid.accounts.pollCode(code.device_code, 5).token;
  const me = () => browser().go(`${base}/api/me`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  assert.equal((await me()).status, 200);

  const page = await b.go(`${base}/`);
  assert.match(page.text, /action="\/account\/delete"/);
  assert.match(page.text, /placeholder="Type eve"/);
  const csrf = csrfOf(page.text);
  const wrong = await b.go(`${base}/account/delete`, { method: 'POST', form: { csrf, confirm: 'ada' }, headers: { origin: base } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.text, /Type eve to delete your account/);
  const forged = await b.go(`${base}/account/delete`, { method: 'POST', form: { csrf: 'nope', confirm: 'eve' }, headers: { origin: base } });
  assert.equal(forged.status, 403);
  assert.ok(grid.accounts.byHandle('eve'));
  assert.equal(grid.hostd.state(eve.id), 'running');

  const done = await b.go(`${base}/account/delete`, { method: 'POST', form: { csrf, confirm: ' Eve ' }, headers: { origin: base } });
  assert.equal(done.status, 200, done.text);
  assert.match(done.text, /Account deleted/);
  assert.match(String(done.headers['set-cookie']), /Max-Age=0/);
  assert.ok(!grid.accounts.byHandle('eve'));
  assert.ok(!fs.existsSync(folder), 'the box’s files, agent logins included');
  for (const t of ['sessions', 'devices', 'identities', 'instances', 'user_secrets', 'keys', 'tickets', 'device_codes']) assert.equal(grid.db.get(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, eve.id).n, 0, t);
  assert.deepEqual(grid.db.all('SELECT action FROM audit WHERE user_id = ?', eve.id).map((r) => r.action), ['user.delete'], 'only that it happened');
  assert.equal(grid.hostd.inst.has(eve.id), false);
  assert.equal((await b.go(`${origin}/`)).status, 404, 'its address is gone');
  assert.equal((await me()).status, 401, 'and its devices');
  assert.doesNotMatch((await b.go(`${base}/`)).text, /account\/delete/, 'signed out');
});

test('wisp grid users --delete: asks for --yes, leaves a running process to the grid, then deletes', async () => {
  const { gridCli } = await import('../grid/cli.js');
  const b = browser();
  await devSignIn(b, 'fay@example.com');
  const { origin } = await openWisp(b);
  const fay = grid.accounts.byHandle('fay');
  await until(async () => (await b.go(`${origin}/api/health`, { headers: { accept: 'application/json' } })).status === 200, { what: 'fay’s wisp' });
  const out = [];
  const log = console.log;
  console.log = (m) => out.push(String(m));
  try {
    await gridCli(['users', '--delete', 'fay', '--data', cfg.dataDir]);
    assert.match(out.join('\n'), /--delete fay --yes/);
    assert.ok(grid.accounts.byHandle('fay'), 'nothing happens without --yes');
    await assert.rejects(gridCli(['users', '--delete', 'fay', '--yes', '--data', cfg.dataDir]), /running/);
    assert.equal(grid.accounts.byHandle('fay').disabled, 0);
    await grid.hostd.stop(fay.id);
    await gridCli(['users', '--delete', 'fay', '--yes', '--data', cfg.dataDir]);
    assert.match(out.at(-1), /✓ deleted fay/);
    await assert.rejects(gridCli(['users', '--delete', 'nobody', '--yes', '--data', cfg.dataDir]), /Nobody here is called nobody/);
  } finally {
    console.log = log;
  }
  assert.ok(!grid.accounts.byHandle('fay'));
  assert.ok(!fs.existsSync(path.join(cfg.dataDir, 'users', fay.id)));
  assert.equal(grid.db.get('SELECT COUNT(*) AS n FROM user_secrets WHERE user_id = ?', fay.id).n, 0);
});

test('device flow from the phone app: Allow links back to the app, not the account page', async () => {
  const code = await browser().go(`${base}/api/device/code`, { method: 'POST', body: { name: 'Phone (wisp app)' } });
  const b = browser();
  await devSignIn(b, 'pia@example.com');
  const page = await b.go(`${code.json.verification_uri_complete}&app=android`);
  assert.match(page.text, /name="app" value="android"/);
  const allowed = await b.go(`${base}/activate`, { method: 'POST', form: { csrf: csrfOf(page.text), code: code.json.user_code, answer: 'allow', app: 'android' }, headers: { origin: base } });
  assert.match(allowed.text, /Device connected/);
  assert.match(allowed.text, /href="dev\.trywisp\.mobile:\/\/signed-in"[^>]*>Back to the wisp app/);
  assert.doesNotMatch(allowed.text, />Your account</);
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
  assert.doesNotMatch(allowed.text, /dev\.trywisp\.mobile:/, 'a computer gets no link to the phone app');

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

test('maxUsers: the first accounts get in, then the grid is full; existing users still sign in', async () => {
  const dataDir = tmp('grid-full');
  ensureMaster(dataDir);
  assert.throws(() => loadConfig({ dataDir, env: {}, overrides: { domain: 'wisp.localhost', auth: { dev: true, maxUsers: 0 } } }), /maxUsers/);
  const port = await freePort();
  const c2 = loadConfig({ dataDir, env: {}, overrides: { domain: 'wisp.localhost', listen: { host: '127.0.0.1', port }, auth: { dev: true, maxUsers: 2 }, hostd: { path: fakeBin } } });
  const g2 = await startGrid(c2, { log: () => {} });
  try {
    const signIn = async (email) => {
      const b = browser();
      const start = await b.go(`${c2.publicUrl}/auth/dev/start`);
      return b.go(`${c2.publicUrl}/auth/dev/callback`, { method: 'POST', form: { csrf: csrfOf(start.text), email, return: '/' }, headers: { origin: c2.publicUrl } });
    };
    const seats = async () => (await browser().go(`${c2.publicUrl}/api/seats`, { headers: { accept: 'application/json' } })).json;
    assert.deepEqual(await seats(), { open: true, invite: false, max: 2, left: 2 });
    assert.equal((await signIn('a@x.test')).status, 302);
    // The sign-in page doesn't count seats; the site can read them from another origin.
    assert.doesNotMatch((await browser().go(`${c2.publicUrl}/`)).text, /seats? left/);
    const r = await browser().go(`${c2.publicUrl}/api/seats`, { headers: { accept: 'application/json', origin: 'https://trywisp.dev' } });
    assert.equal(r.headers['access-control-allow-origin'], '*');
    assert.equal(r.json.left, 1);
    assert.equal((await signIn('b@x.test')).status, 302);
    assert.equal((await seats()).left, 0);
    const landing = (await browser().go(`${c2.publicUrl}/`)).text;
    assert.match(landing, /This grid is full/);
    assert.doesNotMatch(landing, /seats left/);
    // A self-hosted grid has no waitlist to send people to.
    assert.doesNotMatch(landing, /Get the next free seat/);
    const full = await signIn('c@x.test');
    assert.equal(full.status, 403);
    assert.match(full.text, /full/);
    assert.doesNotMatch(full.text, /class="err"/, 'the full note says it once, not twice');
    assert.equal((await signIn('a@x.test')).status, 302);
  } finally {
    await g2.close();
  }
});

test('seats "auto": one more while they are taken and the host stayed under target; never on a busy week', async () => {
  const dataDir = tmp('grid-auto');
  const bad = (auth) => assert.throws(() => loadConfig({ dataDir, env: {}, overrides: { auth } }));
  bad({ maxUsers: 'lots' });
  bad({ maxUsers: 'auto', seats: { min: 3, cap: 2 } });
  bad({ maxUsers: 'auto', seats: { target: 1.5 } });
  assert.throws(() => loadConfig({ dataDir, env: {}, overrides: { hostd: { admit: { boxMb: -1 } } } }), /hostd\.admit/);
  const c = loadConfig({ dataDir, env: {}, overrides: { auth: { maxUsers: 'auto', seats: { min: 2, cap: 3 } } } });
  const db = await openDb(dataDir);
  const { createAccounts } = await import('../grid/accounts.js');
  const accounts = createAccounts({ db, cfg: c, secrets: { forget() {} } });
  const H = 3_600_000;
  const join = (n) => accounts.signIn({ provider: 'dev', subject: `${n}@x.test`, email: `${n}@x.test`, emailVerified: true });
  // A day of samples, from (hours ago) on, every hour.
  const day = ({ running = 1, capacity = 4, waits = 0, from = 25 } = {}) => {
    db.run('DELETE FROM load_samples');
    for (let h = from; h > 0; h--) db.run('INSERT INTO load_samples (at, running, capacity, waits) VALUES (?, ?, ?, ?)', Date.now() - h * H, running, capacity, waits);
  };
  try {
    assert.deepEqual(accounts.seats(), { open: true, invite: false, max: 2, left: 2, auto: true });
    day();
    assert.equal(accounts.sample({ running: 1, capacity: 4 }), false, 'seats still free: no need for more');
    join('a');
    join('b');
    day({ from: 10 });
    assert.equal(accounts.sample({ running: 1, capacity: 4 }), false, 'not a whole day watched yet');
    day({ running: 3, capacity: 4 });
    assert.equal(accounts.sample({ running: 3, capacity: 4 }), false, '3 of 4 is over 70%');
    day({ waits: 1 });
    assert.equal(accounts.sample({ running: 1, capacity: 4 }), false, 'someone had to wait for room');
    day();
    assert.equal(accounts.sample({ running: 1, capacity: 4 }), true);
    assert.deepEqual(accounts.seats(), { open: true, invite: false, max: 3, left: 1, auto: true });
    join('c');
    assert.equal(accounts.sample({ running: 1, capacity: 4 }), false, 'at most one a day');
    db.run("UPDATE meta SET v = ? WHERE k = 'seats.grewAt'", String(Date.now() - 30 * H));
    day();
    assert.equal(accounts.sample({ running: 1, capacity: 4 }), false, 'the cap');
    assert.equal(accounts.seats().max, 3);
  } finally {
    db.close();
  }
});

test('the waitlist: a refused sign-in joins it, a freed seat is held for the oldest, and only they get it', async () => {
  const dataDir = tmp('grid-wait');
  const c = loadConfig({ dataDir, env: {}, overrides: { auth: { maxUsers: 1 } } });
  const db = await openDb(dataDir);
  const { createAccounts } = await import('../grid/accounts.js');
  const accounts = createAccounts({ db, cfg: c, secrets: { forget() {} } });
  const idn = (n, verified = true) => ({ provider: 'github', subject: n, login: n, email: `${n}@x.test`, emailVerified: verified });
  try {
    const a = accounts.signIn(idn('a'));
    assert.throws(() => accounts.signIn(idn('b')), (err) => err.full && err.waitlisted);
    assert.throws(() => accounts.signIn(idn('u', false)), (err) => err.full && !err.waitlisted, 'no verified email, nothing to hold a seat for');
    assert.throws(() => accounts.waitFor('nope'), /email/);
    assert.deepEqual(accounts.waitFor('C@x.test '), { joined: false, invited: false, position: 2 });
    assert.deepEqual(accounts.waitFor('c@x.test'), { joined: false, invited: false, position: 2 }, 'once is enough');
    accounts.remove(a.id);
    // b waited longest: the seat is b's, and nobody else can take it meanwhile.
    assert.equal(accounts.seats().left, 0);
    assert.deepEqual(accounts.waitFor('b@x.test'), { joined: false, invited: true, position: 0 });
    assert.throws(() => accounts.signIn(idn('c')), /full/);
    const b = accounts.signIn(idn('b'));
    assert.equal(b.email, 'b@x.test');
    assert.deepEqual(accounts.waitlist().map((r) => [r.email, r.source, !!r.invited_at, !!r.joined_at]), [
      ['b@x.test', 'signin', true, true],
      ['c@x.test', 'site', false, false],
    ]);
    // b leaves: the seat is held for c next. A hold that runs out frees it for anyone.
    accounts.remove(b.id);
    assert.equal(accounts.waitFor('c@x.test').invited, true);
    assert.throws(() => accounts.signIn(idn('d')), /full/);
    db.run('UPDATE waitlist SET invited_at = ?', Date.now() - 8 * 86_400_000);
    assert.equal(accounts.seats().left, 1);
    assert.equal(accounts.signIn(idn('d')).email, 'd@x.test');
  } finally {
    db.close();
  }
});

test('POST /api/waitlist: from another site, answers with CORS, refuses a bad email', async () => {
  const ok = await browser().go(`${base}/api/waitlist`, { method: 'POST', body: { email: 'wait@x.test' }, headers: { origin: 'https://trywisp.dev' } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.headers['access-control-allow-origin'], '*');
  assert.equal(ok.json.ok, true);
  const no = await browser().go(`${base}/api/waitlist`, { method: 'POST', body: { email: 'x' }, headers: { origin: 'https://trywisp.dev' } });
  assert.equal(no.status, 400);
  assert.equal(no.headers['access-control-allow-origin'], '*');
  assert.match(no.json.error, /email/);
});

test('Add a cloud machine: the account page offers the waitlist for more, bigger and GPU machines', async () => {
  const b = browser();
  await devSignIn(b, 'mia@example.com');
  const home = await b.go(`${base}/`);
  assert.match(home.text, /Add a cloud machine/);
  assert.match(home.text, /One cloud machine per account, for now/);
  assert.match(home.text, /<span class="pill soon">Soon<\/span>/);
  const csrf = csrfOf(home.text);
  const post = (body, accept = 'application/json') => b.go(`${base}/machines/waitlist`, { method: 'POST', body, headers: { origin: base, accept } });
  assert.equal((await post({ wants: ['gpu'] })).status, 403, 'CSRF');
  const bad = await post({ csrf, wants: ['moon'] });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /moon/);
  const ok = await post({ csrf, wants: ['gpu', 'bigger'], note: 'fine-tune a 7B' });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json.wish.wants, ['gpu', 'bigger']);
  const listed = (await b.go(`${base}/`)).text;
  assert.match(listed, /On the waitlist for a bigger machine and GPUs\./);
  assert.match(listed, /name="want_gpu" value="1" checked/);
  assert.match(listed, /fine-tune a 7B<\/textarea>/);
  assert.deepEqual(grid.accounts.machineWishes().map((r) => [r.handle, r.wants]), [['mia', 'gpu,bigger']]);
  // Without script the form posts its checkboxes and comes back to the page; none: off the list.
  const off = await b.go(`${base}/machines/waitlist`, { method: 'POST', form: { csrf }, headers: { origin: base } });
  assert.equal(off.status, 302);
  assert.equal(grid.accounts.machineWish(grid.accounts.byHandle('mia').id), null);
});

test('the sign-in page offers only the sign-ins this grid has, and links shared from it get a preview', async () => {
  const page = (await browser().go(`${base}/`)).text;
  assert.match(page, /With Corp SSO or GitHub\./);
  assert.doesNotMatch(page, /Google/);
  assert.match(page, /Free while in preview/);
  assert.doesNotMatch(page, /seats left/, 'no cap, no count');
  assert.match(page, new RegExp(`<meta property="og:image" content="${cfg.publicUrl}/_grid/a/og.png">`));
  const og = await browser().go(`${base}/_grid/a/og.png`);
  assert.equal(og.status, 200);
  assert.equal(og.headers['content-type'], 'image/png');
});

test('the hosted grid, once full, sends new people to the waitlist first and still signs in the rest', async () => {
  const { signInPage } = await import('../grid/pages.js');
  const providers = new Map([['github', { id: 'github', label: 'GitHub' }]]);
  const hosted = { name: 'wisp Grid', domain: 'grid.trywisp.dev', publicUrl: 'https://grid.trywisp.dev' };
  const full = signInPage({ cfg: hosted, providers, seats: { open: true, invite: false, max: 5, left: 0 } });
  assert.match(full, /All preview seats are taken/);
  assert.match(full, /<a class="btn first" href="https:\/\/trywisp\.dev\/cloud\.html#join">/);
  assert.match(full, /<a class="btn" href="\/auth\/github\/start">/, 'GitHub stays, as the second button');
  const open = signInPage({ cfg: hosted, providers, seats: { open: true, invite: false, max: 5, left: 3 } });
  assert.doesNotMatch(open, /seats? left|of 5/, 'no count: seats open as the grid grows');
  assert.match(open, /Free while in preview/);
  assert.doesNotMatch(open, /cloud\.html#join/);
  // Turned away at sign-in with a verified email: already on the waitlist, so no form to send them to.
  const listed = signInPage({ cfg: hosted, providers, seats: { open: true, invite: false, max: 5, left: 0 }, waitlisted: true });
  assert.match(listed, /you’re on the waitlist/);
  assert.doesNotMatch(listed, /cloud\.html#join/);
  // An allow list or closed sign-ups say so; no count.
  const invite = signInPage({ cfg: hosted, providers, seats: { open: true, invite: true, max: 5, left: 3 } });
  assert.match(invite, /Invite only/);
  assert.doesNotMatch(invite, /seats left/);
});

test('the sign-in funnel: only the hosted grid loads PostHog on its page and ties the GitHub steps to that visitor', async () => {
  const { signInPage } = await import('../grid/pages.js');
  const { createGridTelemetry } = await import('../grid/telemetry.js');
  const { posthogKey } = await import('../server/telemetry.js');
  const providers = new Map([['github', { id: 'github', label: 'GitHub' }]]);
  const hosted = { name: 'wisp Grid', domain: 'grid.trywisp.dev', publicUrl: 'https://grid.trywisp.dev' };
  assert.match(signInPage({ cfg: hosted, providers, analytics: true }), /posthog\.init\("phc_[^"]+",\{api_host:'https:\/\/us\.i\.posthog\.com'.*grid_signin_clicked/s);
  assert.doesNotMatch(signInPage({ cfg: hosted, providers }), /posthog/);
  assert.doesNotMatch((await browser().go(`${base}/`)).text, /posthog/, 'a self-hosted grid loads nothing');

  const sent = [];
  const post = async (b) => (sent.push(...b), true);
  const cookie = { [`ph_${posthogKey()}_posthog`]: JSON.stringify({ distinct_id: '019a0b6c-1d2e-7f00-8a00-0123456789ab', $sesid: [] }) };
  const self = createGridTelemetry({ telemetry: true, domain: 'wisp.example.com' }, { post, env: {} });
  assert.equal(self.pages, false);
  assert.equal(self.visitorId(cookie), null);
  self.funnel('grid_auth_started', 'x', { provider: 'github' });
  self.close();
  assert.equal(sent.length, 0, 'no funnel events from a self-hosted grid');
  assert.equal(createGridTelemetry({ telemetry: true, domain: 'grid.trywisp.dev' }, { post, env: { DO_NOT_TRACK: '1' } }).pages, false);

  const s = createGridTelemetry({ telemetry: true, domain: 'grid.trywisp.dev' }, { post, env: {} });
  assert.equal(s.pages, true);
  const v = s.visitorId(cookie);
  assert.equal(v, '019a0b6c-1d2e-7f00-8a00-0123456789ab');
  assert.equal(s.visitorId({ [`ph_${posthogKey()}_posthog`]: '{"distinct_id":"<script>"}' }), null, 'only an id-shaped value');
  assert.equal(s.visitorId({ [`ph_${posthogKey()}_posthog`]: 'not json' }), null);
  s.funnel('grid_auth_started', v, { provider: 'github' });
  s.funnel('grid_auth_finished', v, { provider: 'github', signup: true });
  s.funnel('grid_auth_failed', null, { provider: 'github', reason: 'full' });
  s.close();
  assert.deepEqual(sent.map((e) => [e.event, e.properties.distinct_id]), [['grid_auth_started', v], ['grid_auth_finished', v], ['grid_auth_failed', 'grid-anonymous']]);
  assert.equal(sent[1].properties.signup, true);
});

test('GitHub sign-in still works with a PostHog cookie from trywisp.dev', async () => {
  const { posthogKey } = await import('../server/telemetry.js');
  const b = browser();
  b.jar.set(new URL(base).host, new Map([[`ph_${posthogKey()}_posthog`, encodeURIComponent(JSON.stringify({ distinct_id: 'abcdef0123456789' }))]]));
  await b.follow(`${base}/auth/github/start`);
  assert.match((await b.go(`${base}/`)).text, /Hi Octo/);
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
  if (!win) assert.equal(fs.statSync(path.join(dataDir, 'secrets', 'master.json')).mode & 0o777, 0o600); // Windows has no POSIX modes
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
    if (!win) assert.equal(fs.statSync(secretsFile).mode & 0o777, 0o600);
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
    // Signing in to an agent on it goes through to the cloud computer's own wisp.
    const there = await api(`/machines/${mid}/agents/codex/login`);
    assert.equal(there.status, 200, JSON.stringify(there.json));
    assert.equal(there.json.agent, 'codex');
    assert.equal(there.json.state, 'idle');
    assert.equal((await api(`/machines/${mid}/agents/opencode/login`, { method: 'POST' })).status, 400);
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

    // This computer on the grid: Machines → Reach this computer from anywhere.
    const on = await api('/computer', { method: 'POST', body: { on: true } });
    assert.equal(on.status, 200, JSON.stringify(on.json));
    assert.ok(on.json.url.includes(`--ada.${cfg.domain}`), on.json.url);
    await until(async () => (await api('/computer')).json.state === 'online', { what: 'the desktop’s tunnel' });
    // The phone, signed in as ada, opens the desktop's own wisp through the grid.
    const phone = await deviceToken('ada@example.com', 'Phone (wisp app)');
    const health = await browser().go(`${on.json.url}/api/health`, { headers: { authorization: `Bearer ${phone}`, accept: 'application/json' } });
    assert.equal(health.status, 200, health.text);
    assert.equal(health.json.pid, process.pid, 'the desktop’s own wisp answered');
    const listed = await browser().go(`${base}/api/computers`, { headers: { authorization: `Bearer ${phone}` } });
    assert.deepEqual(listed.json.computers.map((x) => [x.url, x.online, x.mine]), [[on.json.url, true, false]]);
    // Another of ada's computers joins this desktop's Machines (and not this one itself).
    const other = await deviceToken('ada@example.com', 'Studio (wisp)');
    const studio = await browser().go(`${base}/api/computers`, { method: 'POST', body: { name: 'Studio' }, headers: { authorization: `Bearer ${other}` } });
    await desk.computer.sync();
    const ms = (await api('/machines')).json.filter((x) => x.computer);
    assert.deepEqual(ms.map((x) => [x.name, x.url, x.state]), [['Studio', studio.json.url, 'asleep']], 'offline until its tunnel is up');
    assert.equal((await api('/sessions', { method: 'POST', body: { prompt: 'hi', agent: 'claude', machine: ms[0].id } })).status, 503);
    // Removing it here takes it off the grid; off, this computer leaves the grid too.
    assert.equal((await api(`/machines/${ms[0].id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await api('/computer', { method: 'POST', body: { on: false } })).json.on, false);
    assert.deepEqual((await browser().go(`${base}/api/computers`, { headers: { authorization: `Bearer ${phone}` } })).json.computers, []);
  } finally {
    desk.shutdown();
    desk.server?.close();
  }
});

// A device token for that account, through the device flow (allowed in the browser).
async function deviceToken(email, name) {
  const code = await browser().go(`${base}/api/device/code`, { method: 'POST', body: { name } });
  const b = browser();
  await devSignIn(b, email);
  const page = await b.go(code.json.verification_uri_complete);
  await b.go(`${base}/activate`, { method: 'POST', form: { csrf: csrfOf(page.text), code: code.json.user_code, answer: 'allow' }, headers: { origin: base } });
  return until(async () => (await browser().go(`${base}/api/device/token`, { method: 'POST', body: { device_code: code.json.device_code } })).json.token, { what: `${name}’s token` });
}

test('a computer added to the grid: reached through its tunnel, signed in like the wisp, offline and gone with its device', async () => {
  const { dialTunnel } = await import('../server/grid-tunnel.js');
  // Stands in for wisp on the computer: says what reached it, echoes bodies, streams events.
  const seen = [];
  const local = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.write('event: ping\ndata: {}\n\n');
    }
    let t = '';
    req.on('data', (d) => (t += d));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'local=1' });
      res.end(JSON.stringify({ method: req.method, body: t, host: req.headers.host }));
    });
  });
  const port = (await listen(local)).split(':').pop();
  const laptop = await deviceToken('cara@example.com', 'Cara’s MacBook Pro (wisp)');
  const phone = await deviceToken('cara@example.com', 'Phone (wisp app)');
  const auth = (t) => ({ authorization: `Bearer ${t}`, accept: 'application/json' });
  const c = (await browser().go(`${base}/api/computers`, { method: 'POST', body: { name: 'Cara’s MacBook Pro' }, headers: auth(laptop) })).json;
  assert.equal(c.url, cfg.instanceUrl('cara-s-macbook-pro--cara'));
  assert.equal((await browser().go(`${base}/api/computers`, { method: 'POST', body: { name: 'Cara’s MacBook Pro' }, headers: auth(laptop) })).json.id, c.id, 'one computer per device');
  // Not connected yet: it says so, without asking it anything.
  assert.equal((await browser().go(`${c.url}/_grid/state`, { headers: auth(phone) })).json.state, 'offline');
  const off = await browser().go(`${c.url}/api/hello`, { headers: auth(phone) });
  assert.deepEqual([off.status, off.json.offline], [503, true]);

  const states = [];
  const t = dialTunnel({ url: base, id: c.id, token: laptop, port, onState: (s) => states.push(s.state) });
  try {
    await until(() => states.includes('online'), { what: 'the tunnel' });
    assert.equal((await browser().go(`${c.url}/_grid/state`, { headers: auth(phone) })).json.state, 'running');
    const r = await browser().go(`${c.url}/api/hello?x=1`, { headers: { ...auth(phone), origin: 'https://evil.example', cookie: 'grid=1' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.host, `127.0.0.1:${port}`, 'as if asked on the computer itself');
    const h = seen.at(-1).headers;
    assert.equal(seen.at(-1).url, '/api/hello?x=1');
    assert.ok(!h.authorization && !h.cookie && !h.origin, 'the grid’s sign-in stays on the grid');
    const posted = await browser().go(`${c.url}/api/echo`, { method: 'POST', body: { a: 1 }, headers: auth(phone) });
    assert.deepEqual([posted.json.method, posted.json.body], ['POST', '{"a":1}']);
    // Event streams stream.
    const first = await new Promise((resolve, reject) => {
      const u = new URL(c.url);
      http.get({ host: '127.0.0.1', port: u.port, path: '/api/events', headers: { host: u.host, ...auth(phone) } }, (res) => res.once('data', (d) => (resolve(String(d)), res.destroy()))).on('error', reject);
    });
    assert.match(first, /event: ping/);
    // Someone else's token, or none: not in.
    const dee = await deviceToken('dee@example.com', 'Dee’s laptop');
    assert.equal((await browser().go(`${c.url}/api/hello`, { headers: auth(dee) })).status, 401);
    assert.equal((await browser().go(`${c.url}/api/hello`, { headers: { accept: 'application/json' } })).status, 401);
    assert.equal((await browser().go(`${base}/api/device/link`, { method: 'POST', body: { computer: c.id }, headers: auth(dee) })).status, 404);
    // The phone app's way in: a one-time link to the computer's address, then its cookie.
    const link = await browser().go(`${base}/api/device/link`, { method: 'POST', body: { computer: c.id, path: '/' }, headers: auth(phone) });
    assert.ok(link.json.url.startsWith(`${c.url}/_grid/auth?`), link.json.url);
    const app = browser();
    assert.equal((await app.go(link.json.url)).status, 302);
    assert.equal((await app.go(`${c.url}/api/hello`, { headers: { accept: 'application/json' } })).status, 200);
    assert.equal((await app.go(`${c.url}/api/echo`, { method: 'POST', body: {}, headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await app.go(`${c.url}/api/echo`, { method: 'POST', body: {}, headers: { origin: c.url } })).status, 200);
    // Listed for every device, with which one is the computer itself; Caddy may get its certificate.
    const list = (await browser().go(`${base}/api/computers`, { headers: auth(phone) })).json.computers;
    assert.deepEqual(list.map((x) => [x.name, x.online, x.mine]), [['Cara’s MacBook Pro', true, false]]);
    assert.equal((await browser().go(`${base}/api/computers`, { headers: auth(laptop) })).json.computers[0].mine, true);
    assert.equal((await browser().go(`http://127.0.0.1:${cfg.listen.port}/_grid/tls-ask?domain=cara-s-macbook-pro--cara.wisp.localhost`, { headers: { host: `127.0.0.1:${cfg.listen.port}` } })).status, 200);
    // Only the device that added it can be it.
    const fake = [];
    const t2 = dialTunnel({ url: base, id: c.id, token: phone, port, onState: (s) => fake.push(s.state) });
    await until(() => fake.includes('gone'), { what: 'a tunnel from another device refused' });
    t2.close();
    // Its device removed (the account page): the computer and its tunnel go too.
    const acct = browser();
    await devSignIn(acct, 'cara@example.com');
    const page = await acct.go(`${base}/`);
    assert.match(page.text, /Your computers[\s\S]*Cara’s MacBook Pro[\s\S]*On the grid as Cara’s MacBook Pro/);
    const devId = new RegExp(`action="/devices/([a-f0-9]+)/revoke"`).exec(page.text.slice(page.text.indexOf('Cara’s MacBook Pro (wisp)')))?.[1];
    assert.ok(devId);
    await acct.go(`${base}/devices/${devId}/revoke`, { method: 'POST', form: { csrf: csrfOf(page.text) }, headers: { origin: base } });
    await until(() => states.includes('gone'), { what: 'the tunnel closed for good' });
    assert.deepEqual((await browser().go(`${base}/api/computers`, { headers: auth(phone) })).json.computers, []);
    assert.equal((await browser().go(`${c.url}/api/hello`, { headers: auth(phone) })).status, 404, 'nothing answers there any more');
  } finally {
    t.close();
    local.close();
  }
});

test('the account page keeps up by itself: its event stream says when a computer comes online, goes offline or is added', async () => {
  const { dialTunnel } = await import('../server/grid-tunnel.js');
  const local = http.createServer((req, res) => res.end('{}'));
  const port = (await listen(local)).split(':').pop();
  const acct = browser();
  await devSignIn(acct, 'gus@example.com');
  assert.match((await acct.go(`${base}/`)).text, /data-live="computers"/);
  // Signed out: no stream.
  assert.equal((await browser().go(`${base}/events`, { headers: { accept: 'text/event-stream' } })).status, 401);
  const u = new URL(base);
  const cookie = [...acct.jar.get(u.host)].map(([k, v]) => `${k}=${v}`).join('; ');
  let got = '';
  const stream = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: u.port, path: '/events', headers: { host: u.host, cookie, accept: 'text/event-stream' } }, (res) => {
      assert.equal(res.headers['content-type'], 'text/event-stream');
      res.setEncoding('utf8');
      res.on('data', (d) => (got += d));
      resolve(res);
    }).on('error', reject);
  });
  const changes = () => got.split('event: change').length - 1;
  let t = null;
  try {
    const laptop = await deviceToken('gus@example.com', 'Gus’s laptop (wisp)');
    await until(() => changes() >= 1, { what: 'a change for the new device' });
    const c = (await browser().go(`${base}/api/computers`, { method: 'POST', body: { name: 'Gus’s laptop' }, headers: { authorization: `Bearer ${laptop}`, accept: 'application/json' } })).json;
    await until(() => changes() >= 2, { what: 'a change for the added computer' });
    const states = [];
    t = dialTunnel({ url: base, id: c.id, token: laptop, port, onState: (s) => states.push(s.state) });
    await until(() => states.includes('online') && changes() >= 3, { what: 'a change for the computer online' });
    assert.match((await acct.go(`${base}/`)).text, /Gus’s laptop<\/b>[\s\S]*?Online/);
    const before = changes();
    t.close();
    await until(() => changes() > before, { what: 'a change for the computer offline' });
    assert.match((await acct.go(`${base}/`)).text, /Gus’s laptop<\/b>[\s\S]*?Offline/);
  } finally {
    t?.close();
    stream.destroy();
    local.close();
  }
});

test('a computer’s tunnel over https (TLS in front of the grid, like Caddy): HTTP/2 comes up on the TLS socket', async () => {
  const tls = await import('node:tls');
  const { dialTunnel } = await import('../server/grid-tunnel.js');
  // Terminates TLS and passes the bytes to the grid, as Caddy does (a throwaway localhost certificate).
  // Caddy keeps the port the grid knows (443); here the request's Host names the grid's own port.
  const fx = (f) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url));
  const front = tls.createServer({ key: fx('tls-localhost.key'), cert: fx('tls-localhost.crt') }, (s) => {
    const up = net.connect(cfg.listen.port, '127.0.0.1');
    s.once('data', (d) => {
      up.write(String(d).replace(/^host: .*$/im, `host: wisp.localhost:${cfg.listen.port}`));
      s.pipe(up);
    });
    up.pipe(s);
    s.on('error', () => up.destroy());
    up.on('error', () => s.destroy());
  });
  const port = await new Promise((r) => front.listen(0, '127.0.0.1', () => r(front.address().port)));
  const local = http.createServer((req, res) => res.end(JSON.stringify({ ok: true, url: req.url })));
  const lport = (await listen(local)).split(':').pop();
  const laptop = await deviceToken('tess@example.com', 'Tess’s laptop (wisp)');
  const c = (await browser().go(`${base}/api/computers`, { method: 'POST', body: { name: 'Tess laptop' }, headers: { authorization: `Bearer ${laptop}`, accept: 'application/json' } })).json;
  // The self-signed certificate: only in this test.
  const was = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const states = [];
  const t = dialTunnel({ url: `https://wisp.localhost:${port}`, id: c.id, token: laptop, port: lport, onState: (x) => states.push(x.state) });
  try {
    await until(() => states.includes('online'), { what: 'the tunnel over TLS' });
    const r = await browser().go(`${c.url}/api/hi`, { headers: { authorization: `Bearer ${laptop}`, accept: 'application/json' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.url, '/api/hi');
    assert.ok(grid.tunnels.online(c.id));
  } finally {
    t.close();
    if (was === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = was;
    front.close();
    local.close();
  }
});

test('a computer that answers nonsense can’t take the grid down or set its cookies', async () => {
  // A computer is whatever its owner runs, so this one speaks raw HTTP/2: an impossible status
  // (000, which Node's own HTTP/2 server won't send) and a cookie for the whole domain.
  const laptop = await deviceToken('ivy@example.com', 'Ivy’s laptop (wisp)');
  const auth = { authorization: `Bearer ${laptop}`, accept: 'application/json' };
  const c = (await browser().go(`${base}/api/computers`, { method: 'POST', body: { name: 'Ivy laptop' }, headers: auth })).json;
  const frame = (type, flags, id, payload) => {
    const h = Buffer.alloc(9);
    h.writeUIntBE(payload.length, 0, 3);
    h[3] = type;
    h[4] = flags;
    h.writeUInt32BE(id, 5);
    return Buffer.concat([h, payload]);
  };
  // HPACK literals: ":status" (static index 8), then a header with a new name.
  const lit = (name, value) => Buffer.concat([Buffer.from([0x00, name.length]), Buffer.from(name), Buffer.from([value.length]), Buffer.from(value)]);
  const answers = [Buffer.concat([Buffer.from([0x08, 3]), Buffer.from('000')]), Buffer.concat([Buffer.from([0x08, 3]), Buffer.from('200'), lit('set-cookie', 'x=1; Domain=wisp.localhost')])];
  const u = new URL(base);
  const sock = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: u.port, path: `/api/computers/${c.id}/tunnel`, headers: { host: u.host, connection: 'Upgrade', upgrade: 'wisp-tunnel', authorization: `Bearer ${laptop}` } });
    req.on('upgrade', (res, s, head) => {
      s.write(frame(4, 0, 0, Buffer.alloc(0)));
      let buf = head || Buffer.alloc(0);
      let preface = false;
      s.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (!preface && buf.length >= 24) [buf, preface] = [buf.subarray(24), true];
        while (preface && buf.length >= 9 && buf.length >= 9 + buf.readUIntBE(0, 3)) {
          const [len, type, flags, id] = [buf.readUIntBE(0, 3), buf[3], buf[4], buf.readUInt32BE(5) & 0x7fffffff];
          buf = buf.subarray(9 + len);
          if (type === 4 && !(flags & 1)) s.write(frame(4, 1, 0, Buffer.alloc(0)));
          if (type === 1) s.write(frame(1, 5, id, answers.shift()));
        }
      });
      resolve(s);
    });
    req.on('error', reject);
    req.end();
  });
  try {
    await until(() => grid.tunnels.online(c.id), { what: 'the raw tunnel' });
    const bad = await browser().go(`${c.url}/api/hello`, { headers: auth });
    assert.equal(bad.status, 502, bad.text);
    const ok = await browser().go(`${c.url}/api/hello`, { headers: auth });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['set-cookie'], undefined, 'no cookies from a computer');
    assert.equal((await browser().go(`${base}/healthz`)).status, 200, 'the grid is still up');
  } finally {
    sock.destroy();
  }
});

test('behind Caddy: limits are per client, Caddy’s own address asks for certificates, and sign-in only returns to paths here', async () => {
  // Every request reaches the grid from loopback, with the client last in X-Forwarded-For.
  const via = (ip) => ({ 'x-forwarded-for': `10.9.9.9, ${ip}` });
  const tunnel = (ip) =>
    new Promise((resolve, reject) => {
      const u = new URL(base);
      const req = http.request({ host: '127.0.0.1', port: u.port, path: '/api/computers/abc/tunnel', headers: { host: u.host, connection: 'Upgrade', upgrade: 'wisp-tunnel', ...via(ip) } });
      req.on('response', (res) => (res.resume(), resolve(res.statusCode)));
      req.on('upgrade', (res, s) => (s.destroy(), resolve(101)));
      req.on('error', reject);
      req.end();
    });
  const spam = [];
  for (let i = 0; i < 61; i++) spam.push(await tunnel('203.0.113.7'));
  assert.equal(spam.at(-1), 429, 'one client: limited');
  assert.equal(await tunnel('203.0.113.8'), 401, 'another client: not limited by the first');
  // A name check passed on by Caddy would tell anyone which handles and computers exist.
  const ask = (headers) => browser().go(`http://127.0.0.1:${cfg.listen.port}/_grid/tls-ask?domain=${cfg.domain}`, { headers: { host: `127.0.0.1:${cfg.listen.port}`, ...headers } });
  assert.equal((await ask({})).status, 200);
  assert.notEqual((await ask(via('203.0.113.9'))).status, 200);
  // Browsers drop tabs and newlines from a Location: "/\t/evil.example" would leave the grid.
  const b = browser();
  await devSignIn(b, 'jo@example.com');
  for (const ret of ['/\t/evil.example', '/\n/evil.example', '//evil.example', '/\\evil.example', 'https://evil.example']) {
    assert.equal((await b.go(`${base}/signin?return=${encodeURIComponent(ret)}`)).location, '/', JSON.stringify(ret));
  }
  assert.equal((await b.go(`${base}/signin?return=${encodeURIComponent('/account?x=1')}`)).location, '/account?x=1');
});

test('the container driver: one locked-down container per user, reachable only from this box', async () => {
  const { containerRun, CONTAINER } = await import('../grid/hostd.js');
  const { args } = containerRun({ ...CONTAINER, resolv: '/data/users/1/resolv.conf', envFile: '/data/users/1/box.env', name: 'wisp-u-1', port: 47001, home: '/data/users/1/home' });
  const s = args.join(' ');
  assert.match(s, /--env-file \/data\/users\/1\/box\.env/, 'its secrets come from a file, not the command line');
  assert.match(s, /--runtime runsc/);
  assert.match(s, /-v \/data\/users\/1\/resolv\.conf:\/etc\/resolv\.conf:ro/, 'a resolver gVisor can reach');
  assert.match(s, /-p 127\.0\.0\.1:47001:47001/, 'published on loopback only');
  assert.match(s, /--cap-drop ALL/);
  assert.match(s, /--security-opt no-new-privileges/);
  assert.match(s, /--memory 1536m .*--pids-limit 512/);
  assert.match(s, /-v \/data\/users\/1\/home:\/home\/wisp /, 'only its own home');
  assert.doesNotMatch(s, /-v \/data\/users\/1:|docker\.sock|--privileged/);
});

test('grid usage stats: off unless grid.json turns them on; fixed values, users as hashes', async () => {
  const { createGridTelemetry } = await import('../grid/telemetry.js');
  const sent = [];
  const post = async (b) => (sent.push(...b), true);
  const off = createGridTelemetry({ domain: 'wisp.example.com' }, { post, env: {} });
  off.audit('u1', 'signup', { provider: 'github' });
  off.close();
  assert.equal(sent.length, 0, 'a self-hosted grid sends nothing by default');
  assert.equal(createGridTelemetry({ telemetry: true }, { post, env: { WISP_TELEMETRY: '0' } }).on, false);

  let t = 1_000_000;
  const s = createGridTelemetry({ telemetry: true, domain: 'grid.trywisp.dev', hostd: { driver: 'container' } }, { post, env: {}, now: () => t });
  s.audit('u1', 'signup', { provider: 'github', email: 'ada@example.com' });
  s.audit(null, 'signup.refused', { provider: 'google', reason: 'full' });
  s.audit('u1', 'signout.all');
  s.box({ user: { id: 'u1' }, state: 'starting', event: 'starting' });
  t += 2500;
  s.box({ user: { id: 'u1' }, state: 'running', event: 'started', startedAt: t });
  t += 12 * 60_000;
  s.box({ user: { id: 'u1' }, state: 'stopped', event: 'idle', startedAt: t - 12 * 60_000, stoppedAt: t });
  s.close();
  assert.deepEqual(sent.map((e) => e.event), ['grid_signup', 'grid_signup_refused', 'grid_box_started', 'grid_box_stopped']);
  const [signup, refused, started, stopped] = sent;
  assert.equal(signup.properties.provider, 'github');
  assert.equal(signup.properties.email, undefined);
  assert.equal(signup.properties.hosted, true);
  assert.match(signup.properties.distinct_id, /^grid-[0-9a-f]{24}$/);
  assert.ok(!signup.properties.distinct_id.includes('u1'));
  assert.equal(signup.properties.$process_person_profile, false);
  assert.deepEqual([refused.properties.reason, refused.properties.distinct_id], ['full', 'grid-anonymous']);
  assert.equal(started.properties.ms, 2500);
  assert.deepEqual([stopped.properties.reason, stopped.properties.minutes], ['idle', 12]);
  assert.throws(() => loadConfig({ dataDir: tmp('grid-tel'), env: {}, overrides: { domain: 'wisp.localhost', auth: { dev: true }, telemetry: 'yes' } }), /telemetry/);
});
