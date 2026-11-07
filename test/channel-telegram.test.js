// Telegram with telegram.options on, end to end: a real wisp, fake Telegram on loopback, fake
// agents. Start, ack, question, answer, follow-up, stop, report; the same on a crew member; `with`
// on a follow-up; a restart with a crew job in the queue.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer as netServer } from 'node:net';
import { installFakeBins, isolateAgentConfigs, makeRepo, sleep, tmp, until } from './helpers.js';

process.env.FAKE_RECORD = tmp('tg-record');
process.env.WISP_HOME = tmp('tg-home');
process.env.WISP_UPDATE_CHECK = '0';
installFakeBins();
isolateAgentConfigs();

const { startServer } = await import('../server/index.js');
const { RateLimit } = await import('../server/channels/policy.js');

const CHAT = 42;
const net = { sent: [], calls: [], updates: [], next: 1, msg: 100 };
let fake;
let srv;
let base;
let api2; // repo paths and names
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
const port = () => new Promise((resolve) => {
  const s = netServer().listen(0, '127.0.0.1', () => {
    const { port: p } = s.address();
    s.close(() => resolve(p));
  });
});
async function boot() {
  const p = await port();
  base = `http://127.0.0.1:${p}`;
  srv = await startServer({ port: p, handleSignals: false });
  srv.remote.tgLongPoll = 0;
  srv.remote.channels.telegram.limit = new RateLimit({ max: 1000 }); // this file is one busy sender
  srv.store.config.defaults.agent = 'claude'; // tests can't depend on which harness Auto picks
}
const halt = () => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
};

before(async () => {
  fake = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const u = new URL(req.url, 'http://x');
    const json = (o) => (res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }), res.end(JSON.stringify(o))); // no socket to reuse: this file isn't about keep-alive
    const method = u.pathname.split('/').pop();
    const b = body ? JSON.parse(body) : {};
    net.calls.push({ method, ...b });
    if (method === 'getUpdates') {
      net.updates = net.updates.filter((x) => x.update_id >= (b.offset || 0)); // an offset confirms what's before it
      if (!net.updates.length) await new Promise((r) => setTimeout(r, 15));
      return json({ ok: true, result: net.updates });
    }
    if (method === 'sendMessage') {
      if (net.dropOne) {
        net.dropOne = false;
        return req.socket.destroy();
      }
      if (net.dropNext && b.reply_to_message_id === net.dropNext) return req.socket.destroy(); // Telegram never hears it, or its answer never comes back
      const message_id = ++net.msg;
      net.sent.push({ ...b, message_id });
      if (net.lag) await sleep(net.lag); // Telegram has it, wisp hasn't heard back yet
      return json({ ok: true, result: { message_id } });
    }
    if (method === 'getMe') return json({ ok: true, result: { username: 'wispbot' } });
    return json({ ok: true, result: true });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.WISP_TELEGRAM_API = `http://127.0.0.1:${fake.address().port}`;
  await boot();
  const repo = makeRepo();
  const other = makeRepo();
  await api('/projects', { body: { path: repo } });
  await api('/projects', { body: { path: other } });
  const ps = (await api('/config')).projects;
  name = ps.find((p) => p.path === repo).name;
  web = ps.find((p) => p.path === other).name;
  api2 = { repo, other, main: ps.find((p) => p.path === repo) };
  const view = await api('/remote', { method: 'PUT', body: { telegram: { enabled: true, token: '123:abc', allowStart: true, project: api2.main.id } } });
  net.updates.push({ update_id: net.next++, message: { message_id: 1, chat: { id: CHAT, type: 'private', first_name: 'Ada' }, text: `/link ${view.telegram.linkCode}` } });
  await until(async () => (await api('/remote')).telegram.linked);
  const on = await api('/remote', { method: 'PUT', body: { telegram: { options: true } } });
  assert.equal(on.telegram.options, true);
});

after(() => {
  halt();
  delete process.env.WISP_TELEGRAM_API;
  fake.closeAllConnections?.();
  fake.close();
});

let mid = 1000;
const say = (text, o = {}) => {
  const message_id = o.message_id || ++mid;
  net.updates.push({ update_id: net.next++, message: { message_id, chat: { id: CHAT, type: 'private', first_name: 'Ada' }, from: { id: 7, first_name: 'Mokhles' }, date: Math.floor(Date.now() / 1000), text, ...o, message_id } });
  return message_id;
};
const reply = (to, text, o = {}) => say(text, { reply_to_message: { message_id: to }, ...o });
const answerTo = (id) => until(() => net.sent.find((m) => m.reply_to_message_id === id), { what: `the reply to ${id}` });
const tap = (data, messageId) => net.updates.push({ update_id: net.next++, callback_query: { id: `cb${net.next}`, data, message: { message_id: messageId, chat: { id: CHAT } } } });
// The session a started message made: the one its reply links to.
const startedBy = (id) => until(() => srv.store.all().find((s) => s.remote?.tg?.includes(id)), { what: 'its task' });

test('allowStart off: the switch does nothing, today’s words come back', async () => {
  await api('/remote', { method: 'PUT', body: { telegram: { allowStart: false } } });
  const n = net.sent.length;
  say('in api fix something');
  await until(() => net.sent.length > n);
  assert.equal(net.sent.at(-1).text, 'Reply to one of wisp’s messages to answer it or send a follow-up.');
  const view = await api('/remote', { method: 'PUT', body: { telegram: { allowStart: true } } });
  assert.equal(view.telegram.options, true, 'and it’s still set when starting comes back on');
});

