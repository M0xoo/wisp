// A golden transcript of Telegram and ntfy as they were before the channel layer: every request
// wisp makes to them, byte for byte, against fake servers on loopback. Written and passing on the
// old server/remote.js, then kept unchanged across the move to server/channels/: this file is the
// proof that with telegram.options off nothing changed.
//
// Half of it drives Remote itself with stub actions (every branch, exact bodies), half a real wisp
// with fake agents (the same words end to end).

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import { createServer as netServer } from 'node:net';
import { installFakeBins, isolateAgentConfigs, makeRepo, tmp, until } from './helpers.js';

process.env.FAKE_RECORD = tmp('legacy-record');
process.env.WISP_HOME = tmp('legacy-home');
process.env.WISP_UPDATE_CHECK = '0';
installFakeBins();
isolateAgentConfigs();

const { Remote, findProject, mask } = await import('../server/remote.js');
const { startServer } = await import('../server/index.js');

const OFF = 'Starting tasks from Telegram is off. Turn it on in wisp → Phone → Telegram.';
const TOKEN = '123:abc';
const CHAT = 42;

// One fake server plays both ntfy and the Telegram Bot API, and logs what it hears.
const net = { tg: [], polls: [], updates: [], next: 1, msg: 100, ntfy: [], ntfyPolls: [], replies: [], tgFail: 0, ntfyFail: 0 };
let fake;
let fakeUrl;

