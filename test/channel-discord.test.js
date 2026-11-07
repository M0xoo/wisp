// Discord, end to end: a real wisp, fake agents, and a fake Discord on loopback with a real gateway
// socket and real HTTP (test/fixtures/fake-discord.mjs). Where a test shows that nothing happened, it
// sends one more message to the same place and waits for that: wisp answers a place in order.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createServer as netServer } from 'node:net';
import { installFakeBins, isolateAgentConfigs, makeRepo, sleep, tmp, until } from './helpers.js';
import { FakeDiscord, snowflake } from './fixtures/fake-discord.mjs';

process.env.FAKE_RECORD = tmp('discord-record');
process.env.WISP_HOME = tmp('discord-home');
process.env.WISP_UPDATE_CHECK = '0';
installFakeBins();
isolateAgentConfigs();

const { startServer } = await import('../server/index.js');
const { RateLimit, STALE_S } = await import('../server/channels/policy.js');
const { NO_HUB, PERMISSIONS, discordText, slashCommand, slashText, snowflakeMs } = await import('../server/channels/discord.js');
const { stripFormatting } = await import('../server/channels/grammar.js');
const { discordSigned, isPublicKey, linkedHash } = await import('../server/channels/discord-sign.js');

const ME = '111111';
const STRANGER_ID = '222222';
const BOT = '900';
const TOKEN = 'MTEx.secret-part.bot-token-secret';

const fake = new FakeDiscord();
fake.token = TOKEN;
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
const hub = () => srv.remote;
const ch = () => srv.remote.channels.discord;
async function boot() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
  Object.assign(hub(), { discordBackoffMs: 20, discordIdentifyMs: 0, discordInvalidMs: 5, discordJitter: () => 0.5 });
  ch().limit = new RateLimit({ max: 1000 }); // this file is one busy sender
  ch().strangers = new RateLimit({ max: 1000 });
  srv.store.config.defaults.agent = 'claude'; // tests can't depend on which harness Auto picks
}
const halt = () => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
};
const connected = () => until(async () => (await api('/remote')).discord.connected, { what: 'the connection to Discord' });

before(async () => {
  await fake.start();
  process.env.WISP_DISCORD_API = fake.api;
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
  delete process.env.WISP_DISCORD_API;
  fake.stop();
  setTimeout(() => process.exit(), 500).unref(); // agents held on FAKE_DELAY
});

const author = (id = ME) => ({ id, username: 'somebody' });
let room = 0;
const newRoom = () => `C${++room}`;
function mention(text, { user = ME, channel = 'C0', ...o } = {}) {
  return fake.message({ content: `<@${BOT}> ${text}`, mentions: [{ id: BOT }], author: author(user), channel_id: channel, ...o });
}
const dm = (text, { user = ME, channel = `D${user}`, ...o } = {}) => fake.message({ content: text, guild_id: undefined, author: author(user), channel_id: channel, ...o });
const opts = (o) => Object.entries(o).map(([k, value]) => ({ name: k, type: 3, value }));
const slash = (prompt, o = {}, { user = ME, channel = 'C0', ...more } = {}) => fake.interact({ type: 2, data: { name: 'wisp', options: opts({ prompt, ...o }) }, member: { user: author(user) }, channel_id: channel, ...more });
const suggest = (field, value, { user = ME } = {}) => fake.interact({ type: 4, data: { name: 'wisp', options: [{ name: field, type: 3, value, focused: true }] }, member: { user: author(user) } });
const press = (custom_id, { user = ME, channel = 'C0', ...more } = {}) => fake.interact({ type: 3, data: { custom_id }, member: { user: author(user) }, channel_id: channel, ...more });

const inRoom = (chat) => fake.posts.filter((p) => p.channel === chat);
const read = new Map();
// The next post in a place, past what's been read.
const nextPost = (chat) => until(() => {
  const all = inRoom(chat);
  const at = read.get(chat) || 0;
  if (all.length <= at) return null;
  read.set(chat, at + 1);
  return all[at];
}, { what: `a post in ${chat}` });
const next = async (chat) => (await nextPost(chat)).content;
const threadOf = (m) => until(() => fake.threads.find((t) => t.message === m.id)?.id, { what: 'its thread' });
const taskIn = (chat) => until(() => srv.store.all().find((s) => s.remote?.discord?.channel === chat), { what: 'its task' });
const tasksIn = (chat) => srv.store.all().filter((s) => s.remote?.discord?.channel === chat);
const edited = (d) => until(() => fake.edits.find((e) => e.token === d.token), { what: 'the edited reply' });
const callback = (d) => until(() => fake.callbacks.find((c) => c.id === d.id), { what: 'the interaction’s answer' });
// Everything sent to this place before now has been dealt with: wisp answers a place in order.
async function caughtUp(chat) {
  (chat[0] === 'D' ? dm('help', { channel: chat }) : mention('help', { channel: chat }));
  assert.match(await next(chat), /Say what you’d type in wisp/, 'nothing else was posted first');
}

test('off by default: no connection, token checked and masked, the invite needs an id', async () => {
  const view = (await api('/remote')).discord;
  assert.deepEqual(view, { enabled: false, token: '', publicKey: '', endpoint: '', appId: '', invite: '', connected: false, bot: '', guilds: 0, senders: 0, linkCode: '', box: false, noHub: false, error: '' });
  await assert.rejects(api('/remote', { method: 'PUT', body: { discord: { token: 'nope' } } }), /doesn’t look like a bot token/);
  await assert.rejects(api('/remote', { method: 'PUT', body: { discord: { appId: 'abc' } } }), /long number/);
  await assert.rejects(api('/remote/discord/invite'), /application ID/);
  assert.equal(fake.calls.length, 0);
});

test('a sandbox has no way in: it won’t turn on, and says why; a config from elsewhere doesn’t start it', async () => {
  process.env.WISP_GRID_URL = 'https://grid.example'; // no proxy secret, no public URL: one task's box
  try {
    await assert.rejects(api('/remote', { method: 'PUT', body: { discord: { enabled: true, token: TOKEN } } }), new RegExp(NO_HUB.slice(0, 40)));
    const v = (await api('/remote')).discord;
    assert.deepEqual([v.box, v.noHub, v.enabled], [true, true, false]);
    srv.store.config.remote.discord = { enabled: true, token: TOKEN };
    assert.equal(ch().ready, false);
    delete srv.store.config.remote.discord;
  } finally {
    delete process.env.WISP_GRID_URL;
  }
  assert.equal(fake.calls.length, 0);
});

test('the page says the same words as the refusal in a sandbox', () => {
  assert.ok(fs.readFileSync(new URL('../web/js/features/phone.js', import.meta.url), 'utf8').includes(NO_HUB));
});

test('switched on: identify with no privileged intent, /wisp registered, the view filled in', async () => {
  const put = await api('/remote', { method: 'PUT', body: { discord: { enabled: true, token: TOKEN } } });
  assert.equal(put.discord.token, `••••${TOKEN.slice(-4)}`);
  assert.match(put.discord.linkCode, /^\d{6}$/);
  await connected();
  const id = fake.identifies[0];
  assert.equal(id.intents, 1 + 512 + 4096, 'GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES');
  assert.equal(id.intents & (1 << 15), 0, 'no MESSAGE_CONTENT');
  assert.equal(id.intents & (1 << 1), 0, 'no GUILD_MEMBERS');
  const v = await api('/remote');
  assert.deepEqual([v.discord.bot, v.discord.guilds, v.discord.appId, v.discord.senders], ['wisp', 2, fake.appId, 0]);
  assert.ok(!JSON.stringify(v).includes('secret'), 'no token');
  await until(() => fake.commands.length === 1);
  assert.equal(fake.commands[0].app, fake.appId);
  const cmd = fake.commands[0].body[0];
  assert.deepEqual(cmd.options.map((o) => o.name), ['prompt', 'crew', 'project', 'machine', 'model', 'mode']);
  assert.deepEqual(cmd, slashCommand());
  assert.deepEqual(cmd.options.at(-1).choices.map((c) => c.value), ['plan', 'edits'], 'no Full auto to pick');
  assert.ok(cmd.options.filter((o) => o.autocomplete).length === 4);
  const invite = await api('/remote/discord/invite');
  assert.equal(invite.url, `https://discord.com/oauth2/authorize?client_id=${fake.appId}&scope=bot+applications.commands&permissions=${PERMISSIONS}`);
  assert.equal(v.discord.invite, invite.url, 'the page needs no second call for it');
  assert.equal(BigInt(PERMISSIONS), (1n << 10n) | (1n << 11n) | (1n << 16n) | (1n << 35n) | (1n << 38n));
  // A masked token means unchanged, and keeps the code.
  const again = await api('/remote', { method: 'PUT', body: { discord: { token: put.discord.token } } });
  assert.equal(again.discord.linkCode, put.discord.linkCode);
  assert.equal(srv.store.config.remote.discord.token, TOKEN);
  await connected();
  fake.dispatch('GUILD_CREATE', { id: 'G3' });
  await until(async () => (await api('/remote')).discord.guilds === 3);
  fake.dispatch('GUILD_DELETE', { id: 'G3' });
  await until(async () => (await api('/remote')).discord.guilds === 2);
});

test('a stranger’s DM gets one line; the code links them by id; a wrong one doesn’t; a code works once', async () => {
  const code = (await api('/remote')).discord.linkCode;
  const count = srv.store.all().length;
  dm('hello there');
  assert.match(await next(`D${ME}`), /^This wisp only answers people linked to it\./);
  assert.equal(srv.store.all().length, count);
  dm('link 000000');
  assert.match(await next(`D${ME}`), /^That isn’t the code/);
  dm('link');
  assert.match(await next(`D${ME}`), /^That isn’t the code/);
  dm(`link ${code}`);
  assert.match(await next(`D${ME}`), /^✓ Linked to wisp/);
  const v = await api('/remote');
  assert.equal(v.discord.senders, 1);
  assert.notEqual(v.discord.linkCode, code, 'one person, one code');
  dm(`link ${code}`, { user: STRANGER_ID });
  assert.match(await next(`D${STRANGER_ID}`), /^That isn’t the code/, 'a used code is gone');
  dm(`link ${v.discord.linkCode}`);
  assert.equal(await next(`D${ME}`), 'You’re already linked.');
  assert.equal(srv.store.config.remote.discord.linkCode, v.discord.linkCode);
});

