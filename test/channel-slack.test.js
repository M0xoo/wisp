// Slack, end to end: a real wisp, fake agents, and a fake Slack on loopback with a real socket and
// real HTTP (test/fixtures/fake-slack.mjs). Where a test shows that nothing happened, it sends one
// more message in the same thread and waits for that: wisp answers a thread in order, so what came
// before has had its turn.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer as netServer } from 'node:net';
import { installFakeBins, isolateAgentConfigs, makeRepo, sleep, tmp, until } from './helpers.js';
import { FakeSlack } from './fixtures/fake-slack.mjs';

process.env.FAKE_RECORD = tmp('slack-record');
process.env.WISP_HOME = tmp('slack-home');
process.env.WISP_UPDATE_CHECK = '0';
installFakeBins();
isolateAgentConfigs();

const { startServer } = await import('../server/index.js');
const { RateLimit, STALE_S } = await import('../server/channels/policy.js');
const { NOT_ON_A_BOX, slackManifest, slackText } = await import('../server/channels/slack.js');
const { stripFormatting } = await import('../server/channels/grammar.js');

const ME = 'U0ME';
const STRANGER_ID = 'U0STRANGE';
const APP = 'xapp-1-A1-secret-app-token';
const BOT = 'xoxb-1-secret-bot-token';

const fake = new FakeSlack();
let srv;
let base;
let repo;
let other;
let name;
let web;

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
  return s.state !== 'running' && s.state !== 'waiting' && !s.queue?.length ? s : null;
});
const freePort = () => new Promise((resolve) => {
  const s = netServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
async function boot() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
  srv.remote.slackBackoffMs = 20;
  srv.remote.channels.slack.limit = new RateLimit({ max: 1000 }); // this file is one busy sender
  srv.remote.channels.slack.strangers = new RateLimit({ max: 1000 });
  srv.store.config.defaults.agent = 'claude'; // tests can't depend on which harness Auto picks
}
const halt = () => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
};
const connected = () => until(async () => (await api('/remote')).slack.connected, { what: 'the connection to Slack' });

before(async () => {
  await fake.start();
  process.env.WISP_SLACK_API = fake.api;
  await boot();
  repo = makeRepo();
  other = makeRepo();
  await api('/projects', { body: { path: repo } });
  await api('/projects', { body: { path: other } });
  const ps = (await api('/config')).projects;
  name = ps.find((p) => p.path === repo).name;
  web = ps.find((p) => p.path === other).name;
});

after(() => {
  halt();
  delete process.env.WISP_SLACK_API;
  fake.stop();
  setTimeout(() => process.exit(), 500).unref(); // agents held on FAKE_DELAY
});

let n = 100;
const newTs = () => `${Math.floor(Date.now() / 1000)}.${String(++n).padStart(6, '0')}`;
const uid = () => `cm-${++n}`;
// A mention in a channel, or a DM. → { ts, thread, env }: thread is where the answer goes.
function mention(text, { user = ME, channel = 'C1', thread_ts, ts = newTs(), bare = false, ...o } = {}) {
  const env = fake.event({ type: 'app_mention', user, text: bare ? text : `<@UBOT> ${text}`, channel, ts, client_msg_id: uid(), ...(thread_ts && { thread_ts }), ...o });
  return { ts, thread: { channel, ts: thread_ts || ts }, env };
}
function dm(text, { user = ME, channel = 'D1', thread_ts, ts = newTs(), ...o } = {}) {
  const env = fake.event({ type: 'message', channel_type: 'im', user, text, channel, ts, client_msg_id: uid(), ...(thread_ts && { thread_ts }), ...o });
  return { ts, thread: { channel, ts: thread_ts || ts }, env };
}
const inThread = ({ channel, ts }) => fake.posted.filter((p) => p.channel === channel && p.thread_ts === ts);
// What wisp posts next in a thread, past what's been read. Slack's text comes back unescaped-looking.
const read = new Map();
const next = (t) =>
  until(() => {
    const key = `${t.channel}:${t.ts}`;
    const all = inThread(t);
    const at = read.get(key) || 0;
    if (all.length <= at) return null;
    read.set(key, at + 1);
    return all[at].text;
  }, { what: `a post in ${t.channel} ${t.ts}` });
const taskIn = (t) => until(() => srv.store.all().find((s) => s.remote?.slack?.channel === t.channel && s.remote.slack.ts === t.ts), { what: 'its task' });
const tasksIn = (t) => srv.store.all().filter((s) => s.remote?.slack?.channel === t.channel && s.remote.slack.ts === t.ts);
// Everything sent in this thread before now has been dealt with. wisp answers a thread in order.
async function caughtUp(t) {
  const m = t.channel[0] === 'D' ? dm('help', { channel: t.channel, thread_ts: t.ts }) : mention('help', { channel: t.channel, thread_ts: t.ts });
  assert.match(await next(m.thread), /Say what you’d type in wisp/, 'nothing else was posted first');
}