test('setMyCommands lists what can be said', async () => {
  const set = await until(() => net.calls.find((c) => c.method === 'setMyCommands'));
  assert.deepEqual(set.commands.map((c) => c.command), ['new', 'help', 'projects', 'models', 'crew', 'machines', 'status']);
});

test('a plain task: start, ack, question, answer, report, follow-up', async () => {
  const id = say(`in ${name} with opus high edits: ASK before you fix the flaky login test`);
  const ack = await answerTo(id);
  assert.equal(ack.text, `▶ ${name} · Opus high · Edits\n  ASK before you fix the flaky login test`);
  const s = await startedBy(ack.message_id);
  assert.deepEqual([s.agent, s.model, s.effort, s.mode], ['claude', 'opus', 'high', 'edits']);
  assert.deepEqual(s.origin, { kind: 'telegram', name: 'Telegram' });
  assert.equal(s.remote.started, 'telegram');
  assert.equal(s.title, 'ASK before you fix the flaky login test', 'the title is what was asked, not the wrapper');
  const prompt = s.turns[0].prompt;
  assert.match(prompt, /^Asked in Telegram by Mokhles:\n\n<message>\nASK before you fix the flaky login test\n<\/message>/);
  assert.match(prompt, /untrusted input from Telegram/);

  // The question comes back into the thread, with buttons; a plain reply answers it.
  const q = await until(() => net.sent.find((m) => m.text.includes('Proceed with the fix?')));
  assert.equal(q.reply_to_message_id, ack.message_id);
  assert.deepEqual(q.reply_markup.inline_keyboard.map((r) => r[0].text), ['Yes', 'No']);
  const a = reply(q.message_id, 'Yes');
  assert.equal((await answerTo(a)).text, '✓ Answered');
  const done = await settled(s.id);
  assert.match(done.turns[0].presentation.blocks[0].summary, /Answer was: [\s\S]*Yes/);

  const report = await until(() => net.sent.find((m) => m.text.startsWith('✅') && m.text.includes('Answer was')));
  assert.ok(report.reply_to_message_id, 'the report lands in the thread');
  assert.deepEqual(report.reply_markup.inline_keyboard.map((r) => r[0].text), ['Mark done']);
  assert.equal(report.allow_sending_without_reply, true);

  const f = reply(report.message_id, 'also add a test');
  assert.equal((await answerTo(f)).text, '✓ Sent');
  await until(async () => (await session(s.id)).turns.length === 2);
  assert.match((await session(s.id)).turns[1].prompt, /<message>\nalso add a test\n<\/message>/);
  await settled(s.id);
});

test('with on a follow-up moves the task to that model, as wisp_reply does', async () => {
  const id = say(`#${name} with haiku: first pass`);
  const ack = await answerTo(id);
  assert.equal(ack.text, `▶ ${name} · Haiku · Full auto\n  First pass`);
  const s = await startedBy(ack.message_id);
  await settled(s.id);
  const a = reply(ack.message_id, 'with sonnet carry on');
  assert.equal((await answerTo(a)).text, '✓ Sent · Sonnet');
  await until(async () => (await session(s.id)).turns.length === 2);
  let now = await session(s.id);
  assert.equal(now.model, 'sonnet');
  assert.match(now.turns[1].prompt, /<message>\ncarry on\n<\/message>/);
  await settled(s.id);

  const b = reply(ack.message_id, 'with gpt-0 go on');
  assert.match((await answerTo(b)).text, /No model “gpt-0”[\s\S]*Nothing started/);
  const c = reply(ack.message_id, ': with sonnet is what we used');
  await answerTo(c);
  await until(async () => (await session(s.id)).turns.length === 3);
  now = await session(s.id);
  assert.match(now.turns[2].prompt, /<message>\nwith sonnet is what we used\n<\/message>/);
  await settled(s.id);

  const d = reply(ack.message_id, 'with codex finish it');
  assert.equal((await answerTo(d)).text, '✓ Sent · Codex');
  await until(async () => (await session(s.id)).agent === 'codex');
  await settled(s.id);
  const e = reply(ack.message_id, 'with haiku');
  assert.match((await answerTo(e)).text, /What should it do/);
});

test('a reply whose connection is cut goes again, once', async () => {
  const before = net.sent.length;
  net.dropOne = true;
  const ack = await answerTo(say(`in ${name}: the cut connection`));
  assert.match(ack.text, /^▶ /);
  assert.equal(net.sent.slice(before).filter((m) => m.text.startsWith('▶')).length, 1);
  await settled((await startedBy(ack.message_id)).id);
});

test('a reply that doesn’t reach Telegram never says the follow-up failed: it went, and a resend would run it twice', async () => {
  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    const ack = await answerTo(say(`in ${name}: first`));
    const s = await startedBy(ack.message_id);
    await settled(s.id);
    const before = net.sent.length;
    net.dropNext = ++mid;
    reply(ack.message_id, 'one more thing', { message_id: net.dropNext });
    await until(async () => (await session(s.id)).turns.length === 2);
    await settled(s.id);
    await until(() => warned.some((w) => w.includes('telegram')));
    assert.equal(net.sent.slice(before).filter((m) => /Couldn’t send that/.test(m.text)).length, 0);
  } finally {
    console.warn = warn;
    net.dropNext = null;
  }
});

