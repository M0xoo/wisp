// Telegram and Slack on a sleeping cloud wisp, end to end: real Hostd (process driver), real wisp with
// fake agents, fake Telegram and Slack on loopback. A box goes to sleep, a webhook wakes it, the message is handled
// once, and it goes back to sleep by itself. Also: who may reach POST /api/channels/inbound (a forged
// header from outside can't), a bad secret, a stale message, a stranger, setWebhook's failure, and a
// box on a grid without the hub, which keeps polling. A computer's polling is
// test/channel-legacy.test.js, which this work leaves untouched.

import { createHmac } from 'node:crypto';
import { test as nodeTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { browser, installFakeBins, isolateAgentConfigs, makeRepo, sleep, tmp, until } from './helpers.js';
import { FakeDiscord } from './fixtures/fake-discord.mjs';
import { FakeSlack } from './fixtures/fake-slack.mjs';

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
const tg = { calls: [], msg: 100, hook: { url: '' }, setFail: 0, setMs: 0, delFail: 0 };
const slack = new FakeSlack();
const called = (m) => tg.calls.filter((c) => c.method === m);
const sent = () => called('sendMessage');
const fake = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const [bot, method] = new URL(req.url, 'http://x').pathname.split('/').slice(-2);
  const b = body ? JSON.parse(body) : {};
  tg.calls.push({ method, bot, ...b });
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
    if (tg.delFail > 0) {
      tg.delFail--;
      return json({ ok: false, description: 'Too Many Requests' });
    }
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
async function boot({ channels = { enabled: true, retryMs: 40 }, idleMs = 1400, env = {} } = {}) {
  const dataDir = fs.realpathSync(tmp('inbound-grid'));
  ensureMaster(dataDir);
  const port = await freePort();
  const cfg = loadConfig({ dataDir, env: {}, overrides: { domain: 'wisp.localhost', listen: { host: '127.0.0.1', port }, auth: { dev: true }, hostd: { idleMs, checkMs: 100, path: fakeBin, env: { WISP_TELEGRAM_API: `http://127.0.0.1:${fake.address().port}`, WISP_SLACK_API: slack.api, FAKE_DELAY: '50', ...env } }, ...(channels && { channels }) } });
  const logs = [];
  const grid = await startGrid(cfg, { log: (m) => logs.push(m) });
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
  return { grid, cfg, port, ada, origin, api, ok, b, logs };
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
  await slack.start();
  g = await boot();
  await g.ok('/projects', { body: { path: makeRepo() } });
  const view = await g.ok('/remote', { method: 'PUT', body: { telegram: { enabled: true, token: TOKEN, allowStart: true } } });
  g.linkCode = view.telegram.linkCode;
  g.view = view;
});
after(async () => {
  await g?.grid.close();
  await old?.grid.close();
  await old?.other?.grid.close();
  fake.close();
  if (sqlite) slack.stop(); // never started on a Node with no node:sqlite
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
async function deliverDirect(update, secret, { headers = {}, dropped } = {}) {
  const port = g.grid.hostd.port(g.ada.id);
  const r = await fetch(`http://127.0.0.1:${port}/api/channels/inbound`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wisp-proxy-secret': g.grid.secrets.ensure(g.ada.id, 'wisp-proxy'), 'x-wisp-proxy-via': 'inbox', ...headers }, body: JSON.stringify({ channel: 'telegram', headers: { [SECRET]: secret }, body: Buffer.from(JSON.stringify(update)).toString('base64'), at: Date.now(), dropped }) });
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

test('the line about lost messages waits for a message that passed: a forged one says nothing', async () => {
  const done = await awake();
  const n = sent().length;
  assert.equal((await deliverDirect(msg('forged'), 'a-guess', { dropped: 2 })).status, 403);
  await sleep(100);
  assert.equal(sent().length, n, 'told by a message nobody verified');
  assert.equal((await deliverDirect(msg('hello'), tg.hook.secret, { dropped: 2 })).status, 200);
  assert.ok(sent().slice(n).some((m) => /2 messages didn’t reach wisp/.test(m.text)));
  done();
});

test('only the linked chat, or the code that links one, is accepted: a stranger gets a 403 and no answer', async () => {
  const done = await awake();
  const n = sent().length;
  const refused = async (update) => assert.equal((await deliverDirect(update, tg.hook.secret)).status, 403);
  await refused(msg('hello', { chat: 999 }));
  await refused({ update_id: nextUpdate++, callback_query: { id: '1', data: 'x', message: { message_id: 1, chat: { id: 999 } } } });
  const seen = msg('hello', { chat: 999 });
  await refused(seen);
  await refused(seen); // the same one again isn't a pass either
  assert.equal((await deliverDirect(msg('/help'), tg.hook.secret)).status, 200, 'the linked chat');
  assert.equal(sent().length, n + 1);
  const sets = called('setWebhook').length;
  const view = await g.ok('/remote', { method: 'PUT', body: { telegram: { unlink: true } } });
  await until(() => called('setWebhook').length === sets + 1, { what: 'the new webhook' });
  await refused(msg('000000', { chat: 999 }));
  assert.equal((await deliverDirect(msg(`/start ${view.telegram.linkCode}`), tg.hook.secret)).status, 200, 'the right code');
  assert.equal((await g.ok('/remote')).telegram.linked, true);
  done();
});

test('lost messages: the sender is told once it can be', async () => {
  await g.ok('/status');
  const n = sent().length;
  g.grid.db.run("UPDATE channel_urls SET dropped = 2 WHERE channel = 'telegram'");
  await webhook(msg('hello from a thread'));
  // The message's own answer goes first (inbound, then dropped: routes/channels.js): wait for the line.
  await until(() => sent().slice(n).some((m) => /2 messages didn’t reach wisp/.test(m.text)), { what: 'a line about it' });
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

test('deleteWebhook failing: the mark outlives the box, holds the old bot, and the next start takes it down', { timeout: 60_000 }, async () => {
  let done = await awake();
  await g.ok('/remote', { method: 'PUT', body: { telegram: { enabled: true } } });
  await until(() => tg.hook.url, { what: 'the webhook' });
  const url = tg.hook.url;
  const dels = called('deleteWebhook').length;
  tg.delFail = 1;
  await g.ok('/remote', { method: 'PUT', body: { telegram: { enabled: false, token: '456:def' } } }); // off, and another bot
  await until(() => called('deleteWebhook').length === dels + 1, { what: 'the first try' });
  await until(async () => /Couldn’t remove the webhook/.test((await g.ok('/remote')).status.telegram?.error), { what: 'said in status' });
  assert.equal(tg.hook.url, url, 'Telegram still calls');
  done();
  await g.grid.hostd.stop(g.ada.id, 'idle');
  assert.equal(await webhook(msg('still calling')), 200);
  await until(() => tg.hook.url === '', { what: 'taken down by the next start' });
  assert.equal(called('deleteWebhook').at(-1).bot, `bot${TOKEN}`, 'on the bot it was set on');
  done = await awake();
  await until(async () => !(await g.ok('/remote')).status.telegram?.error, { what: 'the error gone' });
  const n = called('deleteWebhook').length;
  await g.ok('/remote', { method: 'PUT', body: { telegram: { token: TOKEN } } }); // a start: nothing left to do
  await sleep(100);
  assert.equal(called('deleteWebhook').length, n);
  done();
});

test('rotate: a new URL, the same secret and seen list, the old URL dead, and a failed setWebhook comes right', async () => {
  const done = await awake();
  await g.ok('/remote', { method: 'PUT', body: { telegram: { enabled: true } } });
  await until(() => tg.hook.url, { what: 'the webhook' });
  const code = (await g.ok('/remote')).telegram.linkCode;
  assert.equal((await deliverDirect(msg(`/start ${code}`), tg.hook.secret)).status, 200);
  const [first, secret] = [tg.hook.url, tg.hook.secret];
  const m = msg('/help');
  assert.equal((await deliverDirect(m, secret)).status, 200);
  assert.deepEqual(await g.ok('/channels/rotate', { body: { channel: 'telegram' } }), { ok: true });
  const second = tg.hook.url;
  assert.notEqual(second, first);
  assert.equal(tg.hook.secret, secret, 'held messages carry the secret they came with');
  assert.equal((await deliverDirect(m, secret)).json.duplicate, true, 'the seen list stays');
  const n = sent().length;
  tg.hook.url = first;
  assert.equal(await webhook(msg('/help')), 404, 'the old URL');
  tg.hook.url = second;
  assert.equal(await webhook(msg('/help')), 200);
  await until(() => sent().length === n + 1, { what: 'the new URL works' });
  tg.setFail = 1;
  const r = await g.api('/channels/rotate', { body: { channel: 'telegram' } });
  assert.equal(r.status, 502);
  await until(() => tg.hook.url && tg.hook.url !== second, { what: 'set again by itself' });
  assert.equal(tg.hook.secret, secret);
  assert.equal((await g.api('/channels/rotate', { body: { channel: 'nope' } })).status, 404);
  await g.ok('/remote', { method: 'PUT', body: { telegram: { enabled: false } } });
  await until(() => tg.hook.url === '', { what: 'off' });
  assert.equal((await g.api('/channels/rotate', { body: { channel: 'telegram' } })).status, 409, 'no webhook to rotate');
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

// Slack, the same way: real grid, real box, fake Slack (Web API only: there's no socket on a box).
const SIGNING = 'signing-secret-of-the-app-0123456';
const BOT = 'xoxb-1-box-bot-token';
const ME = 'U0LINKED';
const STRANGER = 'U0STRANGE';
let hookUrl;
let old; // the Telegram grid, closed at the end
let evId = 1;
let slackTs = 10;

const nowS = () => Math.floor(Date.now() / 1000);
const tsOf = (s = nowS()) => `${s}.${String(++slackTs).padStart(6, '0')}`;
const signed = (body, ts = nowS(), secret = SIGNING) => ({ 'x-slack-request-timestamp': String(ts), 'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}` });
const event = (text, { user = ME, channel = 'D1', id = `Ev${evId++}`, at = nowS(), ...more } = {}) => ({ type: 'event_callback', team_id: 'T1', api_app_id: 'A1', event_id: id, event_time: at, event: { type: 'message', channel_type: 'im', user, text, channel, ts: tsOf(at), client_msg_id: `cm-${id}`, ...more } });
const mention = (text, o = {}) => {
  const e = event(`<@UBOT> ${text}`, { channel: 'C1', ...o });
  delete e.event.channel_type;
  e.event.type = 'app_mention';
  return e;
};
// Slack calling the Request URL from the manifest. → { status, json }
function slackCall(payload, { url = hookUrl, ts, headers, secret } = {}) {
  const u = new URL(url);
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: u.port, method: 'POST', path: u.pathname, headers: { host: u.host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(headers || signed(body, ts, secret)) } }, (res) => {
      let t = '';
      res.on('data', (d) => (t += d));
      res.on('end', () => {
        let json = {};
        try {
          json = JSON.parse(t);
        } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
// What delivery does, by hand, with the time the grid would stamp on it.
async function slackDirect(payload, { ts, at = Date.now(), dropped, headers, secret, mark = true } = {}) {
  const body = JSON.stringify(payload);
  const port = g.grid.hostd.port(g.ada.id);
  const r = await fetch(`http://127.0.0.1:${port}/api/channels/inbound`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wisp-proxy-secret': g.grid.secrets.ensure(g.ada.id, 'wisp-proxy'), ...(mark && { 'x-wisp-proxy-via': 'inbox' }) }, body: JSON.stringify({ channel: 'slack', headers: headers || signed(body, ts, secret), body: Buffer.from(body).toString('base64'), at, dropped }) });
  return { status: r.status, json: await r.json() };
}
const slackPosted = (re) => slack.posted.filter((p) => re.test(p.text));
const held = () => g.grid.db.get("SELECT count(*) n FROM channel_inbox WHERE channel = 'slack' AND done_at IS NULL").n;
const slackRows = () => g.grid.db.get("SELECT count(*) n FROM channel_inbox WHERE channel = 'slack'").n;

test('Slack on a box: the manifest carries its own URL and no socket, and turning on needs no app token', async () => {
  old = g;
  g = await boot();
  await g.ok('/projects', { body: { path: makeRepo() } });
  const m = await g.ok('/remote/slack/manifest');
  hookUrl = m.settings.event_subscriptions.request_url;
  assert.ok(hookUrl.startsWith(`${g.origin}/_in/`), hookUrl);
  assert.equal(m.settings.socket_mode_enabled, false);
  assert.equal(m.settings.interactivity.is_enabled, false, 'no request URL for clicks on a box yet');
  assert.deepEqual(m.settings.event_subscriptions.bot_events, ['app_mention', 'message.im']);
  assert.equal((await g.api('/remote', { method: 'PUT', body: { slack: { signingSecret: 'short' } } })).status, 400);
  const view = await g.ok('/remote', { method: 'PUT', body: { slack: { enabled: true } } });
  assert.equal(view.slack.enabled, true);
  assert.equal(view.slack.box, true);
  assert.equal(view.slack.connected, false, 'nothing to go on yet');
});

test('Slack’s URL check before there’s a signing secret: the challenge comes back, and nothing else gets in', async () => {
  const done = await awake();
  const ch = await slackCall({ type: 'url_verification', challenge: 'first', token: 'x' }, { headers: {} });
  assert.equal(ch.status, 200);
  assert.deepEqual(ch.json, { challenge: 'first' });
  assert.equal(await slackCall(event('hello'), { headers: {} }).then((r) => r.status), 200);
  await until(() => held() === 0, { what: 'finished with' });
  assert.equal(slack.posted.length, 0);
  done();
});

test('Slack: signing secret and bot token set it going, with no socket; secrets stay masked', async () => {
  const view = await g.ok('/remote', { method: 'PUT', body: { slack: { signingSecret: SIGNING, botToken: BOT } } });
  assert.equal(view.slack.signingSecret, `••••${SIGNING.slice(-4)}`);
  assert.ok(!JSON.stringify(await g.ok('/config')).includes(SIGNING));
  const on = await until(async () => {
    const v = await g.ok('/remote');
    return v.slack.connected ? v : null;
  }, { what: 'it says it’s working' });
  assert.equal(on.slack.team, 'Acme');
  assert.equal(on.status.slack.ok, true);
  assert.equal(slack.opens, 0, 'a box never opens a socket');
  assert.equal(slack.calls.filter((c) => c.method === 'apps.connections.open').length, 0);
  g.linkCode = on.slack.linkCode;
});

test('Slack’s URL check once a secret is set: signed or refused', async () => {
  const done = await awake();
  const payload = { type: 'url_verification', challenge: 'again', token: 'x' };
  assert.deepEqual((await slackCall(payload)).json, { challenge: 'again' });
  assert.equal((await slackCall(payload, { secret: 'wrong-secret-wrong-secret' })).status, 403);
  await until(async () => /signature/.test((await g.ok('/remote')).status.slack?.error), { what: 'said in status' });
  assert.deepEqual((await slackCall(payload)).json, { challenge: 'again' });
  await until(async () => !(await g.ok('/remote')).status.slack?.error, { what: 'the error gone' });
  done();
});

test('Slack: a bad URL check from whoever holds the URL doesn’t stay up: any verified event clears it, a forged one doesn’t', async () => {
  const done = await awake();
  const wrong = 'wrong-secret-wrong-secret';
  const error = async () => (await g.ok('/remote')).status.slack?.error;
  assert.equal((await slackCall({ type: 'url_verification', challenge: 'x', token: 'x' }, { secret: wrong })).status, 403);
  await until(async () => /signature/.test(await error()), { what: 'said in status' });
  assert.equal((await slackDirect(mention('hello', { user: STRANGER }), { secret: wrong })).status, 403);
  assert.match(await error(), /signature/, 'a forged event isn’t proof of anything');
  assert.equal((await slackDirect(mention('hello', { user: STRANGER }))).status, 403, 'a stranger, but signed by Slack');
  await until(async () => !(await error()), { what: 'the error gone' });
  done();
});

test('Slack: through the grid, an edit and wisp’s own echo aren’t held; a person’s file is', async () => {
  const done = await awake();
  const rows = slackRows();
  const edit = event('edited', { subtype: 'message_changed' });
  delete edit.event.user;
  for (const e of [edit, event('wisp’s reply', { user: 'UBOT', bot_id: 'BBOT' })]) assert.equal((await slackCall(e)).status, 200);
  assert.equal(slackRows(), rows);
  assert.equal((await slackCall(event('here', { subtype: 'file_share', user: STRANGER }))).status, 200);
  assert.equal(slackRows(), rows + 1);
  await until(() => held() === 0, { what: 'delivered' });
  done();
});

test('Slack: a stranger’s link code gets them linked, a wrong one doesn’t, and the box says so to the grid', async () => {
  const done = await awake();
  assert.equal((await slackDirect(event('link 000000', { user: STRANGER }))).status, 403);
  await until(() => slackPosted(/isn’t the code/).length === 1, { what: 'the wrong code told' });
  assert.equal((await slackDirect(event(`link ${g.linkCode}`))).status, 200);
  await until(() => slackPosted(/Linked to wisp/).length === 1, { what: 'linked' });
  assert.equal((await g.ok('/remote')).slack.senders, 1);
  done();
});

test('Slack: a box idle-stopped, a signed DM wakes it, the task starts once, retries change nothing, and it sleeps again', { timeout: 60_000 }, async () => {
  await g.ok('/status');
  const ran = await tasks();
  await asleep();
  const e = event('fix the bug');
  const body = JSON.stringify(e);
  const first = signed(body);
  const t = Date.now();
  assert.equal((await slackCall(body, { headers: first })).status, 200);
  const took = Date.now() - t;
  assert.ok(took < 800, `the 200 took ${took} ms`);
  await until(() => slackPosted(/^▶/).length === 1, { what: 'the task', timeout: 30_000 });
  await until(() => held() === 0, { what: 'delivered' });
  const done = g.grid.hostd.begin(g.ada.id, { touch: false });
  const rows = slackRows();
  // Slack's retries: the same signature stops at the grid, one signed anew goes through to the box.
  const retry = { 'x-slack-retry-num': '1', 'x-slack-retry-reason': 'http_timeout' };
  assert.equal((await slackCall(body, { headers: { ...first, ...retry } })).status, 200);
  assert.equal(slackRows(), rows);
  assert.equal((await slackCall(body, { headers: { ...signed(body, nowS() + 1), ...retry } })).status, 200);
  assert.equal(slackRows(), rows + 1);
  await until(() => held() === 0, { what: 'the retry delivered' });
  assert.equal((await slackDirect(e)).json.duplicate, true);
  await sleep(150);
  assert.equal(slackPosted(/^▶/).length, 1);
  assert.equal(await tasks(), ran + 1);
  done();
  await asleep();
});

test('Slack: the seen list outlives the box, so an event redelivered after it slept isn’t run twice', { timeout: 60_000 }, async () => {
  const done = await awake();
  const ran = await tasks();
  const e = event('only once please');
  assert.equal((await slackDirect(e)).status, 200);
  await until(() => slackPosted(/^▶/).length === 2, { what: 'the task' });
  await until(async () => !(await g.ok('/status')).live, { what: 'quiet' });
  done();
  await g.grid.hostd.stop(g.ada.id);
  const again = await awake();
  assert.equal((await slackDirect(e)).json.duplicate, true);
  assert.equal(await tasks(), ran + 1);
  again();
});

test('Slack: a mention on a box just woken is read without the bot’s own name', { timeout: 60_000 }, async () => {
  const done = await awake();
  const e = mention('help');
  assert.equal((await slackDirect(e)).status, 200);
  const reply = slack.posted.filter((p) => p.thread_ts === e.event.ts);
  assert.equal(reply.length, 1);
  assert.match(reply[0].text, /Say what you’d type in wisp/);
  done();
});

test('Slack: a bad signature, a missing one and an old timestamp are refused by the box, and the grid doesn’t retry', { timeout: 60_000 }, async () => {
  const done = await awake();
  const ran = await tasks();
  const e = event('steal it');
  assert.equal((await slackDirect(e, { secret: 'wrong-secret-wrong-secret' })).status, 403);
  assert.equal((await slackDirect(e, { headers: {} })).status, 403);
  // Those didn't burn its id: the real one, whose signature does match, still goes through.
  assert.equal((await slackDirect(e)).status, 200);
  await until(() => slackPosted(/^▶/).length === 3, { what: 'the real one' });
  assert.equal(await tasks(), ran + 1);
  // A captured body sent again later: the grid stamps its own time on it, so it's old.
  const replayed = event('replayed');
  assert.equal((await slackCall(replayed, { ts: nowS() - 6 * 60 })).status, 200);
  await until(() => held() === 0, { what: 'finished with' });
  assert.equal((await slackDirect(replayed, { ts: nowS() - 6 * 60 })).status, 403);
  assert.equal((await slackDirect(replayed, { ts: nowS() + 6 * 60 })).status, 403);
  await sleep(100);
  assert.equal(slack.posted.filter((p) => p.thread_ts === replayed.event.ts).length, 0);
  assert.equal(await tasks(), ran + 1);
  done();
});

test('Slack: at comes from the grid alone: without its mark a back-dated delivery gets nowhere', async () => {
  const done = await awake();
  const ran = await tasks();
  const old = nowS() - 3600;
  assert.equal((await slackDirect(event('back-dated', { at: old }), { ts: old, at: old * 1000, mark: false })).status, 403);
  await sleep(100);
  assert.equal(await tasks(), ran);
  // A time from the future can't stretch the window either.
  assert.equal((await slackDirect(event('from the future'), { ts: nowS() - 6 * 60, at: Date.now() + 3600_000 })).status, 403);
  done();
});

test('Slack: a message held half an hour for a wake still runs: it’s judged by when the grid took it', { timeout: 60_000 }, async () => {
  await g.ok('/status');
  const ran = await tasks();
  await asleep();
  const then = nowS() - 30 * 60;
  const e = event('held for a long time', { at: then });
  const body = JSON.stringify(e);
  const headers = JSON.stringify(signed(body, then));
  g.grid.db.run('INSERT INTO channel_inbox (user_id, channel, event_key, headers, body, size, at) VALUES (?, ?, ?, ?, ?, ?, ?)', g.ada.id, 'slack', `slack:${e.event_id}:held`, headers, Buffer.from(body), body.length, then * 1000);
  g.grid.inbox.drain(g.ada);
  const n = slackPosted(/^▶/).length;
  await until(() => slackPosted(/^▶/).length === n + 1, { what: 'the task', timeout: 30_000 });
  assert.equal(slackPosted(/arrived while wisp was offline/).length, 0);
  await until(() => held() === 0, { what: 'delivered' });
  assert.equal(await tasks(), ran + 1);
});

test('Slack: a stranger is a 403 each time, with one line in a DM and silence in a channel; wisp’s own echo is a 403 too', async () => {
  const done = await awake();
  const ran = await tasks();
  // By thread: a task from an earlier test can still report in its own.
  const said = (e) => slack.posted.filter((p) => p.thread_ts === e.event.ts);
  const dm = event('hello', { user: STRANGER, channel: 'D9' });
  assert.equal((await slackDirect(dm)).status, 403);
  assert.equal((await slackDirect(dm)).status, 403, 'the same one again isn’t a pass');
  assert.equal(said(dm).length, 1);
  assert.match(said(dm)[0].text, /only answers people linked/);
  const edited = event('edited', { subtype: 'message_changed' });
  delete edited.event.user;
  const quiet = [mention('hello', { user: STRANGER }), event('wisp’s reply', { user: 'UBOT', bot_id: 'BBOT' }), edited];
  for (const e of quiet) assert.equal((await slackDirect(e)).status, 403);
  await sleep(100);
  for (const e of quiet) assert.equal(said(e).length, 0);
  assert.equal(await tasks(), ran);
  assert.equal((await slackDirect(event('help'))).status, 200, 'someone linked');
  assert.equal((await slackDirect({ type: 'app_rate_limited', team_id: 'T1' })).status, 400);
  done();
});

test('Slack: lost messages are told in the thread of one that got through, once, and a forged one says nothing', async () => {
  const done = await awake();
  const n = slackPosted(/didn’t reach wisp/).length;
  assert.equal((await slackDirect(event('forged'), { secret: 'wrong-secret-wrong-secret', dropped: 2 })).status, 403);
  await sleep(100);
  assert.equal(slackPosted(/didn’t reach wisp/).length, n);
  const e = event('help');
  assert.equal((await slackDirect(e, { dropped: 2 })).status, 200);
  const line = slackPosted(/2 messages didn’t reach wisp/);
  assert.equal(line.length, n + 1);
  assert.equal(line.at(-1).thread_ts, e.event.ts);
  assert.equal((await g.ok('/remote')).status.slack.dropped, 2);
  done();
});

test('Slack: nothing a message said goes to the grid’s log or audit', async () => {
  const words = 'a-very-private-sentence';
  const done = await awake();
  await slackCall(event(words));
  await slackCall(event(words, { user: STRANGER }));
  await until(() => held() === 0, { what: 'finished with' });
  const audit = JSON.stringify(g.grid.db.all('SELECT * FROM audit'));
  assert.ok(!audit.includes(words));
  assert.ok(!g.logs.join('\n').includes(words));
  assert.equal(JSON.stringify(g.grid.db.all("SELECT body, headers FROM channel_inbox WHERE channel = 'slack' AND done_at IS NOT NULL")).includes(words), false);
  done();
});

test('Slack: rotate gives a new URL for Slack’s settings, and the old one is a 404', async () => {
  const done = await awake();
  const r = await g.ok('/channels/rotate', { body: { channel: 'slack' } });
  assert.notEqual(r.url, hookUrl);
  assert.ok(r.url.startsWith(`${g.origin}/_in/`));
  assert.equal((await slackCall(event('help'))).status, 404);
  hookUrl = r.url;
  assert.equal((await slackCall(event('help'))).status, 200);
  assert.equal((await g.ok('/remote/slack/manifest')).settings.event_subscriptions.request_url, hookUrl);
  done();
});

test('Slack: switched off, a message still in the grid is refused, and unlinking keeps the URL', async () => {
  const done = await awake();
  const v = await g.ok('/remote', { method: 'PUT', body: { slack: { unlink: true } } });
  assert.equal(v.slack.senders, 0);
  assert.equal((await slackDirect(event('hello'))).status, 403);
  await g.ok('/remote', { method: 'PUT', body: { slack: { enabled: false } } });
  assert.equal((await slackDirect(event('hello'))).status, 409);
  assert.equal((await slackCall({ type: 'url_verification', challenge: 'x' })).status, 409);
  done();
});

test('a box on a grid without the hub: Slack says it can’t be reached, in the manifest route and in status', { timeout: 60_000 }, async () => {
  const o = old.other;
  await o.ok('/status');
  assert.equal((await o.api('/remote/slack/manifest')).status, 409);
  assert.match((await o.api('/remote/slack/manifest')).json.error, /can’t reach this computer/);
  await o.ok('/remote', { method: 'PUT', body: { slack: { enabled: true, signingSecret: SIGNING, botToken: BOT } } });
  const v = await until(async () => {
    const x = await o.ok('/remote');
    return x.status.slack?.error ? x : null;
  }, { what: 'the error' });
  assert.match(v.status.slack.error, /can’t reach this computer/);
  assert.equal(v.slack.connected, false);
});

test('the grid holds another bot: this box sets its own webhook and isn’t deaf', async (t) => {
  const api = `http://127.0.0.1:${fake.address().port}`;
  const own = await boot({ channels: { enabled: true, retryMs: 40, route: true, telegramApi: api }, idleMs: 60_000 });
  t.after(() => own.grid.close());
  const BOT = '888:box-own';
  own.grid.secrets.seal(own.ada.id, 'route:telegram', JSON.stringify({ bot: '777:held', name: 'heldbot', secret: 'g'.repeat(64), senders: [String(CHAT)] }));
  own.grid.db.run('INSERT INTO channel_routes (user_id, channel, token_hash, created_at) VALUES (?, ?, ?, ?)', own.ada.id, 'telegram', 'h2', Date.now());
  tg.calls.length = 0;
  await own.ok('/remote', { method: 'PUT', body: { telegram: { enabled: true, token: BOT } } });
  await until(() => called('setWebhook').some((c) => c.bot === `bot${BOT}`), { what: 'its own webhook' });
  assert.match(called('setWebhook').find((c) => c.bot === `bot${BOT}`).url, /\/_in\//);
});

test('a running box asks again: the grid took its bot since, so it neither rotates nor takes the webhook down', async (t) => {
  const api = `http://127.0.0.1:${fake.address().port}`;
  const BOT = '666:running';
  const mine = (m) => called(m).filter((c) => c.bot === `bot${BOT}`);
  const own = await boot({ channels: { enabled: true, retryMs: 40, route: true, telegramApi: api }, idleMs: 60_000 });
  t.after(() => own.grid.close());
  tg.calls.length = 0;
  await own.ok('/remote', { method: 'PUT', body: { telegram: { enabled: true, token: BOT } } });
  await until(() => mine('setWebhook').length === 1, { what: 'its own webhook' });
  await until(async () => (await own.ok('/remote')).status.telegram?.webhook === true, { what: 'wisp on it' });
  // Connected on the account page while this box runs: nothing tells it.
  own.grid.secrets.seal(own.ada.id, 'route:telegram', JSON.stringify({ bot: BOT, name: 'wispbot', secret: 'g'.repeat(64), senders: [String(CHAT)] }));
  own.grid.db.run('INSERT INTO channel_routes (user_id, channel, token_hash, created_at) VALUES (?, ?, ?, ?)', own.ada.id, 'telegram', 'h3', Date.now());
  assert.equal((await own.api('/channels/rotate', { method: 'POST', body: { channel: 'telegram' } })).status, 409);
  assert.equal(mine('setWebhook').length, 1, 'a rotate would have taken the webhook back');
  await own.ok('/remote', { method: 'PUT', body: { telegram: { enabled: false } } });
  await until(() => !own.grid.routes.shared(own.ada.id), { what: 'the box letting go of the bot' });
  assert.equal(mine('deleteWebhook').length, 0, 'the grid’s now, not this box’s to take down');
});

test('the grid holds the webhook: the box sets none, takes what’s verified, and leaves it up when switched off', async (t) => {
  const api = `http://127.0.0.1:${fake.address().port}`;
  const HELD = '777:held'; // earlier tests' boxes still poll TOKEN
  const mine = (m) => called(m).filter((c) => c.bot === `bot${HELD}`);
  const own = await boot({ channels: { enabled: true, retryMs: 40, route: true, telegramApi: api }, idleMs: 60_000 });
  t.after(() => own.grid.close());
  await own.ok('/projects', { body: { path: makeRepo() } });
  own.grid.secrets.seal(own.ada.id, 'route:telegram', JSON.stringify({ bot: HELD, name: 'wispbot', secret: 'g'.repeat(64), senders: [String(CHAT)] }));
  own.grid.db.run('INSERT INTO channel_routes (user_id, channel, token_hash, created_at) VALUES (?, ?, ?, ?)', own.ada.id, 'telegram', 'h', Date.now());
  tg.calls.length = 0;
  const view = await own.ok('/remote', { method: 'PUT', body: { telegram: { enabled: true, token: HELD } } });
  await until(async () => (await own.ok('/remote')).status.telegram?.webhook === true, { what: 'wisp told the grid holds it' });
  assert.equal(mine('setWebhook').length, 0, 'not this box’s to set');
  assert.equal(mine('getUpdates').length, 0, 'and it doesn’t poll');
  const code = view.telegram.linkCode;
  const update = { update_id: 77, message: { message_id: 7, date: Math.floor(Date.now() / 1000), text: code, chat: { id: CHAT, type: 'private', first_name: 'Ada' }, from: { id: CHAT, first_name: 'Ada' } } };
  await own.grid.inbox.hold(own.ada, 'telegram', Buffer.from(JSON.stringify(update)), { verified: true });
  await until(() => sent().some((c) => /Linked/.test(c.text)), { what: 'the box linking from a verified message' });
  // An unverified one has no secret to pass here.
  await own.grid.inbox.hold(own.ada, 'telegram', Buffer.from(JSON.stringify({ ...update, update_id: 78 })));
  await sleep(300);
  assert.equal(sent().filter((c) => /Linked/.test(c.text)).length, 1);
  assert.equal((await own.api('/channels/rotate', { method: 'POST', body: { channel: 'telegram' } })).status, 409);
  await own.ok('/remote', { method: 'PUT', body: { telegram: { enabled: false } } });
  await sleep(200);
  assert.equal(mine('deleteWebhook').length, 0, 'switched off in the box, the grid’s webhook stays');
});

// --- Discord: the same box, with an edge that answers before it's up --------------------------------

const DISCORD_TOKEN = 'MTEx.secret-part.bot-token-secret';
const D_ME = '111111';
const D_STRANGER = '222222';
const dc = new FakeDiscord();
dc.token = DISCORD_TOKEN;
dc.lag('/commands', 300); // CI's macOS was this slow once: connected means /wisp is there
const keypair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, hex: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex') };
};
let d; // the grid for these tests
let url = '';
const keys = keypair();
dc.verifyKey = keys.hex;
const signedBy = (privateKey, raw) => {
  const ts = String(Math.floor(Date.now() / 1000));
  return { 'x-signature-ed25519': sign(null, Buffer.from(ts + raw), privateKey).toString('hex'), 'x-signature-timestamp': ts };
};
// Discord calling the URL pasted in the Developer Portal.
function interact(i, { privateKey = keys.privateKey, to = url, headers } = {}) {
  const u = new URL(to);
  const data = JSON.stringify(i);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: u.port, method: 'POST', path: u.pathname, headers: { host: u.host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers ?? signedBy(privateKey, data)) } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve({ status: res.statusCode, json: t ? JSON.parse(t) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
}
const prompt = (user, text, o = {}) => dc.interaction({ type: 2, member: { user: { id: user } }, data: { name: 'wisp', options: [{ name: 'prompt', value: text }] }, channel: { type: 0 }, channel_id: 'CG', ...o });
const dState = () => d.grid.hostd.state(d.ada.id);
const dAsleep = () => until(() => dState() === 'stopped', { what: 'the box asleep', timeout: 20_000 });
const dTasks = async () => (await d.ok('/sessions')).filter((s) => s.title !== 'Welcome to wisp').length;

test('Discord on a box: its key reaches the grid, no socket, and Discord’s check of the URL is answered while it sleeps', { timeout: 60_000 }, async () => {
  await dc.start();
  d = await boot({ env: { WISP_DISCORD_API: dc.api } });
  await d.ok('/projects', { body: { path: makeRepo() } });
  await d.ok('/remote', { method: 'PUT', body: { discord: { enabled: true, token: DISCORD_TOKEN, publicKey: keys.hex } } });
  const v = await until(async () => {
    const x = (await d.ok('/remote')).discord;
    return x.connected && x.endpoint ? x : null;
  }, { what: 'connected', timeout: 15_000 });
  url = v.endpoint;
  assert.ok(url.startsWith(`${d.origin}/_in/`), url);
  assert.equal(dc.connects, 0, 'no socket on a box');
  assert.equal(dc.calls.filter((c) => c.route === 'GET /gateway/bot').length, 0);
  assert.equal(dc.commands.length, 1);
  await dAsleep();
  const r = await interact({ id: '1', type: 1 });
  assert.deepEqual([r.status, r.json], [200, { type: 1 }]);
  assert.equal(dState(), 'stopped');
  assert.equal((await interact({ id: '1', type: 1 }, { privateKey: keypair().privateKey })).status, 401);
});

test('a /wisp on a sleeping box: type 5 first, it wakes, links once, edits the reply, and sleeps again', { timeout: 60_000 }, async () => {
  await dAsleep();
  const code = (await d.ok('/remote')).discord.linkCode;
  await dAsleep();
  const i = prompt(D_ME, `link ${code}`, { guild_id: undefined, member: undefined, user: { id: D_ME }, channel_id: `D${D_ME}`, channel: { type: 1 } });
  const t = Date.now();
  const r = await interact(i);
  const took = Date.now() - t;
  assert.deepEqual([r.status, r.json], [200, { type: 5 }]);
  assert.ok(took < 1000, `answered after ${took} ms`);
  await until(() => dc.edits.some((e) => e.token === i.token && /^✓ Linked to wisp/.test(e.content)), { what: 'the edit', timeout: 20_000 });
  assert.equal(dc.callbacks.length, 0, 'the grid answered: the box never does');
  assert.equal(dc.connects, 0);
  await dAsleep();
  const task = prompt(D_ME, 'plan: look around');
  assert.deepEqual((await interact(task)).json, { type: 5 });
  await interact(task); // the same delivery again
  await until(() => dc.edits.some((e) => e.token === task.token), { what: 'the edit', timeout: 20_000 });
  await until(async () => (await dTasks()) === 1, { what: 'the task' });
  await sleep(300);
  assert.equal(await dTasks(), 1, 'once');
  await dAsleep();
});

test('a stranger on a sleeping box: a guild’s, or a DM’s that isn’t a code, is answered at the edge and wakes nothing; a code comes to the box', { timeout: 60_000 }, async () => {
  await dAsleep();
  const n = dc.posts.length + dc.edits.length;
  const i = prompt(D_STRANGER, 'plan: mine now');
  const r = await interact(i);
  assert.deepEqual([r.json.type, r.json.data.flags], [4, 64], 'only they see it');
  await sleep(300);
  assert.equal(dState(), 'stopped');
  const inDm = (text) => prompt(D_STRANGER, text, { guild_id: undefined, member: undefined, user: { id: D_STRANGER }, channel_id: `D${D_STRANGER}`, channel: { type: 1 } });
  const hello = await interact(inDm('hello'));
  assert.deepEqual([hello.json.type, hello.json.data.flags], [4, 64], 'how to link, to them only');
  assert.match(hello.json.data.content, /To link, use `\/wisp` here with `link`/);
  await sleep(300);
  assert.equal(dState(), 'stopped', 'a DM that isn’t a code wakes nothing');
  const dm = inDm('link 000000');
  assert.deepEqual((await interact(dm)).json, { type: 5 });
  await until(() => dc.edits.some((e) => e.token === dm.token && /^That isn’t the code/.test(e.content)), { what: 'its one line', timeout: 20_000 });
  assert.equal(dc.posts.length, n - dc.edits.length + 1);
  assert.equal(await dTasks(), 1);
  await dAsleep();
});

test('the box doesn’t take the grid’s word: a key changed on the grid gets past the edge and stops at the box', { timeout: 60_000 }, async () => {
  const thief = keypair();
  d.grid.inbox.setKey(d.ada, 'discord', thief.hex);
  const i = prompt(D_ME, 'plan: forged', { channel_id: 'CF' });
  assert.deepEqual((await interact(i, { privateKey: thief.privateKey })).json, { type: 5 });
  await until(() => d.grid.db.get('SELECT count(*) n FROM channel_inbox WHERE user_id = ? AND done_at IS NULL', d.ada.id).n === 0, { what: 'delivered', timeout: 20_000 });
  assert.equal(await dTasks(), 1);
  assert.ok(!dc.edits.some((e) => e.token === i.token));
  d.grid.inbox.setKey(d.ada, 'discord', keys.hex);
  const r = await d.api('/channels/inbound', { body: { channel: 'discord', headers: {}, body: 'e30=' }, headers: { 'x-wisp-proxy-via': 'inbox' } });
  assert.equal(r.status, 403, 'from outside');
  await d.grid.close();
  dc.stop();
});