test('off by default: no connection, tokens checked, tokens masked', async () => {
  const view = (await api('/remote')).slack;
  assert.deepEqual(view, { enabled: false, appToken: '', botToken: '', connected: false, team: '', bot: '', senders: 0, linkCode: '', box: false, error: '' });
  await assert.rejects(api('/remote', { method: 'PUT', body: { slack: { appToken: 'nope' } } }), /starts with xapp-/);
  await assert.rejects(api('/remote', { method: 'PUT', body: { slack: { botToken: 'xapp-x' } } }), /starts with xoxb-/);
  assert.equal(fake.opens, 0);
});

test('on a cloud computer it won’t turn on, and says why; a config from elsewhere doesn’t start it', async () => {
  process.env.WISP_GRID_URL = 'https://grid.example';
  try {
    await assert.rejects(api('/remote', { method: 'PUT', body: { slack: { enabled: true, appToken: APP, botToken: BOT } } }), new RegExp(NOT_ON_A_BOX.slice(0, 40)));
    assert.equal((await api('/remote')).slack.box, true);
    assert.equal((await api('/remote')).slack.enabled, false);
    srv.store.config.remote.slack = { enabled: true, appToken: APP, botToken: BOT };
    assert.equal(srv.remote.channels.slack.ready, false);
    delete srv.store.config.remote.slack;
  } finally {
    delete process.env.WISP_GRID_URL;
  }
  assert.equal(fake.opens, 0);
});

test('the manifest: Socket Mode, the two events, the exact scopes', async () => {
  const m = await api('/remote/slack/manifest');
  assert.deepEqual(m, slackManifest());
  assert.equal(m.settings.socket_mode_enabled, true);
  assert.deepEqual(m.settings.event_subscriptions.bot_events, ['app_mention', 'message.im']);
  assert.deepEqual(m.oauth_config.scopes.bot, ['app_mentions:read', 'chat:write', 'chat:write.customize', 'im:history']);
  assert.equal(m.features.app_home.messages_tab_enabled, true);
});

test('switched on: it connects, and the view has what Settings needs, masked', async () => {
  const put = await api('/remote', { method: 'PUT', body: { slack: { enabled: true, appToken: APP, botToken: BOT } } });
  assert.equal(put.slack.enabled, true);
  assert.equal(put.slack.appToken, `••••${APP.slice(-4)}`);
  assert.equal(put.slack.botToken, `••••${BOT.slice(-4)}`);
  assert.match(put.slack.linkCode, /^\d{6}$/);
  await connected();
  const v = await api('/remote');
  assert.deepEqual([v.slack.team, v.slack.bot, v.slack.senders], ['Acme', 'wisp', 0]);
  assert.equal(v.status.slack.ok, true);
  assert.ok(!JSON.stringify(v).includes('secret'), 'no token, no ticket');
  assert.equal((await api('/config')).remote, undefined);
  // A masked token means unchanged, and keeps the code and who's linked.
  const again = await api('/remote', { method: 'PUT', body: { slack: { appToken: put.slack.appToken, botToken: put.slack.botToken } } });
  assert.equal(again.slack.linkCode, put.slack.linkCode);
  assert.equal(srv.store.config.remote.slack.botToken, BOT);
  await connected();
});

test('a stranger’s DM gets one line; the code links them by id; a wrong one doesn’t', async () => {
  const code = (await api('/remote')).slack.linkCode;
  const count = srv.store.all().length;
  const a = dm('hello there', { user: ME });
  assert.match(await next(a.thread), /^This wisp only answers people linked to it\./);
  assert.equal(srv.store.all().length, count);
  const w = dm('link 000000', { user: ME });
  assert.match(await next(w.thread), /^That isn’t the code/);
  assert.equal((await api('/remote')).slack.senders, 0);
  const none = dm('link', { user: ME });
  assert.match(await next(none.thread), /^That isn’t the code/);
  const l = dm(`link ${code}`, { user: ME });
  assert.match(await next(l.thread), /^✓ Linked to wisp/);
  const v = await api('/remote');
  assert.equal(v.slack.senders, 1);
  assert.notEqual(v.slack.linkCode, code, 'one person, one code');
  assert.deepEqual(srv.store.config.remote.slack.senders, [ME]);
  const again = dm(`link ${code}`, { user: STRANGER_ID });
  assert.match(await next(again.thread), /^That isn’t the code/, 'a used code is gone');
  const twice = dm(`link ${v.slack.linkCode}`, { user: ME });
  assert.equal(await next(twice.thread), 'You’re already linked.');
  assert.equal(srv.store.config.remote.slack.linkCode, v.slack.linkCode, 'and that didn’t use it up');
});

test('wrong codes change the code; a link in a channel does nothing but be a stranger’s message', async () => {
  const code = (await api('/remote')).slack.linkCode;
  for (let i = 0; i < 5; i++) {
    const w = dm(`link 11111${i}`, { user: `UGUESS${i}` });
    await next(w.thread);
  }
  const now = (await api('/remote')).slack.linkCode;
  assert.notEqual(now, code);
  const c = mention(`link ${now}`, { user: STRANGER_ID });
  await caughtUp(c.thread);
  assert.deepEqual(inThread(c.thread).filter((p) => /Linked/.test(p.text)), []);
  assert.deepEqual(srv.store.config.remote.slack.senders, [ME]);
});