test('plan on the haiku alias: the ack and a follow-up say Sonnet runs, and why', async () => {
  const note = 'Plan runs on Sonnet here, not Haiku: the Claude CLI picks it.';
  const id = say(`in ${name} with haiku plan: read the code`);
  const ack = await answerTo(id);
  assert.equal(ack.text, `▶ ${name} · Sonnet · Plan\n  Read the code\n${note}`);
  const s = await startedBy(ack.message_id);
  assert.deepEqual([s.model, s.mode], ['haiku', 'plan'], 'what was asked for still goes to the CLI');
  await settled(s.id);

  // Into plan, on a task on the alias: no `with`, and the line says so all the same.
  const on = say(`in ${name} with haiku edits: read the code`);
  const onAck = await answerTo(on);
  assert.equal(onAck.text, `▶ ${name} · Haiku · Edits\n  Read the code`);
  const t = await startedBy(onAck.message_id);
  await settled(t.id);
  assert.equal((await answerTo(reply(onAck.message_id, 'plan: look again'))).text, `✓ Sent\n${note}`);
  await until(async () => (await session(t.id)).turns.length === 2);
  await settled(t.id);

  // Onto the alias, already in plan.
  const u = say(`in ${name} with sonnet plan: read the code`);
  const uAck = await answerTo(u);
  assert.equal(uAck.text, `▶ ${name} · Sonnet · Plan\n  Read the code`);
  const v = await startedBy(uAck.message_id);
  await settled(v.id);
  assert.equal((await answerTo(reply(uAck.message_id, 'with haiku look again'))).text, `✓ Sent · Sonnet\n${note}`);
  await until(async () => (await session(v.id)).turns.length === 2);
  await settled(v.id);
  // Haiku with edits is Haiku, and nothing moved: the line stays as it was.
  assert.equal((await answerTo(reply(onAck.message_id, 'edits: go on'))).text, '✓ Sent');
  await until(async () => (await session(t.id)).turns.length === 3);
  await settled(t.id);
});

test('the report names the model the stats show when it isn’t the one asked for', async () => {
  process.env.FAKE_SUBAGENTS = '1'; // its modelUsage: Opus the main thread, a Haiku side call
  try {
    const reportOf = async (words) => {
      const ack = await answerTo(say(`in ${name} with ${words}`));
      const s = await startedBy(ack.message_id);
      await settled(s.id);
      return until(() => net.sent.find((m) => m.message_id > ack.message_id && m.text.includes(s.title)), { what: 'its report' });
    };
    assert.match((await reportOf('sonnet: one model')).text, /\n\nRan on claude-opus-5-5, not sonnet\.(\n|$)/);
    assert.ok(!(await reportOf('opus: same model')).text.includes('Ran on'), 'the alias of what ran: unchanged');
  } finally {
    delete process.env.FAKE_SUBAGENTS;
  }
});

test('stop keeps queued follow-ups, held; status says so; the next message carries on', async () => {
  srv.store.config.defaults.followUp = 'queue';
  process.env.FAKE_DELAY = '30000';
  try {
    const id = say(`in ${name}: a long one`);
    const ack = await answerTo(id);
    const s = await startedBy(ack.message_id);
    await until(async () => (await session(s.id)).state === 'running');
    const q = reply(ack.message_id, 'and then this');
    assert.equal((await answerTo(q)).text, '✓ Queued for when it finishes');
    const st = reply(ack.message_id, 'status');
    assert.equal((await answerTo(st)).text, 'Working: A long one'.replace('A long', 'a long') + ' (1 queued)');
    const stop = reply(ack.message_id, 'stop');
    assert.equal((await answerTo(stop)).text, '■ Stopped. 1 queued follow-up kept: your next message carries them on.');
    await until(async () => (await session(s.id)).state !== 'running');
    const now = await session(s.id);
    assert.equal(now.queue.length, 1, 'stopping never discards a queued follow-up');
    assert.equal(now.queueHeld, true);
    assert.match(now.queue[0].text, /and then this/);
    const again = reply(ack.message_id, '/stop');
    assert.equal((await answerTo(again)).text, 'It isn’t running.');
    delete process.env.FAKE_DELAY;
    const next = reply(ack.message_id, 'pick it up');
    await answerTo(next);
    await settled(s.id);
    const turns = (await session(s.id)).turns.map((t) => t.prompt).join('\n');
    assert.match(turns, /pick it up/);
    assert.match(turns, /and then this/, 'the held one went after it');
  } finally {
    delete process.env.FAKE_DELAY;
    srv.store.config.defaults.followUp = 'interrupt';
  }
});

test('done from a thread closes it; a stale link gets told, not a new task', async () => {
  const id = say(`in ${name}: small thing`);
  const ack = await answerTo(id);
  const s = await startedBy(ack.message_id);
  await settled(s.id);
  const d = reply(ack.message_id, 'done');
  assert.equal((await answerTo(d)).text, '✓ Marked done');
  assert.equal((await session(s.id)).state, 'done');
  const before = srv.store.all().length;
  const x = reply(99999, 'in api do something');
  assert.match((await answerTo(x)).text, /isn’t linked to a task any more/);
  assert.equal(srv.store.all().length, before);
  const y = say('stop');
  assert.match((await answerTo(y)).text, /Reply to the task’s message/);
});

test('/new as a reply to a message no task owns starts a task: it never meant that message', async () => {
  const before = srv.store.all().length;
  const x = reply(99998, `/new in ${name}: fix x`);
  assert.match((await answerTo(x)).text, /^▶ /);
  await until(() => srv.store.all().length === before + 1, { what: 'the new task' });
  await settled(srv.store.all().at(-1).id);
});