before(async () => {
  fake = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const u = new URL(req.url, 'http://x');
    const json = (o) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
    if (u.pathname.startsWith('/bot')) {
      const method = u.pathname.split('/').pop();
      const b = body ? JSON.parse(body) : {};
      assert.equal(u.pathname, `/bot${TOKEN}/${method}`);
      if (method === 'getUpdates') {
        net.polls.push(b);
        if (net.tgFail > 0) {
          net.tgFail--;
          return json({ ok: false, description: 'Bad Gateway' });
        }
        const out = net.updates.filter((x) => x.update_id >= (b.offset || 0));
        if (!out.length) await new Promise((r) => setTimeout(r, 15));
        return json({ ok: true, result: out });
      }
      net.tg.push({ method, ...b });
      return json({ ok: true, result: method === 'sendMessage' ? { message_id: ++net.msg } : true });
    }
    if (req.method === 'POST' && u.pathname === '/') {
      if (net.ntfyFail > 0) {
        net.ntfyFail--;
        res.writeHead(500);
        return res.end('down');
      }
      net.ntfy.push({ auth: req.headers.authorization || '', type: req.headers['content-type'], body: JSON.parse(body) });
      return json({ id: 'p' });
    }
    if (req.method === 'POST') {
      net.replies.push({ id: `r${net.replies.length + 1}`, event: 'message', time: Math.floor(Date.now() / 1000), message: body });
      return json({});
    }
    if (u.pathname.endsWith('-reply/json')) {
      net.ntfyPolls.push({ path: u.pathname, since: u.searchParams.get('since'), poll: u.searchParams.get('poll'), auth: req.headers.authorization || '' });
      if (net.ntfyFail > 0) {
        net.ntfyFail--;
        res.writeHead(503);
        return res.end();
      }
      const since = u.searchParams.get('since');
      const at = net.replies.findIndex((m) => m.id === since);
      const out = /^\d+$/.test(since) ? net.replies : net.replies.slice(at + 1);
      res.writeHead(200);
      return res.end(out.map((m) => JSON.stringify(m)).join('\n'));
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${fake.address().port}`;
  process.env.WISP_TELEGRAM_API = fakeUrl;
});

const reset = () => Object.assign(net, { tg: [], polls: [], updates: [], next: 1, msg: 100, ntfy: [], ntfyPolls: [], replies: [], tgFail: 0, ntfyFail: 0 });

const say = (text, o = {}) => net.updates.push({ update_id: net.next++, message: { message_id: net.next + 1000, chat: { id: CHAT, type: 'private' }, text, ...o } });
const tap = (data, o = {}) => net.updates.push({ update_id: net.next++, callback_query: { id: `cb${net.next}`, data, message: { message_id: 77, chat: { id: CHAT } }, ...o } });

// The poll loop is serial: once the reply to this /help is out, everything before it was handled.
let marks = 0;
const barrier = async (r) => {
  const n = net.tg.length;
  const id = 9000 + ++marks;
  net.updates.push({ update_id: net.next++, message: { message_id: id, chat: { id: CHAT, type: 'private' }, text: '/help' } });
  const was = r.cfg.telegram?.allowStart;
  await until(() => net.tg.slice(n).some((m) => m.method === 'sendMessage' && m.text.includes('Reply to wisp’s messages')));
  net.tg = net.tg.filter((m, i) => !(i >= n && m.method === 'sendMessage' && m.text.includes('Reply to wisp’s messages') && m.chat_id === CHAT && !m.reply_to_message_id && m.text === helpFor(was)));
};
const helpFor = (allowStart) =>
  allowStart ? 'Send /new <task> to start a task in your default project, or /new @project <task> to pick one (/projects lists them). Reply to wisp’s messages to answer or follow up.' : `Reply to wisp’s messages to answer or follow up. ${OFF}`;

const rigs = [];
function rig({ telegram = {}, ntfy, events, projects = [], sessions = [], machines = [], act, launch } = {}) {
  const store = {
    config: { remote: { ...(events && { events }), ...(ntfy && { ntfy }), telegram: { enabled: true, token: TOKEN, chatId: CHAT, chatName: 'Ada', linkCode: '', allowStart: false, project: '', ...telegram } }, projects, machines },
    saved: 0,
    saveConfig() {
      this.saved++;
    },
    all: () => sessions,
    get: (id) => sessions.find((s) => s.id === id) || null,
    save() {},
  };
  const calls = { act: [], launch: [], changes: 0 };
  const r = new Remote({
    store,
    act: async (a) => (calls.act.push(a), act ? act(a) : '✓ Sent'),
    launch: async (a) => (calls.launch.push(a), launch ? launch(a) : { id: 's1', title: 'The title' }),
    onChange: () => calls.changes++,
  });
  r.tgLongPoll = 0;
  r.ntfyPollMs = 15;
  rigs.push(r);
  return { r, store, calls, sessions };
}

afterEach(async () => {
  for (const r of rigs.splice(0)) r.stop();
  await new Promise((res) => setTimeout(res, 40)); // a poll already on its way lands in this test, not the next
  reset();
});

const sends = () => net.tg.filter((m) => m.method === 'sendMessage').map(({ method, ...m }) => m);

// --- linking ---------------------------------------------------------------------------------

test('linking: strangers and wrong codes hear nothing; /link, /start or the bare code link the chat', async () => {
  for (const [i, text] of ['/link 123456', '/start 123456', '123456'].entries()) {
    const { r, store, calls } = rig({ telegram: { chatId: null, chatName: '', linkCode: '123456' } });
    r.start();
    say('hi', { chat: { id: 666 } });
    say('/link 000000', { chat: { id: 666 } });
    say('/new do it', { chat: { id: 666 } });
    tap('a:s:r:0', { message: { message_id: 1, chat: { id: 666 } } });
    say(text, { chat: { id: CHAT, first_name: 'Ada', last_name: 'L' } });
    await until(() => net.tg.length);
    assert.deepEqual(net.tg, [{ method: 'sendMessage', chat_id: CHAT, text: '✓ Linked to wisp. Questions and finished tasks will show up here.' }], text);
    const t = store.config.remote.telegram;
    assert.deepEqual([t.chatId, t.chatName, t.linkCode], [CHAT, 'Ada L', '']);
    assert.equal(calls.act.length + calls.launch.length, 0);
    assert.ok(store.saved >= 1, 'the link is saved');
    r.stop();
    reset();
    assert.ok(i < 3);
  }
});

test('linking: a chat title, then a username, names the link; start() makes a code when there is none', async () => {
  const { r, store } = rig({ telegram: { chatId: null, chatName: '', linkCode: '' } });
  r.start();
  assert.match(store.config.remote.telegram.linkCode, /^\d{6}$/);
  say(`/link ${store.config.remote.telegram.linkCode}`, { chat: { id: -5, title: 'Team', username: 'x' } });
  await until(() => net.tg.length);
  assert.equal(store.config.remote.telegram.chatName, 'Team');
  assert.equal(net.tg[0].chat_id, -5);
  const b = rig({ telegram: { chatId: null, chatName: '', linkCode: '654321' } });
  b.r.start();
  say('/link 654321', { chat: { id: 7, username: 'ada' } });
  await until(() => b.store.config.remote.telegram.chatId);
  assert.equal(b.store.config.remote.telegram.chatName, 'ada');
});

test('getUpdates: the exact poll, and the offset moves past what was handled', async () => {
  const { r } = rig();
  r.start();
  say('/help');
  await until(() => net.tg.length);
  await until(() => net.polls.some((p) => p.offset === 2));
  assert.deepEqual(net.polls[0], { offset: 0, timeout: 0, allowed_updates: ['message', 'callback_query'] });
  assert.equal(r.tgOffset, 2);
});

// --- commands --------------------------------------------------------------------------------

test('/help and /start, with starting off and on, in the exact words', async () => {
  const off = rig();
  off.r.start();
  say('/help');
  say('/start');
  say('/HELP@wispbot');
  await until(() => net.tg.length === 3);
  assert.deepEqual(sends(), [1, 2, 3].map(() => ({ chat_id: CHAT, text: `Reply to wisp’s messages to answer or follow up. ${OFF}` })));
  off.r.stop();
  reset();
  const on = rig({ telegram: { allowStart: true } });
  on.r.start();
  say('/help');
  await until(() => net.tg.length);
  assert.deepEqual(sends(), [{ chat_id: CHAT, text: 'Send /new <task> to start a task in your default project, or /new @project <task> to pick one (/projects lists them). Reply to wisp’s messages to answer or follow up.' }]);
});

test('allowStart off: /new and /projects are refused and nothing launches', async () => {
  const { r, calls } = rig({ projects: [{ id: 'p', name: 'api', path: '/x/api' }] });
  r.start();
  say('/new add a README');
  say('/projects');
  await until(() => net.tg.length === 2);
  assert.deepEqual(sends(), [{ chat_id: CHAT, text: OFF }, { chat_id: CHAT, text: OFF }]);
  assert.equal(calls.launch.length, 0);
});

test('/projects: none, then the list with machines and the default', async () => {
  const none = rig({ telegram: { allowStart: true } });
  none.r.start();
  say('/projects');
  await until(() => net.tg.length);
  assert.deepEqual(sends(), [{ chat_id: CHAT, text: 'No projects yet. Open a folder in wisp first.' }]);
  none.r.stop();
  reset();
  const { r } = rig({
    telegram: { allowStart: true, project: 'p2' },
    projects: [{ id: 'p1', name: 'api', path: '/x/api' }, { id: 'p2', name: 'web', path: '/x/web' }, { id: 'p3', name: 'ops', path: '/x/ops', machine: 'm1' }, { id: 'p4', name: 'etl', path: '/x/etl', machine: 'gone' }],
    machines: [{ id: 'm1', name: 'laptop' }],
  });
  r.start();
  say('/projects');
  await until(() => net.tg.length);
  assert.deepEqual(sends(), [{ chat_id: CHAT, text: 'Projects:\n• api\n• web  ← default\n• ops (on laptop)\n• etl (on gone)\n\n/new @name <task> runs in one of them.' }]);
});

test('/new: default project, @project, and every refusal, in the exact words', async () => {
  const projects = [{ id: 'p1', name: 'api', path: '/x/api', lastUsedAt: 1 }, { id: 'p2', name: 'web', path: '/x/web', lastUsedAt: 9 }];
  const { r, calls, sessions } = rig({ telegram: { allowStart: true }, projects, sessions: [{ id: 's1', title: 'T' }] });
  r.start();
  say('/new add a README', { message_id: 1 });
  say('/new@wispbot @api fix it', { message_id: 2 });
  say('/NEW @API  fix it too', { message_id: 3 });
  say('/new @nope do it', { message_id: 4 });
  say('/new', { message_id: 5 });
  say('/new @api', { message_id: 6 });
  await until(() => net.tg.length === 6);
  assert.deepEqual(sends(), [
    { chat_id: CHAT, text: '▶ Started in web: The title\n\nwisp will message you when it needs you or is done. Reply to this message to follow up.', reply_to_message_id: 1 },
    { chat_id: CHAT, text: '▶ Started in api: The title\n\nwisp will message you when it needs you or is done. Reply to this message to follow up.', reply_to_message_id: 2 },
    { chat_id: CHAT, text: '▶ Started in api: The title\n\nwisp will message you when it needs you or is done. Reply to this message to follow up.', reply_to_message_id: 3 },
    { chat_id: CHAT, text: 'No project matches “nope”. Send /projects to see them.' },
    { chat_id: CHAT, text: 'What should it do? Send /new <task>, or /new @project <task>.' },
    { chat_id: CHAT, text: 'What should it do? Send /new <task>, or /new @project <task>.' },
  ]);
  assert.deepEqual(calls.launch, [
    { project: projects[1], prompt: 'add a README' },
    { project: projects[0], prompt: 'fix it' },
    { project: projects[0], prompt: 'fix it too' },
  ]);
  assert.deepEqual(sessions[0].remote, { tg: [101, 102, 103] }, 'each Started message links to its task');
});

test('/new reads no options: every word after it is the prompt, as it always was', async () => {
  const projects = [{ id: 'p1', name: 'api', path: '/x/api', lastUsedAt: 2 }, { id: 'p2', name: 'web', path: '/x/web', lastUsedAt: 9 }];
  const { r, calls } = rig({ telegram: { allowStart: true }, projects, sessions: [{ id: 's1', title: 'T' }] });
  r.start();
  for (const text of ['in api fix it', 'plan the migration', 'with opus fix it', 'on laptop: fix it', 'plan: fix it', '#api fix it', 'full auto fix it', ': leading colon']) say(`/new ${text}`);
  await until(() => net.tg.length === 8);
  assert.deepEqual(calls.launch.map((x) => x.project.name), Array(8).fill('web'));
  assert.deepEqual(calls.launch.map((x) => x.prompt), ['in api fix it', 'plan the migration', 'with opus fix it', 'on laptop: fix it', 'plan: fix it', '#api fix it', 'full auto fix it', ': leading colon']);
});

test('/new: stale (older than 10 minutes) refused, fresh within 10 minutes runs', async () => {
  const now = Math.floor(Date.now() / 1000);
  const { r, calls } = rig({ telegram: { allowStart: true }, projects: [{ id: 'p1', name: 'api', path: '/x/api' }], sessions: [{ id: 's1' }] });
  r.start();
  say('/new sent while offline', { message_id: 7, date: now - 3600 });
  say('/new just in time', { message_id: 8, date: now - 590 });
  await until(() => net.tg.length === 2);
  assert.deepEqual(sends()[0], { chat_id: CHAT, text: 'That /new arrived while wisp was offline, so it didn’t start. Send it again to run it now.', reply_to_message_id: 7 });
  assert.deepEqual(calls.launch.map((x) => x.prompt), ['just in time']);
});

test('/new: stale only applies to /new; a stale /projects and a stale reply still work', async () => {
  const old = Math.floor(Date.now() / 1000) - 3600;
  const { r, calls } = rig({ telegram: { allowStart: true }, projects: [{ id: 'p1', name: 'api', path: '/x/api' }], sessions: [{ id: 's1', remote: { tg: [500] } }] });
  r.start();
  say('/projects', { date: old });
  say('late reply', { message_id: 9, date: old, reply_to_message: { message_id: 500 } });
  await until(() => net.tg.length === 2);
  assert.equal(sends()[0].text.startsWith('Projects:'), true);
  assert.equal(calls.act[0].text, 'late reply');
});

test('/new: no projects, and a launch that throws', async () => {
  const none = rig({ telegram: { allowStart: true } });
  none.r.start();
  say('/new do it');
  await until(() => net.tg.length);
  assert.deepEqual(sends(), [{ chat_id: CHAT, text: 'No projects yet. Open a folder in wisp first.' }]);
  none.r.stop();
  reset();
  const { r } = rig({ telegram: { allowStart: true }, projects: [{ id: 'p1', name: 'api', path: '/x/api' }], launch: () => Promise.reject(new Error('no such harness')) });
  r.start();
  say('/new do it', { message_id: 11 });
  await until(() => net.tg.length);
  assert.deepEqual(sends(), [{ chat_id: CHAT, text: 'Couldn’t start it: no such harness', reply_to_message_id: 11 }]);
});

test('/new: a launch with no id says the prompt and links nothing; a title too long is cut at 4000', async () => {
  const { r } = rig({ telegram: { allowStart: true }, projects: [{ id: 'p1', name: 'api', path: '/x/api' }], launch: () => null });
  r.start();
  say(`/new ${'x'.repeat(5000)}`, { message_id: 12 });
  await until(() => net.tg.length);
  const [m] = sends();
  assert.equal(m.text.length, 4000);
  assert.ok(m.text.startsWith('▶ Started in api: xxx'));
  assert.ok(m.text.endsWith('x…'));
});

test('plain text outside a thread starts nothing and says so, in both wordings', async () => {
  const off = rig({ projects: [{ id: 'p1', name: 'api', path: '/x/api' }] });
  off.r.start();
  say('fix the flaky login test');
  say('@ada in api on laptop with opus high plan: fix the flaky login test');
  say('help');
  say('/whatever');
  await until(() => net.tg.length === 4);
  assert.deepEqual(sends(), Array(4).fill({ chat_id: CHAT, text: 'Reply to one of wisp’s messages to answer it or send a follow-up.' }));
  assert.equal(off.calls.launch.length, 0);
  off.r.stop();
  reset();
  const on = rig({ telegram: { allowStart: true }, projects: [{ id: 'p1', name: 'api', path: '/x/api' }] });
  on.r.start();
  say('fix the flaky login test');
  say('reply to something unknown', { reply_to_message: { message_id: 999 } });
  await until(() => net.tg.length === 2);
  assert.deepEqual(sends(), Array(2).fill({ chat_id: CHAT, text: 'Reply to one of wisp’s messages to answer it or follow up, or send /new <task> to start one.' }));
  assert.equal(on.calls.launch.length, 0);
});

test('a message with no text and strangers in a linked chat are ignored', async () => {
  const { r, calls } = rig({ telegram: { allowStart: true }, projects: [{ id: 'p1', name: 'api', path: '/x/api' }] });
  r.start();
  net.updates.push({ update_id: net.next++, message: { message_id: 1, chat: { id: CHAT } } });
  net.updates.push({ update_id: net.next++, edited_message: { message_id: 1, chat: { id: CHAT }, text: 'x' } });
  say('/new from a stranger', { chat: { id: 666 } });
  say('/projects', { chat: { id: 666 } });
  tap('d:s1:t:0', { message: { message_id: 3, chat: { id: 666 } } });
  await barrier(r);
  assert.deepEqual(net.tg, []);
  assert.equal(calls.launch.length + calls.act.length, 0);
});

test('a linked group works like a private chat: only the chat id is checked, nothing is capped', async () => {
  const { r, calls } = rig({ telegram: { allowStart: true, chatId: -100 }, projects: [{ id: 'p1', name: 'api', path: '/x/api' }], sessions: [{ id: 's1', remote: { tg: [] } }] });
  r.start();
  net.updates.push({ update_id: net.next++, message: { message_id: 3, chat: { id: -100, type: 'supergroup' }, from: { id: 1 }, text: '/new full auto do it' } });
  await until(() => net.tg.length);
  assert.deepEqual(calls.launch.map((x) => x.prompt), ['full auto do it']);
  assert.equal(net.tg[0].chat_id, -100);
});

// --- replies and buttons ------------------------------------------------------------------------

test('a reply goes to the linked task as text, and its result comes back as a reply', async () => {
  const sessions = [{ id: 's1', remote: { tg: [500] } }, { id: 's2', remote: { tg: [501, 502] } }];
  const { r, calls } = rig({ sessions, act: () => '✓ Queued for when it finishes' });
  r.start();
  say('also add a test', { message_id: 20, reply_to_message: { message_id: 502 } });
  await until(() => net.tg.length);
  assert.deepEqual(sends(), [{ chat_id: CHAT, text: '✓ Queued for when it finishes', reply_to_message_id: 20 }]);
  assert.equal(calls.act.length, 1);
  assert.deepEqual({ ...calls.act[0], later: typeof calls.act[0].later }, { sessionId: 's2', kind: 'text', text: 'also add a test', later: 'function' });
  await calls.act[0].later('btw: an answer');
  assert.deepEqual(sends()[1], { chat_id: CHAT, text: 'btw: an answer', reply_to_message_id: 20 });
});

test('a thread reply reads no commands: stop, status, with sonnet and @names are just text', async () => {
  const { r, calls } = rig({ telegram: { allowStart: true }, sessions: [{ id: 's1', remote: { tg: [500] } }] });
  r.start();
  const texts = ['stop', 'status', 'done', 'with sonnet fix it', '@ada look at this', ': as written', '/btw what changed?'];
  for (const text of texts) say(text, { reply_to_message: { message_id: 500 } });
  await until(() => net.tg.length === texts.length);
  assert.deepEqual(calls.act.map((a) => [a.kind, a.text]), texts.map((t) => ['text', t]));
});

test('buttons: a tap acts, answers the callback and clears the buttons, in that order', async () => {
  const { r, calls } = rig({ act: () => '✓ Answered: Yes' });
  r.start();
  tap('a:s1:ask1:0', { id: 'cb-a' });
  tap('r:s1:t1:2', { id: 'cb-r', message: { message_id: 78, chat: { id: CHAT } } });
  tap('d:s1:t1:0', { id: 'cb-d', message: { message_id: 79, chat: { id: CHAT } } });
  await until(() => net.tg.length === 6);
  assert.deepEqual(calls.act, [
    { sessionId: 's1', kind: 'answer', ref: 'ask1', index: 0 },
    { sessionId: 's1', kind: 'reply', ref: 't1', index: 2 },
    { sessionId: 's1', kind: 'done', ref: 't1', index: 0 },
  ]);
  assert.deepEqual(net.tg, [
    { method: 'answerCallbackQuery', callback_query_id: 'cb-a', text: '✓ Answered: Yes' },
    { method: 'editMessageReplyMarkup', chat_id: CHAT, message_id: 77, reply_markup: { inline_keyboard: [] } },
    { method: 'answerCallbackQuery', callback_query_id: 'cb-r', text: '✓ Answered: Yes' },
    { method: 'editMessageReplyMarkup', chat_id: CHAT, message_id: 78, reply_markup: { inline_keyboard: [] } },
    { method: 'answerCallbackQuery', callback_query_id: 'cb-d', text: '✓ Answered: Yes' },
    { method: 'editMessageReplyMarkup', chat_id: CHAT, message_id: 79, reply_markup: { inline_keyboard: [] } },
  ]);
});

test('buttons: an unknown button says so; a long result is cut at 190', async () => {
  const { r, calls } = rig({ act: () => 'y'.repeat(300) });
  r.start();
  tap('x:s1:t:0', { id: 'cb-x' });
  tap('a:s1:t:0', { id: 'cb-y' });
  await until(() => net.tg.length === 4);
  assert.equal(net.tg[0].text, 'Unknown button.');
  assert.equal(net.tg[2].text, `${'y'.repeat(189)}…`);
  assert.equal(calls.act.length, 1);
});

test('a button on a chat with nothing linked is ignored', async () => {
  const { r, calls } = rig({ telegram: { chatId: null, linkCode: '111111' } });
  r.start();
  tap('a:s1:t:0');
  say('/link 111111');
  await until(() => net.tg.length);
  assert.equal(net.tg.length, 1);
  assert.equal(calls.act.length, 0);
});

// --- what goes out -------------------------------------------------------------------------------

const asking = { id: 's1', title: 'Fix login', agent: 'claude', state: 'waiting', turns: [{ id: 't1' }], ask: { id: 'ask1', question: 'Proceed?', context: 'c'.repeat(700), options: ['Yes', 'No'] } };
const finished = (blocks, o = {}) => ({ id: 's2', title: 'Fix login', agent: 'claude', state: 'review', turns: [{ id: 't2', status: 'done', presentation: { blocks } }], ...o });

test('message(): a question, each hero status, a question block, errors', () => {
  const { r } = rig();
  assert.deepEqual(r.message(asking, { project: 'api' }), { title: '❓ api: Fix login', text: `Proceed?\n\n${'c'.repeat(599)}…`, actions: [{ label: 'Yes', kind: 'answer', ref: 'ask1', index: 0 }, { label: 'No', kind: 'answer', ref: 'ask1', index: 1 }] });
  for (const [status, icon] of [['done', '✅'], ['partial', '🟡'], ['blocked', '⛔'], ['info', '📝']]) {
    const m = r.message(finished([{ type: 'hero', title: 'All fixed', status, summary: 'It works.' }]), { project: 'api' });
    assert.deepEqual(m, { title: `${icon} api: Fix login`, text: 'All fixed\n\nIt works.', actions: [{ label: 'Mark done', kind: 'done', ref: 't2', index: 0 }] });
  }
  assert.deepEqual(r.message(finished([{ type: 'hero', title: 'Fix login', status: 'done', summary: 'S' }, { type: 'question', question: 'Ship?', options: ['Yes', { label: 'No', reply: 'do not' }, { reply: 'later' }] }]), {}), {
    title: '✅ : Fix login',
    text: 'S\n\nShip?',
    actions: [{ label: 'Yes', kind: 'reply', ref: 't2', index: 0 }, { label: 'No', kind: 'reply', ref: 't2', index: 1 }, { label: 'later', kind: 'reply', ref: 't2', index: 2 }],
  });
  assert.equal(r.message(finished([]), { project: 'p', preview: 'A preview' }).text, 'A preview');
  assert.equal(r.message(finished([]), {}).text, 'Ready for review.');
  assert.equal(r.message({ id: 's', title: 'T', turns: [{ status: 'error' }] }, {}).title, '⛔ : T');
  assert.deepEqual(r.message({ id: 's', title: 'T', turns: [] }, {}).actions, [{ label: 'Mark done', kind: 'done', ref: '', index: 0 }]);
});

test('send(): the exact Telegram message, its buttons and its link to the task', async () => {
  const sessions = [{ ...asking }];
  const { r } = rig({ sessions });
  assert.equal(await r.send(r.message(sessions[0], { project: 'api' }), sessions[0]), 1);
  assert.deepEqual(sends(), [
    {
      chat_id: CHAT,
      text: `❓ api: Fix login\n\nProceed?\n\n${'c'.repeat(599)}…\n\n↩ Reply to this message to answer or follow up.`,
      reply_markup: { inline_keyboard: [[{ text: 'Yes', callback_data: 'a:s1:ask1:0' }], [{ text: 'No', callback_data: 'r'.slice(0, 0) + 'a:s1:ask1:1' }]] },
    },
  ]);
  assert.deepEqual(sessions[0].remote, { tg: [101] });
  assert.deepEqual(r.status.telegram.ok, true);
  assert.equal(r.status.ntfy, null);
});

test('send(): no session means no buttons, no reply line and no link; long labels and text are cut', async () => {
  const { r } = rig();
  assert.equal(await r.send({ title: '✨ wisp', text: 'Test from wisp.', actions: [{ label: 'x', kind: 'done', ref: 't', index: 0 }] }), 1);
  assert.deepEqual(sends(), [{ chat_id: CHAT, text: '✨ wisp\n\nTest from wisp.' }]);
  await r.send({ title: 'T', text: 'y'.repeat(5000), actions: [{ label: 'L'.repeat(80), kind: 'reply', ref: 't', index: 3 }] }, { id: 'zz' });
  const m = sends()[1];
  assert.equal(m.text.length, 4000);
  assert.equal(m.reply_markup.inline_keyboard[0][0].text, `${'L'.repeat(59)}…`);
  assert.equal(m.reply_markup.inline_keyboard[0][0].callback_data, 'r:zz:t:3');
});

test('a task keeps its last 20 message ids; a task on a machine links in memory', async () => {
  const s = { id: 's1', title: 'T', turns: [] };
  const { r } = rig({ sessions: [s] });
  for (let i = 0; i < 23; i++) await r.send({ title: 'T', text: 'x', actions: [] }, s);
  assert.equal(s.remote.tg.length, 20);
  assert.equal(s.remote.tg[0], 104);
  assert.equal(s.remote.tg.at(-1), 123);
  await r.send({ title: 'T', text: 'x', actions: [] }, { id: 'a1@m1' });
  assert.equal(r.tgElsewhere.get(124), 'a1@m1');
  r.start();
  say('over there', { message_id: 30, reply_to_message: { message_id: 124 } });
  await until(() => sends().some((m) => m.reply_to_message_id === 30));
});

test('notify(): events, the tour and nothing configured', async () => {
  const s = finished([{ type: 'hero', title: 'Done', status: 'done', summary: 'S' }]);
  const { r } = rig({ sessions: [s], events: ['waiting'] });
  await r.notify(s, { project: 'api' });
  assert.equal(net.tg.length, 0, 'finished is off');
  await r.notify({ ...asking }, { project: 'api' });
  assert.equal(net.tg.length, 1);
  await r.notify({ ...asking, agent: 'wisp' }, {});
  await r.notify(null, {});
  assert.equal(net.tg.length, 1);
  const off = rig({ telegram: { enabled: false } });
  assert.equal(off.r.on, false);
  await off.r.notify(asking, {});
  assert.equal(await off.r.send({ title: 'T', text: 'x', actions: [] }), 0);
  assert.equal(net.tg.length, 1);
});

test('a Telegram failure is marked, and the next good poll clears it', async () => {
  net.tgFail = 1;
  const { r, calls } = rig();
  r.tgLongPoll = 0;
  await assert.doesNotReject(() => r.send({ title: 'T', text: 'x', actions: [] }));
  r.start();
  await until(() => r.status.telegram?.error === 'Telegram: Bad Gateway');
  assert.equal(r.status.telegram.ok, false);
  assert.ok(calls.changes >= 1);
});

// --- ntfy --------------------------------------------------------------------------------------

const NTFY = { enabled: true, topic: 'wisp-test-topic', token: 'tk_secret' };

test('ntfy: the exact publish, three buttons at most, each signed', async () => {
  const sessions = [{ ...asking, ask: { ...asking.ask, options: ['A', 'B', 'C', 'D'] } }];
  const { r } = rig({ telegram: { enabled: false }, ntfy: { ...NTFY, server: `${fakeUrl}/` }, sessions });
  r.cfg.secret = 'fixed-secret';
  assert.equal(await r.send(r.message(sessions[0], { project: 'api' }), sessions[0]), 1);
  const sign = (i) => createHmac('sha256', 'fixed-secret').update(`s1.answer.ask1.${i}`).digest('base64url').slice(0, 22);
  const action = (label, i) => ({ action: 'http', label, url: `${fakeUrl}/wisp-test-topic-reply`, method: 'POST', headers: { authorization: 'Bearer tk_secret' }, body: JSON.stringify({ s: 's1', k: 'a', r: 'ask1', i, sig: sign(i) }), clear: true });
  assert.deepEqual(net.ntfy, [
    {
      auth: 'Bearer tk_secret',
      type: 'application/json',
      body: { topic: 'wisp-test-topic', title: '❓ api: Fix login', message: `Proceed?\n\n${'c'.repeat(599)}…`, tags: ['wisp'], actions: [action('A', 0), action('B', 1), action('C', 2)] },
    },
  ]);
  assert.ok(r.status.ntfy.ok);
});

test('ntfy: no session no buttons, no token no header, long fields cut, failures marked', async () => {
  const { r } = rig({ telegram: { enabled: false }, ntfy: { enabled: true, topic: 't', server: fakeUrl } });
  await r.send({ title: 'T'.repeat(300), text: 'x'.repeat(4000), actions: [{ label: 'x', kind: 'done', ref: 't', index: 0 }] });
  assert.deepEqual(net.ntfy, [{ auth: '', type: 'application/json', body: { topic: 't', title: `${'T'.repeat(199)}…`, message: `${'x'.repeat(2999)}…`, tags: ['wisp'] } }]);
  net.ntfyFail = 1;
  await r.send({ title: 'T', text: 'x', actions: [] });
  assert.equal(r.status.ntfy.ok, false);
  assert.equal(r.status.ntfy.error, 'ntfy: 500 down');
});

test('ntfy: forged, malformed and foreign taps do nothing; a signed tap acts once', async () => {
  const { r, calls } = rig({ telegram: { enabled: false }, ntfy: { enabled: true, topic: 't', server: fakeUrl, token: 'tk' } });
  r.cfg.secret = 'fixed-secret';
  r.start();
  const good = { s: 's1', k: 'a', r: 'ask1', i: 1, sig: r.sign('s1', 'answer', 'ask1', 1) };
  for (const body of ['not json', '{"s":"s1"}', JSON.stringify({ ...good, sig: 'x'.repeat(22) }), JSON.stringify({ ...good, i: 0 }), JSON.stringify({ ...good, k: 'z' }), 'null']) await fetch(`${fakeUrl}/t-reply`, { method: 'POST', body });
  await new Promise((res) => setTimeout(res, 60));
  assert.deepEqual(calls.act, []);
  await fetch(`${fakeUrl}/t-reply`, { method: 'POST', body: JSON.stringify(good) });
  await until(() => calls.act.length);
  await new Promise((res) => setTimeout(res, 60));
  assert.deepEqual(calls.act, [{ sessionId: 's1', kind: 'answer', ref: 'ask1', index: 1 }]);
  assert.equal(net.ntfyPolls[0].path, '/t-reply/json');
  assert.equal(net.ntfyPolls[0].poll, '1');
  assert.equal(net.ntfyPolls[0].auth, 'Bearer tk');
  assert.match(net.ntfyPolls[0].since, /^\d{10}$/);
  assert.ok(net.ntfyPolls.at(-1).since.startsWith('r'), 'later polls ask since the last message id');
});

test('ntfy: the Done and Reply tap kinds sign and verify; a thrown act is swallowed', async () => {
  const { r, calls } = rig({ telegram: { enabled: false }, ntfy: { enabled: true, topic: 't', server: fakeUrl }, act: () => Promise.reject(new Error('boom')) });
  r.cfg.secret = 'fixed-secret';
  r.start();
  await fetch(`${fakeUrl}/t-reply`, { method: 'POST', body: JSON.stringify({ s: 's1', k: 'd', r: 't1', i: 0, sig: r.sign('s1', 'done', 't1', 0) }) });
  await fetch(`${fakeUrl}/t-reply`, { method: 'POST', body: JSON.stringify({ s: 's1', k: 'r', r: 't1', i: 2, sig: r.sign('s1', 'reply', 't1', 2) }) });
  await until(() => calls.act.length === 2);
  assert.deepEqual(calls.act.map((a) => a.kind), ['done', 'reply']);
  assert.equal(r.verify(null), false);
  assert.equal(r.verify({ s: 's1', k: 'd', r: 't1', i: 0 }), false);
  assert.equal(r.verify({ s: 's1', k: 'd', r: 't1', i: 0, sig: r.sign('s1', 'done', 't1', 0) }), true);
});

test('ntfy: a failed poll is marked, then cleared', async () => {
  const { r } = rig({ telegram: { enabled: false }, ntfy: { enabled: true, topic: 't', server: fakeUrl } });
  net.ntfyFail = 1;
  r.ntfyPollMs = 300; // long enough for until() to see the error before the next poll clears it
  r.start();
  await until(() => r.status.ntfy?.error === 'ntfy: 503', { every: 5 });
  await until(() => r.status.ntfy?.error === '');
  assert.equal(r.status.ntfy.ok, true);
});

// --- settings ------------------------------------------------------------------------------------

const VIEW = ['enabled', 'token', 'linked', 'chatName', 'linkCode', 'allowStart', 'project'];
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

test('view(): masked secrets, defaults and health', () => {
  const { r } = rig({ telegram: { allowStart: true, project: 'p1' }, ntfy: { enabled: true, topic: 't', token: 'tk_secret1234' } });
  const v = r.view();
  assert.deepEqual(v.events, ['waiting', 'finished']);
  assert.deepEqual(v.ntfy, { enabled: true, server: 'https://ntfy.sh', topic: 't', token: '••••1234' });
  assert.deepEqual(pick(v.telegram, VIEW), { enabled: true, token: '••••:abc', linked: true, chatName: 'Ada', linkCode: '', allowStart: true, project: 'p1' });
  assert.equal(v.status, r.status);
  const empty = new Remote({ store: { config: { remote: {}, projects: [] }, saveConfig() {} }, act: async () => '' }).view();
  assert.deepEqual(empty.ntfy, { enabled: false, server: 'https://ntfy.sh', topic: '', token: '' });
  assert.deepEqual(pick(empty.telegram, VIEW), { enabled: false, token: '', linked: false, chatName: '', linkCode: '', allowStart: false, project: '' });
});

test('update(): tokens, unlink, validation', () => {
  const { r, store } = rig({ telegram: { enabled: false }, projects: [{ id: 'p1', name: 'api', path: '/x' }] });
  r.tgOffset = 50;
  assert.throws(() => r.update({ ntfy: { server: 'ftp://x' } }), /ntfy server must be an http\(s\) URL/);
  assert.throws(() => r.update({ ntfy: { topic: 'a b' } }), /ntfy topic: letters, digits, - and _ only/);
  assert.throws(() => r.update({ telegram: { project: 'nope' } }), /Unknown project/);
  r.update({ events: ['waiting', 'nonsense'], ntfy: { enabled: true, topic: 'tt', token: 'secret-token' } });
  assert.deepEqual(store.config.remote.events, ['waiting']);
  assert.equal(store.config.remote.ntfy.token, 'secret-token');
  r.update({ ntfy: { token: '••••oken' } });
  assert.equal(store.config.remote.ntfy.token, 'secret-token', 'a masked token means unchanged');
  r.update({ telegram: { token: '••••:abc', allowStart: true, project: 'p1' } });
  let t = store.config.remote.telegram;
  assert.deepEqual([t.token, t.chatId, t.allowStart, t.project], [TOKEN, CHAT, true, 'p1']);
  assert.equal(r.tgOffset, 50, 'the same token keeps its offset');
  r.update({ telegram: { token: '999:zzz' } });
  t = store.config.remote.telegram;
  assert.equal(t.chatId, null, 'another bot, another link');
  assert.match(t.linkCode, /^\d{6}$/);
  assert.equal(r.tgOffset, 0);
  r.update({ telegram: { unlink: true } });
  assert.match(store.config.remote.telegram.linkCode, /^\d{6}$/);
  r.update({ telegram: { token: '' } });
  assert.equal(store.config.remote.telegram.linkCode, '');
  r.stop();
});

test('findProject, mask and defaultProject', () => {
  const ps = [{ id: '1', name: 'api-server', path: '/x/one', lastUsedAt: 5 }, { id: '2', name: 'web', path: '/Applications/web', addedAt: 9 }, { id: '3', name: 'api', path: '/x/three' }];
  assert.equal(findProject(ps, 'API').id, '3');
  assert.equal(findProject(ps, 'api-').id, '1');
  assert.equal(findProject(ps, 'server').id, '1');
  assert.equal(findProject(ps, 'applic').id, '2');
  assert.equal(findProject(ps, 'nope'), null);
  assert.equal(findProject(ps, ''), null);
  assert.equal(mask('abcdef'), '••••cdef');
  assert.equal(mask(''), '');
  const { r } = rig({ projects: ps });
  assert.equal(r.defaultProject().id, '2', 'the most recently used or added');
  r.cfg.telegram.project = '3';
  assert.equal(r.defaultProject().id, '3');
  r.cfg.telegram.project = 'gone';
  assert.equal(r.defaultProject().id, '2');
  r.store.config.projects = [];
  assert.equal(r.defaultProject(), null);
});

// --- the same, end to end: a real wisp, fake agents ---------------------------------------------------

let srv;
let base;
async function api(p, { method, body } = {}) {
  const r = await fetch(`${base}/api${p}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body || (method && method !== 'GET') ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : method && method !== 'GET' ? '{}' : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
}
const session = (id) => api(`/sessions/${id}`);
const settled = (id) => until(async () => {
  const s = await session(id);
  return s.state !== 'running' && s.state !== 'waiting' ? s : null;
});

before(async () => {
  const port = await new Promise((resolve) => {
    const s = netServer().listen(0, '127.0.0.1', () => {
      const { port: p } = s.address();
      s.close(() => resolve(p));
    });
  });
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
  srv.remote.ntfyPollMs = 30;
  srv.remote.tgLongPoll = 0;
  srv.store.config.defaults.agent = 'claude'; // tests can't depend on which harness Auto picks
});

after(async () => {
  await api('/remote', { method: 'PUT', body: { ntfy: { enabled: false }, telegram: { enabled: false } } }).catch(() => {});
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
  fake.closeAllConnections?.();
  fake.close();
});

// The volatile parts of what went out: ids become their first-seen names.
function normal(items, ids) {
  const seen = new Map();
  const name = (v) => {
    if (!seen.has(v)) seen.set(v, `id${seen.size + 1}`);
    return seen.get(v);
  };
  const clean = (m) => JSON.parse(JSON.stringify(m).replace(new RegExp(`\\b(${ids.join('|')})\\b`, 'g'), (v) => name(v)));
  return items.map(clean);
}

test('end to end: link, question on both channels, forged and real taps, reply, Mark done', async () => {
  let view = await api('/remote', { method: 'PUT', body: { ntfy: { enabled: true, server: fakeUrl, topic: 'wisp-legacy' }, telegram: { enabled: true, token: TOKEN } } });
  assert.equal(view.telegram.token, '••••:abc');
  assert.match(view.telegram.linkCode, /^\d{6}$/);
  say('hi', { chat: { id: 666 } });
  say(`/link ${view.telegram.linkCode}`, { chat: { id: CHAT, first_name: 'Ada' } });
  view = await until(async () => ((await api('/remote')).telegram.linked ? api('/remote') : null));
  assert.equal(view.telegram.chatName, 'Ada');

  const repo = makeRepo();
  const s = await api('/sessions', { body: { prompt: 'ASK before fixing', cwd: repo, agent: 'claude', worktree: false } });
  await until(async () => (await session(s.id)).state === 'waiting');
  const note = await until(() => net.ntfy.find((p) => p.body.title.includes('❓')));
  const q = await until(() => net.tg.find((m) => m.text?.includes('Proceed with the fix?')));
  const project = (await session(s.id)).project || repo.split('/').pop();
  const title = (await session(s.id)).title;
  const ask = (await session(s.id)).ask;
  assert.deepEqual(normal([q], [s.id, ask.id])[0], {
    method: 'sendMessage',
    chat_id: CHAT,
    text: `❓ ${project}: ${title}\n\nProceed with the fix?\n\n↩ Reply to this message to answer or follow up.`,
    reply_markup: { inline_keyboard: [[{ text: 'Yes', callback_data: 'a:id1:id2:0' }], [{ text: 'No', callback_data: 'a:id1:id2:1' }]] },
  });
  assert.deepEqual([note.body.topic, note.body.tags, note.body.message], ['wisp-legacy', ['wisp'], 'Proceed with the fix?']);
  assert.deepEqual(note.body.actions.map((a) => a.label), ['Yes', 'No']);

  // A forged tap does nothing; the real one answers.
  const yes = JSON.parse(note.body.actions[0].body);
  await fetch(note.body.actions[0].url, { method: 'POST', body: JSON.stringify({ ...yes, i: 1, sig: 'x'.repeat(22) }) });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await session(s.id)).state, 'waiting');
  await fetch(note.body.actions[0].url, { method: 'POST', body: note.body.actions[0].body });
  const done = await settled(s.id);
  assert.match(done.turns[0].presentation.blocks[0].summary, /Answer was: .*Yes/);

  // The finished notice, and a follow-up by replying to it.
  const fin = await until(() => net.tg.find((m) => m.text?.startsWith('✅') && /Answer was: .*Yes/.test(m.text)));
  assert.deepEqual(fin.reply_markup.inline_keyboard.map((r) => r[0].text), ['Mark done']);
  assert.ok(fin.text.endsWith('\n\n↩ Reply to this message to answer or follow up.'));
  const finId = net.msg;
  say('also add a test', { message_id: 3, reply_to_message: { message_id: finId } });
  const sentBack = await until(() => net.tg.find((m) => m.reply_to_message_id === 3));
  assert.deepEqual(sentBack, { method: 'sendMessage', chat_id: CHAT, text: '✓ Sent', reply_to_message_id: 3 });
  await until(async () => (await session(s.id)).turns.length === 2);
  assert.equal((await session(s.id)).turns[1].prompt, 'also add a test');
  await settled(s.id);

  // Mark done, from the button on the latest message.
  const last = await until(() => net.tg.filter((m) => m.text?.startsWith('✅')).at(1));
  const data = last.reply_markup.inline_keyboard[0][0].callback_data;
  tap(data, { id: 'cb-done', message: { message_id: net.msg, chat: { id: CHAT } } });
  await until(async () => (await session(s.id)).state === 'done');
  const ans = await until(() => net.tg.find((m) => m.method === 'answerCallbackQuery'));
  assert.deepEqual(ans, { method: 'answerCallbackQuery', callback_query_id: 'cb-done', text: '✓ Marked done' });
  await until(() => net.tg.find((m) => m.method === 'editMessageReplyMarkup'));
  // A second tap on it: there's nothing left to say but that.
  tap(data, { id: 'cb-again' });
  const again = await until(() => net.tg.find((m) => m.callback_query_id === 'cb-again'));
  assert.equal(again.text, '✓ Marked done');
});