test('a task from a channel: start, ack, question, answer, report, follow-up', async () => {
  const m = mention(`in ${name} with opus high plan: ASK before you fix the flaky login test`);
  assert.equal(await next(m.thread), `▶ ${name} · Opus high · Plan\n  ASK before you fix the flaky login test`);
  const s = await taskIn(m.thread);
  assert.deepEqual([s.agent, s.model, s.effort, s.mode], ['claude', 'opus', 'high', 'plan']);
  assert.deepEqual(s.origin, { kind: 'slack', name: 'Slack' });
  assert.equal(s.remote.started, 'slack');
  assert.deepEqual(s.remote.slack, { channel: 'C1', ts: m.ts });
  assert.equal(s.title, 'ASK before you fix the flaky login test');
  assert.match(s.turns[0].prompt, new RegExp(`^Asked in Slack by ${ME}:\\n\\n<message>\\nASK before you fix the flaky login test\\n</message>`));
  assert.match(s.turns[0].prompt, /untrusted input from Slack/);

  const q = await next(m.thread);
  assert.match(q, /^❓ .*\n\nProceed with the fix\?/);
  assert.match(q, /Choices: Yes · No/);
  assert.match(q, /Mention wisp in this thread to answer or follow up\./);
  mention('Yes', { thread_ts: m.ts });
  assert.equal(await next(m.thread), '✓ Answered');
  await settled(s.id);
  const report = await next(m.thread);
  assert.match(report, /^✅ /);
  assert.match(report, /Answer was/);

  mention('also add a test', { thread_ts: m.ts });
  assert.equal(await next(m.thread), '✓ Sent');
  await until(async () => (await session(s.id)).turns.length === 2);
  assert.match((await session(s.id)).turns[1].prompt, /<message>\nalso add a test\n<\/message>/);
  await settled(s.id);
  await next(m.thread);
  assert.equal(tasksIn(m.thread).length, 1);
});

test('a DM: plain replies in the thread follow up, `with` moves it, new starts another', async () => {
  const m = dm('fix the DM thing');
  assert.equal(await next(m.thread), `▶ ${name} · Claude Code · Plan\n  Fix the DM thing`, 'a DM shows the project');
  const s = await taskIn(m.thread);
  assert.equal(s.mode, 'plan', 'no mode asked for: Plan, whatever the launcher’s default');
  await settled(s.id);
  assert.match(await next(m.thread), /Reply in this thread to answer or follow up\./);
  dm('with sonnet carry on', { thread_ts: m.ts });
  assert.equal(await next(m.thread), '✓ Sent · Sonnet');
  await until(async () => (await session(s.id)).turns.length === 2);
  assert.equal((await session(s.id)).model, 'sonnet');
  await settled(s.id);
  await next(m.thread);
  dm('new a separate job', { thread_ts: m.ts });
  assert.match(await next(m.thread), /^▶ .*\n  A separate job/);
  await until(() => tasksIn(m.thread).length === 2);
  await settled(tasksIn(m.thread).find((x) => x.id !== s.id).id);
  await next(m.thread);
  assert.equal((await session(s.id)).turns.length, 2, 'not a follow-up');
});

test('stop, status, done, btw in a thread; stop keeps queued follow-ups; no thread, no such thing', async () => {
  const out = dm('stop');
  assert.equal(await next(out.thread), 'Do that in a task’s thread.');
  srv.store.config.defaults.followUp = 'queue';
  process.env.FAKE_DELAY = '30000';
  try {
    const m = dm('a long one');
    await next(m.thread);
    const s = await taskIn(m.thread);
    await until(async () => (await session(s.id)).state === 'running');
    dm('and then this', { thread_ts: m.ts });
    assert.equal(await next(m.thread), '✓ Queued for when it finishes');
    dm('status', { thread_ts: m.ts });
    assert.equal(await next(m.thread), 'Working: a long one (1 queued)');
    dm('stop', { thread_ts: m.ts });
    assert.equal(await next(m.thread), '■ Stopped. 1 queued follow-up kept: your next message carries them on.');
    await until(async () => (await session(s.id)).state !== 'running');
    assert.equal((await session(s.id)).queue.length, 1);
    delete process.env.FAKE_DELAY;
    await next(m.thread); // its report
    dm('pick it up', { thread_ts: m.ts });
    await next(m.thread);
    await until(async () => (await session(s.id)).turns.length >= 2);
    await settled(s.id);
    await until(() => inThread(m.thread).filter((p) => /Reply in this thread/.test(p.text)).length >= 2);
    read.set(`${m.thread.channel}:${m.thread.ts}`, inThread(m.thread).length);
    dm('btw what changed?', { thread_ts: m.ts });
    assert.match(await next(m.thread), /Asking on the side/);
    assert.match(await next(m.thread), /^btw: /);
    dm('done', { thread_ts: m.ts });
    assert.equal(await next(m.thread), '✓ Marked done');
    assert.equal((await session(s.id)).state, 'done');
  } finally {
    delete process.env.FAKE_DELAY;
    srv.store.config.defaults.followUp = 'interrupt';
  }
});