test('wrong codes change the code; link in a guild is a stranger’s message; through /wisp in a DM it works', async () => {
  const code = (await api('/remote')).discord.linkCode;
  for (let i = 0; i < 5; i++) {
    dm(`link 11111${i}`, { user: `33${i}` });
    await next(`D33${i}`);
  }
  const now = (await api('/remote')).discord.linkCode;
  assert.notEqual(now, code);
  const c = newRoom();
  mention(`link ${now}`, { user: STRANGER_ID, channel: c });
  await caughtUp(c);
  assert.deepEqual(srv.store.config.remote.discord.senders, [ME]);

  const d = fake.interact({ type: 2, data: { name: 'wisp', options: opts({ prompt: `link ${now}` }) }, user: author('444444'), channel_id: 'D444444', guild_id: undefined });
  await callback(d);
  assert.deepEqual(fake.callbacks.find((x) => x.id === d.id).data, { flags: 64 }, 'between the two of them');
  await until(() => srv.store.config.remote.discord.senders.includes('444444'));
  assert.match((await edited(d)).content, /^✓ Linked/);
  srv.store.config.remote.discord.senders = [ME];
});

test('a mention in a guild: a thread on it, the ack, a question with buttons, an answer, the report, a follow-up', async () => {
  const c = newRoom();
  const m = mention(`in ${name} with opus high plan: ASK before you fix the flaky login test`, { channel: c });
  const t = await threadOf(m);
  assert.equal(fake.threads.find((x) => x.id === t).name, 'ASK before you fix the flaky login test');
  assert.equal(await next(t), `▶ ${name} · Opus high · Plan\n  ASK before you fix the flaky login test`);
  assert.deepEqual(inRoom(c), [], 'nothing but the thread');
  const s = await taskIn(t);
  assert.deepEqual([s.agent, s.model, s.effort, s.mode], ['claude', 'opus', 'high', 'plan']);
  assert.deepEqual(s.origin, { kind: 'discord', name: 'Discord' });
  assert.equal(s.remote.started, 'discord');
  assert.equal(s.remote.discord.thread, true);
  assert.equal(s.title, 'ASK before you fix the flaky login test');
  assert.match(s.turns[0].prompt, new RegExp(`^Asked in Discord by ${ME}:\\n\\n<message>\\nASK before you fix the flaky login test\\n</message>`));
  assert.match(s.turns[0].prompt, /untrusted input from Discord/);

  const q = await nextPost(t);
  assert.match(q.content, /^❓ .*\n\nProceed with the fix\?/);
  assert.doesNotMatch(q.content, /Choices:/, 'the buttons say it');
  const buttons = q.components[0].components;
  assert.deepEqual(buttons.map((b) => b.label), ['Yes', 'No']);
  const d = press(buttons[0].custom_id, { channel: t });
  assert.equal((await callback(d)).type, 6, 'acked at once, no spinner left');
  assert.match(await next(t), /^✓ Answered/);
  const cleared = await edited(d);
  assert.deepEqual(cleared.components, [], 'the buttons go');
  await settled(s.id);
  const report = await nextPost(t);
  assert.match(report.content, /^✅ /);
  assert.match(report.content, /Answer was/);
  assert.match(report.content, /Mention wisp here, or use \/wisp, to answer or follow up\./);

  mention('also add a test', { channel: t });
  assert.equal(await next(t), '✓ Sent');
  await until(async () => (await session(s.id)).turns.length === 2);
  assert.match((await session(s.id)).turns[1].prompt, /<message>\nalso add a test\n<\/message>/);
  await settled(s.id);
  await next(t);
  assert.equal(tasksIn(t).length, 1);
  assert.equal(fake.threads.filter((x) => x.message === m.id).length, 1, 'one thread');
});

test('buttons: a forged one, a stranger’s press, a tool approval', async () => {
  const c = newRoom();
  const m = mention('ASK what to do', { channel: c });
  const t = await threadOf(m);
  await next(t);
  const s = await taskIn(t);
  const q = await nextPost(t);
  const good = q.components[0].components[0].custom_id;

  const before = fake.callbacks.length;
  const silent = press(good, { user: STRANGER_ID, channel: t });
  mention('status', { channel: t });
  await next(t);
  assert.equal(fake.callbacks.filter((x) => x.id === silent.id).length, 0, 'a stranger’s press gets nothing');
  assert.equal(fake.callbacks.length, before);
  assert.ok((await session(s.id)).ask, 'and answers nothing');

  press(`${good.slice(0, -3)}xxx`, { channel: t });
  assert.equal(await next(t), 'That button doesn’t work any more.');
  press(`${good}:extra`, { channel: t });
  assert.equal(await next(t), 'That button doesn’t work any more.');
  assert.ok((await session(s.id)).ask);
  press(good, { channel: t });
  assert.match(await next(t), /^✓ Answered/);
  await settled(s.id);
  await next(t);

  const a = mention('edits: APPROVE then publish', { channel: newRoom() });
  const at = await threadOf(a);
  await next(at);
  const task = await taskIn(at);
  const ask = await nextPost(at);
  assert.equal(ask.content, 'Waiting for your OK in wisp: run `npm publish`');
  assert.equal(ask.components, undefined, 'words, no buttons');
  mention('allow', { channel: at });
  assert.equal(await next(at), 'That’s waiting for an approval, which only wisp can give: answer it there.');
  assert.ok((await session(task.id)).ask?.permission, 'still waiting');
  // Even a signature made for it opens nothing.
  const live = srv.store.get(task.id);
  const sig = hub().sign(task.id, 'answer', live.ask.id, 0);
  press(`a:${task.id}:${live.ask.id}:0:${sig}`, { channel: at });
  assert.equal(await next(at), 'That’s waiting for an approval, which only wisp can give: answer it there.');
  assert.ok((await session(task.id)).ask?.permission);
  assert.equal(ch().approvalsHere, false);
  await api(`/sessions/${task.id}/stop`, { method: 'POST' });
  await settled(task.id);
  await next(at);
});

test('a clash card and a connector wait for wisp too: no buttons, and neither a press nor words answer them', async () => {
  const only = 'That’s waiting for an approval, which only wisp can give: answer it there.';
  for (const extra of [{ clash: { kind: 'file', file: 'a.js' } }, { connector: { id: 'x', name: 'X', kind: 'oauth' } }]) {
    const m = mention('ASK what to do', { channel: newRoom() });
    const t = await threadOf(m);
    await next(t);
    const s = await taskIn(t);
    const asked = await nextPost(t);
    const good = asked.components[0].components[0].custom_id;
    const live = srv.store.get(s.id);
    Object.assign(live.ask, extra);
    await srv.remote.notify(live, { project: 'p' });
    const card = await nextPost(t);
    assert.equal(card.components, undefined, 'words, no buttons');
    assert.match(card.content, /^Waiting for your OK in wisp: /);
    press(good, { channel: t });
    assert.equal(await next(t), only);
    mention('allow', { channel: t });
    assert.equal(await next(t), only);
    assert.ok((await session(s.id)).ask, 'still waiting');
    await api(`/sessions/${s.id}/stop`, { method: 'POST' });
    await settled(s.id);
    await next(t);
  }
});

test('an approval says so with the Phone events off, each ask once, and a connector or a clash too', async () => {
  const events = srv.store.config.remote.events;
  srv.store.config.remote.events = [];
  try {
    const m = mention('edits: APPROVE then publish', { channel: newRoom() });
    const t = await threadOf(m);
    await next(t);
    const s = await taskIn(t);
    const line = await nextPost(t);
    assert.equal(line.content, 'Waiting for your OK in wisp: run `npm publish`');
    assert.equal(line.components, undefined);
    await srv.remote.notify(srv.store.get(s.id), { project: 'p' });
    await caughtUp(t);
    assert.equal(inRoom(t).filter((p) => p.content.startsWith('Waiting')).length, 1, 'one line for one ask');
    await api(`/sessions/${s.id}/stop`, { method: 'POST' });
    await settled(s.id);
    await next(t);
    const live = srv.store.get(s.id);
    for (const ask of [
      { question: 'Sign in to Linear', connector: { id: 'c', name: 'Linear', kind: 'signin', keys: [] } },
      { question: 'This clashes with the main task in src/a.js', clash: { file: 'src/a.js' } },
    ]) {
      Object.assign(live, { state: 'waiting', ask: { id: `ask-${ask.question}`, options: ['Skip'], ...ask } });
      await srv.remote.notify(live, { project: 'p' });
      const said = await nextPost(t);
      assert.equal(said.content, `Waiting for your OK in wisp: ${ask.question}`);
      assert.equal(said.components, undefined, 'no buttons for it');
      delete live.ask;
      live.state = 'review';
    }
  } finally {
    srv.store.config.remote.events = events;
  }
});