test('/btw in a thread answers on the side, wrapped, and comes back there', async () => {
  const id = say(`in ${name}: side question target`);
  const ack = await answerTo(id);
  const s = await startedBy(ack.message_id);
  await settled(s.id);
  const b = reply(ack.message_id, '/btw what changed?');
  assert.match((await answerTo(b)).text, /Asking on the side/);
  const answer = await until(() => net.sent.find((m) => m.reply_to_message_id === b && m.text.startsWith('btw: ')));
  assert.match(answer.text, /what changed\?/);
  assert.equal((await session(s.id)).turns.length, 1);
});

test('plain text starts a task; a leading colon sends it as written; what’s wrong says so and starts nothing', async () => {
  const id = say('fix the flaky login test');
  const ack = await answerTo(id);
  assert.equal(ack.text, `▶ ${name} · Claude Code · Full auto\n  Fix the flaky login test`);
  assert.equal((await startedBy(ack.message_id)).mode, 'auto', 'no options: the launcher’s defaults, as /new has always had');

  const p = say('plan the migration to postgres');
  const pa = await answerTo(p);
  assert.equal(pa.text, `▶ ${name} · Claude Code · Full auto\n  Plan the migration to postgres`);

  const w = say(': on laptop: exactly this');
  const wa = await answerTo(w);
  assert.match(wa.text, /On laptop: exactly this/);
  assert.match((await startedBy(wa.message_id)).turns[0].prompt, /<message>\non laptop: exactly this\n<\/message>/);

  const n = say('on nothere fix it');
  const na = await answerTo(n);
  assert.match(na.text, /“on nothere” isn’t one of your machines, so I read it as part of the task\./);

  const count = srv.store.all().length;
  for (const [text, re] of [
    ['on nothere: fix it', /No machine “nothere”/],
    ['with gpt-0 fix it', /No model “gpt-0”[\s\S]*Choices: opus, sonnet, haiku[\s\S]*Nothing started/],
    ['#nosuch fix it', new RegExp(`No project matches “nosuch”[\\s\\S]*Choices: .*${web}`)],
    ['@nobody fix it', /No crew member or project matches “nobody”/],
    [`in ${name}`, /What should it do/],
    ['/bogus', /There’s no \/bogus here/],
  ]) {
    const x = say(text);
    assert.match((await answerTo(x)).text, re, text);
  }
  assert.equal(srv.store.all().length, count, 'nothing started');
});

test('/new goes through the grammar with the switch on', async () => {
  const id = say(`/new in ${web} with sonnet plan: read the code`);
  const ack = await answerTo(id);
  assert.equal(ack.text, `▶ ${web} · Sonnet · Plan\n  Read the code`);
  const s = await startedBy(ack.message_id);
  assert.equal(s.mode, 'plan');
  assert.equal(s.model, 'sonnet');
  await settled(s.id);
  const bot = say(`@wispbot in ${web} edits: bot mention`);
  assert.match((await answerTo(bot)).text, new RegExp(`^▶ ${web} · Claude Code · Edits`));
});

test('lists: each ends with an example in the user’s own words', async () => {
  for (const [text, re] of [
    ['help', /Say what you’d type in wisp/],
    ['/projects', new RegExp(`• ${name}  ← default`)],
    ['models', /• claude: opus, sonnet, haiku/],
    ['machines', /• this computer · online/],
    ['status', /./],
  ]) {
    const n = net.sent.length;
    say(text);
    const m = await until(() => net.sent.slice(n).find((x) => !x.text.startsWith('✅') && !x.text.startsWith('▶')));
    assert.match(m.text, re, text);
    assert.match(m.text.split('\n').at(-1), /^Try: /, text);
  }
});

test('a tool approval is answered from Telegram’s buttons', async () => {
  const id = say(`in ${name} edits: APPROVE then publish`);
  const ack = await answerTo(id);
  const s = await startedBy(ack.message_id);
  const q = await until(() => net.sent.find((m) => m.reply_markup && /publish/i.test(m.text) && m.text.includes('Needs') === false && m.text.startsWith('❓')));
  const buttons = q.reply_markup.inline_keyboard.map((r) => r[0]);
  assert.ok(buttons.length >= 2, JSON.stringify(buttons));
  assert.ok((await session(s.id)).ask?.permission, 'a live approval');
  tap(buttons[0].callback_data, q.message_id);
  await settled(s.id);
  assert.ok(!(await session(s.id)).ask);
});

test('Full auto adds no hold or question', async () => {
  const id = say(`in ${name} full auto: APPROVE then publish`);
  const ack = await answerTo(id);
  assert.match(ack.text, /· Full auto\n/);
  const s = await startedBy(ack.message_id);
  assert.equal(s.mode, 'auto');
  const done = await settled(s.id);
  assert.ok(!done.ask);
  assert.ok(!done.turns.some((t) => t.held));
});

