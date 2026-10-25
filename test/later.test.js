// Later (server/later.js): follow-ups into the same task, reminders and tasks at a set time. The
// clock is moved by hand: entries are put in the past, then tick() runs.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeRepo, records, tmp, until } from './helpers.js';

process.env.WISP_HOME = tmp('later-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.WISP_NO_OPEN = '1';
const rec = tmp('later-rec');
process.env.FAKE_RECORD = rec;
installFakeBins();
const { startServer } = await import('../server/index.js');
const { whenOf, laterNote, CHAIN_MAX } = await import('../server/later.js');
const { parseWhen } = await import('../web/js/when.js');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let srv;
let base;
before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
  srv.later.stop(); // the tests tick it themselves
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

async function api(p, body, method = body ? 'POST' : 'GET', headers = {}) {
  const r = await fetch(`${base}/api${p}`, { method, headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${p}: ${j.error}`), { status: r.status });
  return j;
}
const ended = (id, turns = 1) =>
  until(async () => {
    const x = await api(`/sessions/${id}`);
    return x.turns.length >= turns && x.state !== 'running' && x.turns.at(-1)?.status !== 'running' && x;
  });
const task = async (prompt = 'look at math.js') => {
  const s = await api('/sessions', { prompt, cwd: makeRepo(), agent: 'claude', worktree: false });
  await ended(s.id);
  return srv.store.get(s.id);
};
const past = (s) => s.later.forEach((l) => (l.at = Date.now() - 1000));

test('whenOf: minutes or a time, within a minute and a month', () => {
  const now = Date.UTC(2026, 9, 25, 12);
  assert.equal(whenOf({ in: 5 }, { now }), now + 5 * 60_000);
  assert.equal(whenOf({ at: now + 3600_000 }, { now }), now + 3600_000);
  assert.equal(whenOf({ at: '2026-10-25T14:00Z' }, { now }), Date.UTC(2026, 9, 25, 14));
  assert.throws(() => whenOf({ in: 0 }, { now }), /at least a minute/);
  assert.throws(() => whenOf({ in: 60 * 24 * 40 }, { now }), /within a month/);
  assert.throws(() => whenOf({}, { now }), /Say when/);
});

test('a scheduled follow-up resumes the same task, with a note only the agent reads', async () => {
  const s = await task();
  const agentSession = s.agentSessionId;
  const l = await api(`/sessions/${s.id}/later`, { in: 10, text: 'check the run again' });
  assert.equal(l.by, 'user');
  assert.equal((await api('/sessions')).find((x) => x.id === s.id).later[0].text, 'check the run again');
  past(s);
  await srv.later.tick();
  const done = await ended(s.id, 2);
  const turn = done.turns.at(-1);
  assert.equal(turn.prompt, 'check the run again'); // the bubble: just the message
  assert.equal(turn.later.by, 'user');
  assert.equal(done.later, undefined);
  const last = records(rec, 'claude').at(-1);
  assert.match(JSON.stringify(last), /this is the follow-up the user scheduled/);
  assert.match(JSON.stringify(last), new RegExp(agentSession)); // resumed, not a new conversation
});

test('held while the task asks you; archived lapses; Send now goes at once', async () => {
  const s = await task();
  await api(`/sessions/${s.id}/later`, { in: 10, text: 'go on' });
  past(s);
  s.ask = { id: 'q1', question: 'Which one?' };
  await srv.later.tick();
  assert.equal(s.later.length, 1, 'kept while it asks');
  assert.ok(srv.later.nextAt() === null || srv.later.nextAt() >= Date.now(), 'never a time in the past');
  delete s.ask;
  s.archived = true;
  await srv.later.tick();
  assert.equal(s.later, undefined, 'archived: it lapses');
  delete s.archived;
  const l = await api(`/sessions/${s.id}/later`, { in: 30, text: 'now please' });
  await api(`/sessions/${s.id}/later`, { item: l.id, now: true }, 'PATCH');
  assert.equal((await ended(s.id, 2)).turns.at(-1).prompt, 'now please');
});

test('the agent schedules with resume_later; marking done drops its wake-ups, keeps yours; the chain has a cap', async () => {
  const s = await task();
  const internal = (body) => api('/internal/later', { session: s.id, ...body }, 'POST', { 'x-wisp-token': srv.token });
  const out = await internal({ minutes: 15, message: 'see if CI went green' });
  assert.match(out.text, /Scheduled \(id \w+\)/);
  await api(`/sessions/${s.id}/later`, { in: 60, text: 'mine' });
  await assert.rejects(internal({ at: '2026-10-25T14:30', message: 'x' }), /offset/);
  await api(`/sessions/${s.id}`, { state: 'done' }, 'PATCH');
  assert.deepEqual(s.later.map((l) => l.text), ['mine']);
  s.laterChain = CHAIN_MAX;
  await assert.rejects(internal({ minutes: 5, message: 'again' }), /in a row/);
  // A message from you resets it.
  await api(`/sessions/${s.id}/reply`, { text: 'carry on' });
  await ended(s.id, 2);
  assert.equal(s.laterChain, undefined);
});

test('a reminder on a task brings it back to Needs you, and snoozes', async () => {
  const s = await task();
  await api(`/sessions/${s.id}`, { state: 'done' }, 'PATCH');
  await api(`/sessions/${s.id}/later`, { in: 60, text: 'review the PR', remind: true });
  past(s);
  await srv.later.tick();
  assert.equal(s.state, 'review');
  assert.equal(s.unread, true);
  assert.equal(s.reminder.text, 'review the PR');
  assert.equal(s.turns.length, 1, 'no agent run');
  await api(`/sessions/${s.id}/later`, { item: 'reminder', in: 10 }, 'PATCH');
  assert.equal(s.reminder, undefined);
  assert.equal(s.state, 'done');
  assert.equal(s.later[0].remind, true);
});

test('plans: a task starts when due; a reminder becomes a task with no agent', async () => {
  const cwd = makeRepo();
  const p = await api('/later', { kind: 'task', in: 5, prompt: 'run the e2e suite', cwd, agent: 'claude', worktree: false });
  assert.equal(p.title, 'run the e2e suite');
  assert.equal((await api('/config')).later.length, 1);
  srv.store.config.later[0].at = Date.now() - 1000;
  await srv.later.tick();
  assert.equal(srv.store.config.later.length, 0);
  const started = await until(() => srv.store.all().find((x) => x.turns[0]?.prompt === 'run the e2e suite'));
  assert.equal(started.origin.kind, 'later');

  await api('/later', { kind: 'reminder', in: 60, text: 'call the bank' });
  srv.store.config.later[0].at = Date.now() - 1000;
  await srv.later.tick();
  const r = srv.store.all().find((x) => x.kind === 'reminder');
  assert.equal(r.state, 'review');
  assert.equal(r.title, 'call the bank');
  await assert.rejects(api(`/sessions/${r.id}/reply`, { text: 'do it' }), /no agent/);
  // Snoozed: back to a plan, and the task goes.
  await api(`/sessions/${r.id}/later`, { item: 'reminder', in: 10 }, 'PATCH');
  assert.equal(srv.store.get(r.id), undefined);
  assert.equal(srv.store.config.later[0].text, 'call the bank');
  await api(`/later/${srv.store.config.later[0].id}`, null, 'DELETE');
  assert.equal(srv.store.config.later.length, 0);
});

test('a day late: a task becomes a missed reminder, a follow-up waits for you', async () => {
  await api('/later', { kind: 'task', in: 5, prompt: 'nightly audit', cwd: makeRepo(), agent: 'claude' });
  srv.store.config.later[0].at = Date.now() - 30 * 3600_000;
  await srv.later.tick();
  assert.ok(srv.store.all().some((x) => x.kind === 'reminder' && /Missed: “nightly audit”/.test(x.title)));
  const s = await task();
  await api(`/sessions/${s.id}/later`, { in: 10, text: 'stale check' });
  s.later[0].at = Date.now() - 30 * 3600_000;
  await srv.later.tick();
  assert.equal(s.turns.length, 1);
  assert.match(s.reminder.text, /Missed follow-up/);
});

test('the late note tells the agent to re-check', () => {
  const now = Date.now();
  assert.match(laterNote({ by: 'agent', setAt: now - 3 * 3600_000, at: now - 3600_000, late: true }, now), /60 min late/);
});

test('status reports the next wake-up for a host to start wisp', async () => {
  const s = await task();
  await api(`/sessions/${s.id}/later`, { in: 7, text: 'x' });
  const st = await api('/status');
  assert.ok(st.nextWakeAt && st.nextWakeAt <= s.later[0].at);
});

test('parseWhen: a leading time, or a trailing one after "remind me"', () => {
  const now = new Date(2026, 9, 25, 14, 30); // Sun 14:30, local
  const p = parseWhen('in 5 minutes run the e2e suite', now);
  assert.equal(p.at, now.getTime() + 5 * 60_000);
  assert.equal(p.rest, 'run the e2e suite');
  assert.equal(p.reminder, false);
  assert.equal(parseWhen('in 2h, check the deploy', now).rest, 'check the deploy');
  assert.equal(parseWhen('tomorrow at 9 check the nightly', now).at, new Date(2026, 9, 26, 9).getTime());
  assert.equal(parseWhen('at 4pm ship it', now).at, new Date(2026, 9, 25, 16).getTime());
  assert.equal(parseWhen('at 9:15 standup notes', now).at, new Date(2026, 9, 26, 9, 15).getTime(), 'a time already past is tomorrow');
  const r = parseWhen('remind me to review Lena’s PR in 1 hour', now);
  assert.equal(r.reminder, true);
  assert.equal(r.rest, 'review Lena’s PR');
  assert.equal(r.at, now.getTime() + 3600_000);
  assert.equal(parseWhen('in 30 min remind me about the standup', now).rest, 'the standup');
  // Ordinary work that mentions a time is left alone.
  for (const t of ['make the cron run at 2pm', 'fix the banner that says tomorrow at 9', 'in the header, fix the logo', 'at least add a test', 'in 5']) assert.equal(parseWhen(t, now), null, t);
});