test('in a DM lists are whole; in a channel others read them, so none of your names', async () => {
  for (const [text, re] of [
    ['help', /Say what you’d type in wisp/],
    ['projects', new RegExp(`• ${name}`)],
    ['models', /• claude: opus, sonnet, haiku/],
    ['machines', /• this computer · online/],
    ['crew', /./],
  ]) {
    const m = dm(text);
    const got = await next(m.thread);
    assert.match(got, re, text);
    assert.match(got.split('\n').at(-1), /^Try: /, text);
  }
  await api('/crew', { body: { name: 'Ada', role: 'CI watcher', brief: 'Watch CI.', cwd: repo, agent: 'claude', model: 'sonnet', mode: 'auto', parallel: 2 } });
  srv.store.config.machines = [...(srv.store.config.machines || []), { id: 'm1', name: 'secretbox', target: 'x' }];
  const leaks = (body) => [name, web, repo, 'secretbox'].filter((x) => body.includes(x));
  try {
    for (const word of ['projects', 'crew', 'machines', 'models']) {
      const m = mention(word);
      assert.equal(await next(m.thread), 'That list isn’t shown in a channel: see it in wisp, or ask here in a DM.', word);
    }
    const h = mention('help');
    const help = await next(h.thread);
    assert.match(help, /Try: plan: fix the flaky test/);
    assert.deepEqual(leaks(help), []);
    const st = mention('status');
    assert.match(await next(st.thread), /^\d+ running, \d+ waiting: see them in wisp\.$/);

    for (const [text, re] of [
      ['in nope: fix it', /^No project “nope”\.\n\nNothing started\./],
      ['on secr: fix it', /^… is offline\.\n\nNothing started\./],
      [`@ada in ${web}: fix it`, /^Ada works in …: a job can’t move them to /],
    ]) {
      const m = mention(text);
      const body = await next(m.thread);
      assert.match(body, re, text);
      assert.doesNotMatch(body, /Choices:/, text);
      assert.deepEqual(leaks(body).filter((x) => !text.includes(x)), [], text);
    }
    const c = mention('fix something');
    assert.equal(await next(c.thread), '▶ Claude Code · Plan\n  Fix something', 'the ack hides the default project');
    const s = await taskIn(c.thread);
    await settled(s.id);
    await next(c.thread);
    mention('status', { thread_ts: c.ts });
    assert.equal(await next(c.thread), 'Ready for review.', 'a thread’s status keeps its title to wisp');

    const inDm = dm('in nope: fix it');
    assert.match(await next(inDm.thread), new RegExp(`Choices: .*${name}`), 'a DM keeps them');
  } finally {
    srv.store.config.machines = srv.store.config.machines.filter((m) => m.id !== 'm1');
  }
});

test('a crew member: Plan by default, posted under their name, plain without the scope; a mention in a thread', async () => {
  const m = mention('@ada check the deploy');
  assert.match(await next(m.thread), /^▶ Ada has it · Sonnet · Plan\n  Check the deploy/);
  const job = await taskIn(m.thread);
  assert.equal(job.mode, 'plan', 'their own Full auto doesn’t reach a job from here');
  assert.equal(job.remote.by, 'Ada');
  await settled(job.id);
  const report = await until(() => inThread(m.thread).find((p) => p.username === 'Ada'));
  assert.match(report.text, /^Ada: ✅ /);
  assert.ok(report.icon_emoji);
  await next(m.thread);

  fake.noCustomize = true;
  const p = mention('@ada again, without the scope');
  await next(p.thread);
  await settled((await taskIn(p.thread)).id);
  const plain = await next(p.thread);
  assert.match(plain, /^Ada: ✅ /, 'plain, and it still arrives');
  assert.equal(inThread(p.thread).at(-1).username, undefined);
  fake.noCustomize = false;

  const t = dm('a task to ask about');
  await next(t.thread);
  const s = await taskIn(t.thread);
  await settled(s.id);
  await next(t.thread);
  dm('@ada look at this', { thread_ts: t.ts });
  assert.match(await next(t.thread), /^▶ Ada has it/);
  assert.match(await next(t.thread), /^Ada: /);
  dm('carry on', { thread_ts: t.ts });
  assert.equal(await next(t.thread), '✓ Sent');
  await until(async () => (await session(s.id)).turns.length === 2);
  assert.match((await session(s.id)).turns[1].prompt, /carry on/, 'the task it was on, not the job that answered');
  await settled(s.id);
  await next(t.thread);
});