test('a group is capped at Edits: Full auto refused, defaults held down, follow-ups too', async () => {
  const group = { chat: { id: CHAT, type: 'supergroup', title: 'Team' } };
  const f = say('full auto: wipe it', group);
  assert.match((await answerTo(f)).text, /Full auto isn’t allowed from here[\s\S]*Nothing started/);
  const id = say(`in ${name}: group job`, group);
  const ack = await answerTo(id);
  assert.match(ack.text, /· Edits\n/, 'the launcher’s default is Full auto: not here');
  const s = await startedBy(ack.message_id);
  assert.equal(s.mode, 'edits');
  await settled(s.id);

  // A task in Full auto, followed up from the group, doesn't stay there.
  const own = say(`in ${name} full auto: private one`);
  const privAck = await answerTo(own);
  const p = await startedBy(privAck.message_id);
  await settled(p.id);
  const g = reply(privAck.message_id, 'carry on from the group', group);
  await answerTo(g);
  await until(async () => (await session(p.id)).turns.length === 2);
  assert.equal((await session(p.id)).mode, 'edits');
  await settled(p.id);

  const m = await api('/crew', { body: { name: 'Gus', agent: 'claude', cwd: api2.repo, mode: 'auto' } });
  const j = say('@gus group job for a member', group);
  const jack = await answerTo(j);
  assert.match(jack.text, /^▶ Gus has it · .* · Edits/);
  const job = await startedBy(jack.message_id);
  assert.equal(job.mode, 'edits');
  await settled(job.id);
  await api(`/crew/${m.id}`, { method: 'DELETE' });
});

test('a task started in wisp still takes a reply, and options apply there too', async () => {
  net.lag = 300; // a slow answer from Telegram: what's sent is in net.sent before wisp links it
  try {
    const s = await api('/sessions', { body: { prompt: 'plain task', cwd: api2.repo, agent: 'claude', worktree: false } });
    await settled(s.id);
    // Linked, not only sent: Telegram (net.sent) has a message before wisp hears its id back.
    const m = await until(() => net.sent.find((x) => srv.store.get(s.id).remote?.tg?.includes(x.message_id)));
    assert.equal(srv.store.get(s.id).remote.started, undefined);
    assert.equal(m.reply_to_message_id, undefined, 'not a thread: nothing started it there');
    const r = reply(srv.store.get(s.id).remote.tg.at(-1), 'with sonnet from the phone');
    assert.equal((await answerTo(r)).text, '✓ Sent · Sonnet');
    await settled(s.id);
  } finally {
    net.lag = 0;
  }
});

test('telemetry: counts only, never what was said', async () => {
  const seen = [];
  const real = srv.telemetry.track;
  srv.telemetry.track = (event, props) => (event === 'channel_event' ? seen.push(props) : 0, real.call(srv.telemetry, event, props));
  try {
    const id = say(`in ${name}: a secret plan about telemetry`);
    await answerTo(id);
    const h = say('help');
    await until(() => seen.some((p) => p.detail === 'help'), { what: `help ${h}` });
  } finally {
    srv.telemetry.track = real;
  }
  assert.deepEqual(seen.map((p) => [p.kind, p.detail]), [['start', 'plain'], ['list', 'help']]);
  assert.ok(!JSON.stringify(seen).includes('secret plan'));
});

// --- crew ----------------------------------------------------------------------------------------

// --- someone else's words: a forward runs nothing --------------------------------------------------

const FORWARD_LINE = 'Forwarded, so nothing started. Say it in your own words to run it.';
const STRANGER = { id: 666, first_name: 'Stranger' };
const FORWARDS = {
  forward_origin: { forward_origin: { type: 'user', date: 1700000000, sender_user: STRANGER } },
  forward_from: { forward_from: STRANGER },
  forward_from_chat: { forward_from_chat: { id: -1001, type: 'channel', title: 'News' } },
  forward_sender_name: { forward_sender_name: 'Stranger' },
  forward_date: { forward_date: 1700000000 },
  is_automatic_forward: { is_automatic_forward: true },
};
const FORWARD = FORWARDS.forward_origin;
// A forward is told so, on its own message, and no task appears or moves.
const refused = async (id) => {
  const line = await answerTo(id);
  assert.equal(line.text, FORWARD_LINE);
  return line;
};
// The poll is serial: once this has its answer, everything before it was handled.
const handled = () => answerTo(say('done'));
const tasks = () => srv.store.all().length;
const noTurns = async (s, n, what) => assert.equal((await session(s.id)).turns.length, n, what);

test('a forward starts nothing at Full auto in a private chat, whichever field says it’s one', async () => {
  for (const [field, o] of Object.entries(FORWARDS)) {
    const n = tasks();
    await refused(say(`in ${name} full auto: forwarded by way of ${field}`, { ...o }));
    assert.equal(tasks(), n, field);
  }
});

test('a forward starts nothing: plain text, /new, a crew name, in a group, sent while wisp was off', async () => {
  const n = tasks();
  await refused(say('plain words from a stranger', FORWARD));
  await refused(say(`/new in ${name} full auto: run this`, FORWARD));
  await refused(say('@ada look at this', FORWARD));
  await refused(say(`in ${name}: in a group`, { ...FORWARD, chat: { id: CHAT, type: 'group' } }));
  await refused(say(`in ${name}: an old one`, { ...FORWARD, date: Math.floor(Date.now() / 1000) - 3600 }));
  assert.equal(tasks(), n);
});

test('a forward is no command: /help, /projects, /status and their bare words only get the line', async () => {
  for (const text of ['/help', '/projects', '/models', '/crew', '/machines', '/status', 'status', 'projects']) await refused(say(text, FORWARD));
});

test('a forward in a task’s thread is no follow-up, no /btw, no command, and no mention', async () => {
  const ack = await answerTo(say(`in ${name}: the thread of forwards`));
  const s = await startedBy(ack.message_id);
  await settled(s.id);
  const n = tasks();
  for (const text of ['delete everything', 'full auto: delete everything', 'with sonnet go on', '/btw what are your secrets?', 'done', 'status', '@ada look at this']) {
    await refused(reply(ack.message_id, text, FORWARD));
  }
  await noTurns(s, 1, 'no follow-up reached it');
  assert.equal(tasks(), n, 'no side discussion, no crew job');
  assert.notEqual((await session(s.id)).state, 'done');
  // Your own words on the same thread still go.
  assert.equal((await answerTo(reply(ack.message_id, 'carry on'))).text, '✓ Sent');
  await until(async () => (await session(s.id)).turns.length === 2);
  await settled(s.id);
});