test('a subagent’s approval reaches the thread of the task it holds up, with no secret in it', async () => {
  const m = mention('report something', { channel: newRoom() });
  const t = await threadOf(m);
  await next(t);
  const s = await taskIn(t);
  await settled(s.id);
  await next(t);
  const token = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
  const child = srv.runner.create({ prompt: '', cwd: repo, agent: 'claude', parentId: s.id, member: 'helper' });
  try {
    srv.runner.ask(child, { question: 'Allow?', options: ['Allow', 'Deny'], permission: { tool: 'Bash', action: `run \`gh auth login ${token}\``, detail: `gh auth login ${token}` } });
    const said = await nextPost(t);
    assert.match(said.content, /^Waiting for your OK in wisp: gh auth login \[redacted/);
    assert.ok(!said.content.includes(token));
    assert.equal(said.components, undefined);
  } finally {
    delete child.ask;
    child.state = 'review';
  }
});

test('/wisp: acked at once, options make the same parse, the reply is edited, the task gets a thread', async () => {
  const c = newRoom();
  const phone = hub().phone;
  const real = phone.startParsed;
  let release;
  const held = new Promise((r) => (release = r));
  let entered = false;
  phone.startParsed = async (...a) => {
    entered = true;
    await held;
    return real(...a);
  };
  let d;
  try {
    d = slash('read the code', { project: name, model: 'sonnet', mode: 'edits' }, { channel: c });
    await until(() => entered, { what: 'the work, still going' });
    assert.equal((await callback(d)).type, 5, 'deferred, whatever the work takes');
    release();
    const reply = await edited(d);
    assert.equal(reply.content, '▶ On it.');
    const t = await until(() => fake.threads.find((x) => x.message === reply.id)?.id);
    assert.equal(await next(t), `▶ ${name} · Sonnet · Edits\n  Read the code`);
    const s = await taskIn(t);
    assert.deepEqual([s.model, s.mode], ['sonnet', 'edits']);
    await settled(s.id);
    assert.match(await next(t), /^✅ /);
    // /wisp in the thread is a follow-up, and needs no mention.
    const f = slash('one more thing', {}, { channel: t });
    assert.equal((await edited(f)).content, '✓ Sent');
    await until(async () => (await session(s.id)).turns.length === 2);
    await settled(s.id);
    await next(t);
  } finally {
    phone.startParsed = real;
  }
  const r = slash('in nope: anything', {}, { channel: c });
  assert.match((await edited(r)).content, /^No project “nope”\.\n\nNothing started\./);
  const f = slash('anything', { project: 'nope' }, { channel: c });
  assert.match((await edited(f)).content, /^No project “nope”/, 'an option goes through the same grammar');
});

test('/wisp never stays on “thinking”: a link held back, a throw, an edit that failed', async () => {
  const keep = ch().strangers;
  ch().strangers = new RateLimit({ max: 0 });
  try {
    const d = slash('link 000000', {}, { user: STRANGER_ID, channel: `D${STRANGER_ID}`, guild_id: undefined });
    assert.equal((await callback(d)).type, 5);
    assert.match((await edited(d)).content, /Too many tries/);
  } finally {
    ch().strangers = keep;
  }
  const phone = hub().phone;
  const real = phone.context;
  phone.context = async () => {
    throw new Error('/Users/someone/secret-project broke');
  };
  try {
    const d = slash('help', {}, { channel: newRoom() });
    const { content } = await edited(d);
    assert.match(content, /wisp hit an error/);
    assert.doesNotMatch(content, /secret-project/, 'others read this: only a fixed line');
  } finally {
    phone.context = real;
  }
  fake.fail('/messages/@original', { status: 500, body: { code: 0, message: 'Server error' } });
  const d = slash('help', {}, { channel: newRoom() });
  assert.match((await edited(d)).content, /wisp hit an error/, 'the failed edit is tried once more');
});

test('autocomplete: your own names for you, nothing for a stranger', async () => {
  const a = suggest('project', '');
  const got = (await callback(a));
  assert.equal(got.type, 8);
  assert.deepEqual(got.data.choices.map((x) => x.name).sort(), [name, web].sort());
  const f = suggest('project', web.slice(-4));
  assert.deepEqual((await callback(f)).data.choices.map((x) => x.value), [web]);
  const m = suggest('model', 'son');
  assert.ok((await callback(m)).data.choices.some((x) => x.value === 'sonnet'));
  const mc = suggest('machine', '');
  assert.deepEqual((await callback(mc)).data.choices.map((x) => x.value), ['here']);
  for (const field of ['project', 'crew', 'machine', 'model']) {
    const s = suggest(field, '', { user: STRANGER_ID });
    assert.deepEqual((await callback(s)).data, { choices: [] }, field);
  }
});

test('a DM: no thread, a reply to wisp’s message follows up, a plain message starts another', async () => {
  const chat = `D${ME}`;
  dm('fix the DM thing');
  const ack = await nextPost(chat);
  assert.equal(ack.content, `▶ ${name} · Claude Code · Plan\n  Fix the DM thing`, 'a DM shows the project');
  const s = await taskIn(chat);
  assert.equal(s.mode, 'plan', 'no mode asked for: Plan, whatever the launcher’s default');
  assert.equal(s.remote.discord.thread, false);
  await settled(s.id);
  const report = await nextPost(chat);
  assert.match(report.content, /Reply to this message to answer or follow up\./);
  assert.equal(report.message_reference?.message_id, ack.id, 'its report answers the task’s last message');
  await until(() => srv.store.get(s.id).remote.discord.ids.includes(report.id), { what: 'wisp to remember its report' }); // the fake has it before wisp hears back
  dm('with sonnet carry on', { type: 19, message_reference: { message_id: report.id } });
  assert.equal(await next(chat), '✓ Sent · Sonnet');
  await until(async () => (await session(s.id)).turns.length === 2);
  await settled(s.id);
  await next(chat);
  dm('also on the ack', { type: 19, message_reference: { message_id: ack.id } });
  assert.equal(await next(chat), '✓ Sent');
  await until(async () => (await session(s.id)).turns.length === 3);
  await settled(s.id);
  await next(chat);
  const n = srv.store.all().length;
  dm('a separate job');
  await next(chat);
  await until(() => srv.store.all().length === n + 1);
  const other2 = srv.store.all().at(-1);
  await settled(other2.id);
  await next(chat);
});

test('where no thread can be made: replies carry it', async () => {
  fake.noThreads = 50013;
  try {
    const c = newRoom();
    mention('without a thread', { channel: c });
    const ack = await nextPost(c);
    assert.match(ack.content, /^▶ /);
    const s = await taskIn(c);
    assert.equal(s.remote.discord.thread, false);
    await settled(s.id);
    await next(c);
    mention('carry on', { channel: c, type: 19, message_reference: { message_id: ack.id } });
    assert.equal(await next(c), '✓ Sent');
    await until(async () => (await session(s.id)).turns.length === 2);
    await settled(s.id);
    await next(c);
    mention('help', { channel: c }); // not a reply: nothing to do with the task
    await next(c);
  } finally {
    fake.noThreads = 0;
  }
});

test('in a task’s thread someone else’s thread isn’t the task’s, and a mention there runs in place', async () => {
  fake.noThreads = 50024;
  try {
    const t = newRoom();
    fake.threadChannels.add(t);
    mention('here in this thread', { channel: t });
    assert.match(await next(t), /^▶ /);
    const s = await taskIn(t);
    assert.equal(s.remote.discord.thread, true);
    await settled(s.id);
    await next(t);
  } finally {
    fake.noThreads = 0;
  }
});

test('a thread refused in a plain channel: the channel doesn’t become the task’s', async () => {
  const oneMore = async (c, what) => {
    const n = tasksIn(c).length;
    mention(what, { channel: c }); // not a reply, so a task of its own
    assert.match(await next(c), /^▶ /);
    await until(() => tasksIn(c).length === n + 1, { what: 'a task of its own' });
    const s = tasksIn(c).at(-1);
    await settled(s.id);
    await next(c);
    return s;
  };
  try {
    for (const code of [50024, 160004]) {
      fake.noThreads = code;
      const c = newRoom();
      const m = mention('in a plain channel', { channel: c });
      assert.match(await next(c), /^▶ /);
      const s = await taskIn(c);
      assert.equal(s.remote.discord.thread, false, String(code));
      assert.ok(s.remote.discord.ids.includes(m.id));
      await settled(s.id);
      await next(c);
      await oneMore(c, 'a second job');
      assert.equal(tasksIn(c).length, 2);
    }
    // Not knowing is the same as no: a thread would take every mention there.
    fake.noThreads = 50024;
    const c = newRoom();
    fake.fail('GET /channels/', { status: 500 });
    mention('nobody can say', { channel: c });
    assert.match(await next(c), /^▶ /);
    const s = await taskIn(c);
    assert.equal(s.remote.discord.thread, false);
    await settled(s.id);
    await next(c);
    // new in reply to one of its messages, in the same channel.
    fake.noThreads = 50013;
    mention('new from a reply', { channel: c, type: 19, message_reference: { message_id: s.remote.discord.ids[0] } });
    assert.match(await next(c), /^▶ /);
    await until(() => tasksIn(c).length === 2);
    const n = tasksIn(c).at(-1);
    assert.equal(n.remote.discord.thread, false, 'a reply isn’t a thread');
    await settled(n.id);
    await next(c);
    await oneMore(c, 'and this is its own');
  } finally {
    fake.noThreads = 0;
  }
});

test('stop, status, done, btw in a thread; stop keeps queued follow-ups; out of one, it says so', async () => {
  dm('stop');
  assert.equal(await next(`D${ME}`), 'Do that in a task’s thread, or as a reply to its message.');
  srv.store.config.defaults.followUp = 'queue';
  process.env.FAKE_DELAY = '30000';
  try {
    const m = mention('a long one', { channel: newRoom() });
    const t = await threadOf(m);
    await next(t);
    const s = await taskIn(t);
    await until(async () => (await session(s.id)).state === 'running');
    mention('and then this', { channel: t });
    assert.equal(await next(t), '✓ Queued for when it finishes');
    mention('status', { channel: t });
    assert.equal(await next(t), 'Working.', 'a guild keeps a title to wisp');
    mention('stop', { channel: t });
    assert.equal(await next(t), '■ Stopped. 1 queued follow-up kept: your next message carries them on.');
    await until(async () => (await session(s.id)).state !== 'running');
    assert.equal((await session(s.id)).queue.length, 1);
    delete process.env.FAKE_DELAY;
    await next(t); // its report
    mention('pick it up', { channel: t });
    await next(t);
    await until(async () => (await session(s.id)).turns.length >= 2);
    await settled(s.id);
    await until(() => inRoom(t).filter((p) => /Mention wisp here/.test(p.content)).length >= 2);
    read.set(t, inRoom(t).length);
    mention('btw what changed?', { channel: t });
    assert.match(await next(t), /Asking on the side/);
    assert.match(await next(t), /^btw: /);
    mention('done', { channel: t });
    assert.equal(await next(t), '✓ Marked done');
    assert.equal((await session(s.id)).state, 'done');
  } finally {
    delete process.env.FAKE_DELAY;
    srv.store.config.defaults.followUp = 'interrupt';
  }
});

test('in a DM lists are whole; in a guild others read them, so none of your names', async () => {
  for (const [text, re] of [
    ['help', /Say what you’d type in wisp/],
    ['projects', new RegExp(`• ${name}`)],
    ['models', /• claude: opus, sonnet, haiku/],
    ['machines', /• this computer · online/],
    ['crew', /./],
  ]) {
    dm(text);
    const got = await next(`D${ME}`);
    assert.match(got, re, text);
    assert.match(got.split('\n').at(-1), /^Try: /, text);
  }
  await api('/crew', { body: { name: 'Ada', role: 'CI watcher', brief: 'Watch CI.', cwd: repo, agent: 'claude', model: 'sonnet', mode: 'auto', parallel: 2 } });
  srv.store.config.machines = [...(srv.store.config.machines || []), { id: 'm1', name: 'secretbox', target: 'x' }];
  const leaks = (body) => [name, web, repo, 'secretbox'].filter((x) => body.includes(x));
  const c = newRoom();
  try {
    for (const word of ['projects', 'crew', 'machines', 'models']) {
      mention(word, { channel: c });
      assert.equal(await next(c), 'That list isn’t shown here: see it in wisp, or ask in a DM.', word);
    }
    mention('help', { channel: c });
    const help = await next(c);
    assert.match(help, /Try: plan: fix the flaky test/);
    assert.deepEqual(leaks(help), []);
    mention('status', { channel: c });
    assert.match(await next(c), /^\d+ running, \d+ waiting: see them in wisp\.$/);
    for (const [text, re] of [
      ['in nope: fix it', /^No project “nope”\.\n\nNothing started\./],
      ['on secr: fix it', /^… is offline\.\n\nNothing started\./],
      [`@ada in ${web}: fix it`, /^Ada works in …: a job can’t move them to /],
    ]) {
      mention(text, { channel: c });
      const body = await next(c);
      assert.match(body, re, text);
      assert.doesNotMatch(body, /Choices:/, text);
      assert.deepEqual(leaks(body).filter((x) => !text.includes(x)), [], text);
    }
    const m = mention('fix something', { channel: c });
    const t = await threadOf(m);
    assert.equal(await next(t), '▶ Claude Code · Plan\n  Fix something', 'the ack hides the default project');
    await settled((await taskIn(t)).id);
    await next(t);
    dm('in nope: fix it');
    assert.match(await next(`D${ME}`), new RegExp(`Choices: .*${name}`), 'a DM keeps them');
  } finally {
    srv.store.config.machines = srv.store.config.machines.filter((x) => x.id !== 'm1');
  }
});

test('a crew member: Plan by default, a report under their name; a mention in a thread', async () => {
  const m = mention('@ada check the deploy', { channel: newRoom() });
  const t = await threadOf(m);
  assert.match(await next(t), /^▶ Ada has it · Sonnet · Plan\n  Check the deploy/);
  const job = await taskIn(t);
  assert.equal(job.mode, 'plan', 'their own Full auto doesn’t reach a job from here');
  assert.equal(job.remote.by, 'Ada');
  await settled(job.id);
  assert.match(await next(t), /^Ada: ✅ /);

  const a = mention('a task to ask about', { channel: newRoom() });
  const at = await threadOf(a);
  await next(at);
  const s = await taskIn(at);
  await settled(s.id);
  await next(at);
  mention('@ada look at this', { channel: at });
  assert.match(await next(at), /^▶ Ada has it/);
  assert.match(await next(at), /^Ada: /);
  mention('carry on', { channel: at });
  assert.equal(await next(at), '✓ Sent');
  await until(async () => (await session(s.id)).turns.length === 2);
  assert.match((await session(s.id)).turns[1].prompt, /carry on/, 'the task it was on, not the job that answered');
  await settled(s.id);
  await next(at);
});

test('a stranger in a guild: silence, by id and not by name, and no answer to /wisp', async () => {
  const c = newRoom();
  const count = srv.store.all().length;
  mention('run this for me', { user: STRANGER_ID, channel: c, author: { id: STRANGER_ID, username: 'me', global_name: 'mokh' } });
  const d = slash('run this too', {}, { user: STRANGER_ID, channel: c });
  await caughtUp(c);
  assert.equal(inRoom(c).length, 1, 'only the answer to the last message');
  assert.equal(fake.callbacks.filter((x) => x.id === d.id).length, 0, 'no answer, so nothing others can see');
  assert.equal(srv.store.all().length, count);
});

test('bots, webhooks, itself, system messages, and guild messages that don’t mention it', async () => {
  const c = newRoom();
  mention('from a bot', { channel: c, author: { id: ME, bot: true } });
  mention('from a webhook', { channel: c, webhook_id: 'W1' });
  mention('from itself', { channel: c, user: BOT });
  mention('a pin', { channel: c, type: 6 });
  fake.message({ content: 'no mention, no text to read', channel_id: c, author: author() });
  fake.message({ content: '@everyone look', channel_id: c, mention_everyone: true, author: author() });
  await caughtUp(c);
  assert.equal(inRoom(c).length, 1);
  assert.deepEqual(fake.threads.filter((t) => t.channel === c), [], 'no task either');

  const own = `D${BOT}`;
  dm('my own report', { user: BOT, channel: own });
  dm('a bot', { channel: own, author: { id: STRANGER_ID, bot: true } });
  dm('help', { channel: own });
  assert.match(await next(own), /Say what you’d type/, 'no stranger’s line to itself or a bot');
  assert.equal(inRoom(own).length, 1);
});

test('duplicates: a message or a slash command delivered twice runs once', async () => {
  const c = newRoom();
  const m = mention('only once', { channel: c });
  const t = await threadOf(m);
  await next(t);
  const s = await taskIn(t);
  await settled(s.id);
  await next(t);
  fake.dispatch('MESSAGE_CREATE', m);
  await caughtUp(c);
  assert.equal(srv.store.all().filter((x) => x.turns[0]?.prompt.includes('only once')).length, 1);
  const d = slash('help', {}, { channel: c });
  await edited(d);
  fake.dispatch('INTERACTION_CREATE', d);
  await caughtUp(c);
  assert.equal(fake.callbacks.filter((x) => x.id === d.id).length, 1);
});

test('stale, by the snowflake: told and not run', async () => {
  const count = srv.store.all().length;
  const c = `D${ME}`;
  const old = Date.now() - (STALE_S + 60) * 1000;
  dm('from a while ago', { id: snowflake(old), timestamp: new Date().toISOString() });
  assert.match(await next(c), /^That arrived while wisp was offline, so it didn’t run\./);
  assert.equal(srv.store.all().length, count);
  assert.ok(Math.abs(snowflakeMs(snowflake(old)) - old) < 2);
});

test('a burst is told once, then silence', async () => {
  const keep = ch().limit;
  ch().limit = new RateLimit({ max: 1 });
  const c = newRoom();
  try {
    mention('help', { channel: c });
    await next(c);
    mention('help', { channel: c });
    assert.match(await next(c), /^That’s a lot of messages/);
    mention('help', { channel: c });
    ch().limit = keep;
    await caughtUp(c);
  } finally {
    ch().limit = keep;
  }
});

test('Full auto is refused and nothing starts; Edits is the most; a follow-up is held to it', async () => {
  const wiped = () => srv.store.all().filter((s) => s.turns[0]?.prompt.includes('wipe it'));
  const c = newRoom();
  mention('full auto: wipe it', { channel: c });
  assert.equal(await next(c), 'Full auto isn’t allowed from here. The most this chat can ask for is Edits.\n\nNothing started.');
  const d = slash('full auto: wipe it', {}, { channel: c });
  assert.match((await edited(d)).content, /Full auto isn’t allowed/);
  const f = slash('wipe it', { mode: 'full auto' }, { channel: c });
  assert.match((await edited(f)).content, /Full auto isn’t allowed/, 'a forged option too');
  assert.deepEqual(wiped(), []);
  const m = mention('edits: small fix', { channel: c });
  const t = await threadOf(m);
  assert.match(await next(t), /· Edits\n  Small fix/);
  const s = await taskIn(t);
  assert.equal(s.mode, 'edits');
  await settled(s.id);
  await next(t);
  mention('full auto: and now wipe it', { channel: t });
  assert.match(await next(t), /Full auto isn’t allowed from here/);
  assert.equal((await session(s.id)).turns.length, 1);
  srv.store.get(s.id).mode = 'auto'; // switched in wisp meanwhile
  mention('carry on', { channel: t });
  await next(t);
  await until(async () => (await session(s.id)).turns.length === 2);
  assert.equal((await session(s.id)).mode, 'edits', 'a message can’t carry a task on in Full auto');
  await settled(s.id);
  await next(t);
});

async function reported(blocks, title = 'A title', arm = () => {}) {
  const chat = `D${ME}`;
  dm('report something');
  await next(chat);
  const s = await taskIn(chat).then(() => srv.store.all().at(-1));
  await settled(s.id);
  await next(chat);
  const live = srv.store.get(s.id);
  live.title = title;
  live.turns.at(-1).presentation = { blocks };
  arm();
  await srv.remote.notify(live, { project: 'p' });
  return nextPost(chat);
}

test('what leaves: a secret goes, nobody is pinged, a link shows itself, no embed, and it fits', async () => {
  const token = `ghp_${'a1B2'.repeat(10)}`;
  const post = await reported([{ type: 'hero', status: 'done', title: 'Agent’s title', summary: `Found ${token} @everyone @here <@111> <@&222> <#333> [click here](https://evil.example/?d=1) [also](<https://evil.example>)` }], `Title ${token}`);
  const text = post.content;
  assert.ok(!text.includes(token), text);
  assert.match(text, /wisp took a secret out of this message/);
  assert.doesNotMatch(text, /(^|\s)@(everyone|here)\b/);
  assert.doesNotMatch(text, /<@|<#/, 'no live mention');
  assert.doesNotMatch(text, /\]\(/, 'no masked link');
  assert.match(text, /https:\/\/evil\.example/, 'it shows what it is');
  assert.deepEqual(post.allowed_mentions, { parse: [] });
  assert.equal(post.flags & 4, 4, 'no embed');
  const big = await reported([{ type: 'hero', status: 'done', title: 'T', summary: 'x'.repeat(20000) }]);
  assert.ok(big.content.length <= 2000, String(big.content.length));
});

test('a report past the limit gives way in its middle: the title, the secret note and how to answer stay', async () => {
  const token = `ghp_${'a1B2'.repeat(10)}`;
  const post = await reported([{ type: 'hero', status: 'done', title: 'T', summary: `${token} ${'x '.repeat(3000)}` }], 'The title');
  assert.ok(post.content.length <= 2000, String(post.content.length));
  assert.match(post.content, /The title/);
  assert.match(post.content, /x …\n\n\(wisp took a secret out of this message: open the task in wisp to see it\.\)\n\nReply to this message to answer or follow up\.$/);
  assert.ok(!post.content.includes(token));
  assert.ok(post.components?.length, 'its buttons too');
});

test('a plain answer with no hero is the report, through the hub', async () => {
  const post = await reported([{ type: 'markdown', text: 'The plain answer is 42.' }]);
  assert.match(post.content, /The plain answer is 42\./);
  assert.doesNotMatch(post.content, /Ready for review/);
});

test('buttons an agent’s long labels break: Discord refuses them, and the words still go', async () => {
  const post = await reported([{ type: 'hero', status: 'done', title: 'T', summary: 'S' }, { type: 'question', question: 'Which?', options: ['One', 'Two'] }], 'A title', () => fake.fail('POST /channels', { status: 400, body: { code: 50035, message: 'Invalid Form Body' } }));
  assert.equal(post.components, undefined);
  assert.match(post.content, /Which\?/);
});

test('a button that starts a turn: yes on a task in Edits, no on one in Full auto, where only words are capped', async () => {
  const chat = `D${ME}`;
  const question = [{ type: 'hero', status: 'done', title: 'T', summary: 'S' }, { type: 'question', question: 'Which?', options: ['One', 'Two'] }];
  const q = await reported(question);
  const s = srv.store.all().at(-1);
  const custom_id = q.components[0].components[0].custom_id;
  const pressInDm = () => fake.interact({ type: 3, data: { custom_id }, user: author(), channel_id: chat, guild_id: undefined });
  srv.store.get(s.id).mode = 'auto'; // switched in wisp meanwhile
  pressInDm();
  assert.equal(await next(chat), 'Say that in words here, so it runs in Edits at most.');
  assert.equal((await session(s.id)).turns.length, 1);
  srv.store.get(s.id).mode = 'edits';
  pressInDm();
  assert.match(await next(chat), /^✓ Sent/);
  await until(async () => (await session(s.id)).turns.length === 2);
  await settled(s.id);
  await next(chat);
});

test('reports: only tasks started here, whatever the Phone events say; a task from wisp posts nothing', async () => {
  const events = srv.store.config.remote.events;
  srv.store.config.remote.events = [];
  try {
    const m = mention('with the events off', { channel: newRoom() });
    const t = await threadOf(m);
    await next(t);
    await settled((await taskIn(t)).id);
    assert.match(await next(t), /^✅ /);
  } finally {
    srv.store.config.remote.events = events;
  }
  const before = fake.posts.length;
  const s = await api('/sessions', { body: { prompt: 'plain task', cwd: repo, agent: 'claude', worktree: false } });
  await settled(s.id);
  const out = await srv.crew.checkin(srv.crew.find('ada'), { unattended: true });
  await settled(out.session.id);
  await srv.remote.notify(srv.store.get(s.id), { project: 'p' });
  await srv.remote.notify(srv.store.get(out.session.id), { project: 'p' });
  assert.equal(fake.posts.length, before, 'nothing about them');
});

test('heartbeats carry the sequence number, and Discord can ask for one', async () => {
  await connected();
  const n = fake.beats.length;
  await until(() => fake.beats.length >= n + 3, { what: 'heartbeats' });
  assert.ok(fake.beats.at(-1) > 0, 'with the last seq');
  // On a long interval, so a beat now can only be the answer to Discord's ask.
  fake.heartbeat = 3_600_000;
  const r = fake.resumes.length;
  fake.op(7);
  await until(() => fake.resumes.length > r);
  await connected();
  const sent = fake.beats.length;
  fake.op(1);
  await until(() => fake.beats.length > sent, { what: 'a beat on request' });
  fake.heartbeat = 20;
  const again = fake.resumes.length;
  fake.op(7);
  await until(() => fake.resumes.length > again);
  await connected();
});

test('an unacked heartbeat ends the connection, and it resumes where it was', async () => {
  await connected();
  const r = fake.resumes.length;
  const ids = fake.identifies.length;
  fake.deaf = true;
  await until(() => fake.resumes.length > r || fake.sockets.size === 0, { what: 'the socket to be given up on' });
  fake.deaf = false;
  await until(() => fake.resumes.length > r, { what: 'a resume' });
  await connected();
  assert.equal(fake.identifies.length, ids, 'no new session');
  assert.match(fake.resumes.at(-1).session_id, /^session-/);
  assert.equal(fake.resumes.at(-1).token, TOKEN);
});

test('a dropped socket: what was said meanwhile is replayed on resume', async () => {
  await connected();
  const r = fake.resumes.length;
  fake.drop();
  const c = newRoom();
  mention('help', { channel: c }); // nobody's connected: it waits in Discord
  await until(() => fake.resumes.length > r, { what: 'a resume' });
  assert.match(await next(c), /Say what you’d type/);
  await connected();
});

test('op 7: a new socket at once, and a resume', async () => {
  await connected();
  const r = fake.resumes.length;
  fake.op(7);
  await until(() => fake.resumes.length > r);
  assert.ok(fake.closes.includes(4000), 'closed so the session stays');
  await connected();
});

test('op 9: resumable resumes, not resumable identifies, and identifies keep their distance', async () => {
  await connected();
  const r = fake.resumes.length;
  fake.op(9, true);
  await until(() => fake.resumes.length > r);
  await connected();
  hub().discordIdentifyMs = 400;
  ch().identifiedAt = Date.now();
  const started = Date.now();
  const ids = fake.identifies.length;
  fake.op(9, false);
  await until(() => fake.identifies.length > ids, { what: 'a new identify' });
  assert.ok(Date.now() - started >= 380, `${Date.now() - started} ms`);
  hub().discordIdentifyMs = 0;
  await connected();
});

test('a session Discord won’t resume starts over; so does a close that ends it', async () => {
  await connected();
  ch().session.id = 'stale-session';
  const ids = fake.identifies.length;
  fake.drop();
  await until(() => fake.identifies.length > ids, { what: 'a new identify after op 9' });
  await connected();
  const more = fake.identifies.length;
  fake.close(4009);
  await until(() => fake.identifies.length > more);
  await connected();
});

test('a socket that never says hello is given up on', async () => {
  await connected();
  const keep = hub().discordHelloMs;
  hub().discordHelloMs = 30;
  try {
    const n = fake.connects;
    fake.silent = true;
    fake.drop();
    await until(() => fake.connects >= n + 2, { what: 'a second try after no hello' });
    fake.silent = false;
    await connected();
  } finally {
    fake.silent = false;
    hub().discordHelloMs = keep;
  }
});

test('a resume URL that’s gone: a few tries, then a new session', async () => {
  await connected();
  const ids = fake.identifies.length;
  ch().session.url = `ws://127.0.0.1:${await freePort()}/gone`;
  fake.drop();
  await until(() => fake.identifies.length > ids, { what: 'an identify on the gateway’s own URL' });
  await connected();
});

test('saving settings: the old socket closing late leaves the new connection alone', async () => {
  // Beats too far apart to end a socket on a busy machine: only the old one may go here.
  fake.heartbeat = 60_000;
  try {
    const was = fake.connects;
    fake.drop();
    await until(() => fake.connects > was, { what: 'a calm socket' });
    await connected();
    const started = fake.identifies.length + fake.resumes.length;
    fake.slowClose = true;
    await api('/remote', { method: 'PUT', body: { discord: { enabled: true } } });
    await until(() => fake.sockets.size === 2 && fake.identifies.length + fake.resumes.length > started, { what: 'the new connection' });
    await connected();
    await until(() => fake.sockets.size === 1, { what: 'the old socket to give up' });
    assert.equal((await api('/remote')).discord.connected, true);
    assert.ok(ch().session, 'and its session stays');
  } finally {
    fake.slowClose = false;
    fake.heartbeat = 20;
    const back = fake.resumes.length + fake.identifies.length;
    fake.drop();
    await until(() => fake.resumes.length + fake.identifies.length > back, { what: 'the usual socket' });
    await connected();
  }
});

test('fatal close codes stop it and say what to do; saving settings starts it again', async () => {
  for (const [code, re] of [
    [4004, /Discord refused the token/],
    [4010, /shard/],
    [4011, /too many servers/],
    [4012, /gateway version/],
    [4013, /intents/],
    [4014, /intents/],
  ]) {
    await connected();
    fake.close(code);
    const v = await until(async () => {
      const x = await api('/remote');
      return re.test(x.discord.error) ? x : null;
    }, { what: `the words for ${code}` });
    assert.equal(v.discord.connected, false);
    const calls = fake.calls.length;
    const beats = fake.identifies.length + fake.resumes.length;
    await sleep(120);
    assert.deepEqual([fake.calls.length, fake.identifies.length + fake.resumes.length], [calls, beats], 'it doesn’t try again');
    await api('/remote', { method: 'PUT', body: { discord: { enabled: true } } });
  }
  await connected();
});

test('a new token drops what went wrong with the last one', async () => {
  await connected();
  const { senders } = srv.store.config.remote.discord;
  fake.close(4004);
  await until(async () => /refused the token/.test((await api('/remote')).discord.error), { what: 'the refusal' });
  fake.silent = true; // connected or not, the view right after the save has no old error
  const put = await api('/remote', { method: 'PUT', body: { discord: { token: 'new.token.here' } } });
  assert.deepEqual([put.discord.error, put.discord.appId, put.discord.invite, put.status.discord], ['', '', '', null]);
  fake.silent = false;
  await api('/remote', { method: 'PUT', body: { discord: { token: TOKEN } } });
  srv.store.config.remote.discord.senders = senders; // a new token unlinks; the next tests are linked
  await connected();
});

test('a 429: the post waits Retry-After and still goes; a global one holds every route', async () => {
  await connected();
  const c = newRoom();
  fake.fail('POST /channels', { status: 429, headers: { 'retry-after': '1' }, body: { message: 'slow', retry_after: 0.3, global: false } });
  const t0 = Date.now();
  mention('help', { channel: c });
  assert.match(await next(c), /Say what you’d type/);
  assert.ok(Date.now() - t0 >= 280, `${Date.now() - t0} ms`);

  const g = newRoom();
  fake.fail('POST /channels', { status: 429, headers: { 'x-ratelimit-global': 'true' }, body: { message: 'slow', retry_after: 0.4, global: true } });
  ch().globalUntil = 0;
  mention('help', { channel: g });
  await until(() => ch().globalUntil > 0, { what: 'the global limit' });
  const open = ch().globalUntil;
  const d = slash('help', {}, { channel: newRoom() }); // another route altogether
  await next(g);
  await callback(d);
  const held = fake.calls.find((x) => x.route.includes(`/interactions/${d.id}/`));
  assert.ok(held.at >= open - 5, `${open - held.at} ms early`);
});

test('a bucket at zero waits for its reset without being told twice', async () => {
  const c = newRoom();
  fake.fail('POST /channels', { status: 200, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '0.4' }, body: { id: '1' } });
  mention('help', { channel: c });
  await until(() => ch().paused.size > 0, { what: 'the bucket to close' });
  const t0 = Date.now();
  mention('help', { channel: c });
  assert.match(await next(c), /Say what you’d type/);
  assert.ok(Date.now() - t0 >= 300, `${Date.now() - t0} ms`);
});

test('a 429 on the gateway URL, and no sessions left today, both wait', async () => {
  await connected();
  ch().session = null;
  const seen = () => fake.calls.filter((x) => x.route === 'GET /gateway/bot').map((x) => x.at);
  const before = seen().length;
  fake.fail('GET /gateway/bot', { status: 429, body: { retry_after: 0.3 } });
  fake.drop();
  await until(() => seen().length >= before + 2, { what: 'a second try' });
  const [a, b] = seen().slice(before);
  assert.ok(b - a >= 280, `${b - a} ms`);
  await connected();

  ch().session = null;
  const after = seen().length;
  fake.limit = { total: 1000, remaining: 0, reset_after: 300, max_concurrency: 1 };
  fake.drop();
  await until(() => seen().length > after);
  fake.limit = null;
  await until(() => seen().length > after + 1, { what: 'a try after the reset' });
  const [x, y] = seen().slice(after);
  assert.ok(y - x >= 280, `${y - x} ms`);
  await connected();
});

test('a revoked token stops it, says what to do, and a new one starts over; no token in any error', async () => {
  await connected();
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    fake.revoked = true;
    ch().session = null;
    fake.drop();
    const v = await until(async () => {
      const x = await api('/remote');
      return /Check the token/.test(x.discord.error) ? x : null;
    });
    assert.equal(v.discord.connected, false);
    const n = fake.calls.length;
    await sleep(150);
    assert.equal(fake.calls.length, n, 'it doesn’t hammer a dead token');
    fake.revoked = false;
    fake.token = 'MTEx.second-part.new-secret';
    const put = await api('/remote', { method: 'PUT', body: { discord: { token: fake.token } } });
    assert.equal(put.discord.senders, 0, 'a new bot token unlinks everyone');
    await connected();
    assert.equal((await api('/remote')).discord.error, '');
    assert.ok(!JSON.stringify(warned).includes('secret'), warned.join());
    srv.store.config.remote.discord.senders = [ME];
  } finally {
    console.warn = warn;
  }
});

