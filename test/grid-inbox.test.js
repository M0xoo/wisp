// The grid's held inbox (grid/inbox.js) against stand-in boxes (fixtures/inbox-box.mjs), so this is
// about the grid alone: the 200 never waits for a box, the caps, a retry from the sender, the hour,
// delivery's retries, a restart of the grid, one user's token never reaching another's box, and a
// channel never keeping a box awake. test/channel-inbound.test.js does the same with a real wisp.

import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, tmp, until } from './helpers.js';

const sqlite = await import('node:sqlite').then(
  () => true,
  () => false,
);
const test = (name, opts, fn) => nodeTest(name, { skip: !sqlite && 'the grid needs node:sqlite (Node 22.13+)', ...(fn ? opts : {}) }, fn || opts);

process.env.WISP_UPDATE_CHECK = '0';
const { loadConfig } = sqlite ? await import('../grid/config.js') : {};
const { startGrid } = sqlite ? await import('../grid/server.js') : {};
const { ensureMaster, sha256 } = sqlite ? await import('../grid/secrets.js') : {};

const BOX = fileURLToPath(new URL('./fixtures/inbox-box.mjs', import.meta.url));
const SECRET = 'x-telegram-bot-api-secret-token';
const running = [];
after(async () => {
  await Promise.all(running.map((g) => g.close().catch(() => {})));
});

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// What the outside world sees: anything at any address on the grid's one port.
function call(port, host, p, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `${host}:${port}`, connection: 'close', ...headers } }, (res) => {
      let t = '';
      res.on('data', (d) => (t += d));
      res.on('end', () => resolve({ status: res.statusCode, text: t, json: () => JSON.parse(t) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function boot({ channels = { enabled: true, retryMs: 30, wakeRetryMs: 80 }, hostd = {}, dataDir, port } = {}) {
  dataDir ||= fs.realpathSync(tmp('inbox'));
  port ||= await freePort();
  ensureMaster(dataDir);
  const logs = [];
  const cfg = loadConfig({ dataDir, env: {}, overrides: { domain: 'wisp.localhost', listen: { host: '127.0.0.1', port }, auth: { dev: true }, hostd: { idleMs: 1e9, checkMs: 60, startMs: 8000, wispBin: BOX, ...hostd }, ...(channels && { channels }) } });
  const grid = await startGrid(cfg, { log: (m) => logs.push(m) });
  running.push(grid);
  const g = { grid, port, dataDir, logs };
  g.user = (handle) => {
    if (!grid.accounts.byHandle(handle)) grid.db.run('INSERT INTO users (id, handle, created_at) VALUES (?, ?, ?)', `u-${handle}`, handle, Date.now());
    return grid.accounts.byHandle(handle);
  };
  g.boxAuth = (u, as = u) => `Box ${as.handle} ${grid.secrets.ensure(u.id, 'wisp-proxy')}`;
  g.url = async (u, channel = 'telegram') => {
    const r = await call(port, 'wisp.localhost', `/api/channels/url?channel=${channel}`, { method: 'GET', headers: { authorization: g.boxAuth(u) } });
    assert.equal(r.status, 200, r.text);
    return r.json();
  };
  g.home = (u) => grid.hostd.dirs(u).home;
  g.box = (u, conf) => {
    fs.mkdirSync(g.home(u), { recursive: true });
    fs.writeFileSync(path.join(g.home(u), 'box.json'), JSON.stringify(conf));
  };
  g.got = (u) => {
    try {
      return fs.readFileSync(path.join(g.home(u), 'inbound.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  // A webhook call, as Telegram makes it.
  g.post = (u, url, body, headers = { [SECRET]: 'the-secret' }) => {
    const at = new URL(url);
    return call(port, `${u.handle}.wisp.localhost`, at.pathname, { headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  };
  g.rows = (u) => grid.db.all('SELECT * FROM channel_inbox WHERE user_id = ? ORDER BY id', u.id);
  g.dropped = (u) => grid.db.get('SELECT dropped FROM channel_urls WHERE user_id = ?', u.id)?.dropped;
  return g;
}
// A box that never comes up: everything stays held. A start gives up soon, so closing doesn't wait.
const NEVER = { hostd: { startMs: 300 } };
const update = (id, text = 'hello') => ({ update_id: id, message: { message_id: id, text, chat: { id: 42 }, date: Math.floor(Date.now() / 1000) } });
const decoded = (m) => JSON.parse(Buffer.from(m.body, 'base64').toString('utf8'));

test('the 200 beats a box that takes 5 s to wake, and the message is delivered once, after', { timeout: 30_000 }, async () => {
  const g = await boot();
  const ada = g.user('ada');
  const { url } = await g.url(ada);
  g.box(ada, { bootMs: 5000 });
  const t = Date.now();
  const r = await g.post(ada, url, update(1));
  const took = Date.now() - t;
  assert.equal(r.status, 200);
  assert.ok(took < 1000, `answered after ${took} ms`);
  assert.equal(g.got(ada).length, 0);
  assert.notEqual(g.grid.hostd.state(ada.id), 'running');
  await until(() => g.got(ada).length === 1, { what: 'the delivery' });
  assert.ok(Date.now() - t >= 4900, `delivered after ${Date.now() - t} ms: it can't have waited for the wake`);
  const [m] = g.got(ada);
  assert.equal(m.channel, 'telegram');
  assert.equal(decoded(m).update_id, 1);
  assert.equal(m.http['x-wisp-proxy-secret'], g.grid.secrets.ensure(ada.id, 'wisp-proxy'));
  assert.equal(m.http['x-wisp-proxy-via'], 'inbox');
  assert.equal(m.http['content-type'], 'application/json');
  assert.deepEqual(m.headers, { [SECRET]: 'the-secret' }, 'what the channel sent, for the box to verify');
  assert.equal(m.http.host, `127.0.0.1:${g.grid.hostd.port(ada.id)}`, 'like a wisp behind proxy(): the header is what lets it in');
  await sleep(150);
  assert.equal(g.got(ada).length, 1);
});

test('a burst wakes the box once, and arrives in order, one at a time', async () => {
  const g = await boot();
  const ada = g.user('ada');
  const { url } = await g.url(ada);
  const starts = [];
  g.grid.hostd.on('change', (e) => e.event === 'started' && starts.push(e.user.handle));
  g.box(ada, { bootMs: 300, answerMs: 40 });
  for (const id of [1, 2, 3, 4]) assert.equal((await g.post(ada, url, update(id))).status, 200);
  await until(() => g.got(ada).length === 4, { what: 'all four' });
  assert.deepEqual(g.got(ada).map((m) => decoded(m).update_id), [1, 2, 3, 4]);
  assert.deepEqual(starts, ['ada']);
});

test('a retry from the sender is one message, and only what the box needs is kept of a delivered one', async () => {
  const g = await boot();
  const ada = g.user('ada');
  const { url } = await g.url(ada);
  assert.equal((await g.post(ada, url, update(7))).status, 200);
  await until(() => g.got(ada).length === 1, { what: 'the delivery' });
  await until(() => g.rows(ada)[0]?.done_at, { what: 'done' });
  assert.equal((await g.post(ada, url, update(7))).status, 200);
  await sleep(120);
  assert.equal(g.got(ada).length, 1);
  const [row] = g.rows(ada);
  assert.equal(g.rows(ada).length, 1);
  assert.equal(Buffer.from(row.body).length, 0, 'no message left on the grid once delivered');
  assert.equal(row.headers, '{}');
  // No id: the body's hash stands in for one.
  const bare = await boot({ channels: { enabled: true } });
  const bob = bare.user('bob');
  const u2 = (await bare.url(bob)).url;
  bare.box(bob, { live: 1 });
  await bare.post(bob, u2, 'not json');
  await bare.post(bob, u2, 'not json');
  await until(() => bare.got(bob).length === 1);
  await sleep(100);
  assert.equal(bare.got(bob).length, 1);
});

test('over the caps: a 200 that drops and counts', async () => {
  const g = await boot({ channels: { enabled: true, maxRows: 2 }, ...NEVER });
  const ada = g.user('ada');
  const { url } = await g.url(ada);
  g.box(ada, { bootMs: 60_000 }); // never up: everything stays held
  for (const id of [1, 2, 3]) assert.equal((await g.post(ada, url, update(id))).status, 200);
  assert.equal(g.rows(ada).length, 2);
  assert.equal(g.dropped(ada), 1);
  await g.grid.close();

  const b = await boot({ channels: { enabled: true, maxBytes: 600 }, ...NEVER });
  const bob = b.user('bob');
  const u2 = (await b.url(bob)).url;
  b.box(bob, { bootMs: 60_000 });
  assert.equal((await b.post(bob, u2, { update_id: 1, pad: 'x'.repeat(400) })).status, 200);
  assert.equal((await b.post(bob, u2, { update_id: 2, pad: 'x'.repeat(400) })).status, 200);
  assert.equal(b.rows(bob).length, 1);
  assert.equal(b.dropped(bob), 1);
  // Too big for any row: not even stored.
  assert.equal((await b.post(bob, u2, { update_id: 3, pad: 'x'.repeat(300 * 1024) })).status, 200);
  assert.equal(b.rows(bob).length, 1);
  assert.equal(b.dropped(bob), 2);
});

test('rows go after an hour; one never delivered counts as lost, and the box is told', async () => {
  const g = await boot(NEVER);
  const ada = g.user('ada');
  const { url } = await g.url(ada);
  g.box(ada, { bootMs: 60_000 });
  await g.post(ada, url, update(1));
  await g.post(ada, url, update(2));
  const hour = 60 * 60_000;
  g.grid.db.run('UPDATE channel_inbox SET at = ? WHERE event_key = ?', Date.now() - hour - 1, 'telegram:1');
  g.grid.inbox.sweep();
  assert.deepEqual(g.rows(ada).map((r) => r.event_key), ['telegram:2']);
  assert.equal(g.dropped(ada), 1);
  assert.equal((await g.url(ada)).dropped, 1);
  assert.equal((await g.url(ada)).dropped, 0, 'told once');
  assert.equal(g.grid.db.get("SELECT meta FROM audit WHERE action = 'channel.drop'").meta.includes('"why":"expired"'), true);
});

test('delivery retries with backoff, five times at most, then drops and tells the box', async () => {
  const g = await boot();
  const ada = g.user('ada');
  const { url } = await g.url(ada);
  g.box(ada, { status: 500 });
  await g.post(ada, url, update(1));
  await until(() => g.dropped(ada) === 1, { what: 'the drop' });
  assert.equal(g.got(ada).length, 5);
  assert.ok(g.rows(ada)[0].done_at);
  assert.equal(Buffer.from(g.rows(ada)[0].body).length, 0);
  g.box(ada, {});
  await g.post(ada, url, update(2));
  await until(() => g.got(ada).length === 6);
  assert.equal(g.got(ada)[5].dropped, 1, 'the next message says so');
  await until(() => g.dropped(ada) === 0, { what: 'the count reset' });
});

test('a 4xx is the box’s last word: no retry, and nothing counted as lost', async () => {
  const g = await boot();
  const ada = g.user('ada');
  const { url } = await g.url(ada);
  g.box(ada, { status: 403 });
  await g.post(ada, url, update(1));
  await until(() => g.rows(ada)[0]?.done_at, { what: 'done' });
  await sleep(150);
  assert.equal(g.got(ada).length, 1);
  assert.equal(g.dropped(ada), 0);
});

test('a restart of the grid keeps held rows, and wakes the box for them', { timeout: 30_000 }, async () => {
  const g = await boot(NEVER);
  const ada = g.user('ada');
  const { url } = await g.url(ada);
  g.box(ada, { bootMs: 60_000 });
  await g.post(ada, url, update(1));
  await g.grid.close();
  assert.equal(g.got(ada).length, 0);
  g.box(ada, {});
  const again = await boot({ dataDir: g.dataDir, port: g.port });
  await until(() => again.got(ada).length === 1, { what: 'the delivery after the restart' });
  assert.equal(decoded(again.got(ada)[0]).update_id, 1);
  assert.equal((await again.url(ada)).url, url, 'the same URL: Telegram still has it');
});

test('one user’s token never reaches another’s box, and a box gets only its own URL', async () => {
  const g = await boot();
  const [ada, bob] = [g.user('ada'), g.user('bob')];
  const a = (await g.url(ada)).url;
  const b = (await g.url(bob)).url;
  assert.notEqual(a, b);
  assert.ok(a.startsWith(`http://ada.wisp.localhost:${g.port}/_in/`), a);
  assert.ok(b.startsWith(`http://bob.wisp.localhost:${g.port}/_in/`), b);
  // Ada's token at Bob's address: nobody's message.
  assert.equal((await g.post(bob, a, update(1))).status, 404);
  assert.equal((await g.post(ada, b, update(2))).status, 404);
  assert.equal(g.rows(ada).length + g.rows(bob).length, 0);
  await sleep(100);
  assert.equal(g.grid.hostd.state(ada.id), 'stopped');
  assert.equal(g.grid.hostd.state(bob.id), 'stopped');
  // Each to its own, and only there.
  await g.post(ada, a, update(3));
  await until(() => g.got(ada).length === 1);
  assert.equal(g.got(bob).length, 0);
  assert.equal(g.grid.hostd.state(bob.id), 'stopped');
  // Asking for someone else's URL: with their handle and your secret, or no box at all.
  const ask = (authorization) => call(g.port, 'wisp.localhost', '/api/channels/url?channel=telegram', { method: 'GET', headers: authorization ? { authorization } : {} });
  assert.equal((await ask(g.boxAuth(bob, ada))).status, 401);
  assert.equal((await ask(`Box ada ${'x'.repeat(43)}`)).status, 401);
  assert.equal((await ask()).status, 401);
  const dev = g.grid.accounts.deviceCode('laptop');
  g.grid.accounts.answerCode(dev.user_code, ada.id, true);
  const tok = g.grid.accounts.pollCode(dev.device_code, 0).token;
  assert.ok(tok, 'a device token to try with');
  assert.equal((await ask(`Bearer ${tok}`)).status, 401, 'a device has no box to give it to');
  const unknown = await call(g.port, 'wisp.localhost', '/api/channels/url?channel=nope', { method: 'GET', headers: { authorization: g.boxAuth(ada) } });
  assert.equal(unknown.status, 404);
  const proto = await call(g.port, 'wisp.localhost', '/api/channels/url?channel=__proto__', { method: 'GET', headers: { authorization: g.boxAuth(ada) } });
  assert.equal(proto.status, 404);
});

test('an account switched off or deleted: its URL is a 404, and what it held goes with it', async () => {
  const g = await boot(NEVER);
  const ada = g.user('ada');
  const { url } = await g.url(ada);
  g.box(ada, { bootMs: 60_000 });
  await g.post(ada, url, update(1));
  g.grid.accounts.setDisabled(ada.id, true);
  assert.equal((await g.post(ada, url, update(2))).status, 404);
  g.grid.accounts.setDisabled(ada.id, false);
  g.grid.db.run('DELETE FROM users WHERE id = ?', ada.id);
  assert.equal(g.grid.db.get('SELECT count(*) n FROM channel_inbox').n, 0);
  assert.equal(g.grid.db.get('SELECT count(*) n FROM channel_urls').n, 0);
});

test('a channel never keeps a box awake: delivery touches nothing, and it sleeps on its own timer', async () => {
  const g = await boot({ hostd: { idleMs: 700, checkMs: 40 } });
  const ada = g.user('ada');
  const { url } = await g.url(ada);
  const stops = [];
  g.grid.hostd.on('change', (e) => e.state === 'stopped' && stops.push(e.event));
  // Woken by a message: that wake is the one use it counts.
  await g.post(ada, url, update(1));
  await until(() => g.got(ada).length === 1, { what: 'the first delivery' });
  const inst = g.grid.hostd.inst.get(ada.id);
  const touched = inst.lastTouch;
  // Messages keep coming, faster than idleMs: each lands, none of them moves the clock.
  const t = Date.now();
  let id = 2;
  while (g.grid.hostd.state(ada.id) === 'running' && Date.now() - t < 5000) {
    await g.post(ada, url, update(id++));
    await sleep(90);
    if (g.grid.hostd.state(ada.id) === 'running') assert.equal(inst.lastTouch, touched, 'a delivery moved lastTouch');
  }
  assert.ok(id > 4, 'several messages went by first');
  await until(() => stops.includes('idle'), { what: 'the idle stop', timeout: 5000 });
  assert.ok(Date.now() - touched < 3000, `it slept after ${Date.now() - touched} ms, idleMs is 700`);
});

test('a full grid: like a page, it queues; the row stays held until there’s room', { timeout: 20_000 }, async () => {
  const g = await boot({ hostd: { maxRunning: 1, evictAfterMs: 0, queueMs: 100 } });
  const [ada, bob] = [g.user('ada'), g.user('bob')];
  g.box(bob, { live: 1 }); // busy: can't be evicted
  await g.grid.hostd.ensure(bob);
  await until(() => g.grid.hostd.inst.get(bob.id)?.status, { what: 'bob’s status' });
  const { url } = await g.url(ada);
  await g.post(ada, url, update(1));
  await until(() => g.logs.some((l) => /can't wake ada/.test(l)), { what: 'the wake refused' });
  await sleep(200);
  assert.equal(g.got(ada).length, 0);
  assert.equal(g.rows(ada).length, 1);
  assert.equal(g.rows(ada)[0].tries, 0, 'a box that couldn’t start isn’t the message’s fault');
  await g.grid.hostd.stop(bob.id);
  await until(() => g.got(ada).length === 1, { what: 'the delivery once there’s room' });
});

test('a wake evicts a quiet box, as a page opening it does', async () => {
  const g = await boot({ hostd: { maxRunning: 1, evictAfterMs: 0 } });
  const [ada, bob] = [g.user('ada'), g.user('bob')];
  await g.grid.hostd.ensure(bob);
  await until(() => g.grid.hostd.inst.get(bob.id)?.status, { what: 'bob’s status' });
  const { url } = await g.url(ada);
  await g.post(ada, url, update(1));
  await until(() => g.got(ada).length === 1, { what: 'the delivery' });
  assert.equal(g.grid.hostd.state(bob.id), 'stopped');
});

test('nothing a message said, and no token, reaches a log or audit: channel and size only', async () => {
  const g = await boot();
  const ada = g.user('ada');
  const { url } = await g.url(ada);
  const token = url.split('/').pop();
  const SAID = 'the launch code is 8675309';
  g.box(ada, { status: 500 });
  await g.post(ada, url, update(1, SAID));
  await until(() => g.dropped(ada) === 1, { what: 'the drop' });
  // A row left to expire, one refused, a wake that fails, an error inside the route.
  g.box(ada, { status: 403 });
  await g.post(ada, url, update(2, SAID));
  await until(() => g.rows(ada)[1]?.done_at, { what: 'the refusal' });
  g.grid.db.run('UPDATE channel_inbox SET at = 0');
  g.grid.inbox.sweep();
  const real = g.grid.inbox.accept;
  g.grid.inbox.accept = async () => {
    throw new Error('disk full');
  };
  assert.equal((await g.post(ada, url, update(3, SAID))).status, 500);
  g.grid.inbox.accept = real;
  const told = [...g.logs, ...g.grid.db.all('SELECT action, meta FROM audit').map((a) => `${a.action} ${a.meta}`)].join('\n');
  assert.match(told, /channel\.drop/);
  assert.ok(!told.includes(SAID.slice(0, 12)) && !told.includes('8675309'), told);
  assert.ok(!told.includes(token), 'the token was logged');
  assert.ok(!told.includes(sha256(token)), 'the token’s hash left the database');
  for (const a of g.grid.db.all("SELECT meta FROM audit WHERE action = 'channel.drop'")) assert.deepEqual(Object.keys(JSON.parse(a.meta)).sort(), ['channel', 'size', 'why']);
  // Stored as a hash; the token itself only sealed.
  const raw = fs.readFileSync(path.join(g.dataDir, 'grid.db'));
  assert.ok(!raw.includes(token), 'the token sits in the database in the clear');
  assert.equal(g.grid.db.get('SELECT token_hash FROM channel_urls').token_hash, sha256(token));
});

test('with channels not in grid.json, /_in/ is a 404, nothing is kept or woken, and the box polls', async () => {
  for (const channels of [null, {}, { enabled: false }]) {
    const g = await boot({ channels });
    const ada = g.user('ada');
    assert.equal(g.grid.inbox.on, false);
    const tok = 'a'.repeat(43);
    for (const method of ['POST', 'GET']) {
      const r = await call(g.port, 'ada.wisp.localhost', `/_in/${tok}`, { method });
      assert.equal(r.status, 404);
      assert.deepEqual(JSON.parse(r.text), { error: 'not found' });
    }
    assert.equal((await call(g.port, 'nobody.wisp.localhost', `/_in/${tok}`)).status, 404);
    const r = await call(g.port, 'wisp.localhost', '/api/channels/url?channel=telegram', { method: 'GET', headers: { authorization: g.boxAuth(ada) } });
    assert.equal(r.status, 401, 'as any other unknown device-API path: no sign the hub exists');
    assert.equal(g.grid.hostd.state(ada.id), 'stopped');
    assert.equal(g.grid.db.get('SELECT count(*) n FROM channel_urls').n, 0);
    await g.grid.close();
  }
});

test('channels on: a wrong token, a wrong shape or a GET gets the same 404 as off', async () => {
  const g = await boot();
  const ada = g.user('ada');
  const { url } = await g.url(ada);
  const p = new URL(url).pathname;
  assert.equal((await call(g.port, 'ada.wisp.localhost', `/_in/${'b'.repeat(43)}`)).status, 404);
  assert.equal((await call(g.port, 'ada.wisp.localhost', '/_in/short')).status, 404);
  assert.equal((await call(g.port, 'ada.wisp.localhost', '/_in')).status, 404);
  assert.equal((await call(g.port, 'ada.wisp.localhost', p, { method: 'GET' })).status, 404);
  assert.equal(g.rows(ada).length, 0);
  // A header an outsider adds is never kept: only what the channel needs.
  g.box(ada, {});
  await g.post(ada, url, update(1), { [SECRET]: 's', 'x-wisp-proxy-secret': 'forged', 'x-wisp-proxy-via': 'key', cookie: 'a=b' });
  await until(() => g.got(ada).length === 1);
  assert.deepEqual(g.got(ada)[0].http['x-wisp-proxy-via'], 'inbox');
  assert.equal(g.got(ada)[0].http['x-wisp-proxy-secret'], g.grid.secrets.ensure(ada.id, 'wisp-proxy'));
  await until(() => g.rows(ada)[0]?.done_at);
  const held = await boot(NEVER);
  const bob = held.user('bob');
  const u2 = (await held.url(bob)).url;
  held.box(bob, { bootMs: 60_000 });
  await held.post(bob, u2, update(2), { [SECRET]: 's', 'x-wisp-proxy-secret': 'forged', 'x-forwarded-for': '1.2.3.4', authorization: 'Bearer x' });
  assert.deepEqual(JSON.parse(held.rows(bob)[0].headers), { [SECRET]: 's' });
});

test('the limits: per token, then per address', async () => {
  const g = await boot();
  const ada = g.user('ada');
  const { url } = await g.url(ada);
  g.box(ada, { live: 1 });
  let last;
  for (let i = 0; i < 121; i++) last = await g.post(ada, url, update(i));
  assert.equal(last.status, 429);
  let ip;
  for (let i = 0; i < 480; i++) ip = await call(g.port, 'ada.wisp.localhost', `/_in/${'b'.repeat(43)}`);
  assert.equal(ip.status, 429);
});

test('channels in grid.json: what’s accepted, what’s refused', () => {
  const dataDir = tmp('inbox-cfg');
  const load = (channels) => loadConfig({ dataDir, env: {}, overrides: { channels } });
  assert.equal(load({ enabled: true, maxRows: 10, maxBytes: 1000 }).channels.maxRows, 10);
  assert.throws(() => load({ enabled: 'yes' }), /channels/);
  assert.throws(() => load({ maxRows: 0 }), /channels\.maxRows/);
  assert.throws(() => load({ maxBytes: 'lots' }), /channels\.maxBytes/);
  assert.throws(() => load([]), /channels/);
});

test('a grid.db from before the hub opens as it was: the migration only adds', async () => {
  const g = await boot();
  const ada = g.user('ada');
  g.grid.db.raw.exec(`DROP TABLE channel_inbox; DROP TABLE channel_urls; UPDATE meta SET v = '8' WHERE k = 'schema';`);
  await g.grid.close();
  const again = await boot({ dataDir: g.dataDir, port: g.port });
  assert.equal(again.grid.accounts.byHandle('ada').id, ada.id);
  assert.equal(again.grid.db.get('SELECT count(*) n FROM channel_inbox').n, 0);
  assert.equal(again.grid.db.get('SELECT count(*) n FROM channel_urls').n, 0);
});
