// Telegram on a sleeping cloud wisp, end to end: real Hostd (process driver), real wisp with fake
// agents, fake Telegram on loopback. A box goes to sleep, a webhook wakes it, the message is handled
// once, and it goes back to sleep by itself. Also: who may reach POST /api/channels/inbound (a forged
// header from outside can't), a bad secret, a stale message, a stranger, setWebhook's failure, and a
// box on a grid without the hub, which keeps polling. A computer's polling is
// test/channel-legacy.test.js, which this work leaves untouched.

import { test as nodeTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { browser, installFakeBins, isolateAgentConfigs, makeRepo, sleep, tmp, until } from './helpers.js';

const sqlite = await import('node:sqlite').then(
  () => true,
  () => false,
);
const test = (name, opts, fn) => nodeTest(name, { skip: !sqlite && 'the grid needs node:sqlite (Node 22.13+)', ...(fn ? opts : {}) }, fn || opts);

const fakeBin = installFakeBins();
isolateAgentConfigs();
process.env.WISP_HOME = tmp('inbound-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.FAKE_DELAY = '50';

const { loadConfig } = sqlite ? await import('../grid/config.js') : {};
const { startGrid } = sqlite ? await import('../grid/server.js') : {};
const { ensureMaster } = sqlite ? await import('../grid/secrets.js') : {};
const { startServer } = await import('../server/index.js');

const SECRET = 'x-telegram-bot-api-secret-token';
const CHAT = 42;
const TOKEN = '123:abc';

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// Telegram: what it heard, and what it holds about the webhook.
const tg = { calls: [], msg: 100, hook: { url: '' }, setFail: 0, setMs: 0 };
const called = (m) => tg.calls.filter((c) => c.method === m);
const sent = () => called('sendMessage');
const fake = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const method = new URL(req.url, 'http://x').pathname.split('/').pop();
  const b = body ? JSON.parse(body) : {};
  tg.calls.push({ method, ...b });
  const json = (o) => (res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }), res.end(JSON.stringify(o)));
  if (method === 'setWebhook') {
    if (tg.setMs) await sleep(tg.setMs);
    if (tg.setFail > 0) {
      tg.setFail--;
      return json({ ok: false, description: 'Bad Request: bad webhook: Failed to resolve host' });
    }
    tg.hook = { url: b.url, secret: b.secret_token };
    return json({ ok: true, result: true });
  }
  if (method === 'deleteWebhook') {
    tg.hook = { url: '' };
    return json({ ok: true, result: true });
  }
  if (method === 'getWebhookInfo') return json({ ok: true, result: { url: tg.hook.url } });
  if (method === 'getUpdates') {
    if (tg.hook.url) return json({ ok: false, error_code: 409, description: 'Conflict: can\'t use getUpdates method while webhook is active' });
    await sleep(15);
    return json({ ok: true, result: [] });
  }
  if (method === 'sendMessage') return json({ ok: true, result: { message_id: ++tg.msg } });
  json({ ok: true, result: true });
});

let g; // { grid, port, b, ada, origin }
let nextUpdate = 1000;
let msgId = 1;

// A grid with one user, signed in by cookie. hostd.env sends the box to fake Telegram.
async function boot({ channels = { enabled: true, retryMs: 40 }, idleMs = 1400 } = {}) {
  const dataDir = fs.realpathSync(tmp('inbound-grid'));
  ensureMaster(dataDir);
  const port = await freePort();
  const cfg = loadConfig({ dataDir, env: {}, overrides: { domain: 'wisp.localhost', listen: { host: '127.0.0.1', port }, auth: { dev: true }, hostd: { idleMs, checkMs: 100, path: fakeBin, env: { WISP_TELEGRAM_API: `http://127.0.0.1:${fake.address().port}`, FAKE_DELAY: '50' } }, ...(channels && { channels }) } });
  const grid = await startGrid(cfg, { log: () => {} });
  grid.db.run('INSERT INTO users (id, handle, created_at) VALUES (?, ?, ?)', 'u-ada', 'ada', Date.now());
  const ada = grid.accounts.byHandle('ada');
  const origin = cfg.instanceUrl('ada');
  const b = browser();
  const c = grid.accounts.createSession(ada.id, `i:${ada.id}`, 'test');
  b.jar.set(new URL(origin).host, new Map([['wisp_grid', c]]));
  const api = async (p, { method, body, headers } = {}) => {
    const r = await b.go(`${origin}/api${p}`, { method: method || (body ? 'POST' : 'GET'), body, headers: { accept: 'application/json', origin, ...headers } });
    return r;
  };
  const ok = async (p, o) => {
    const r = await api(p, o);
    assert.ok(r.status < 300, `${p}: ${r.status} ${r.text}`);
    return r.json;
  };
  return { grid, cfg, port, ada, origin, api, ok, b };
}