test('the application id: READY always says, an interaction’s own id answers it, a new token forgets the old', async () => {
  await connected();
  const c = srv.store.config.remote.discord;
  c.appId = '777777';
  const d = slash('help', {}, { channel: newRoom() });
  assert.equal((await edited(d)).app, fake.appId, 'the interaction’s id, not what was saved');
  const ids = fake.identifies.length;
  fake.close(4009);
  await until(() => fake.identifies.length > ids);
  await connected();
  assert.equal(c.appId, fake.appId, 'READY overwrites');

  const [token, app] = [fake.token, fake.appId];
  fake.token = 'MTEx.third-part.another-secret';
  fake.appId = '666666';
  try {
    fake.revoked = true; // so READY can't refill it before it's read
    const put = await api('/remote', { method: 'PUT', body: { discord: { token: fake.token } } });
    assert.equal(put.discord.appId, '', 'another bot, another application');
    await until(async () => /Check the token/.test((await api('/remote')).discord.error));
    fake.revoked = false;
    await api('/remote', { method: 'PUT', body: { discord: { enabled: true } } });
    await connected();
    assert.equal((await api('/remote')).discord.appId, '666666');
    await until(() => fake.commands.some((x) => x.app === '666666'), { what: '/wisp on the new application' });
  } finally {
    fake.token = token;
    fake.appId = app;
    fake.revoked = false;
    await api('/remote', { method: 'PUT', body: { discord: { token } } });
    srv.store.config.remote.discord.senders = [ME];
    await connected();
  }
});