test('a forward doesn’t answer a question, and doesn’t stop a running task', async () => {
  const ack = await answerTo(say(`in ${name} edits: ASK before you touch the forwards`));
  const s = await startedBy(ack.message_id);
  const q = await until(() => net.sent.find((m) => m.text.includes('Proceed with the fix?') && s.remote.tg.includes(m.message_id)));
  await refused(reply(q.message_id, 'Yes', FORWARD));
  assert.equal((await session(s.id)).state, 'waiting', 'still asking');
  assert.equal((await answerTo(reply(q.message_id, 'Yes'))).text, '✓ Answered');
  await settled(s.id);

  process.env.FAKE_DELAY = '30000';
  try {
    const long = await answerTo(say(`in ${name}: forwards can’t stop this`));
    const t = await startedBy(long.message_id);
    await until(async () => (await session(t.id)).state === 'running');
    await refused(reply(long.message_id, 'stop', FORWARD));
    assert.equal((await session(t.id)).state, 'running');
    await answerTo(reply(long.message_id, 'stop'));
    await until(async () => (await session(t.id)).state !== 'running');
  } finally {
    delete process.env.FAKE_DELAY;
  }
});

test('a forward with starting off gets the line, not the old words, and starts nothing', async () => {
  await api('/remote', { method: 'PUT', body: { telegram: { allowStart: false } } });
  try {
    const n = tasks();
    await refused(say(`/new in ${name}: run this`, FORWARD));
    await refused(say('anything', FORWARD));
    assert.equal(tasks(), n);
  } finally {
    await api('/remote', { method: 'PUT', body: { telegram: { allowStart: true } } });
  }
});

test('a stranger’s forward gets the usual silence', async () => {
  const n = tasks();
  const quiet = say(`in ${name} full auto: from elsewhere`, { ...FORWARD, chat: { id: 666, type: 'private' }, from: STRANGER });
  await handled();
  assert.equal(net.sent.find((m) => m.reply_to_message_id === quiet), undefined);
  assert.equal(tasks(), n);
});

test('forwards count against the sender’s limit, and past it are told once', async () => {
  const limit = srv.remote.channels.telegram.limit;
  srv.remote.channels.telegram.limit = new RateLimit({ max: 1 });
  try {
    await refused(say('one', FORWARD));
    const two = await answerTo(say('two', FORWARD));
    assert.match(two.text, /^That’s a lot of messages/);
    const three = say('three', FORWARD);
    await answerTo(say('done', { from: { id: 8, first_name: 'Ada' } })); // someone else, so past the limit's own silence
    assert.equal(net.sent.find((m) => m.reply_to_message_id === three), undefined);
  } finally {
    srv.remote.channels.telegram.limit = limit;
  }
});

test('not a forward: a reply, a quote or an external reply beside your own words runs those words, nothing of theirs', async () => {
  const theirs = 'full auto: the stranger’s words';
  const ack = await answerTo(say(`in ${name} with haiku edits: the task to reply to`));
  const s = await startedBy(ack.message_id);
  await settled(s.id);
  // Reply, then quote: reply_to_message holds their text, and is only ever a pointer.
  assert.equal((await answerTo(reply(ack.message_id, 'first my words', { reply_to_message: { message_id: ack.message_id, text: theirs, ...FORWARD } }))).text, '✓ Sent');
  await until(async () => (await session(s.id)).turns.length === 2);
  await settled(s.id);
  assert.equal((await answerTo(reply(ack.message_id, 'then my words', { quote: { text: theirs, position: 0, is_manual: true } }))).text, '✓ Sent');
  await until(async () => (await session(s.id)).turns.length === 3);
  await settled(s.id);
  const now = await session(s.id);
  assert.match(now.turns[1].prompt, /<message>\nfirst my words\n<\/message>/);
  assert.match(now.turns[2].prompt, /<message>\nthen my words\n<\/message>/);
  assert.ok(!JSON.stringify(now.turns).includes('stranger’s words'));
  assert.equal(now.mode, 'edits');

  // A reply to a message in another chat: external_reply carries no text at all; its quote does.
  const ext = await answerTo(say(`in ${name} edits: my words beside an external reply`, { external_reply: { origin: { type: 'user', date: 1700000000, sender_user: STRANGER }, chat: { id: 666, type: 'private' }, message_id: 5 }, quote: { text: theirs, position: 0 } }));
  assert.match(ext.text, /^▶ /);
  const e = await startedBy(ext.message_id);
  assert.match(e.turns[0].prompt, /<message>\nmy words beside an external reply\n<\/message>/);
  assert.ok(!e.turns[0].prompt.includes('stranger’s words'));
  await settled(e.id);

  // No text of the sender's: nothing to read, whatever the quote holds. Silence, as today.
  const n = tasks();
  const bare = say(undefined, { text: undefined, quote: { text: theirs, position: 0 }, reply_to_message: { message_id: ack.message_id } });
  await handled();
  assert.equal(net.sent.find((m) => m.reply_to_message_id === bare), undefined);
  assert.equal(tasks(), n);
});

