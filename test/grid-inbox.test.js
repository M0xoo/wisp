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

test('a forged update can’t take the real one’s key: what it came with is part of the key', async () => {
  const g = await boot();
  const ada = g.user('ada');
  const { url } = await g.url(ada);
  g.box(ada, { live: 1 });
  await g.post(ada, url, update(9, 'forged'), { [SECRET]: 'a-guess' }); // the token leaked, the secret didn't
  await until(() => g.got(ada).length === 1, { what: 'the forged one' });
  await g.post(ada, url, update(9, 'real'));
  await until(() => g.got(ada).length === 2, { what: 'the real one, still delivered' });
  assert.equal(decoded(g.got(ada)[1]).message.text, 'real');
  await g.post(ada, url, update(9, 'real')); // and Telegram's own retry is still one message
  await sleep(120);
  assert.equal(g.got(ada).length, 2);
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
  g.grid.db.run('UPDATE channel_inbox SET at = ? WHERE event_key LIKE ?', Date.now() - hour - 1, 'telegram:1:%');
  g.grid.inbox.sweep();
  assert.deepEqual(g.rows(ada).map((r) => r.event_key.split(':').slice(0, 2).join(':')), ['telegram:2']);
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

test('a row that runs out of tries doesn’t hold up the rows behind it', async () => {
  const g = await boot();
  const ada = g.user('ada');
  const { url } = await g.url(ada);
  g.box(ada, { bootMs: 400, failIds: [1] }); // held until it's up, so B and C are waiting when A fails
  for (const id of [1, 2, 3]) await g.post(ada, url, update(id));
  await until(() => g.got(ada).length === 7, { what: 'the two behind it' });
  assert.deepEqual(g.got(ada).map((m) => decoded(m).update_id), [1, 1, 1, 1, 1, 2, 3]);
  assert.equal(g.got(ada)[5].dropped, 1, 'the next one says so');
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

test('rotate: a box replaces its own URL; the old one is a 404, what’s held and counted stays', async () => {
  const g = await boot({ ...NEVER });
  const [ada, bob] = [g.user('ada'), g.user('bob')];
  const { url } = await g.url(ada);
  const rotate = (authorization, channel = 'telegram') => call(g.port, 'wisp.localhost', `/api/channels/url/rotate?channel=${channel}`, { headers: authorization ? { authorization } : {} });
  assert.equal((await rotate()).status, 401);
  assert.equal((await rotate(g.boxAuth(ada), 'nope')).status, 404);
  await g.post(ada, url, update(1));
  g.grid.db.run('UPDATE channel_urls SET dropped = 2 WHERE user_id = ?', ada.id);
  const r = await rotate(g.boxAuth(ada));
  assert.equal(r.status, 200, r.text);
  const fresh = r.json().url;
  assert.notEqual(fresh, url);
  assert.equal((await g.post(ada, url, update(2))).status, 404);
  assert.equal((await g.post(ada, fresh, update(3))).status, 200);
  assert.equal(g.rows(ada).length, 2);
  assert.equal(g.grid.secrets.open(ada.id, 'channel:telegram'), fresh.split('/').pop(), 'sealed');
  assert.equal(g.grid.db.get('SELECT token_hash t FROM channel_urls WHERE user_id = ?', ada.id).t, sha256(fresh.split('/').pop()));
  const got = await g.url(ada);
  assert.deepEqual(got, { url: fresh, dropped: 2 }, 'the same URL from now on, the count intact');
  assert.equal((await rotate(g.boxAuth(ada, bob))).status, 401, 'another’s secret');
  await g.url(bob);
  assert.equal((await rotate(g.boxAuth(bob))).status, 200);
  assert.equal((await g.post(ada, fresh, update(4))).status, 200, 'one box’s rotate is no one else’s');
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
  const g = await boot({ hostd: { checkMs: 40 } });
  const ada = g.user('ada');
  const { url } = await g.url(ada);
  const stops = [];
  g.grid.hostd.on('change', (e) => e.state === 'stopped' && stops.push(e.event));
  await g.post(ada, url, update(1));
  await until(() => g.got(ada).length === 1, { what: 'the first delivery' });
  // Its idle clock starts now, not during a boot that takes who knows how long on a loaded machine.
  const idleMs = 3000;
  const inst = g.grid.hostd.inst.get(ada.id);
  g.grid.hostd.touch(ada.id);
  const touched = inst.lastTouch;
  g.grid.hostd.idleMs = idleMs;
  // Messages keep coming, faster than idleMs: each lands, none of them moves the clock.
  const t = Date.now();
  let id = 2;
  while (g.grid.hostd.state(ada.id) === 'running' && Date.now() - t < 10_000) {
    await g.post(ada, url, update(id++));
    await sleep(90);
    if (g.grid.hostd.state(ada.id) === 'running') assert.equal(inst.lastTouch, touched, 'a delivery moved lastTouch');
  }
  assert.ok(id > 4, 'several messages went by first');
  await until(() => stops.includes('idle'), { what: 'the idle stop', timeout: 10_000 });
  assert.ok(Date.now() - touched < idleMs + 2500, `it slept after ${Date.now() - touched} ms, idleMs is ${idleMs}`);
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

// Three wakes nobody wanted, each stopped by hand. → the hostd.ensure calls the inbox made.
async function struck(g, u, url) {
  const wakes = [];
  const ensure = g.grid.hostd.ensure.bind(g.grid.hostd);
  g.grid.hostd.ensure = (user, o) => (wakes.push({ wake: !!o?.wake, at: Date.now() }), ensure(user, o));
  g.box(u, { status: 403 });
  for (let id = 1; id <= 3; id++) {
    await g.post(u, url, update(id));
    await until(() => g.got(u).length === id, { what: `message ${id}` });
    await until(() => g.rows(u)[id - 1]?.done_at, { what: 'done' });
    await g.grid.hostd.stop(u.id, 'idle');
  }
  return wakes;
}

test('wakes nobody wanted: after three, a low-priority wake, at most one per gap, and a page still drains at once', { timeout: 30_000 }, async () => {
  const wakeGapMs = 1500;
  const g = await boot({ channels: { enabled: true, retryMs: 30, wakeRetryMs: 80, wakeGapMs } });
  const ada = g.user('ada');
  const { url } = await g.url(ada);
  const wakes = await struck(g, ada, url);
  assert.deepEqual(wakes.map((w) => w.wake), [false, false, false]);
  const touched = g.grid.hostd.inst.get(ada.id).lastTouch;
  await g.post(ada, url, update(4));
  await until(() => g.got(ada).length === 4, { what: 'the fourth' });
  assert.deepEqual(wakes.map((w) => w.wake), [false, false, false, true]);
  assert.equal(g.grid.hostd.inst.get(ada.id).lastTouch, touched, 'a wake like this is no use of the box');
  await until(() => g.rows(ada)[3]?.done_at, { what: 'done' });
  await g.grid.hostd.stop(ada.id, 'idle');
  // Inside the gap nothing wakes it, however many come; once it's over one wake takes them all.
  const stopped = Date.now();
  await g.post(ada, url, update(5));
  await g.post(ada, url, update(6));
  await sleep(150);
  if (Date.now() - wakes[3].at < wakeGapMs) assert.equal(wakes.length, 4, 'woken inside the gap');
  await until(() => g.got(ada).length === 6, { what: 'both, after the gap' });
  assert.equal(wakes.length, 5);
  assert.ok(wakes[4].at - wakes[3].at >= wakeGapMs - 50, `${wakes[4].at - wakes[3].at} ms apart`);
  assert.ok(stopped < wakes[4].at);
  await until(() => g.rows(ada)[5]?.done_at, { what: 'done' });
  await g.grid.hostd.stop(ada.id, 'idle');
  // A page opening it doesn't wait for the gap.
  await g.post(ada, url, update(7));
  await g.grid.hostd.ensure(ada);
  await until(() => g.got(ada).length === 7, { what: 'drained by the page', timeout: wakeGapMs - 300 });
  await until(() => g.rows(ada)[6]?.done_at, { what: 'done' });
  // A message the box accepts ends it.
  g.box(ada, {});
  await g.post(ada, url, update(8));
  await until(() => g.got(ada).length === 8, { what: 'accepted' });
  await until(() => g.rows(ada)[7]?.done_at, { what: 'done' });
  await g.grid.hostd.stop(ada.id, 'idle');
  const n = wakes.length;
  await g.post(ada, url, update(9));
  await until(() => g.got(ada).length === 9, { what: 'a plain wake again', timeout: 1000 });
  assert.equal(wakes[n].wake, false);
});

test('a low-priority wake evicts nobody, and waiting for one doesn’t hold up closing the grid', { timeout: 30_000 }, async () => {
  const g = await boot({ channels: { enabled: true, retryMs: 30, wakeRetryMs: 80, wakeGapMs: 0 }, hostd: { maxRunning: 1, evictAfterMs: 0 } });
  const [ada, bob] = [g.user('ada'), g.user('bob')];
  const { url } = await g.url(ada);
  await struck(g, ada, url);
  await g.grid.hostd.ensure(bob);
  await until(() => g.grid.hostd.inst.get(bob.id)?.status, { what: 'bob’s status' });
  await g.post(ada, url, update(4));
  await until(() => g.grid.hostd.state(ada.id) === 'queued', { what: 'ada waiting' });
  await sleep(200);
  assert.equal(g.grid.hostd.state(bob.id), 'running');
  assert.equal(g.grid.hostd.state(ada.id), 'queued');
  running.splice(running.indexOf(g.grid), 1);
  const t = Date.now();
  await g.grid.close();
  assert.ok(Date.now() - t < 5000, `closed in ${Date.now() - t} ms`);
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

test('switched off, what was held still goes after its hour', async () => {
  const g = await boot({ channels: { enabled: false, sweepMs: 30 } });
  const ada = g.user('ada');
  const old = Date.now() - 2 * 60 * 60_000;
  g.grid.db.run("INSERT INTO channel_inbox (user_id, channel, event_key, headers, body, size, at) VALUES (?, 'telegram', 'k', '{\"s\":\"x\"}', x'00', 1, ?)", ada.id, old);
  await until(() => g.rows(ada).length === 0, { what: 'the sweep' });
  const again = await boot({ channels: { enabled: false, sweepMs: 1e9 } });
  const bob = again.user('bob');
  again.grid.db.run("INSERT INTO channel_inbox (user_id, channel, event_key, headers, body, size, at) VALUES (?, 'telegram', 'k', '{}', x'00', 1, ?)", bob.id, old);
  again.grid.inbox.resume();
  assert.equal(again.rows(bob).length, 0, 'and a restart sweeps too');
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

test('the limits: a known token by its own, an unknown one by address', async () => {
  const g = await boot();
  const ada = g.user('ada');
  const { url } = await g.url(ada);
  g.box(ada, { live: 1 });
  let last;
  for (let i = 0; i < 121; i++) last = await g.post(ada, url, update(i));
  assert.equal(last.status, 429);
  // Telegram posts every user's webhook from a few addresses: a known token doesn't count against one.
  const bad = () => call(g.port, 'ada.wisp.localhost', `/_in/${'b'.repeat(43)}`);
  for (let i = 0; i < 600; i++) assert.equal((await bad()).status, 404, `unknown token ${i}`);
  assert.equal((await bad()).status, 429);
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

// Slack: the grid still reads nothing a person said. Its row of CHANNELS says what to keep and which
// request can't wait; a signature is the box's to judge.
const SLACK = { 'x-slack-signature': 'v0=abc', 'x-slack-request-timestamp': '1700000000' };
const slackEvent = (id, text = 'secret words') => JSON.stringify({ type: 'event_callback', event_id: id, event: { type: 'message', text } });
const challenge = JSON.stringify({ type: 'url_verification', challenge: 'c-1', token: 'legacy' });

test('Slack: its signature headers are kept, the retry header isn’t, and a retry with the same signature is one row', async () => {
  const g = await boot();
  const ada = g.user('ada');
  const { url } = await g.url(ada, 'slack');
  const body = slackEvent('Ev1');
  assert.equal((await g.post(ada, url, body, { ...SLACK, 'x-other': 'no' })).status, 200);
  assert.equal((await g.post(ada, url, body, { ...SLACK, 'x-slack-retry-num': '1', 'x-slack-retry-reason': 'http_timeout' })).status, 200);
  await until(() => g.got(ada).length === 1, { what: 'delivery' });
  await g.grid.inbox.settled();
  const [row] = g.got(ada);
  assert.equal(row.channel, 'slack');
  assert.deepEqual(row.headers, SLACK);
  assert.equal(Buffer.from(row.body, 'base64').toString(), body);
  assert.ok(Math.abs(Date.now() - row.at) < 60_000, 'the time the grid took it');
  assert.equal(g.grid.db.get('SELECT count(*) n FROM channel_inbox').n, 1);
});

test('Slack: a retry signed anew is a row of its own, for the box to spot; a forged event_id can’t take the real one’s place', async () => {
  const g = await boot();
  const ada = g.user('ada');
  const { url } = await g.url(ada, 'slack');
  const body = slackEvent('Ev2');
  await g.post(ada, url, body, { ...SLACK, 'x-slack-signature': 'v0=forged' });
  await g.post(ada, url, body, SLACK);
  await g.post(ada, url, body, { ...SLACK, 'x-slack-signature': 'v0=retry', 'x-slack-request-timestamp': '1700000060' });
  await until(() => g.got(ada).length === 3, { what: 'all three' });
  assert.deepEqual(g.got(ada).map((r) => r.headers['x-slack-signature']), ['v0=forged', 'v0=abc', 'v0=retry']);
});

test('url_verification, box up: answered live with what the box says, kept nowhere, and it isn’t use of the box', async () => {
  const g = await boot();
  const ada = g.user('ada');
  const { url } = await g.url(ada, 'slack');
  g.box(ada, { answer: { challenge: 'c-1' } });
  await g.grid.hostd.ensure(ada);
  const touched = g.grid.hostd.inst.get(ada.id).lastTouch;
  const r = await g.post(ada, url, challenge, SLACK);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json(), { challenge: 'c-1' });
  assert.equal(g.grid.db.get('SELECT count(*) n FROM channel_inbox').n, 0);
  assert.equal(g.got(ada).length, 1);
  assert.deepEqual(g.got(ada)[0].headers, SLACK);
  assert.equal(g.grid.hostd.inst.get(ada.id).lastTouch, touched);
  assert.ok(!g.logs.some((l) => l.includes('c-1')));
});

test('url_verification, box asleep: a 503 for Slack to try again, no wake, nothing held', async () => {
  const g = await boot();
  const ada = g.user('ada');
  const { url } = await g.url(ada, 'slack');
  const r = await g.post(ada, url, challenge, SLACK);
  assert.equal(r.status, 503);
  await sleep(150);
  assert.equal(g.grid.hostd.state(ada.id), 'stopped');
  assert.equal(g.grid.db.get('SELECT count(*) n FROM channel_inbox').n, 0);
});

test('Slack: an edit or a bot’s message is never held, so it wakes nothing and costs no strike; a person’s file is held, and a Telegram body like one too', async () => {
  const g = await boot();
  const ada = g.user('ada');
  const { url } = await g.url(ada, 'slack');
  const ensure = g.grid.hostd.ensure.bind(g.grid.hostd);
  let wakes = 0;
  g.grid.hostd.ensure = (user, o) => (wakes++, ensure(user, o));
  const of = (id, event) => JSON.stringify({ type: 'event_callback', event_id: id, event: { type: 'message', ...event } });
  const noise = [of('EvE1', { subtype: 'message_changed' }), of('EvE2', { subtype: 'message_deleted' }), of('EvE3', { user: 'UBOT', bot_id: 'BBOT' }), of('EvE4', { subtype: 'bot_message' })];
  for (const body of noise) assert.equal((await g.post(ada, url, body, SLACK)).status, 200, 'Slack still gets its 200');
  await sleep(150);
  assert.equal(g.rows(ada).length, 0);
  assert.equal(wakes, 0);
  assert.equal(g.grid.hostd.state(ada.id), 'stopped');
  assert.equal(g.dropped(ada), 0, 'skipped isn’t lost');
  const file = of('EvF1', { subtype: 'file_share', user: 'U1' });
  assert.equal((await g.post(ada, url, file, SLACK)).status, 200);
  await until(() => g.got(ada).length === 1, { what: 'the file delivered' });
  assert.equal(wakes, 1);
  const tg = await g.url(ada);
  await g.post(ada, tg.url, { update_id: 7, event: { subtype: 'message_changed' } });
  await until(() => g.got(ada).length === 2, { what: 'Telegram’s delivered' });
});

test('url_verification: what the box refuses is refused, and a box that doesn’t answer is a 503', async () => {
  const g = await boot({ channels: { enabled: true, retryMs: 30, liveMs: 200 } });
  const ada = g.user('ada');
  const { url } = await g.url(ada, 'slack');
  g.box(ada, { status: 403, answer: { error: 'no' } });
  await g.grid.hostd.ensure(ada);
  assert.equal((await g.post(ada, url, challenge, SLACK)).status, 403);
  g.box(ada, { answerMs: 2000 });
  assert.equal((await g.post(ada, url, challenge, SLACK)).status, 503);
});

test('url_verification is Slack’s: on Telegram’s URL a body that looks like one is held like any other', async () => {
  const g = await boot();
  const ada = g.user('ada');
  const { url } = await g.url(ada);
  assert.equal((await g.post(ada, url, challenge)).status, 200);
  await until(() => g.got(ada).length === 1, { what: 'delivery' });
});