test('a restart: linked people stay, a queued crew job answers in its thread', async () => {
  await connected();
  const z = await api('/crew', { body: { name: 'Zed', brief: 'Watch.', cwd: repo, agent: 'claude', model: 'sonnet', mode: 'edits', parallel: 1 } });
  process.env.FAKE_DELAY = '30000';
  const m = mention('@zed the long job', { channel: newRoom() });
  const t = await threadOf(m);
  await next(t);
  const q = mention('@zed the queued job', { channel: newRoom() });
  const qt = await threadOf(q);
  assert.match(await next(qt), /^▶ Zed has it \(queued, 1 ahead\)/);
  assert.equal(srv.crew.get(z.id).queue[0].thread.chat, qt);
  srv.store.saveConfig();
  halt();
  delete process.env.FAKE_DELAY;
  await boot();
  await connected();
  assert.equal((await api('/remote')).discord.senders, 1);
  await srv.crew.tick();
  const job = await taskIn(qt);
  assert.equal(job.remote.by, 'Zed');
  await settled(job.id);
  assert.match(await next(qt), /^Zed: /);
});

test('a task on another machine keeps its thread across a restart: it reports, and a mention follows up', async () => {
  const id = 'abc@m1';
  const t = newRoom();
  hub().markStarted(id, 'discord', 'Ada');
  ch().threadStarted({ id }, { channel: 'discord', chat: t, thread: true, ids: [] }, { name: 'Ada' });
  const disk = JSON.parse(fs.readFileSync(path.join(process.env.WISP_HOME, 'config.json'), 'utf8'));
  assert.equal(disk.remote.discord.away[id].discord.channel, t, 'on disk at once');
  await api('/remote', { method: 'PUT', body: { discord: { enabled: true } } });
  assert.ok(srv.store.config.remote.discord.away[id], 'a settings change keeps it');
  halt();
  await boot();
  await connected();
  assert.equal(hub().startedFrom({ id }).channel, 'discord');
  const turns = [{ id: 't1', status: 'done', presentation: { blocks: [{ type: 'hero', status: 'done', title: 'From away', summary: 'Done over there' }] } }];
  await hub().notify({ id, state: 'review', title: 'Away task', turns }, { project: 'p' });
  assert.match(await next(t), /^Ada: ✅ p: Away task[\s\S]*Done over there/);
  const sent = [];
  srv.machines.json = async (mid, method, p, body) => {
    if (method === 'GET') return { id: 'abc', agent: 'claude', state: 'review', mode: 'plan', title: 'Away task', turns };
    sent.push({ p, body });
    return { queued: false };
  };
  srv.machines.session = (mid, s) => ({ ...s, id: `${s.id}@${mid}` });
  const count = srv.store.all().length;
  mention('and the next thing', { channel: t });
  assert.equal(await next(t), '✓ Sent');
  assert.equal(sent[0].p, '/sessions/abc/reply');
  assert.equal(srv.store.all().length, count, 'not another task');
});