test('a stranger in a channel: silence, by id and not by name; bots and edits too', async () => {
  const count = srv.store.all().length;
  const a = mention('run this for me', { user: STRANGER_ID, username: 'mokh' });
  for (const [text, o] of [
    ['from a bot', { bot_id: 'B9' }],
    ['from this bot', { user: 'UBOT' }],
    ['an edit', { subtype: 'message_changed' }],
    ['a bot message', { subtype: 'bot_message' }],
  ])
    mention(text, { ts: a.ts, thread_ts: a.ts, ...o, client_msg_id: uid() });
  dm('from a bot, in a DM', { thread_ts: a.ts, channel: 'C1', bot_id: 'B9' });
  await caughtUp(a.thread);
  assert.equal(inThread(a.thread).length, 1, 'only the answer to the last message');
  assert.equal(srv.store.all().length, count);

  // In a DM a stranger gets a line, but this bot's own message isn't one: it would answer itself.
  const own = dm('my own report', { user: 'UBOT' });
  dm('and a bot', { thread_ts: own.ts, bot_id: 'B9' });
  await caughtUp(own.thread);
  assert.equal(inThread(own.thread).length, 1);
});

test('duplicates: a retried envelope, a redelivered event, one message as two events; each acked', async () => {
  const m = dm('only once');
  await next(m.thread);
  const s = await taskIn(m.thread);
  await settled(s.id);
  await next(m.thread);
  const retry = { ...m.env, envelope_id: 'env-retry', retry_attempt: 1, retry_reason: 'timeout' };
  fake.envelope(retry);
  fake.envelope(m.env); // the same one, whole
  const twin = fake.event({ ...m.env.payload.event }, { event_id: 'EvTwin' }); // same client_msg_id, another event
  await until(() => [retry.envelope_id, twin.envelope_id].every((id) => fake.acks.includes(id)));
  assert.equal(fake.acks.filter((id) => id === m.env.envelope_id).length, 2);
  await caughtUp(m.thread);
  assert.equal(tasksIn(m.thread).length, 1);
  assert.equal(srv.store.all().filter((x) => x.turns[0]?.prompt.includes('only once')).length, 1);
});

test('every envelope is acked at once: the work comes after, however long it takes', async () => {
  const phone = srv.remote.phone;
  const real = phone.startParsed;
  let release;
  const held = new Promise((r) => (release = r));
  let entered = false;
  phone.startParsed = async (...a) => {
    entered = true;
    await held;
    return real(...a);
  };
  try {
    const m = dm('a slow start');
    await until(() => entered && fake.acks.includes(m.env.envelope_id), { what: 'the ack, with the work still going' });
    assert.deepEqual(inThread(m.thread), []);
    release();
    await next(m.thread);
    await settled((await taskIn(m.thread)).id);
    await next(m.thread);
  } finally {
    phone.startParsed = real;
  }
  const other2 = fake.envelope({ envelope_id: 'env-slash', type: 'slash_commands', payload: {} });
  await until(() => fake.acks.includes(other2.envelope_id), { what: 'an envelope of a kind wisp doesn’t use' });
});

test('stale: said while wisp was off, told and not run', async () => {
  const count = srv.store.all().length;
  const old = `${Math.floor(Date.now() / 1000) - STALE_S - 60}.000100`;
  const m = dm('from a while ago', { ts: old });
  assert.match(await next(m.thread), /^That arrived while wisp was offline, so it didn’t run\./);
  assert.equal(srv.store.all().length, count);
});

test('a burst is told once, then silence', async () => {
  const ch = srv.remote.channels.slack;
  const keep = ch.limit;
  ch.limit = new RateLimit({ max: 1 });
  try {
    const m = dm('help');
    await next(m.thread);
    dm('help', { thread_ts: m.ts });
    assert.match(await next(m.thread), /^That’s a lot of messages/);
    dm('help', { thread_ts: m.ts });
    ch.limit = keep;
    await caughtUp(m.thread);
  } finally {
    ch.limit = keep;
  }
});

test('Full auto is refused and nothing starts; Edits is the most; a follow-up is held to it', async () => {
  const wiped = () => srv.store.all().filter((s) => s.turns[0]?.prompt.includes('wipe it'));
  const m = dm('full auto: wipe it');
  assert.equal(await next(m.thread), 'Full auto isn’t allowed from here. The most this chat can ask for is Edits.\n\nNothing started.');
  assert.deepEqual(wiped(), []);
  const e = dm('edits: small fix');
  assert.match(await next(e.thread), /· Edits\n  Small fix/);
  const s = await taskIn(e.thread);
  assert.equal(s.mode, 'edits');
  await settled(s.id);
  await next(e.thread);
  dm('full auto: and now wipe it', { thread_ts: e.ts });
  assert.match(await next(e.thread), /Full auto isn’t allowed from here/);
  assert.equal((await session(s.id)).turns.length, 1);
  srv.store.get(s.id).mode = 'auto'; // switched in wisp meanwhile
  dm('carry on', { thread_ts: e.ts });
  await next(e.thread);
  await until(async () => (await session(s.id)).turns.length === 2);
  assert.equal((await session(s.id)).mode, 'edits', 'a message can’t carry a task on in Full auto');
  await settled(s.id);
  await next(e.thread);
});