test('a crew member: start, ack, report under their name, follow-up, one job’s model', async () => {
  const m = await api('/crew', { body: { name: 'Ada', role: 'CI watcher', brief: 'Watch CI.', cwd: api2.repo, agent: 'claude', model: 'sonnet', mode: 'edits', parallel: 2 } });
  const id = say('@ada check the deploy');
  const ack = await answerTo(id);
  assert.equal(ack.text, `▶ Ada has it · ${name} · Sonnet\n  Check the deploy`);
  const job = await startedBy(ack.message_id);
  assert.equal(job.crew.id, m.id);
  assert.equal(job.crew.job, 'task');
  assert.equal(job.remote.started, 'telegram');
  assert.equal(job.remote.by, 'Ada');
  assert.deepEqual([job.model, job.mode], ['sonnet', 'edits']);
  await until(() => srv.crew.get(m.id).log[0]?.sessionId === job.id);
  assert.equal(srv.crew.get(m.id).log[0].prompt, 'check the deploy', 'their log says what was asked');
  assert.match(job.turns[0].prompt, /<message>\ncheck the deploy\n<\/message>/);
  await settled(job.id);
  const report = await until(() => net.sent.find((x) => x.text.startsWith('Ada: ✅')));
  assert.ok(report.reply_to_message_id);

  const f = reply(report.message_id, 'and the staging one');
  assert.equal((await answerTo(f)).text, '✓ Sent');
  await until(async () => (await session(job.id)).turns.length === 2);
  await settled(job.id);

  // with: this job only; their settings stay.
  const w = say('@ada with opus high plan: look at the logs');
  const wa = await answerTo(w);
  assert.match(wa.text, new RegExp(`^▶ Ada has it · ${name} · Opus high · Plan\\n  Look at the logs\\nThat model is for this job only\\.`));
  const one = await startedBy(wa.message_id);
  assert.deepEqual([one.model, one.effort, one.mode], ['opus', 'high', 'plan']);
  const after = (await api('/crew')).find((x) => x.id === m.id);
  assert.deepEqual([after.model, after.effort, after.mode], ['sonnet', '', 'edits']);
  await settled(one.id);

  // The haiku alias in plan runs on Sonnet: their ack says so too.
  const skim = say('@ada with haiku plan: skim the logs');
  const skimmed = await answerTo(skim);
  assert.equal(skimmed.text, `▶ Ada has it · ${name} · Sonnet · Plan\n  Skim the logs\nThat model is for this job only.\nPlan runs on Sonnet here, not Haiku: the Claude CLI picks it.`);
  await settled((await startedBy(skimmed.message_id)).id);

  // What a job can't honour is refused, never ignored.
  const count = srv.store.all().length;
  for (const [text, re] of [
    ['@ada with codex go', /can’t change harness/],
    [`@ada in ${web} go`, new RegExp(`can’t move them to ${web}`)],
    ['@ada with gpt-0 go', /No model “gpt-0”/],
  ]) {
    const x = say(text);
    assert.match((await answerTo(x)).text, re, text);
  }
  assert.equal(srv.store.all().length, count);
  const own = say(`@ada in ${name} on here: their own place is fine`);
  const oa = await answerTo(own);
  assert.match(oa.text, /^▶ Ada has it/);
  await settled((await startedBy(oa.message_id)).id);

  // A follow-up on their job can't change harness either.
  const swap = reply(wa.message_id, 'with codex take over');
  assert.match((await answerTo(swap)).text, /Ada stays on Claude Code: a job can’t change harness/);
  assert.equal((await session(one.id)).agent, 'claude');

  // Paused: told, and a job you give them runs anyway.
  srv.crew.update(srv.crew.get(m.id), { paused: true });
  const held = say('@ada while paused');
  const ha = await answerTo(held);
  assert.match(ha.text, /^▶ Ada has it \(paused, this one runs anyway\) · /);
  await settled((await startedBy(skimmed.message_id)).id);
  srv.crew.update(srv.crew.get(m.id), { paused: false });

  const st = say('crew');
  const list = await until(() => net.sent.find((x) => x.text.startsWith('Crew:') && x.text.includes('@ada')));
  assert.match(list.text, /• @ada · CI watcher · /);
  assert.match(list.text.split('\n').at(-1), /^Try: @ada /);
  assert.ok(st);
});

test('@ada in a task’s thread: the mention path, the answer back in the thread', async () => {
  const id = say(`in ${name}: a task to ask about`);
  const ack = await answerTo(id);
  const s = await startedBy(ack.message_id);
  await settled(s.id);
  const ask = reply(ack.message_id, '@ada look at this');
  const said = await answerTo(ask);
  assert.match(said.text, /^▶ Ada has it/);
  const entry = await until(async () => (await session(s.id)).turns.at(-1).btw?.find((b) => b.crew?.name === 'Ada' && b.status === 'done'));
  assert.equal(entry.question, 'look at this', 'the task shows what was said');
  const job = srv.store.get(entry.job);
  assert.equal(job.crew.job, 'mention');
  assert.equal(job.remote.started, 'telegram');
  await until(() => net.sent.find((x) => x.text.startsWith('Ada: ') && job.remote.tg.includes(x.message_id)));
  assert.equal((await session(s.id)).turns.length, 1, 'the task’s own agent wasn’t interrupted');
});