test('telemetry: counts only, never what was said', async () => {
  const seen = [];
  const real = srv.telemetry.track;
  srv.telemetry.track = (event, props) => (event === 'channel_event' ? seen.push(props) : 0, real.call(srv.telemetry, event, props));
  try {
    const m = mention('a secret plan about telemetry', { channel: newRoom() });
    const t = await threadOf(m);
    await next(t);
    await settled((await taskIn(t)).id);
    await next(t);
  } finally {
    srv.telemetry.track = real;
  }
  assert.deepEqual(seen.filter((p) => p.kind !== 'report').map((p) => [p.kind, p.detail]), [['start', 'plain']]);
  assert.ok(!JSON.stringify(seen).includes('secret plan'));
});

test('every post in this file set allowed_mentions empty and held no embed', () => {
  assert.ok(fake.posts.length > 50);
  for (const p of [...fake.posts, ...fake.edits.filter((e) => e.content !== undefined)]) {
    assert.deepEqual(p.allowed_mentions, { parse: [] }, p.content);
    assert.equal(p.flags & 4, 4, p.content);
  }
});

test('a post whose connection broke goes again, and a 429 still waits Retry-After', async () => {
  const n = fake.posts.length;
  fake.sever('POST /channels/C9/messages');
  await ch().rest('POST', '/channels/C9/messages', { content: 'once' });
  assert.equal(fake.posts.length, n + 1);
  fake.sever('POST /channels/C9/messages');
  await assert.rejects(ch().rest('POST', '/channels/C9/messages', { content: 'one try' }, { tries: 1 }));
  assert.equal(fake.posts.length, n + 1, 'tries: 1 means one');
  fake.sever('POST /channels/C9/messages');
  await ch().rest('POST', '/channels/C9/messages', { content: 'cut, then limited' }, { tries: 2 }).catch(() => {});
  fake.fail('POST /channels/C9/messages', { status: 429, body: { retry_after: 0.05 } });
  const t = Date.now();
  await ch().rest('POST', '/channels/C9/messages', { content: 'waits' });
  assert.ok(Date.now() - t >= 40, 'Retry-After was kept');
});

test('a first reply that doesn’t get out is kept, and goes ahead of the report', async () => {
  const c = `D${ME}`;
  await caughtUp(c);
  const at = inRoom(c).length;
  fake.fail(`POST /channels/${c}/messages`, { status: 500, body: { message: 'down' } });
  dm(`in ${web} plan: note the thing`, { channel: c });
  const report = await until(() => inRoom(c).slice(at).find((p) => /Reply to this message to answer or follow up\./.test(p.content)), { what: 'the report' });
  const said = inRoom(c).slice(at);
  assert.equal(said.length, 2, said.map((p) => p.content).join(' | '));
  assert.equal(said[1], report, 'the owed first reply went first');
  read.set(c, inRoom(c).length);
  await settled((await taskIn(c)).id).catch(() => {});
});

test('unlinking: everyone goes, a new code, and they’re strangers again; off closes cleanly', async () => {
  const before = (await api('/remote')).discord.linkCode;
  const v = await api('/remote', { method: 'PUT', body: { discord: { unlink: true } } });
  assert.equal(v.discord.senders, 0);
  assert.notEqual(v.discord.linkCode, before);
  await connected();
  dm('hello');
  assert.match(await next(`D${ME}`), /^This wisp only answers/);
  const off = await api('/remote', { method: 'PUT', body: { discord: { enabled: false } } });
  assert.equal(off.discord.enabled, false);
  await until(() => fake.sockets.size === 0, { what: 'the socket to close' });
  assert.equal(fake.closes.at(-1), 1000);
  assert.equal(srv.remote.on, false);
});