test('end to end: /new off, then on: /projects, @project, stale, a stranger, follow-up, /btw, the default project', async () => {
  net.next = srv.remote.tgOffset + 1; // afterEach starts the fake's counter over; this wisp's offset carries on
  net.msg = 5000;
  const count = (await api('/sessions')).length;
  say('/new add a README', { message_id: 10 });
  await until(() => net.tg.find((m) => m.text === OFF));
  assert.equal((await api('/sessions')).length, count);

  const repo = makeRepo();
  const other = makeRepo();
  await api('/projects', { body: { path: repo } });
  await api('/projects', { body: { path: other } });
  const otherP = (await api('/config')).projects.find((p) => p.path === other);
  const repoP = (await api('/config')).projects.find((p) => p.path === repo);
  const view = await api('/remote', { method: 'PUT', body: { telegram: { allowStart: true } } });
  assert.equal(view.telegram.allowStart, true);
  assert.equal(view.telegram.linked, true, 'switching it on keeps the chat linked');

  say('/projects', { message_id: 11 });
  const list = await until(() => net.tg.find((m) => m.text?.startsWith('Projects:')));
  assert.match(list.text, new RegExp(`• ${otherP.name}`));
  assert.match(list.text, /\n\n\/new @name <task> runs in one of them\.$/);

  say('/new@wispbot @nosuchproject do it', { message_id: 12 });
  await until(() => net.tg.find((m) => m.text === 'No project matches “nosuchproject”. Send /projects to see them.'));
  say('/new from a stranger', { message_id: 13, chat: { id: 666 } });
  say('/new sent while offline', { message_id: 17, date: Math.floor(Date.now() / 1000) - 3600 });
  await until(() => net.tg.find((m) => m.reply_to_message_id === 17 && m.text === 'That /new arrived while wisp was offline, so it didn’t start. Send it again to run it now.'));

  say(`/new @${otherP.name.toUpperCase()} write the docs`, { message_id: 14 });
  const started = await until(() => net.tg.find((m) => m.reply_to_message_id === 14));
  assert.equal(started.text, `▶ Started in ${otherP.name}: write the docs\n\nwisp will message you when it needs you or is done. Reply to this message to follow up.`);
  const startedId = net.tg.filter((m) => m.method === 'sendMessage').indexOf(started);
  assert.ok(startedId >= 0);
  const byPrompt = async (text) => {
    for (const x of await api('/sessions')) if ((await session(x.id)).turns[0]?.prompt === text) return x;
    return null;
  };
  const t1 = await until(() => byPrompt('write the docs'));
  assert.equal(t1.projectId, otherP.id);
  assert.deepEqual(t1.origin, { kind: 'telegram', name: 'Telegram' });
  assert.equal(t1.agent, 'claude');
  assert.equal(t1.mode, srv.store.config.defaults.mode || 'auto');
  const full = await session(t1.id);
  assert.equal(full.remote.started, undefined, 'absent means today’s path');
  assert.equal(full.remote.tg.length >= 1, true);
  const link = full.remote.tg[0];
  await settled(t1.id);

  say('and a changelog', { message_id: 15, reply_to_message: { message_id: link } });
  await until(async () => (await session(t1.id)).turns.length === 2);
  assert.equal((await session(t1.id)).turns[1].prompt, 'and a changelog');
  await settled(t1.id);

  say('/btw what changed?', { message_id: 18, reply_to_message: { message_id: link } });
  const asked = await until(() => net.tg.find((m) => m.reply_to_message_id === 18));
  assert.equal(asked.text, '✓ Asking on the side; the agent keeps working. The answer follows here.');
  const btw = await until(() => net.tg.find((m) => m.reply_to_message_id === 18 && m.text.startsWith('btw: ')));
  assert.equal(btw.text, 'btw: Side answer (forked): what changed?');
  assert.equal((await session(t1.id)).turns.length, 2);

  // stop is a follow-up here, not a command.
  say('stop', { message_id: 19, reply_to_message: { message_id: link } });
  await until(async () => (await session(t1.id)).turns.length === 3);
  assert.equal((await session(t1.id)).turns[2].prompt, 'stop');
  await settled(t1.id);

  await api('/remote', { method: 'PUT', body: { telegram: { project: repoP.id } } });
  say('/new tidy up', { message_id: 16 });
  const t2 = await until(() => byPrompt('tidy up'));
  assert.equal(t2.projectId, repoP.id);
  await settled(t2.id);
  assert.equal(await byPrompt('from a stranger'), null);
  assert.equal(await byPrompt('sent while offline'), null);
  assert.equal((await api('/sessions')).length, count + 2, 'settings changes restart the poll; nothing runs twice');
  assert.equal(srv.store.config.remote.telegram.options, undefined, 'the option stays off unless asked for');
});
