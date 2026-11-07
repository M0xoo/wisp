// `on laptop` in a message to wisp on Cloud (grid/route.js): the grid verifies it, reads the place
// with the shared grammar and forwards it through that computer's tunnel; the box is never asked and
// gains no reach. Against a fake Telegram on loopback, a stand-in box (fixtures/inbox-box.mjs), and a
// stand-in computer on a real tunnel; the last tests use a real wisp at the far end.

import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browser, installFakeBins, isolateAgentConfigs, makeRepo, sleep, tmp, until } from './helpers.js';

const sqlite = await import('node:sqlite').then(
  () => true,
  () => false,
);
const test = (name, opts, fn) => nodeTest(name, { skip: !sqlite && 'the grid needs node:sqlite (Node 22.13+)', ...(fn ? opts : {}) }, fn || opts);

const fakeBin = installFakeBins();
isolateAgentConfigs();
process.env.WISP_HOME = tmp('route-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.FAKE_DELAY = '50';

const { loadConfig } = sqlite ? await import('../grid/config.js') : {};
const { startGrid } = sqlite ? await import('../grid/server.js') : {};
const { ensureMaster } = sqlite ? await import('../grid/secrets.js') : {};
const { dialTunnel } = await import('../server/grid-tunnel.js');
const { parseMessage, parseRoute, stripFormatting } = await import('../server/channels/grammar.js');

const BOX = fileURLToPath(new URL('./fixtures/inbox-box.mjs', import.meta.url));
const HEADER = 'x-telegram-bot-api-secret-token';
const BOT = '123:the-bot-token';
const now = () => Math.floor(Date.now() / 1000);

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

// Telegram: what it heard. Every bot gets its own webhook; setWebhook's secret goes nowhere else.
function fakeTelegram() {
  const tg = { calls: [], msg: 500, hooks: new Map(), setFail: '' };
  tg.called = (m) => tg.calls.filter((c) => c.method === m);
  tg.sent = () => tg.called('sendMessage');
  tg.server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const [bot, method] = new URL(req.url, 'http://x').pathname.split('/').slice(-2);
    const b = body ? JSON.parse(body) : {};
    tg.calls.push({ method, bot, ...b });
    const json = (o) => (res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }), res.end(JSON.stringify(o)));
    if (bot.endsWith('bad-token')) return json({ ok: false, description: 'Unauthorized' });
    if (method === 'getMe') return json({ ok: true, result: { id: 123, username: 'wispbot' } });
    if (method === 'setWebhook') {
      if (tg.setFail) return json({ ok: false, description: tg.setFail });
      tg.hooks.set(bot, { url: b.url, secret: b.secret_token, updates: b.allowed_updates });
      return json({ ok: true, result: true });
    }
    if (method === 'deleteWebhook') return tg.hooks.delete(bot), json({ ok: true, result: true });
    if (method === 'sendMessage') return json({ ok: true, result: { message_id: ++tg.msg } });
    json({ ok: true, result: true });
  });
  return tg;
}