test('a tool approval is never answered from Slack, and says so', async () => {
  const m = dm('edits: APPROVE then publish');
  await next(m.thread);
  const s = await taskIn(m.thread);
  assert.equal(await next(m.thread), 'Waiting for your OK in wisp: run `npm publish`');
  dm('allow', { thread_ts: m.ts });
  assert.equal(await next(m.thread), 'That’s waiting for an approval, which only wisp can give: answer it there.');
  assert.ok((await session(s.id)).ask?.permission, 'still waiting');
  assert.equal(srv.remote.channels.slack.approvalsHere, false);
  await api(`/sessions/${s.id}/stop`, { method: 'POST' });
  await settled(s.id);
  await next(m.thread);
});

test('an approval says so with the Phone events off, each ask once, and a connector or a clash too', async () => {
  const events = srv.store.config.remote.events;
  srv.store.config.remote.events = [];
  try {
    const m = dm('edits: APPROVE then publish');
    await next(m.thread);
    const s = await taskIn(m.thread);
    assert.equal(await next(m.thread), 'Waiting for your OK in wisp: run `npm publish`');
    await srv.remote.notify(srv.store.get(s.id), { project: 'p' });
    await caughtUp(m.thread);
    assert.equal(inThread(m.thread).filter((p) => p.text.startsWith('Waiting')).length, 1, 'one line for one ask');
    await api(`/sessions/${s.id}/stop`, { method: 'POST' });
    await settled(s.id);
    await next(m.thread);
    const live = srv.store.get(s.id);
    for (const ask of [
      { question: 'Sign in to Linear', connector: { id: 'c', name: 'Linear', kind: 'signin', keys: [] } },
      { question: 'This clashes with the main task in src/a.js', clash: { file: 'src/a.js' } },
    ]) {
      Object.assign(live, { state: 'waiting', ask: { id: `ask-${ask.question}`, options: ['Skip'], ...ask } });
      await srv.remote.notify(live, { project: 'p' });
      assert.equal(await next(m.thread), `Waiting for your OK in wisp: ${ask.question}`);
      delete live.ask;
      live.state = 'review';
    }
  } finally {
    srv.store.config.remote.events = events;
  }
});