test('the pure parts', () => {
  assert.equal(slashText({ prompt: 'fix it' }), 'fix it');
  assert.equal(slashText({ prompt: 'fix it', crew: 'ada', project: 'api', machine: 'laptop', model: 'opus', mode: 'plan' }), '@ada in api on laptop with opus plan: fix it');
  const s = (t, o) => stripFormatting(t, 'discord', o);
  assert.equal(s('<@900> in api fix it', { bot: '900' }), 'in api fix it');
  assert.equal(s('<@!900>: fix it', { bot: '900' }), 'fix it');
  assert.equal(s('hey <@900> fix it', { bot: '900' }), 'hey fix it');
  assert.equal(s('<@1> look', { bot: '900' }), '<@1> look');
  assert.equal(s('see <https://a.dev/x>'), 'see https://a.dev/x');
  assert.equal(discordText('[a](b)'), '[a]\\(b)');
  assert.equal(discordText('x'.repeat(5000)).length, 2000);
  const noted = discordText(`ghp_${'a1B2'.repeat(10)} ${'x'.repeat(5000)}`);
  assert.ok(noted.length <= 2000);
  assert.match(noted, /…\n\n\(wisp took a secret out of this message/);
  assert.equal(discordText('short', 'the end'), 'short\n\nthe end');
  assert.equal(discordText('', 'the end'), 'the end');
  const ended = discordText('y'.repeat(5000), `@everyone [a](b) ghp_${'a1B2'.repeat(10)}`);
  assert.ok(ended.length <= 2000);
  assert.match(ended, /@\u200beveryone \[a\]\\\(b\) \[redacted: a GitHub token\]$/, 'the ending leaves as safely as the rest');
});

// --- on a cloud computer: no socket, and the grid's edge answers first ----------------------------

const keypair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, hex: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex') };
};
const keys = keypair();
const signedBy = (privateKey, raw) => {
  const ts = String(Math.floor(Date.now() / 1000));
  return { 'x-signature-ed25519': sign(null, Buffer.from(ts + raw), privateKey).toString('hex'), 'x-signature-timestamp': ts };
};
// Discord's HTTP call, as the grid delivers it.
const held = (d, privateKey = keys.privateKey) => {
  const raw = JSON.stringify(d);
  return ch().inbound(Buffer.from(raw), signedBy(privateKey, raw));
};
const command = (user, prompt, o = {}) => fake.interaction({ type: 2, member: { user: { id: user } }, data: { name: 'wisp', options: [{ name: 'prompt', value: prompt }] }, channel: { type: 0 }, ...o });
const inDm = (user, prompt, o = {}) => command(user, prompt, { guild_id: undefined, member: undefined, user: { id: user }, channel_id: `D${user}`, channel: { type: 1 }, ...o });
const box = { keys: [], linked: [], dropped: 0, hub: true, url: 'https://ada.grid.example/_in/the-inbox-token' };
const fakeGrid = http.createServer(async (req, res) => {
  let t = '';
  for await (const c of req) t += c;
  const url = new URL(req.url, 'http://x');
  const send = (status, o) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  if (!box.hub) return send(404, { error: 'not found' });
  if (req.headers.authorization !== 'Box ada box-secret') return send(401, { error: 'no' });
  if (url.pathname === '/api/channels/url/key') {
    box.keys.push(JSON.parse(t).key);
    box.linked.push(JSON.parse(t).linked);
    return send(200, { ok: true });
  }
  if (url.pathname === '/api/channels/url/rotate') {
    box.url = 'https://ada.grid.example/_in/the-next-token';
    return send(200, { url: box.url });
  }
  const dropped = box.dropped;
  box.dropped = 0;
  send(200, { url: box.url, dropped });
});
const warned = [];
const warn = console.warn;

test('a cloud computer: set up by paste, a bad key refused, no gateway, /wisp registered by REST once', async () => {
  await api('/remote', { method: 'PUT', body: { discord: { enabled: false, token: '' } } });
  fake.token = TOKEN; // earlier tests moved it on
  fake.verifyKey = keys.hex;
  await new Promise((r) => fakeGrid.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { WISP_GRID_URL: `http://127.0.0.1:${fakeGrid.address().port}`, WISP_TRUSTED_PROXY_SECRET: 'box-secret', WISP_PUBLIC_URL: 'https://ada.grid.example' });
  console.warn = (...a) => {
    warned.push(a.join(' '));
    warn(...a);
  };
  await assert.rejects(api('/remote', { method: 'PUT', body: { discord: { publicKey: 'abc' } } }), /64 hex/);
  await assert.rejects(api('/remote', { method: 'PUT', body: { discord: { publicKey: 'z'.repeat(64) } } }), /64 hex/);
  const connects = fake.connects;
  const identifies = fake.identifies.length;
  const gateway = fake.calls.filter((c) => c.route === 'GET /gateway/bot').length;
  const cmds = fake.commands.length;
  await api('/remote', { method: 'PUT', body: { discord: { enabled: true, token: TOKEN } } });
  assert.equal(ch().ready, false, 'no key yet');
  const v = await api('/remote', { method: 'PUT', body: { discord: { publicKey: keys.hex.toUpperCase() } } });
  assert.equal(v.discord.publicKey, keys.hex);
  const up = await until(async () => {
    const x = (await api('/remote')).discord;
    return x.connected && x.endpoint ? x : null;
  }, { what: 'the box connected' });
  assert.deepEqual([up.box, up.bot, up.endpoint, up.appId, up.guilds], [true, 'wisp', box.url, fake.appId, 2]);
  assert.equal(box.keys.at(-1), keys.hex, 'the grid has the key');
  await until(() => fake.commands.length === cmds + 1, { what: '/wisp registered' });
  assert.deepEqual(fake.commands.at(-1).body, [slashCommand()]);
  assert.equal(fake.connects, connects, 'no socket');
  assert.equal(fake.identifies.length, identifies);
  assert.equal(fake.calls.filter((c) => c.route === 'GET /gateway/bot').length, gateway);
  hub().start(); // what a wake does
  await until(() => box.keys.length >= 2, { what: 'the key again' });
  await sleep(100);
  assert.equal(fake.commands.length, cmds + 1, 'a box wakes often: registered once');
  assert.equal(fake.connects, connects);
  assert.ok(!JSON.stringify(await api('/config')).includes('the-inbox-token'), 'the URL stays out of /config');
});

test('a box’s /wisp stays off a socket: a signature it can’t check, or none, is a 401', async () => {
  const d = inDm(STRANGER_ID, 'hello');
  const raw = JSON.stringify(d);
  const count = srv.store.all().length;
  assert.equal((await held(d, keypair().privateKey)).status, 401, 'forged, with a good-looking grid mark');
  assert.equal((await ch().inbound(Buffer.from(raw), {})).status, 401, 'no headers');
  assert.equal((await ch().inbound(Buffer.from(`${raw} `), signedBy(keys.privateKey, raw))).status, 401, 'another body');
  assert.deepEqual([fake.edits.filter((e) => e.token === d.token).length, fake.deletes.filter((e) => e.token === d.token).length, srv.store.all().length], [0, 0, count]);
});

test('a box: linked by /wisp in a DM, in the deferred response, no callback at all', async () => {
  const code = (await api('/remote')).discord.linkCode;
  const callbacks = fake.callbacks.length;
  const wrong = inDm(ME, 'link 000000');
  assert.equal((await held(wrong)).status, 403, 'a stranger still');
  const d = inDm(ME, `link ${code}`);
  assert.equal((await held(d)).status, 200);
  await until(() => fake.edits.some((e) => e.token === d.token && /^✓ Linked to wisp/.test(e.content)), { what: 'the edit' });
  assert.equal((await api('/remote')).discord.senders, 1);
  assert.equal(fake.callbacks.length, callbacks, 'the grid answered: a second answer fails');
  await until(() => box.linked.at(-1)?.includes(linkedHash(ME)), { what: 'the grid told who’s linked' });
  assert.ok(!JSON.stringify(box.linked).includes(ME), 'hashed');
});

test('a box: a command starts from the deferred state: edited, threaded, once, and a report by post', async () => {
  const count = srv.store.all().length;
  const callbacks = fake.callbacks.length;
  const d = command(ME, `in ${name} plan: look around`, { channel_id: 'CB1' });
  assert.equal((await held(d)).status, 200);
  await until(() => fake.edits.some((e) => e.token === d.token), { what: 'the edit' });
  const again = await held(d);
  assert.deepEqual([again.status, again.body.duplicate], [200, true]);
  const s = await until(() => srv.store.all().find((x) => x.remote?.discord && x.createdAt && srv.store.all().length === count + 1), { what: 'the task' });
  await settled(s.id);
  const thread = fake.threads.at(-1);
  assert.equal(thread.channel, 'CB1');
  const report = await until(() => inRoom(thread.id).find((p) => /Use \/wisp here to answer or follow up\./.test(p.content)), { what: 'the report' });
  assert.doesNotMatch(report.content, /Mention/);
  assert.equal(srv.store.all().length, count + 1, 'once');
  assert.equal(fake.callbacks.length, callbacks);
  assert.equal(srv.store.config.remote.discord.seen.includes(d.id), true, 'a box forgets what’s in memory');
  const follow = command(ME, 'and the rest', { channel_id: thread.id, channel: { type: 11 } });
  assert.equal((await held(follow)).status, 200);
  await until(() => fake.edits.some((e) => e.token === follow.token), { what: 'the follow-up’s edit' });
  assert.equal(srv.store.all().length, count + 1, 'a follow-up in its thread, by /wisp');
});

test('a box: a /wisp in a DM follows up on the task there: replies don’t reach it', async () => {
  const count = srv.store.all().length;
  const had = new Set(srv.store.all().map((x) => x.id));
  const d = inDm(ME, `in ${name} plan: one thing`);
  await held(d);
  const s = await until(() => srv.store.all().find((x) => !had.has(x.id) && x.remote?.discord?.channel === `D${ME}`), { what: 'the task' });
  await settled(s.id);
  assert.equal(s.remote.discord.thread, true);
  const next = inDm(ME, 'and another');
  await held(next);
  await until(() => fake.edits.some((e) => e.token === next.token), { what: 'the edit' });
  assert.equal(srv.store.all().length, count + 1);
});