function call(port, host, p, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `${host}:${port}`, connection: 'close', ...headers } }, (res) => {
      let t = '';
      res.on('data', (d) => (t += d));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(t);
        } catch {}
        resolve({ status: res.statusCode, text: t, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const running = [];
after(async () => {
  for (const f of running.reverse()) await f();
});

let updates = 9000;
const message = (text, { from = 42, chat = from, date = now(), reply, id = ++updates, bot = false, type } = {}) => ({
  update_id: id,
  message: { message_id: id + 1000, date, from: { id: from, is_bot: bot, first_name: 'Ada' }, chat: { id: chat, type: type || (chat === from ? 'private' : 'group') }, text, ...(reply && { reply_to_message: { message_id: reply } }) },
});

async function boot({ channels = { enabled: true, route: true, retryMs: 30, wakeRetryMs: 80 } } = {}) {
  const tg = fakeTelegram();
  const api = `http://127.0.0.1:${await listen(tg.server)}`;
  const dataDir = fs.realpathSync(tmp('route'));
  const port = await freePort();
  ensureMaster(dataDir);
  const cfg = loadConfig({ dataDir, env: {}, overrides: { domain: 'wisp.localhost', listen: { host: '127.0.0.1', port }, auth: { dev: true }, hostd: { idleMs: 1e9, checkMs: 60, startMs: 8000, wispBin: BOX }, ...(channels && { channels: { ...channels, telegramApi: api } }) } });
  const grid = await startGrid(cfg, { log: () => {} });
  const base = cfg.publicUrl;
  running.push(async () => {
    await grid.close().catch(() => {});
    tg.server.closeAllConnections?.();
    await new Promise((r) => tg.server.close(r));
  });
  const g = { grid, tg, port, base, cfg };
  g.user = (handle) => {
    if (!grid.accounts.byHandle(handle)) grid.db.run('INSERT INTO users (id, handle, created_at) VALUES (?, ?, ?)', `u-${handle}`, handle, Date.now());
    return grid.accounts.byHandle(handle);
  };
  g.boxAuth = (u) => `Box ${u.handle} ${grid.secrets.ensure(u.id, 'wisp-proxy')}`;
  g.got = (u) => {
    try {
      return fs.readFileSync(path.join(grid.hostd.dirs(u).home, 'inbound.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  // The account page, signed in: the grid's own cookie and the page's own CSRF token.
  g.signedIn = async (u) => {
    const b = browser();
    b.jar.set(new URL(base).host, new Map([['grid', grid.accounts.createSession(u.id, 'grid', 'test')]]));
    const page = await b.go(`${base}/account`);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)?.[1];
    return { b, page, csrf };
  };
  g.link = async (u, { token = BOT, senders = '42' } = {}) => {
    const { b, csrf } = await g.signedIn(u);
    return b.follow(`${base}/channels/route`, { method: 'POST', form: { csrf, token, senders }, headers: { origin: base } });
  };
  g.hook = (bot = BOT) => tg.hooks.get(`bot${bot}`);
  // Telegram calling the webhook the grid set.
  g.send = (update, { secret = g.hook().secret, url = g.hook().url } = {}) => {
    const u = new URL(url);
    const headers = { 'content-type': 'application/json', ...(secret !== null && { [HEADER]: secret }) };
    return call(port, u.hostname, u.pathname, { headers, body: JSON.stringify(update) });
  };
  g.device = (u, name) => {
    const d = grid.accounts.deviceCode(name);
    grid.accounts.answerCode(d.user_code, u.id, true);
    return grid.accounts.pollCode(d.device_code, 0).token;
  };
  // A computer of u's, online: a stand-in for wisp behind a real tunnel. answer(body) says what it does.
  g.computer = async (u, name, answer = () => ({ status: 200, body: { reply: '▶ Started' } })) => {
    const token = g.device(u, `${name} (wisp)`);
    const r = await call(port, 'wisp.localhost', '/api/computers', { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    assert.equal(r.status, 200, r.text);
    const c = { id: r.json.id, token, url: r.json.url, seen: [], answer };
    c.local = http.createServer(async (req, res) => {
      let t = '';
      for await (const d of req) t += d;
      c.seen.push({ url: req.url, headers: req.headers, body: t ? JSON.parse(t) : null });
      const a = c.answer(c.seen.at(-1));
      res.writeHead(a.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(a.body));
    });
    c.tunnel = () => dialTunnel({ url: base, id: c.id, token, port: 0 + c.local.address().port });
    await listen(c.local);
    c.dial = c.tunnel();
    await until(() => grid.tunnels.online(c.id), { what: `${name}’s tunnel` });
    running.push(async () => {
      c.dial.close();
      c.local.closeAllConnections?.();
      await new Promise((r) => c.local.close(r));
    });
    return c;
  };
  return g;
}

const routedTo = (c) => c.seen.filter((x) => x.url === '/api/channels/routed');

// --- the grammar: shared, and importable without wisp ---------------------------------------------

test('grammar.js can be imported by the grid: nothing but itself and mentions.js', () => {
  const dir = new URL('../server/channels/', import.meta.url);
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(new URL(file, dir), 'utf8');
    for (const m of src.matchAll(/^import .* from '([^']+)';$/gm)) {
      assert.ok(m[1].startsWith('./'), `${file} imports ${m[1]}`);
      walk(m[1].slice(2));
    }
  };
  walk('grammar.js');
  assert.deepEqual([...seen].sort(), ['grammar.js', 'mentions.js']);
});

const laptop = [{ id: 'c1', name: 'laptop' }, { id: 'c2', name: 'Mac Studio' }, { id: 'c3', name: 'lapdog' }];
for (const [text, want] of [
  ['on laptop fix the login', { machine: 'c1', text: 'fix the login' }],
  ['on laptop: fix the login', { machine: 'c1', text: ': fix the login' }],
  ['**on** laptop fix it', { machine: 'c1', text: 'fix it' }],
  ['ON LAPTOP fix it', { machine: 'c1', text: 'fix it' }],
  ['on Mac Studio plan: fix it', { machine: 'c2', text: 'plan: fix it' }],
  ['on mac fix it', { machine: 'c2', text: 'fix it' }],
  ['in api on laptop fix it', { machine: 'c1', text: 'in api fix it' }],
  ['in api on laptop with opus high plan: fix it', { machine: 'c1', text: 'in api with opus high plan: fix it' }],
  ['with gpt-5 high on laptop: fix it', { machine: 'c1', text: 'with gpt-5 high : fix it' }],
  ['with claude opus-4 on laptop fix it', { machine: 'c1', text: 'with claude opus-4 fix it' }],
  ['#api on laptop fix it', { machine: 'c1', text: '#api fix it' }],
  ['@ada on laptop fix it', { machine: 'c1', text: '@ada fix it' }],
  ['/new on laptop status', { machine: 'c1', text: '/new status' }],
  ['/new in api on laptop fix it', { machine: 'c1', text: '/new in api fix it' }],
  ['on laptop full auto: delete it', { machine: 'c1', text: 'full auto: delete it' }],
  // What isn't a route: the box's, as today.
  ['fix it on laptop', null],
  ['plan the migration on laptop', null],
  ['on my laptop fix it', null],
  ['on the laptop fix it', null],
  ['on desk fix it', null],
  ['on desk: fix it', null],
  ['on here fix it', null],
  ['on local fix it', null],
  ['on cloud fix it', null],
  ['on sandbox fix it', null],
  [': on laptop fix it', null],
  ['status', null],
  ['/status', null],
  ['/nope on laptop', null],
  ['models on laptop', null],
  ['', null],
  ['in the login page on laptop fix it', null],
  ['#123 on laptop fix it', null],
]) {
  test(`parseRoute: ${JSON.stringify(text)}`, () => {
    const got = parseRoute(text, laptop);
    if (!want) return assert.equal(got?.machine ?? null, null, JSON.stringify(got));
    assert.equal(got.machine, want.machine);
    assert.equal(got.text.trim(), want.text);
  });
}

test('parseRoute: a name two computers share is said, not guessed', () => {
  const got = parseRoute('on lap fix it', laptop);
  assert.equal(got.machine, undefined);
  assert.match(got.problems[0].text, /could be 2/);
});

test('what the grid hands on reads the same on the computer', () => {
  const ctx = { projects: [{ name: 'api', path: '/api' }], machines: [], adapters: [], agents: [], crew: [] };
  for (const [text, want] of [
    ['in api on laptop fix it', { project: 'api', prompt: 'fix it' }],
    ['on laptop: in api fix it', { project: null, prompt: 'in api fix it' }],
    ['on laptop plan: fix it', { project: null, prompt: 'fix it', mode: 'plan' }],
    ['on laptop full auto: fix it', { project: null, prompt: 'fix it', mode: 'auto' }],
    ['on laptop', { project: null, prompt: '' }],
  ]) {
    const p = parseMessage(parseRoute(text, laptop).text, ctx);
    assert.equal(p.project?.name ?? null, want.project, text);
    assert.equal(p.prompt, want.prompt, text);
    if (want.mode) assert.equal(p.mode, want.mode, text);
  }
  assert.equal(stripFormatting('@wispbot on laptop fix it', 'telegram', { bot: 'wispbot' }), 'on laptop fix it');
});

// --- the account page ------------------------------------------------------------------------------

test('the page holds the bot: the grid makes the secret and owns the webhook, and nothing shows it', async () => {
  const g = await boot();
  const ada = g.user('ada');
  const r = await g.link(ada, { senders: '42, 77' });
  assert.equal(r.status, 200, r.text);
  const hook = g.hook();
  assert.ok(hook.url.startsWith(`${g.base}/_route/`), hook.url);
  assert.ok(hook.secret.length >= 32);
  assert.ok(hook.updates.includes('message') && hook.updates.includes('callback_query'));
  const dump = JSON.stringify(g.grid.db.all('SELECT * FROM user_secrets')) + JSON.stringify(g.grid.db.all('SELECT * FROM channel_routes'));
  for (const s of [hook.secret, BOT, new URL(hook.url).pathname.split('/').pop()]) assert.ok(!dump.includes(s), 'sealed');
  const { page } = await g.signedIn(ada);
  assert.match(page.text, /wispbot/);
  for (const s of [hook.secret, BOT]) assert.ok(!page.text.includes(s), 'never shown again');
  assert.equal(g.grid.routes.get(ada.id).senders.join(), '42,77');
});

test('the page refuses what would never work, and says so', async () => {
  const g = await boot();
  const ada = g.user('ada');
  assert.match((await g.link(ada, { token: '123:bad-token' })).text, /Telegram.*Unauthorized|didn’t take/);
  assert.match((await g.link(ada, { senders: 'ada' })).text, /number/);
  assert.equal(g.tg.hooks.size, 0);
  assert.equal(g.grid.routes.get(ada.id), null);
  g.tg.setFail = 'Bad Request: bad webhook: An HTTPS URL must be provided for webhook';
  assert.match((await g.link(ada)).text, /HTTPS URL/);
  assert.equal(g.grid.routes.get(ada.id), null, 'nothing kept for a webhook that isn’t there');
});

test('Forget it: Telegram stops calling, the seal is gone, the URL is a 404', async () => {
  const g = await boot();
  const ada = g.user('ada');
  await g.link(ada);
  const { url, secret } = g.hook();
  const { b, csrf } = await g.signedIn(ada);
  assert.equal((await b.follow(`${g.base}/channels/route/remove`, { method: 'POST', form: { csrf }, headers: { origin: g.base } })).status, 200);
  assert.equal(g.hook(), undefined);
  assert.equal(g.grid.db.get("SELECT count(*) n FROM user_secrets WHERE purpose = 'route:telegram'").n, 0);
  assert.equal((await g.send(message('on laptop x'), { url, secret })).status, 404);
});

test('off unless grid.json says route: true: no page, no address, no held webhook', async () => {
  const g = await boot({ channels: { enabled: true } });
  const ada = g.user('ada');
  const { b, csrf, page } = await g.signedIn(ada);
  assert.doesNotMatch(page.text, /\/channels\/route/);
  assert.equal((await b.go(`${g.base}/channels/route`, { method: 'POST', form: { csrf, token: BOT, senders: '42' }, headers: { origin: g.base } })).status, 404);
  assert.equal((await call(g.port, 'wisp.localhost', `/_route/${'a'.repeat(43)}`, { body: '{}' })).status, 404);
  assert.equal(g.tg.calls.length, 0);
  const url = await call(g.port, 'wisp.localhost', '/api/channels/url?channel=telegram', { method: 'GET', headers: { authorization: g.boxAuth(ada) } });
  assert.equal(url.json.held, undefined);
});

test('a page in a box can’t set it: another origin is refused, and no CSRF token is no go', async () => {
  const g = await boot();
  const ada = g.user('ada');
  const { b, csrf } = await g.signedIn(ada);
  const box = `http://ada.wisp.localhost:${g.port}`;
  assert.equal((await b.go(`${g.base}/channels/route`, { method: 'POST', form: { csrf, token: BOT, senders: '666' }, headers: { origin: box } })).status, 403);
  assert.equal((await b.go(`${g.base}/channels/route`, { method: 'POST', form: { token: BOT, senders: '666' }, headers: { origin: g.base } })).status, 403);
  assert.equal(g.grid.routes.get(ada.id), null);
});

// --- at the edge ----------------------------------------------------------------------------------

test('routed: a verified message for a computer goes through its tunnel, the box hears nothing', async () => {
  const g = await boot();
  const ada = g.user('ada');
  await g.link(ada);
  const c = await g.computer(ada, 'laptop');
  const r = await g.send(message('@wispbot in api on laptop fix the login'));
  assert.equal(r.status, 200, r.text);
  await until(() => g.tg.sent().length, { what: 'the answer' });
  const [one] = routedTo(c);
  assert.equal(one.body.text.trim(), 'in api fix the login');
  assert.equal(one.body.sender, 'Ada');
  assert.equal(one.body.channel, 'telegram');
  assert.ok(one.body.id && one.body.at && one.body.thread);
  assert.equal(one.headers['x-wisp-route'], 'grid');
  assert.ok(!(HEADER in one.headers) && !('authorization' in one.headers));
  const [said] = g.tg.sent();
  assert.equal(said.text, '▶ Started');
  assert.equal(String(said.chat_id), '42');
  assert.equal(g.got(ada).length, 0);
  assert.equal(g.grid.hostd.state(ada.id), 'stopped', 'never woken');
  assert.equal(g.grid.db.get('SELECT count(*) n FROM channel_inbox WHERE user_id = ? AND done_at IS NULL', ada.id).n, 0);
});

test('switch off: the computer says no, the grid says so in the chat, nothing is held anywhere', async () => {
  const g = await boot();
  const ada = g.user('ada');
  await g.link(ada);
  await g.computer(ada, 'laptop', () => ({ status: 403, body: { off: true, reply: 'That computer doesn’t accept tasks from channels.' } }));
  await g.send(message('on laptop fix it'));
  await until(() => g.tg.sent().length, { what: 'the line' });
  assert.match(g.tg.sent()[0].text, /doesn’t accept tasks/);
  assert.equal(g.got(ada).length, 0);
  assert.equal(g.grid.db.get('SELECT count(*) n FROM channel_inbox WHERE user_id = ? AND done_at IS NULL', ada.id).n, 0);
});

test('computer offline: a plain line back, nothing queued for later', async () => {
  const g = await boot();
  const ada = g.user('ada');
  await g.link(ada);
  const c = await g.computer(ada, 'laptop');
  c.dial.close();
  await until(() => !g.grid.tunnels.online(c.id), { what: 'it offline' });
  await g.send(message('on laptop fix it'));
  await until(() => g.tg.sent().length, { what: 'the line' });
  assert.match(g.tg.sent()[0].text, /laptop is offline/);
  c.dial = c.tunnel();
  await until(() => g.grid.tunnels.online(c.id), { what: 'it back' });
  await sleep(150);
  assert.equal(routedTo(c).length, 0, 'it doesn’t arrive later');
  assert.equal(g.got(ada).length, 0);
});

test('a computer too old for this, or one that doesn’t answer: a line, not silence', async () => {
  const g = await boot();
  const ada = g.user('ada');
  await g.link(ada);
  await g.computer(ada, 'laptop', () => ({ status: 404, body: { error: 'not found' } }));
  await g.send(message('on laptop fix it'));
  await until(() => g.tg.sent().length, { what: 'the line' });
  assert.match(g.tg.sent()[0].text, /laptop needs a newer wisp/);
});

test('another user’s computer: only your own are read, and theirs never hears of it', async () => {
  const g = await boot();
  const [ada, bea] = [g.user('ada'), g.user('bea')];
  await g.link(ada);
  const theirs = await g.computer(bea, 'studio');
  await g.send(message('on studio fix it'));
  await until(() => g.got(ada).length, { what: 'the box hearing it' });
  assert.equal(routedTo(theirs).length, 0);
  assert.equal(g.tg.sent().length, 0);
});

test('two people, one grid: each bot reaches its own person’s computer', async () => {
  const g = await boot();
  const [ada, bea] = [g.user('ada'), g.user('bea')];
  await g.link(ada);
  await g.link(bea, { token: '456:other-bot', senders: '77' });
  const [a, b] = [await g.computer(ada, 'laptop'), await g.computer(bea, 'laptop')];
  await g.send(message('on laptop from ada'));
  await g.send(message('on laptop from bea', { from: 77 }), { url: g.hook('456:other-bot').url, secret: g.hook('456:other-bot').secret });
  await until(() => routedTo(a).length && routedTo(b).length, { what: 'both' });
  assert.match(routedTo(a)[0].body.text, /from ada/);
  assert.match(routedTo(b)[0].body.text, /from bea/);
  assert.equal(routedTo(a).length + routedTo(b).length, 2);
  // One bot's secret doesn't open the other's URL.
  assert.equal((await g.send(message('on laptop x'), { url: g.hook('456:other-bot').url, secret: g.hook().secret })).status, 403);
  assert.equal(g.tg.sent().filter((x) => x.bot === 'bot456:other-bot').length, 1, 'bea’s answer through bea’s bot');
});

test('forged sender: Telegram’s word for the id is the only one, and a stranger’s goes to the box', async () => {
  const g = await boot();
  const ada = g.user('ada');
  await g.link(ada);
  const c = await g.computer(ada, 'laptop');
  // No secret: anyone holding the URL, claiming to be the owner.
  assert.equal((await g.send(message('on laptop rm -rf'), { secret: null })).status, 403);
  // Really from Telegram, from someone not on the list; a bot; a group the owner is in.
  await g.send(message('on laptop stranger', { from: 666 }));
  await g.send(message('on laptop bot', { bot: true }));
  await g.send(message('on laptop group', { chat: -100, type: 'group' }));
  await until(() => g.got(ada).length === 3, { what: 'the box hearing all three' });
  assert.equal(routedTo(c).length, 0);
});

test('bad secret: refused at the edge, not routed, not held, whatever it says', async () => {
  const g = await boot();
  const ada = g.user('ada');
  await g.link(ada);
  const c = await g.computer(ada, 'laptop');
  // The box's own secret and URL can't stand in for the grid's.
  assert.equal((await g.send(message('on laptop a'), { secret: g.grid.secrets.ensure(ada.id, 'wisp-proxy') })).status, 403);
  assert.equal((await g.send(message('on laptop b'), { secret: 'x'.repeat(g.hook().secret.length) })).status, 403);
  await sleep(120);
  assert.equal(g.grid.db.get('SELECT count(*) n FROM channel_inbox').n, 0);
  assert.equal(routedTo(c).length, 0);
  // A wrong token: as if nothing were there.
  assert.equal((await g.send(message('on laptop c'), { url: `${g.base}/_route/${'a'.repeat(43)}` })).status, 404);
  assert.equal((await call(g.port, 'wisp.localhost', g.hook().url.replace(g.base, ''), { method: 'GET' })).status, 404);
});

test('replay: Telegram’s retry and a repeated update run once', async () => {
  const g = await boot();
  const ada = g.user('ada');
  await g.link(ada);
  const c = await g.computer(ada, 'laptop');
  const u = message('on laptop once');
  await g.send(u);
  await g.send(u);
  await until(() => routedTo(c).length, { what: 'it' });
  await sleep(120);
  await g.send(u);
  await sleep(80);
  assert.equal(routedTo(c).length, 1);
  assert.equal(g.tg.sent().length, 1);
});

test('anything else goes to the box as today: verified, without the grid’s secret', async () => {
  const g = await boot();
  const ada = g.user('ada');
  await g.link(ada);
  const c = await g.computer(ada, 'laptop');
  const reply = message('not linked', { reply: 12345 });
  const button = { update_id: ++updates, callback_query: { id: 'q', from: { id: 42 }, data: 'a:s:r:0', message: { message_id: 3, chat: { id: 42 } } } };
  for (const u of [message('fix the login'), message('on desk fix it'), message('on laptop later', { reply: 12345, id: ++updates }), reply, button]) await g.send(u);
  await until(() => g.got(ada).length === 5, { what: 'the box hearing them' });
  for (const row of g.got(ada)) {
    assert.equal(row.verified, true);
    assert.ok(!(HEADER in row.headers), 'the grid’s secret stays here');
    assert.ok(!JSON.stringify(row).includes(g.hook().secret));
  }
  assert.equal(routedTo(c).length, 0);
});

test('a name two computers share gets its line from the grid', async () => {
  const g = await boot();
  const ada = g.user('ada');
  await g.link(ada);
  await g.computer(ada, 'laptop');
  await g.computer(ada, 'lapdog');
  await g.send(message('on lap fix it'));
  await until(() => g.tg.sent().length, { what: 'the line' });
  assert.match(g.tg.sent()[0].text, /could be 2/);
  assert.equal(g.got(ada).length, 0);
});

test('a box that asks gets nothing: it’s told the webhook is held, and no more', async () => {
  const g = await boot();
  const ada = g.user('ada');
  await g.link(ada);
  const before = await call(g.port, 'wisp.localhost', '/api/channels/url?channel=telegram', { method: 'GET', headers: { authorization: g.boxAuth(ada) } });
  assert.equal(before.json.held, true);
  for (const s of [g.hook().secret, BOT, new URL(g.hook().url).pathname.split('/').pop()]) assert.ok(!before.text.includes(s));
});

test('Box secret refused: not a page, not a reply, not a route, and its own URL reaches only its box', async () => {
  const g = await boot();
  const ada = g.user('ada');
  await g.link(ada, { senders: '42' });
  const c = await g.computer(ada, 'laptop');
  await g.send(message('on laptop first'));
  await until(() => routedTo(c).length, { what: 'a thread' });
  const { thread } = routedTo(c)[0].body;
  const box = { authorization: g.boxAuth(ada), 'content-type': 'application/json' };
  // Reply: device tokens only.
  assert.equal((await call(g.port, 'wisp.localhost', '/api/channels/reply', { headers: box, body: JSON.stringify({ thread, text: 'x' }) })).status, 401);
  // The account page: a cookie and a CSRF token, which a Box secret is neither of.
  const page = await call(g.port, 'wisp.localhost', '/channels/route', { headers: { ...box, 'content-type': 'application/x-www-form-urlencoded', origin: g.base }, body: `token=${BOT}&senders=666` });
  assert.equal(page.status, 302);
  assert.equal(g.grid.routes.get(ada.id).senders.join(), '42');
  // A box can't take the route at its own address.
  assert.notEqual((await call(g.port, 'ada.wisp.localhost', g.hook().url.replace(g.base, ''), { headers: { ...box, [HEADER]: g.hook().secret }, body: JSON.stringify(message('on laptop x')) })).status, 200);
  // Its /_in URL, with the secret it chose and any sender it likes, reaches its box and no further.
  const url = await call(g.port, 'wisp.localhost', '/api/channels/url?channel=telegram', { method: 'GET', headers: { authorization: g.boxAuth(ada) } });
  const at = new URL(url.json.url);
  await call(g.port, at.hostname, at.pathname, { headers: { 'content-type': 'application/json', [HEADER]: 'its-own' }, body: JSON.stringify(message('on laptop forged')) });
  await until(() => g.got(ada).length, { what: 'the box hearing itself' });
  assert.equal(g.got(ada)[0].verified, undefined, 'and it isn’t called verified');
  assert.equal(routedTo(c).length, 1);
});

test('the mark can’t be sent from a browser at the computer’s address', async () => {
  const g = await boot();
  const ada = g.user('ada');
  await g.link(ada);
  const c = await g.computer(ada, 'laptop');
  const r = await call(g.port, new URL(c.url).hostname, '/api/channels/routed', { headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json', 'x-wisp-route': 'grid' }, body: '{}' });
  assert.equal(r.status, 200);
  assert.equal(c.seen.at(-1).headers['x-wisp-route'], undefined);
});

// --- reports and follow-ups ------------------------------------------------------------------------

test('a report: a device with the thread posts to that chat, and that’s all it can do', async () => {
  const g = await boot();
  const [ada, bea] = [g.user('ada'), g.user('bea')];
  await g.link(ada);
  const [c, other] = [await g.computer(ada, 'laptop'), await g.computer(ada, 'studio')];
  const stranger = g.device(bea, 'Bea’s (wisp)');
  await g.send(message('on laptop fix it', { id: 7777 }));
  await until(() => routedTo(c).length, { what: 'the thread' });
  const { thread } = routedTo(c)[0].body;
  const post = (token, body) => call(g.port, 'wisp.localhost', '/api/channels/reply', { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post(c.token, { thread, text: '✅ Done', chat_id: 666 })).status, 200);
  const said = g.tg.sent().at(-1);
  assert.equal(said.text, '✅ Done');
  assert.equal(String(said.chat_id), '42', 'the chat is the thread’s, not the caller’s');
  assert.equal(said.reply_to_message_id, 8777);
  assert.equal((await post(other.token, { thread, text: 'x' })).status, 404, 'another computer of theirs');
  assert.equal((await post(stranger, { thread, text: 'x' })).status, 404, 'another person');
  assert.equal((await post(c.token, { thread: 'a'.repeat(43), text: 'x' })).status, 404);
  assert.equal((await post('nope', { thread, text: 'x' })).status, 401);
  assert.equal(g.tg.sent().length, 2);
});

test('a follow-up: a reply to what the grid sent goes back to that computer, in that thread', async () => {
  const g = await boot();
  const ada = g.user('ada');
  await g.link(ada);
  const c = await g.computer(ada, 'laptop');
  await g.send(message('on laptop fix it'));
  await until(() => g.tg.sent().length, { what: 'the first answer' });
  const { thread } = routedTo(c)[0].body;
  await g.send(message('now do the other one', { reply: 501 }));
  await until(() => routedTo(c).length === 2, { what: 'the follow-up' });
  const follow = routedTo(c)[1].body;
  assert.equal(follow.follow, true);
  assert.equal(follow.thread, thread);
  assert.equal(follow.text, 'now do the other one');
  assert.equal(g.got(ada).length, 0);
});