// Telegram calling the URL it was given, whatever the box is doing.
function webhook(update, secret = tg.hook.secret, extra = {}) {
  const u = new URL(tg.hook.url);
  const data = JSON.stringify(update);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: u.port, method: 'POST', path: u.pathname, headers: { host: u.host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(secret && { [SECRET]: secret }), ...extra } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(data);
  });
}
const msg = (text, { chat = CHAT, date = Math.floor(Date.now() / 1000), id = nextUpdate++ } = {}) => ({ update_id: id, message: { message_id: msgId++, text, chat: { id: chat, type: 'private', first_name: 'Ada' }, from: { id: chat, first_name: 'Ada' }, date } });
const state = () => g.grid.hostd.state(g.ada.id);
// Tasks that ran: the fake agent renames each, so they're counted, not matched by title.
const tasks = async () => (await g.ok('/sessions')).filter((s) => s.title !== 'Welcome to wisp').length;
// Up, and kept up without counting as use, for a test that talks to its port: on a loaded machine
// the idle stop can land between two lines. → what lets it go.
const awake = async () => {
  await g.ok('/status');
  return g.grid.hostd.begin(g.ada.id, { touch: false });
};
const asleep = () => until(() => state() === 'stopped', { what: 'the box asleep', timeout: 20_000 });

before(async () => {
  if (!sqlite) return;
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  g = await boot();
  await g.ok('/projects', { body: { path: makeRepo() } });
  const view = await g.ok('/remote', { method: 'PUT', body: { telegram: { enabled: true, token: TOKEN, allowStart: true } } });
  g.linkCode = view.telegram.linkCode;
  g.view = view;
});
after(async () => {
  await g?.grid.close();
  await g?.other?.grid.close();
  fake.close();
});

test('on a box Telegram takes a webhook to its own URL, with a random secret, and never polls', async () => {
  await until(() => tg.hook.url, { what: 'setWebhook' });
  assert.ok(tg.hook.url.startsWith(`${g.origin}/_in/`), tg.hook.url);
  assert.match(tg.hook.secret, /^[a-f0-9]{64}$/);
  assert.deepEqual(called('setWebhook')[0].allowed_updates, ['message', 'callback_query']);
  assert.equal(called('getUpdates').length, 0);
  const view = await until(async () => {
    const v = await g.ok('/remote');
    return v.status.telegram?.webhook ? v : null;
  }, { what: 'the status' });
  assert.equal(view.status.telegram.ok, true);
  assert.equal(view.telegram.webhook, `••••${tg.hook.secret.slice(-4)}`, 'masked in the view');
  assert.ok(!JSON.stringify(view).includes(tg.hook.secret));
  assert.ok(!JSON.stringify(await g.ok('/config')).includes(tg.hook.secret));
});

test('links over the webhook, while it’s awake', async () => {
  assert.equal(await webhook(msg(`/link ${g.linkCode}`)), 200);
  await until(async () => (await g.ok('/remote')).telegram.linked, { what: 'linked' });
  await until(() => sent().some((m) => /Linked to wisp/.test(m.text)), { what: 'the reply' });
});

test('a box idle-stopped: a webhook wakes it, the task starts once, a retry changes nothing, and it sleeps again by itself', { timeout: 60_000 }, async () => {
  await asleep();
  const hooked = called('setWebhook').length;
  const secret = tg.hook.secret;
  const before = g.grid.db.get('SELECT count(*) n FROM channel_inbox').n;
  await g.ok('/status');
  const ran = await tasks();
  await asleep();
  const u = msg('/new fix the bug');
  const t = Date.now();
  assert.equal(await webhook(u), 200);
  const took = Date.now() - t;
  assert.ok(took < 800, `the 200 took ${took} ms`);
  await until(() => sent().some((m) => /Started in/.test(m.text)), { what: 'the task', timeout: 30_000 });
  const done = g.grid.hostd.begin(g.ada.id, { touch: false });
  // Telegram's retry after a lost 200, at the grid and again past it, straight at the box.
  assert.equal(await webhook(u), 200);
  const direct = await deliverDirect(u, tg.hook.secret);
  assert.equal(direct.status, 200);
  assert.equal(direct.json.duplicate, true);
  await sleep(200);
  assert.equal(sent().filter((m) => /Started in/.test(m.text)).length, 1);
  assert.equal(await tasks(), ran + 1);
  assert.equal(g.grid.db.get('SELECT count(*) n FROM channel_inbox').n, before + 1);
  // A wake isn't a new webhook: a secret that changed would refuse everything held.
  assert.equal(called('setWebhook').length, hooked);
  assert.equal(tg.hook.secret, secret);
  assert.equal(called('getUpdates').length, 0);
  done();
  await asleep();
});