test('a box: a key that isn’t the application’s says so, and isn’t Connected; the right one recovers', async () => {
  const wrong = keypair().hex;
  const commands = fake.commands.length;
  await api('/remote', { method: 'PUT', body: { discord: { publicKey: wrong } } });
  const v = await until(async () => {
    const x = await api('/remote');
    return x.discord.error ? x : null;
  }, { what: 'the error' });
  assert.equal(v.discord.connected, false);
  assert.match(v.discord.error, new RegExp(`doesn’t match.*${keys.hex.slice(-6)}.*General Information`));
  assert.ok(!v.discord.error.includes(TOKEN));
  assert.equal(fake.commands.length, commands);
  await api('/remote', { method: 'PUT', body: { discord: { publicKey: keys.hex } } });
  await until(async () => (await api('/remote')).discord.connected, { what: 'connected again' });
  assert.equal((await api('/remote')).discord.error, '');
});

test('a box: a stranger’s deferred response goes, nothing said, no task, and the grid hears a 403', async () => {
  const count = srv.store.all().length;
  const edits = fake.edits.length;
  const d = command(STRANGER_ID, `in ${name} plan: anything`);
  assert.equal((await held(d)).status, 403);
  await until(() => fake.deletes.some((x) => x.token === d.token), { what: 'the delete' });
  assert.deepEqual([fake.edits.length, srv.store.all().length], [edits, count]);
  assert.equal((await held(d)).status, 403, 'a repeat');
  assert.equal(fake.deletes.filter((x) => x.token === d.token).length, 1, 'gone once');
});

test('a box: a stranger’s DM gets its one line in the deferred response, then nothing', async () => {
  ch().strangers = new RateLimit({ max: 1 });
  const d = inDm('333333', 'hello');
  assert.equal((await held(d)).status, 403);
  const line = await until(() => fake.edits.find((e) => e.token === d.token), { what: 'the line' });
  assert.match(line.content, /^This wisp only answers people linked to it\. To link, use `\/wisp` here with `link` and the code/);
  const next = inDm('333333', 'hello again');
  assert.equal((await held(next)).status, 403);
  await until(() => fake.deletes.some((x) => x.token === next.token), { what: 'the delete' });
  ch().strangers = new RateLimit({ max: 1000 });
});

test('a box: a stranger’s button is left alone: @original there is the message itself, and it isn’t deleted', async () => {
  const d = fake.interaction({ type: 3, member: { user: { id: STRANGER_ID } }, data: { custom_id: 'a:s:r:0:sig' }, channel_id: 'CB2' });
  const deletes = fake.deletes.length;
  assert.equal((await held(d)).status, 403);
  await sleep(50);
  assert.equal(fake.deletes.length, deletes);
  assert.equal(inRoom('CB2').length, 0);
});

test('a box: a linked click needs no callback, and a command that isn’t /wisp is taken away', async () => {
  const callbacks = fake.callbacks.length;
  const d = fake.interaction({ type: 3, member: { user: { id: ME } }, data: { custom_id: 'a:nope:r:0:bad' }, channel_id: 'CB3' });
  assert.equal((await held(d)).status, 200);
  await until(() => inRoom('CB3').some((p) => /doesn’t work any more/.test(p.content)), { what: 'the line' });
  assert.equal(fake.callbacks.length, callbacks);
  const other = fake.interaction({ type: 2, member: { user: { id: ME } }, data: { name: 'other' } });
  assert.equal((await held(other)).status, 200);
  await until(() => fake.deletes.some((x) => x.token === other.token), { what: 'the delete' });
});

test('a small-order key: a fixed signature would verify anything, so it’s no key at all', async () => {
  const identity = `01${'00'.repeat(31)}`;
  assert.equal(discordSigned(identity, Buffer.from('anything'), { 'x-signature-ed25519': `01${'00'.repeat(63)}`, 'x-signature-timestamp': '1' }), false);
  assert.equal(isPublicKey(identity), false);
  assert.equal(isPublicKey(identity.toUpperCase()), false);
  assert.equal(isPublicKey(`ed${'ff'.repeat(31)}`), false, 'the sign bit changes nothing');
  assert.equal(isPublicKey(keys.hex), true);
  await assert.rejects(api('/remote', { method: 'PUT', body: { discord: { publicKey: identity } } }), /64 hex/);
});

test('a box: strangers can’t push an id out of seen: all under 14 minutes stay, older ones go', async () => {
  const c = srv.store.config.remote.discord;
  c.seen = [...c.seen, snowflake(Date.now() - 20 * 60_000)];
  const first = command(STRANGER_ID, 'one');
  assert.equal((await held(first)).status, 403);
  await until(() => fake.deletes.some((x) => x.token === first.token), { what: 'the delete' });
  for (let i = 0; i < 230; i++) await held(command(STRANGER_ID, `flood ${i}`));
  assert.ok(c.seen.includes(first.id), 'pushed out');
  assert.ok(c.seen.every((id) => Date.now() - snowflakeMs(id) < 14 * 60_000), 'older ones go');
  assert.equal((await held(first)).status, 403);
  assert.equal(fake.deletes.filter((x) => x.token === first.token).length, 1, 'the repeat did nothing');
});

test('a box: past 14 minutes a row is dropped with a plain log; before that it still runs, past the 10 of a message', async () => {
  const count = srv.store.all().length;
  const old = command(ME, `in ${name} plan: too late`, { id: snowflake(Date.now() - 14 * 60_000 - 1000) });
  const out = await held(old);
  assert.equal(out.status, 410);
  assert.ok(warned.some((l) => /discord: dropped a held interaction, 14 min old/.test(l)), warned.join('\n'));
  assert.deepEqual([fake.edits.filter((e) => e.token === old.token).length, srv.store.all().length], [0, count]);
  assert.ok(inRoom(old.channel_id).some((p) => /One message didn’t reach wisp while it was asleep/.test(p.content)), 'someone linked is told, where they asked');
  const theirs = command(STRANGER_ID, 'late', { id: snowflake(Date.now() - 14 * 60_000 - 1000), channel_id: 'CB8' });
  assert.equal((await held(theirs)).status, 410);
  assert.equal(inRoom('CB8').length, 0, 'a stranger isn’t');
  const late = command(ME, 'help', { id: snowflake(Date.now() - 12 * 60_000), channel_id: 'CB4' });
  assert.equal((await held(late)).status, 200);
  const edit = await until(() => fake.edits.find((e) => e.token === late.token), { what: 'the edit' });
  assert.match(edit.content, /Say what you’d type in wisp/, 'it ran: the 10 minutes of a message aren’t a held row’s');
});

test('a box: a token that dies goes by channel message, and the thread hangs on that message', async () => {
  const d = command(ME, 'help', { channel_id: 'CB5' });
  fake.deadTokens.add(d.token);
  assert.equal((await held(d)).status, 200);
  await until(() => inRoom('CB5').some((p) => /Say what you’d type in wisp/.test(p.content)), { what: 'the post' });
  const count = srv.store.all().length;
  const task = command(ME, `in ${name} plan: long one`, { channel_id: 'CB7' });
  fake.deadTokens.add(task.token);
  assert.equal((await held(task)).status, 200);
  const s = await until(() => (srv.store.all().length === count + 1 ? srv.store.all().find((x) => fake.threads.some((t) => t.channel === 'CB7' && t.id === x.remote?.discord?.channel)) : null), { what: 'the task' });
  await settled(s.id);
  const thread = fake.threads.find((t) => t.channel === 'CB7');
  assert.equal(thread.message, inRoom('CB7')[0].id, 'on the post that took the reply’s place');
  await until(() => inRoom(thread.id).some((p) => /Use \/wisp here/.test(p.content)), { what: 'the report' });
  assert.equal(fake.edits.filter((e) => e.token === task.token).length, 0);
});

test('a box: autocomplete answers in the body, for the linked; a stranger gets nothing, and neither calls back', async () => {
  const callbacks = fake.callbacks.length;
  const ask = (user) => fake.interaction({ type: 4, member: { user: { id: user } }, data: { name: 'wisp', options: [{ name: 'project', value: '', focused: true }] } });
  const mine = await held(ask(ME));
  assert.equal(mine.status, 200);
  assert.equal(mine.body.type, 8);
  assert.ok(mine.body.data.choices.some((c) => c.name === name));
  const theirs = await held(ask(STRANGER_ID));
  assert.deepEqual(theirs.body, { type: 8, data: { choices: [] } });
  assert.equal(fake.callbacks.length, callbacks);
});

test('a box: what the grid lost is said where someone last spoke, a rotate shows the new URL', async () => {
  const n = fake.posts.length;
  await ch().dropped(2);
  assert.match(fake.posts.at(-1).content, /2 messages didn’t reach wisp while it was asleep/);
  assert.equal(fake.posts.length, n + 1);
  const out = await ch().rotate();
  assert.deepEqual([out.status, out.body.url], [200, box.url]);
  assert.equal((await api('/remote')).discord.endpoint, box.url);
});

test('a box: switched off, its key leaves the grid, so nothing wakes it; a grid with no hub says so', async () => {
  await api('/remote', { method: 'PUT', body: { discord: { enabled: false } } });
  await until(() => box.keys.at(-1) === '', { what: 'the key gone' });
  const held0 = await held(command(ME, 'help'));
  assert.equal(held0.status, 409);
  box.hub = false;
  await api('/remote', { method: 'PUT', body: { discord: { enabled: true } } });
  const v = await until(async () => {
    const x = await api('/remote');
    return x.status.discord?.error ? x : null;
  }, { what: 'the error' });
  assert.equal(v.status.discord.error, NO_HUB);
  box.hub = true;
});

test('a box: a new token drops the old key: another bot, another key', async () => {
  await api('/remote', { method: 'PUT', body: { discord: { token: 'MTEx.other-part.other-token' } } });
  assert.equal(srv.store.config.remote.discord.publicKey, '');
  assert.equal(ch().ready, false);
});

test('no token, interaction token, inbox URL or key reached a log on a box', () => {
  const all = warned.join('\n');
  for (const s of [TOKEN, 'itoken-', 'the-inbox-token', keys.hex]) assert.ok(!all.includes(s), s);
  console.warn = warn;
  for (const k of ['WISP_GRID_URL', 'WISP_TRUSTED_PROXY_SECRET', 'WISP_PUBLIC_URL']) delete process.env[k];
  fakeGrid.close();
  fakeGrid.closeAllConnections?.();
});