test('a subagent’s approval reaches the thread of the task it holds up, with no secret in it', async () => {
  const m = dm('report something');
  await next(m.thread);
  const s = await taskIn(m.thread);
  await settled(s.id);
  await next(m.thread);
  const token = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
  const child = srv.runner.create({ prompt: '', cwd: repo, agent: 'claude', parentId: s.id, member: 'helper' });
  try {
    srv.runner.ask(child, { question: 'Allow?', options: ['Allow', 'Deny'], permission: { tool: 'Bash', action: `run \`gh auth login ${token}\``, detail: `gh auth login ${token}` } });
    const said = await next(m.thread);
    assert.match(said, /^Waiting for your OK in wisp: gh auth login \[redacted/);
    assert.ok(!said.includes(token));
  } finally {
    delete child.ask;
    child.state = 'review';
  }
});

async function reported(summary, title = 'A title') {
  const m = dm('report something');
  await next(m.thread);
  const s = await taskIn(m.thread);
  await settled(s.id);
  await next(m.thread);
  const live = srv.store.get(s.id);
  live.title = title;
  live.turns.at(-1).presentation = { blocks: [{ type: 'hero', status: 'done', title: 'Agent’s title', summary }] };
  await srv.remote.notify(live, { project: 'p' });
  return { text: await next(m.thread), post: inThread(m.thread).at(-1) };
}

test('what leaves: a secret is taken out, nobody is pinged, no URL is fetched, and it fits', async () => {
  const token = `ghp_${'a1B2'.repeat(10)}`;
  const { text, post } = await reported(`Found ${token} <!channel> <!here> <@U999> <#C1|general> <https://evil.example|click> @everyone @here`, `Title ${token} <!channel>`);
  assert.ok(!text.includes(token), text);
  assert.match(text, /wisp took a secret out of this message/);
  assert.doesNotMatch(text, /<[!@#]/, 'no live mention');
  assert.doesNotMatch(text, /<http/, 'no live link');
  assert.match(text, /&lt;/);
  assert.doesNotMatch(text, /(^|\s)@(everyone|here)\b/, 'not as a word either');
  assert.deepEqual([post.parse, post.link_names, post.unfurl_links, post.unfurl_media], ['none', false, false, false]);
  assert.equal(post.channel, 'D1');
  assert.ok(post.thread_ts, 'a report goes in the thread');
  const big = await reported('x'.repeat(20000));
  assert.ok(big.text.length <= 3900);
  assert.equal(slackText('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
});

test('reports: only tasks started here, whatever the Phone events say; a task from wisp posts nothing', async () => {
  const events = srv.store.config.remote.events;
  srv.store.config.remote.events = [];
  try {
    const m = dm('with the events off');
    await next(m.thread);
    await settled((await taskIn(m.thread)).id);
    assert.match(await next(m.thread), /^✅ /);
  } finally {
    srv.store.config.remote.events = events;
  }
  const before = fake.posted.length;
  const s = await api('/sessions', { body: { prompt: 'plain task', cwd: repo, agent: 'claude', worktree: false } });
  await settled(s.id);
  const m = srv.crew.find('ada');
  const out = await srv.crew.checkin(m, { unattended: true });
  await settled(out.session.id);
  await srv.remote.notify(srv.store.get(s.id), { project: 'p' });
  await srv.remote.notify(srv.store.get(out.session.id), { project: 'p' });
  assert.equal(fake.posted.length, before, 'nothing about them');
});

test('the connection drops: wisp dials again, and what’s said next arrives', async () => {
  await connected();
  const opens = fake.opens;
  fake.drop();
  await until(() => fake.opens > opens && fake.sockets.size === 1, { what: 'a new connection' });
  await connected();
  const m = dm('help');
  assert.match(await next(m.thread), /Say what you’d type/);
});

test('Slack’s own disconnect: a new socket right away; link_disabled stops and says so', async () => {
  await connected();
  const opens = fake.opens;
  fake.disconnect('refresh_requested');
  await until(() => fake.opens > opens, { what: 'a new connection' });
  await connected();
  const m = dm('help');
  await next(m.thread);

  const calls = fake.calls.length;
  fake.disconnect('link_disabled');
  const v = await until(async () => {
    const x = await api('/remote');
    return /link_disabled/.test(x.slack.error) ? x : null;
  });
  assert.equal(v.slack.connected, false);
  assert.match(v.slack.error, /Check the tokens/);
  assert.equal(fake.calls.length, calls, 'it didn’t try again');
  await api('/remote', { method: 'PUT', body: { slack: { enabled: true } } }); // settings saved: it starts over
  await connected();
});

test('a 429 with Retry-After: the next try waits that long; a post waits and still goes', async () => {
  await connected();
  const tried = [];
  const real = globalThis.fetch;
  globalThis.fetch = (url, o) => {
    if (String(url).endsWith('/apps.connections.open')) tried.push(Date.now());
    return real(url, o);
  };
  try {
    fake.fail('apps.connections.open', { status: 429, headers: { 'retry-after': '1' }, body: { ok: false, error: 'ratelimited' } });
    fake.drop();
    await until(() => tried.length >= 2 && fake.sockets.size === 1, { what: 'the second try' });
    assert.ok(tried[1] - tried[0] >= 950, `${tried[1] - tried[0]} ms`);
    await connected();
  } finally {
    globalThis.fetch = real;
  }
  fake.fail('chat.postMessage', { status: 429, headers: { 'retry-after': '1' }, body: { ok: false, error: 'ratelimited' } });
  const m = dm('help');
  assert.match(await next(m.thread), /Say what you’d type/);
  assert.equal(srv.remote.channels.slack.connected, true);
});

test('a revoked token stops it, says what to do, and new tokens start it again; no token in any error', async () => {
  await connected();
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    fake.revoked = true;
    fake.drop();
    const v = await until(async () => {
      const x = await api('/remote');
      return /token_revoked/.test(x.slack.error) ? x : null;
    });
    assert.match(v.slack.error, /Check the tokens/);
    assert.equal(v.slack.connected, false);
    const n1 = fake.calls.length;
    await sleep(150);
    assert.equal(fake.calls.length, n1, 'it doesn’t hammer a dead token');
    fake.revoked = false;
    await api('/remote', { method: 'PUT', body: { slack: { appToken: `${APP}2` } } });
    await connected();
    assert.equal((await api('/remote')).slack.error, '');
    assert.equal((await api('/remote')).slack.senders, 1, 'a new app token keeps who’s linked');
    assert.ok(!JSON.stringify(warned).includes('secret'), warned.join());
  } finally {
    console.warn = warn;
  }
});

test('a socket that says nothing, or stops answering, is replaced', async () => {
  await connected();
  const ch = srv.remote;
  const keep = ch.slackPingMs;
  ch.slackPingMs = 30;
  try {
    const opens = fake.opens;
    fake.silent();
    fake.drop();
    await until(() => fake.opens >= opens + 2, { what: 'a second try after no hello' });
    fake.silent(false);
    await connected();
    const again = fake.opens;
    fake.deaf = true; // the socket stays up, and nothing comes back
    await until(() => fake.opens > again, { what: 'a new connection when pings go unanswered' });
    fake.deaf = false;
    await connected();
  } finally {
    ch.slackPingMs = keep;
    fake.drop();
  }
  await connected();
});

test('a restart: linked people stay, a queued crew job answers in its thread, nothing runs twice', async () => {
  await connected();
  const z = await api('/crew', { body: { name: 'Zed', brief: 'Watch.', cwd: repo, agent: 'claude', model: 'sonnet', mode: 'edits', parallel: 1 } });
  process.env.FAKE_DELAY = '30000';
  const a = dm('@zed the long job');
  await next(a.thread);
  await taskIn(a.thread);
  const q = dm('@zed the queued job');
  assert.match(await next(q.thread), /^▶ Zed has it \(queued, 1 ahead\)/);
  assert.deepEqual({ ...srv.crew.get(z.id).queue[0].thread }, { channel: 'slack', chat: 'D1', ts: q.ts });
  halt();
  delete process.env.FAKE_DELAY;
  await boot();
  await connected();
  assert.equal((await api('/remote')).slack.senders, 1);
  await srv.crew.tick();
  const job = await taskIn(q.thread);
  assert.equal(job.remote.by, 'Zed');
  await settled(job.id);
  assert.match(await next(q.thread), /^Zed: /);
});

test('a task on another machine keeps its thread across a restart: it reports, and a reply follows up', async () => {
  const id = 'abc@m1';
  const thread = { channel: 'slack', chat: 'D1', ts: newTs() };
  const t = { channel: 'D1', ts: thread.ts };
  srv.remote.markStarted(id, 'slack', 'Ada');
  srv.remote.channels.slack.threadStarted({ id }, thread, { name: 'Ada' });
  const disk = JSON.parse(fs.readFileSync(path.join(process.env.WISP_HOME, 'config.json'), 'utf8'));
  assert.deepEqual(disk.remote.slack.away[id].slack, t, 'on disk at once');
  await api('/remote', { method: 'PUT', body: { slack: { enabled: true } } });
  assert.ok(srv.store.config.remote.slack.away[id], 'a settings change keeps it');
  halt();
  await boot();
  await connected();
  assert.equal(srv.remote.startedFrom({ id }).channel, 'slack');
  const turns = [{ id: 't1', status: 'done', presentation: { blocks: [{ type: 'hero', status: 'done', title: 'From away', summary: 'Done over there' }] } }];
  await srv.remote.notify({ id, state: 'review', title: 'Away task', turns }, { project: 'p' });
  assert.match(await next(t), /^Ada: ✅ p: Away task[\s\S]*Done over there/);
  const sent = [];
  srv.machines.json = async (mid, method, p, body) => {
    if (method === 'GET') return { id: 'abc', agent: 'claude', state: 'review', mode: 'plan', title: 'Away task', turns };
    sent.push({ p, body });
    return { queued: false };
  };
  srv.machines.session = (mid, s) => ({ ...s, id: `${s.id}@${mid}` });
  const count = srv.store.all().length;
  dm('and the next thing', { thread_ts: t.ts });
  assert.equal(await next(t), '✓ Sent');
  assert.equal(sent[0].p, '/sessions/abc/reply');
  assert.equal(srv.store.all().length, count, 'not another task');
});

test('telemetry: counts only, never what was said', async () => {
  const seen = [];
  const real = srv.telemetry.track;
  srv.telemetry.track = (event, props) => (event === 'channel_event' ? seen.push(props) : 0, real.call(srv.telemetry, event, props));
  try {
    const m = dm('a secret plan about telemetry');
    await next(m.thread);
    await settled((await taskIn(m.thread)).id);
    await next(m.thread);
  } finally {
    srv.telemetry.track = real;
  }
  assert.deepEqual(seen.filter((p) => p.kind !== 'report').map((p) => [p.kind, p.detail]), [['start', 'plain']]);
  assert.ok(!JSON.stringify(seen).includes('secret plan'));
});

test('unlinking: everyone goes, a new code, and they’re strangers again; off stops it', async () => {
  const before = (await api('/remote')).slack.linkCode;
  const v = await api('/remote', { method: 'PUT', body: { slack: { unlink: true } } });
  assert.equal(v.slack.senders, 0);
  assert.notEqual(v.slack.linkCode, before);
  await connected();
  const m = dm('hello');
  assert.match(await next(m.thread), /^This wisp only answers/);
  const off = await api('/remote', { method: 'PUT', body: { slack: { enabled: false } } });
  assert.equal(off.slack.enabled, false);
  await until(() => fake.sockets.size === 0, { what: 'the socket to close' });
  await until(() => fake.closes.length > 0);
  assert.equal(fake.closes.at(-1), 1000, 'a clean goodbye');
  assert.equal(srv.remote.on, false);
});

test('stripFormatting: Slack’s markup, gone before the grammar reads it', () => {
  const s = (t, o) => stripFormatting(t, 'slack', o);
  assert.equal(s('<@UBOT> in api fix it', { bot: 'UBOT' }), 'in api fix it');
  assert.equal(s('<@UBOT|wisp>: fix it', { bot: 'UBOT' }), 'fix it');
  assert.equal(s('hey <@UBOT> fix it', { bot: 'UBOT' }), 'hey fix it');
  assert.equal(s('<@UOTHER> look', { bot: 'UBOT' }), '<@UOTHER> look');
  assert.equal(s('see <https://a.dev/x>'), 'see https://a.dev/x');
  assert.equal(s('see <https://a.dev|a.dev>'), 'see a.dev');
  assert.equal(s('see <https://a.dev/x|the docs>'), 'see the docs (https://a.dev/x)');
  assert.equal(s('mail <mailto:a@b.co|a@b.co>'), 'mail a@b.co');
  assert.equal(s('<#C123|api> fix it'), '#api fix it');
  assert.equal(s('<#C123> fix it'), '#C123 fix it');
  assert.equal(s('<!here> look'), '@here look');
  assert.equal(s('<!subteam^S1|@devs> look'), '@devs look');
  assert.equal(s('a &amp;&amp; b &lt;c&gt;'), 'a && b <c>');
  assert.equal(s('&amp;lt;'), '&lt;', 'decoded once');
});