// What delivery does, by hand: to the box's port with the proxy secret and the mark.
async function deliverDirect(update, secret, { headers = {} } = {}) {
  const port = g.grid.hostd.port(g.ada.id);
  const r = await fetch(`http://127.0.0.1:${port}/api/channels/inbound`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wisp-proxy-secret': g.grid.secrets.ensure(g.ada.id, 'wisp-proxy'), 'x-wisp-proxy-via': 'inbox', ...headers }, body: JSON.stringify({ channel: 'telegram', headers: { [SECRET]: secret }, body: Buffer.from(JSON.stringify(update)).toString('base64'), at: Date.now() }) });
  return { status: r.status, json: await r.json() };
}

test('a message that does nothing leaves the idle clock alone: wisp’s, and hostd’s', { timeout: 60_000 }, async () => {
  const done = await awake();
  const status = async () => (await fetch(`http://127.0.0.1:${g.grid.hostd.port(g.ada.id)}/api/status`)).json();
  const was = (await status()).lastActivityAt;
  const touched = g.grid.hostd.inst.get(g.ada.id).lastTouch;
  const n = sent().length;
  assert.equal(await webhook(msg('hello', { chat: 999 })), 200, 'a stranger');
  await until(() => g.grid.db.get('SELECT count(*) n FROM channel_inbox WHERE done_at IS NULL').n === 0, { what: 'delivered' });
  await sleep(100);
  assert.equal((await status()).lastActivityAt, was, 'the route moved wisp’s lastActivityAt');
  assert.equal(g.grid.hostd.inst.get(g.ada.id).lastTouch, touched, 'delivery moved hostd’s lastTouch');
  assert.equal(sent().length, n, 'a stranger hears nothing');
  done();
  await asleep();
});

test('a wrong secret token: the box refuses it and the grid doesn’t retry', { timeout: 60_000 }, async () => {
  await g.ok('/status');
  const ran = await tasks();
  await asleep();
  const n = sent().length;
  assert.equal(await webhook(msg('/new steal it'), 'f'.repeat(64)), 200); // the grid can't tell: only the box holds the secret
  await until(() => state() === 'running', { what: 'the wake', timeout: 30_000 });
  await until(() => g.grid.db.get('SELECT count(*) n FROM channel_inbox WHERE done_at IS NULL').n === 0, { what: 'finished with' });
  const none = await webhook(msg('/new no header'), null);
  assert.equal(none, 200);
  await until(() => g.grid.db.get('SELECT count(*) n FROM channel_inbox WHERE done_at IS NULL').n === 0, { what: 'finished with' });
  await sleep(150);
  assert.equal(sent().length, n);
  assert.equal(await tasks(), ran);
  assert.equal(g.grid.db.get("SELECT dropped FROM channel_urls WHERE channel = 'telegram'").dropped, 0);
});

test('a stale /new doesn’t run, and says so', async () => {
  await g.ok('/status');
  const ran = await tasks();
  await webhook(msg('/new an old one', { date: Math.floor(Date.now() / 1000) - 3600 }));
  await until(() => sent().some((m) => /arrived while wisp was offline/.test(m.text)), { what: 'the refusal' });
  assert.equal(await tasks(), ran);
});

test('the seen list outlives the box: a message redelivered after a restart isn’t run twice', { timeout: 60_000 }, async () => {
  const done = await awake();
  const ran = await tasks();
  const u = msg('/new only once please');
  assert.equal((await deliverDirect(u, tg.hook.secret)).status, 200);
  await until(() => sent().some((m) => /only once please/.test(m.text)), { what: 'the task' });
  await until(async () => !(await g.ok('/status')).live, { what: 'quiet' });
  done();
  await g.grid.hostd.stop(g.ada.id);
  const again = await awake();
  const r = await deliverDirect(u, tg.hook.secret);
  assert.equal(r.json.duplicate, true);
  assert.equal(await tasks(), ran + 1);
  again();
});

test('POST /api/channels/inbound from outside: forged headers get nowhere', async () => {
  const done = await awake();
  const ran = await tasks();
  const real = g.grid.secrets.ensure(g.ada.id, 'wisp-proxy');
  const forged = { 'x-wisp-proxy-secret': real, 'x-wisp-proxy-via': 'inbox' };
  const payload = { channel: 'telegram', headers: { [SECRET]: tg.hook.secret }, body: Buffer.from(JSON.stringify(msg('/new forged'))).toString('base64') };
  // Not signed in, even with the real secret: the edge stops it.
  const anon = browser();
  assert.equal((await anon.go(`${g.origin}/api/channels/inbound`, { method: 'POST', body: payload, headers: forged })).status, 401);
  // Signed in: the edge passes it on with its own headers, so the mark doesn't arrive.
  const r = await g.api('/channels/inbound', { body: payload, headers: forged });
  assert.equal(r.status, 403, r.text);
  // An API key is let in too, and is told apart the same way.
  const key = g.grid.accounts.createApiKey(g.ada.id, 'script');
  const k = await browser().go(`${g.origin}/api/channels/inbound`, { method: 'POST', body: payload, headers: { authorization: `Bearer ${key.key}`, ...forged } });
  assert.equal(k.status, 403, k.text);
  await sleep(100);
  assert.equal(await tasks(), ran);
  // On the box itself: right secret, no mark, and no secret, are both refused.
  const port = g.grid.hostd.port(g.ada.id);
  const local = (headers) => fetch(`http://127.0.0.1:${port}/api/channels/inbound`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
  assert.equal((await local({})).status, 403);
  assert.equal((await local({ 'x-wisp-proxy-secret': real })).status, 403);
  assert.equal((await local({ 'x-wisp-proxy-secret': 'w'.repeat(real.length), 'x-wisp-proxy-via': 'inbox' })).status, 403);
  done();
});

test('off a grid the route is refused, even with the proxy secret and the mark', async () => {
  const secret = 's'.repeat(40);
  const was = { ...process.env };
  process.env.WISP_TRUSTED_PROXY_SECRET = secret;
  process.env.WISP_PUBLIC_URL = 'https://me.example.com';
  delete process.env.WISP_GRID_URL;
  const port = await freePort();
  const srv = await startServer({ port, handleSignals: false });
  try {
    const post = (headers = {}, body = { channel: 'telegram', body: '' }) => fetch(`http://127.0.0.1:${port}/api/channels/inbound`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const marked = { 'x-wisp-proxy-secret': secret, 'x-wisp-proxy-via': 'inbox' };
    assert.equal((await post()).status, 403);
    assert.equal((await post(marked)).status, 403, 'a reverse proxy of your own is not a grid');
    process.env.WISP_GRID_URL = 'http://wisp.localhost:1';
    assert.equal((await post()).status, 403);
    assert.equal((await post({ 'x-wisp-proxy-secret': secret })).status, 403);
    assert.equal((await post(marked)).status, 409, 'on a grid, past the door: Telegram is just off here');
    assert.equal((await post(marked, { channel: 'nope', body: '' })).status, 404);
    assert.equal((await post(marked, { channel: '__proto__', body: '' })).status, 404);
    assert.equal((await post(marked, { channel: 'ntfy', body: '' })).status, 404, 'a channel with no inbound');
    assert.equal((await post(marked, { channel: 'telegram' })).status, 400);
  } finally {
    srv.shutdown();
    srv.server.closeAllConnections?.();
    srv.server.close();
    for (const k of ['WISP_TRUSTED_PROXY_SECRET', 'WISP_PUBLIC_URL', 'WISP_GRID_URL']) if (was[k] === undefined) delete process.env[k];
    else process.env[k] = was[k];
  }
});

test('lost messages: the sender is told once it can be', async () => {
  await g.ok('/status');
  const n = sent().length;
  g.grid.db.run("UPDATE channel_urls SET dropped = 2 WHERE channel = 'telegram'");
  await webhook(msg('hello from a thread'));
  await until(() => sent().length > n, { what: 'a line about it' });
  assert.ok(sent().slice(n).some((m) => /2 messages didn’t reach wisp/.test(m.text)));
  assert.equal((await g.ok('/remote')).status.telegram.dropped, 2);
  await until(() => g.grid.db.get("SELECT dropped FROM channel_urls WHERE channel = 'telegram'").dropped === 0, { what: 'the count reset' });
});

test('unlink takes the webhook down and a new one goes up; off takes it down for good', async () => {
  const done = await awake();
  const first = tg.hook.secret;
  const [dels, sets] = [called('deleteWebhook').length, called('setWebhook').length];
  await g.ok('/remote', { method: 'PUT', body: { telegram: { unlink: true } } });
  await until(() => called('setWebhook').length === sets + 1, { what: 'the new webhook' });
  assert.equal(called('deleteWebhook').length, dels + 1);
  assert.notEqual(tg.hook.secret, first, 'random per setWebhook');
  assert.ok(tg.calls.findLastIndex((c) => c.method === 'deleteWebhook') < tg.calls.findLastIndex((c) => c.method === 'setWebhook'), 'in that order');
  await g.ok('/remote', { method: 'PUT', body: { telegram: { enabled: false } } });
  await until(() => called('deleteWebhook').length === dels + 2, { what: 'deleteWebhook' });
  assert.equal(tg.hook.url, '');
  assert.equal((await g.ok('/remote')).telegram.webhook, '');
  assert.equal(called('getUpdates').length, 0);
  // While off, a message the grid still had is refused, not handled.
  assert.equal((await deliverDirect(msg('/new off'), 'x')).status, 409);
  done();
});

test('switched off while setWebhook is on its way: the webhook doesn’t stay behind', async () => {
  const done = await awake();
  tg.setMs = 400;
  const sets = called('setWebhook').length;
  const hooked = () => g.ok('/remote', { method: 'PUT', body: { telegram: { enabled: true } } });
  await hooked();
  await until(() => called('setWebhook').length === sets + 1, { what: 'setWebhook on its way' });
  await g.ok('/remote', { method: 'PUT', body: { telegram: { enabled: false } } }); // Telegram hasn't answered yet
  await until(() => tg.calls.at(-1).method === 'deleteWebhook' && tg.hook.url === '', { what: 'deleteWebhook after it' });
  assert.equal((await g.ok('/remote')).telegram.webhook, '');
  // And on, off, on: what's left set is the last one, with the secret wisp kept.
  await hooked();
  await until(() => called('setWebhook').length === sets + 2, { what: 'the second' });
  await g.ok('/remote', { method: 'PUT', body: { telegram: { enabled: false } } });
  await hooked();
  tg.setMs = 0;
  await until(async () => tg.hook.url && (await g.ok('/remote')).telegram.webhook === `••••${tg.hook.secret.slice(-4)}`, { what: 'one webhook, wisp’s' });
  await g.ok('/remote', { method: 'PUT', body: { telegram: { enabled: false } } });
  await until(() => tg.hook.url === '', { what: 'off again' });
  done();
});

test('setWebhook failing says so in status, doesn’t poll, and comes right by itself', async () => {
  tg.setFail = 2;
  const sets = called('setWebhook').length;
  await g.grid.hostd.ensure(g.ada);
  await g.ok('/remote', { method: 'PUT', body: { telegram: { enabled: true } } });
  const view = await until(async () => {
    const v = await g.ok('/remote');
    return v.status.telegram?.ok === false ? v : null;
  }, { what: 'the error in status' });
  assert.match(view.status.telegram.error, /Couldn’t set the webhook: Telegram: Bad Request: bad webhook/);
  assert.equal(view.status.telegram.webhook, false);
  assert.equal(called('getUpdates').length, 0);
  assert.equal(called('setWebhook').length > sets, true);
});

test('a box on a grid without the hub polls as it always did, and a webhook left over goes first', { timeout: 60_000 }, async () => {
  const o = (g.other = await boot({ channels: null, idleMs: 1e9 }));
  await o.ok('/status');
  tg.hook = { url: 'http://left.over/_in/x', secret: 'old' }; // getUpdates answers 409 until it's gone
  const home = o.grid.hostd.dirs(o.ada).wisp;
  await o.ok('/remote', { method: 'PUT', body: { telegram: { enabled: true, token: TOKEN } } });
  const sets = called('setWebhook').length;
  await until(() => called('getUpdates').length > 0, { what: 'polling' });
  assert.equal(called('setWebhook').length, sets);
  await o.grid.hostd.stop(o.ada.id);
  // An old config from the time this grid had the hub: same box, hub since turned off.
  const file = `${home}/config.json`;
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.remote.telegram.hook = { url: 'http://left.over/_in/x', secret: 'old', seen: [] };
  fs.writeFileSync(file, JSON.stringify(cfg));
  const dels = called('deleteWebhook').length;
  const polls = called('getUpdates').length;
  await o.ok('/status');
  await until(() => called('deleteWebhook').length === dels + 1, { what: 'deleteWebhook' });
  assert.equal(tg.hook.url, '');
  await until(() => called('getUpdates').length > polls, { what: 'polling again' });
  assert.ok(tg.calls.findLastIndex((c) => c.method === 'deleteWebhook') < tg.calls.findLastIndex((c) => c.method === 'getUpdates'));
});