test('a scheduled check-in gets no thread, and with the Phone events off nothing about it goes out', async () => {
  const m = srv.crew.find('ada');
  const n = net.sent.length;
  const events = srv.store.config.remote.events;
  srv.store.config.remote.events = [];
  const out = await srv.crew.checkin(m, { unattended: true });
  const s = out.session;
  await settled(s.id);
  await new Promise((r) => setTimeout(r, 150));
  const mark = say(': the end of the check-in test');
  await answerTo(mark);
  // Other tasks here may still report: what counts is that nothing went out about this one.
  const about = net.sent.slice(n).filter((x) => JSON.stringify(x.reply_markup || '').includes(s.id));
  srv.store.config.remote.events = events;
  assert.deepEqual(about.map((x) => x.text), [], 'nothing about the check-in');
  assert.equal(srv.store.get(s.id).crew.job, 'checkin');
  assert.equal(srv.store.get(s.id).remote?.tg, undefined);
  await settled((await startedBy((await answerTo(mark)).message_id)).id);
});

test('busy is told in the ack; a queued job keeps its run and thread across a restart, and answers there', async () => {
  const m = await api('/crew', { body: { name: 'Zed', brief: 'Watch.', cwd: api2.repo, agent: 'claude', model: 'sonnet', mode: 'edits', parallel: 1 } });
  process.env.FAKE_DELAY = '30000';
  const first = say('@zed the long job');
  const fa = await answerTo(first);
  assert.match(fa.text, /^▶ Zed has it · /);
  const running = await startedBy(fa.message_id);
  await until(async () => (await session(running.id)).state === 'running');
  const second = say('@zed with opus plan: the queued job');
  const sa = await answerTo(second);
  assert.match(sa.text, new RegExp(`^▶ Zed has it \\(queued, 1 ahead\\) · ${name} · Opus · Plan\\n  The queued job`));
  const third = say('@zed the next one');
  assert.match((await answerTo(third)).text, /\(queued, 2 ahead\)/);
  const w = srv.crew.get(m.id).queue[0];
  assert.deepEqual(w.run, { model: 'opus', mode: 'plan' });
  assert.deepEqual({ ...w.thread }, { channel: 'telegram', chat: CHAT, message: second, ack: sa.message_id });
  assert.deepEqual(w.origin, { kind: 'telegram', name: 'Telegram' });

  halt();
  delete process.env.FAKE_DELAY;
  await boot();
  const back = srv.crew.get(m.id);
  assert.equal(back.queue.length, 2, 'the queue is still there');
  assert.deepEqual(back.queue[0].thread, w.thread);
  assert.deepEqual(back.queue[0].run, w.run);

  await srv.crew.tick();
  const job = await until(() => srv.store.all().find((s) => s.crew?.id === m.id && s.turns[0]?.prompt.includes('the queued job')));
  assert.deepEqual([job.model, job.mode], ['opus', 'plan'], 'the job’s own run');
  assert.equal(job.remote.started, 'telegram');
  assert.equal(job.remote.by, 'Zed');
  assert.ok(job.remote.tg.includes(sa.message_id));
  assert.ok(job.remote.tg.includes(second));
  await settled(job.id);
  const report = await until(() => net.sent.find((x) => x.text.startsWith('Zed: ') && job.remote.tg.includes(x.message_id)));
  assert.equal(report.reply_to_message_id, sa.message_id, 'its answer goes back to the thread that started it');
  const f = reply(sa.message_id, 'one more thing');
  await answerTo(f);
  await until(async () => (await session(job.id)).turns.length === 2);
  await settled(job.id);

  // One more in the queue, on a launch that fails: the thread hears why.
  const launch = srv.crew.launch;
  const zed = srv.crew.get(m.id);
  await until(() => !zed.queue.length && srv.crew.busy(zed) === 0); // the third job ran on its own
  srv.crew.launch = () => Promise.reject(new Error('the folder is gone'));
  try {
    zed.queue.push({ id: 'waiting1', prompt: 'never starts', job: 'task', thread: { channel: 'telegram', chat: CHAT, message: second, ack: sa.message_id }, at: Date.now() });
    srv.crew.drain(zed);
    const told = await until(() => net.sent.find((x) => x.text === 'Zed couldn’t start: the folder is gone'));
    assert.ok(told.reply_to_message_id);
  } finally {
    srv.crew.launch = launch;
  }
});

test('on a box Telegram never reaches another machine: not by /new, not by a project, and none is listed', async () => {
  const c = srv.store.config;
  const was = c.machines;
  const usable = srv.machines.usable;
  c.machines = [...(c.machines || []), { id: 'm1', name: 'laptop', target: 'x' }];
  srv.machines.usable = () => true;
  const phone = srv.remote.phone;
  const far = { name: 'far', path: '/far', machine: 'm1' };
  const said = /doesn’t reach other machines/;
  assert.equal((await phone.context()).machines.length > 0, true, 'a computer has them');
  process.env.WISP_GRID_URL = 'https://grid.example';
  try {
    assert.deepEqual((await phone.context()).machines, []);
    await assert.rejects(srv.remote.launch({ project: far, prompt: 'go' }), said);
    await assert.rejects(phone.startParsed({ prompt: 'go', tagged: [], notes: [], crew: null, machine: 'm1', project: { name, path: api2.repo || '/x' } }, { channel: 'telegram', name: 'Telegram', ctx: await phone.context() }), said);
    await assert.rejects(phone.startParsed({ prompt: 'go', tagged: [], notes: [], crew: null, project: far }, { channel: 'telegram', name: 'Telegram', ctx: await phone.context() }), said);
  } finally {
    delete process.env.WISP_GRID_URL;
    c.machines = was;
    srv.machines.usable = usable;
  }
});

