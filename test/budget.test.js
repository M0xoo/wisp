// Plan budget (server/budget.js): how much of each account's usage windows is gone, from what Claude
// prints and Codex writes on every run, and when you'd run out at this pace. A usage limit asks what
// next on any harness, with the reset the CLI reported; with Wait for the reset on, the task carries
// on in the same conversation after it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeRepo, tmp, until } from './helpers.js';

// The server is set up before the first test: a top-level await after a test lets Node 22 run
// the root's after hook before this before hook, and the open server keeps the run from ending.
process.env.WISP_HOME = tmp('budget-wisp');
process.env.WISP_UPDATE_CHECK = '0';
process.env.CLAUDE_CONFIG_DIR = tmp('budget-claude-home'); // never this computer's ~/.claude
installFakeBins();
const { startServer } = await import('../server/index.js');
let srv;
let base;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
async function api(p, body, method) {
  const r = await fetch(`${base}/api${p}`, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${p}: ${j.error}`), { status: r.status });
  return j;
}
const ended = (id, state) => until(async () => {
  const x = await api(`/sessions/${id}`);
  return x.state === state && x.turns.at(-1).status !== 'running' && x;
}, { timeout: 30_000 });

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
  srv.later.stop(); // nothing fires on its own here
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

const { Budget, claudeLimits, codexLimits, codexRollout, paceOf } = await import('../server/budget.js');
const { LIMIT_CARRY_ON } = await import('../server/later.js');

const H = 3600_000;
// What Claude Code 2.1.309 printed on a real run (trimmed ids).
const CLAUDE_EVENT = {
  status: 'allowed_warning',
  resetsAt: 1793192400,
  rateLimitType: 'seven_day',
  utilization: 0.76,
  overageStatus: 'rejected',
  isUsingOverage: false,
  surpassedThreshold: 0.75,
  unifiedWindows: { five_hour: { utilization: 0.72, resetsAt: 1792982400 }, seven_day: { utilization: 0.76, resetsAt: 1793192400 } },
};

test('claude: both windows from its rate_limit_event, in ms; a refusal without a number is full', () => {
  assert.deepEqual(claudeLimits(CLAUDE_EVENT), {
    windows: [
      { id: 'five_hour', used: 0.72, resetsAt: 1792982400_000, ms: 5 * H },
      { id: 'seven_day', used: 0.76, resetsAt: 1793192400_000, ms: 7 * 24 * H },
    ],
  });
  assert.deepEqual(claudeLimits({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1792982400 }), { windows: [{ id: 'five_hour', used: 1, resetsAt: 1792982400_000, ms: 5 * H }], rejected: 'five_hour' });
  assert.equal(claudeLimits({ status: 'allowed' }), null, 'nothing to show');
  assert.equal(claudeLimits(null), null);
});

test('codex: primary and secondary from its session file, named by their length', () => {
  const rl = { primary: { used_percent: 41, window_minutes: 300, resets_at: 1792982400 }, secondary: { used_percent: 100, window_minutes: 10080, resets_at: 1793192400 }, rate_limit_reached_type: 'secondary' };
  assert.deepEqual(codexLimits(rl), {
    windows: [
      { id: 'five_hour', used: 0.41, resetsAt: 1792982400_000, ms: 5 * H },
      { id: 'seven_day', used: 1, resetsAt: 1793192400_000, ms: 7 * 24 * H },
    ],
    rejected: 'seven_day',
  });
  // A free plan's month-long window.
  assert.equal(codexLimits({ primary: { used_percent: 56, window_minutes: 43200, resets_at: 1794875575 }, secondary: null }).windows[0].id, 'w43200m');
  assert.equal(codexLimits({ primary: null }), null);

  const home = tmp('budget-codex');
  const now = new Date(2026, 9, 26, 12).getTime();
  const day = path.join(home, 'sessions', '2026', '10', '24'); // a resumed thread keeps its first day's file
  fs.mkdirSync(day, { recursive: true });
  const line = (pct) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: pct, window_minutes: 300, resets_at: 1792982400 } } } });
  const premium = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'premium', primary: null, secondary: null } } });
  fs.writeFileSync(path.join(day, 'rollout-2026-10-24T09-00-00-abc-123.jsonl'), [line(10), '{"type":"event_msg","payload":{"type":"agent_message"}}', line(35), premium, ''].join('\n'));
  assert.equal(codexRollout('abc-123', { home, now }).primary.used_percent, 35, 'the last one written (not another limit’s, with no windows)');
  assert.equal(codexRollout('nope', { home, now }), null);
  assert.equal(codexRollout('../etc', { home, now }), null, 'only an id');
});

test('pace: when the window runs out at the rate since it started, if before the reset', () => {
  const now = 1_000 * H;
  // 5-hour window, 3 h in, 72% gone: 100% about 1 h 10 min from now, before the reset in 2 h.
  const hit = paceOf({ used: 0.72, resetsAt: now + 2 * H, ms: 5 * H }, now);
  assert.equal(Math.round((hit - now) / 60_000), 70);
  assert.equal(paceOf({ used: 0.3, resetsAt: now + 2 * H, ms: 5 * H }, now), null, 'lasts past the reset');
  assert.equal(paceOf({ used: 0.5, resetsAt: now + 4.9 * H, ms: 5 * H }, now), null, 'too early to tell');
  assert.equal(paceOf({ used: 1, resetsAt: now + H, ms: 5 * H }, now), null, 'already used up');
  assert.equal(paceOf({ used: 0.5, resetsAt: now - 1, ms: 5 * H }, now), null, 'reset already');
});

test('Budget keeps each account’s windows, reads a passed reset as fresh, knows when a full one resets', () => {
  const home = tmp('budget-home');
  let now = 1_000 * H;
  let changes = 0;
  const b = new Budget(home, { now: () => now, onChange: () => changes++ });
  b.record('claude', 'default', { windows: [{ id: 'seven_day', used: 0.5, resetsAt: now + 3 * 24 * H, ms: 7 * 24 * H }, { id: 'five_hour', used: 1, resetsAt: now + H, ms: 5 * H }] });
  assert.equal(changes, 1);
  b.record('claude', 'default', { windows: [{ id: 'five_hour', used: 0.999, resetsAt: now + H, ms: 5 * H }] });
  assert.equal(changes, 1, 'the same percent: nobody told');
  assert.deepEqual(b.view('claude').map((a) => [a.account, a.windows.map((w) => w.id)]), [['default', ['five_hour', 'seven_day']]], '5-hour first');
  assert.equal(b.resetAt('claude', 'default'), now + H);
  assert.equal(b.resetAt('claude', 'other'), null);
  assert.equal(new Budget(home, { now: () => now }).view('claude')[0].windows[1].used, 0.5, 'kept on disk');
  now += 2 * H;
  const five = b.view('claude')[0].windows[0];
  assert.deepEqual([five.used, five.resetsAt, five.hitAt], [0, null, null], 'past its reset: fresh');
  assert.equal(b.resetAt('claude', 'default'), null);
  assert.deepEqual(b.view('codex'), []);
});

const limited = (reset) => ({ status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: Math.round(reset / 1000), unifiedWindows: { five_hour: { utilization: 1, resetsAt: Math.round(reset / 1000) }, seven_day: { utilization: 0.4, resetsAt: Math.round((reset + 3 * 24 * H) / 1000) } } });

test('a run’s windows reach the harness list; a limit on one account asks, with the reset the CLI said', async () => {
  const reset = Date.now() + 2 * H + 17 * 60_000;
  process.env.FAKE_LIMITS = JSON.stringify(limited(reset));
  process.env.FAKE_LIMIT_ONCE = path.join(tmp('budget-limit'), 'hit');
  try {
    const s = await api('/sessions', { prompt: 'fix the add bug please', cwd: makeRepo(), agent: 'claude', worktree: false });
    const x = await ended(s.id, 'review');
    const t = x.turns[0];
    assert.equal(t.status, 'error');
    assert.equal(t.presentation.blocks[0].title, 'Claude Code is at its usage limit', 'one account: the harness’s name');
    assert.match(t.presentation.blocks[0].summary, /^Wait for the reset, or hand/);
    assert.deepEqual(t.limit.others, []);
    assert.equal(Math.round(t.limit.until / 1000), Math.round(reset / 1000), 'the reset from the rate_limit_event, not the 9pm in the text');
    const claude = (await api('/agents')).find((a) => a.id === 'claude');
    assert.deepEqual(claude.budget.map((a) => [a.account, a.windows.map((w) => [w.id, w.used])]), [['default', [['five_hour', 1], ['seven_day', 0.4]]]]);
    assert.equal(x.later, undefined, 'Wait for the reset is off: nothing scheduled by itself');
  } finally {
    delete process.env.FAKE_LIMITS;
    delete process.env.FAKE_LIMIT_ONCE;
  }
});

test('Wait for the reset on: the task waits under Scheduled and carries on in the same conversation', async () => {
  const reset = Date.now() + 40 * 60_000;
  await api('/config', { defaults: { limitWait: 'on' } }, 'PATCH');
  process.env.FAKE_LIMITS = JSON.stringify(limited(reset));
  process.env.FAKE_LIMIT_ONCE = path.join(tmp('budget-wait'), 'hit');
  try {
    const s = await api('/sessions', { prompt: 'fix the add bug please', cwd: makeRepo(), agent: 'claude', worktree: false, confirmLimit: true }); // the test before left the 5-hour window used up: Ask near the limit would ask first
    const x = await ended(s.id, 'done');
    assert.equal(x.unread, false, 'nobody is pinged');
    assert.equal(x.later.length, 1);
    assert.equal(x.later[0].text, LIMIT_CARRY_ON);
    assert.equal(x.later[0].by, 'wisp');
    assert.ok(Math.abs(x.later[0].at - reset) < 2000, 'at the reset');
    assert.equal(x.turns[0].limit.waiting, true);
    assert.match(x.turns[0].presentation.blocks[0].summary, /carries on by itself after the reset/);
    // The reset comes: the follow-up goes into the same conversation, and this time it works.
    delete process.env.FAKE_LIMITS;
    const live = srv.store.get(s.id);
    live.later[0].at = Date.now() - 1000;
    await srv.later.tick();
    const next = await until(async () => {
      const y = await api(`/sessions/${s.id}`);
      return y.turns.length === 2 && y.turns[1].status === 'done' && y;
    }, { timeout: 30_000 });
    assert.equal(next.turns[1].prompt, LIMIT_CARRY_ON);
    assert.equal(next.later, undefined);
  } finally {
    delete process.env.FAKE_LIMITS;
    delete process.env.FAKE_LIMIT_ONCE;
    await api('/config', { defaults: { limitWait: 'off' } }, 'PATCH');
  }
});

// --- Automations stop at, and where the plan went ------------------------------------------------

const { holdWhy, stopAtOf, whereItWent, addShare, planOf } = await import('../server/budget.js');

test('hold: the window past Automations stop at, until every such window resets; off, or no reset time, holds nothing', () => {
  let now = 1_000 * H;
  const b = new Budget(tmp('budget-hold'), { now: () => now });
  b.record('claude', 'default', { windows: [{ id: 'five_hour', used: 0.8, resetsAt: now + H, ms: 5 * H }, { id: 'seven_day', used: 0.9, resetsAt: now + 50 * H, ms: 7 * 24 * H }] });
  assert.equal(stopAtOf('off'), null);
  assert.equal(stopAtOf('75'), 0.75);
  assert.equal(stopAtOf('80'), null, 'only the choices Settings offers');
  assert.equal(b.hold('claude', 'default', null), null, 'off');
  const h = b.hold('claude', 'default', 0.75);
  assert.deepEqual([h.window, h.label, h.used, h.until], ['seven_day', 'Weekly', 0.9, now + 50 * H], 'the fuller window names it; it waits for the later reset');
  assert.equal(b.hold('claude', 'default', 0.9).until, now + 50 * H, 'at the line counts');
  assert.equal(b.hold('claude', 'default', 0.95), null);
  assert.equal(b.hold('claude', 'work', 0.5), null, 'another account');
  assert.equal(holdWhy(h, 'Claude Code'), 'Claude Code’s weekly window is at 90%, past your 75%');
  assert.equal(holdWhy(h, 'Claude Code', 'Work'), 'Claude Code (Work)’s weekly window is at 90%, past your 75%');
  now += 2 * H; // the 5-hour one reset: only the weekly one holds now
  assert.equal(b.hold('claude', 'default', 0.75).window, 'seven_day');
  b.record('codex', 'default', { windows: [{ id: 'five_hour', used: 0.99, resetsAt: null, ms: 5 * H }] });
  assert.equal(b.hold('codex', 'default', 0.5), null, 'no reset time: nothing to wait for');
});

test('where it went: a window’s move is shared among the turns that ran since the last report, by how long each ran', () => {
  let now = 1_000 * H;
  const shares = [];
  const b = new Budget(tmp('budget-share'), { now: () => now, onShare: (sid, tid, x) => shares.push([sid, tid, x.window, Math.round(x.used * 1000) / 1000]) });
  const R = now + 50 * H;
  const w = (used) => ({ windows: [{ id: 'seven_day', used, resetsAt: R, ms: 7 * 24 * H }] });
  b.begin('claude', 'default', 'a', 't1');
  b.record('claude', 'default', w(0.2)); // the first report: nothing to compare with
  assert.deepEqual(shares, []);
  now += 30 * 60_000;
  b.begin('claude', 'default', 'b', 't1');
  now += 30 * 60_000;
  b.end('claude', 'default', 'a', 't1');
  b.record('claude', 'default', w(0.29)); // a ran 60 min since the last report, b 30 min
  assert.deepEqual(shares, [['a', 't1', 'seven_day', 0.06], ['b', 't1', 'seven_day', 0.03]]);
  shares.length = 0;
  now += 10 * 60_000;
  b.record('claude', 'default', w(0.31)); // a ended before this stretch: only b ran
  assert.deepEqual(shares, [['b', 't1', 'seven_day', 0.02]]);
  shares.length = 0;
  b.end('claude', 'default', 'b', 't1');
  now += 60 * 60_000;
  b.record('claude', 'default', w(0.4)); // nothing of wisp's ran: it went outside wisp
  assert.deepEqual(shares, []);
  b.begin('claude', 'default', 'c', 't1');
  b.record('claude', 'default', w(0.45)); // a run that reports the moment it starts still counts
  assert.deepEqual(shares, [['c', 't1', 'seven_day', 0.05]]);
  shares.length = 0;
  now = R + H; // a new period: all of what's used now is new
  b.record('claude', 'default', { windows: [{ id: 'seven_day', used: 0.03, resetsAt: R + 7 * 24 * H, ms: 7 * 24 * H }] });
  assert.deepEqual(shares, [['c', 't1', 'seven_day', 0.03]]);
});

test('where it went: tasks by their share of this period, a subagent’s on its lead, and how much is traced', () => {
  const R = 5_000 * H;
  const turn = (shares) => {
    const t = {};
    for (const [w, used, r = R] of shares) addShare(t, 'claude', { account: 'default', window: w, used, resetsAt: r });
    return t;
  };
  const sessions = [
    { id: 'a', title: 'Fix auth', turns: [turn([['seven_day', 0.05], ['five_hour', 0.2]]), turn([['seven_day', 0.03]])] },
    { id: 'b', title: 'Docs', turns: [turn([['seven_day', 0.01], ['seven_day', 0.04, R - 7 * 24 * H]])] }, // last week's doesn't count
    { id: 'c', title: 'helper', parentId: 'a', turns: [turn([['seven_day', 0.02]])] },
    { id: 'd', title: 'Codex task', turns: [{ plan: [{ agent: 'codex', account: 'default', window: 'seven_day', used: 0.5, resetsAt: R }] }] },
  ];
  assert.deepEqual(planOf(sessions[0]), { seven_day: 0.08, five_hour: 0.2 });
  assert.equal(planOf({ turns: [{}] }), undefined);
  const w = whereItWent(sessions, 'claude', 'default', 'seven_day', R);
  assert.deepEqual(w.tasks.map((t) => [t.id, Math.round(t.used * 100)]), [['a', 10], ['b', 1]]);
  assert.equal(Math.round(w.traced * 100), 11);
  assert.equal(w.more, 0);
  assert.equal(whereItWent(sessions, 'claude', 'default', 'seven_day', R, { limit: 1 }).more, 1);
  assert.equal(whereItWent(sessions, 'claude', 'work', 'seven_day', R), null);
});

// A plan seen on the last run: Claude Code's weekly window at 80% until R.
const seedPlan = (used = 0.8, R = Date.now() + 3 * 24 * H) => {
  srv.budget.record('claude', 'default', { windows: [{ id: 'five_hour', used: 0.1, resetsAt: Date.now() + 2 * H, ms: 5 * H }, { id: 'seven_day', used, resetsAt: R, ms: 7 * 24 * H }] });
  return R;
};

test('Automations stop at: a setting with fixed choices; what you start runs, an agent’s follow-up waits for the reset', async () => {
  await assert.rejects(api('/config', { defaults: { autoStop: '80' } }, 'PATCH'), /autoStop must be one of off, 50, 75, 90/);
  const R = seedPlan();
  await api('/config', { defaults: { autoStop: '75' } }, 'PATCH');
  try {
    const s = await api('/sessions', { prompt: 'fix the add bug please', cwd: makeRepo(), agent: 'claude', worktree: false });
    await ended(s.id, 'review'); // yours: past the line or not, it runs
    const live = srv.store.get(s.id);
    srv.later.add(live, { text: 'look at CI again', by: 'agent', in: 2 });
    srv.later.add(live, { text: 'and mine', by: 'user', in: 3 });
    for (const l of live.later) l.at = Date.now() - 1000;
    await until(() => !srv.runner.live.has(s.id)); // a follow-up waits for the CLI to let go
    await srv.later.tick();
    const x = await until(async () => {
      const y = await api(`/sessions/${s.id}`);
      return y.turns.length === 2 && y.turns[1].status === 'done' && y;
    }, { timeout: 30_000 });
    assert.equal(x.turns[1].prompt, 'and mine', 'your own scheduled follow-up went');
    assert.equal(x.later.length, 1);
    assert.equal(x.later[0].text, 'look at CI again');
    assert.equal(x.later[0].at, R, 'the agent’s waits for the reset');
    assert.equal(x.later[0].held.why, 'Claude Code’s weekly window is at 80%, past your 75%');
  } finally {
    await api('/config', { defaults: { autoStop: 'off' } }, 'PATCH');
  }
});

test('Automations stop at: a goal’s next round waits under Scheduled, then goes on at the reset; Resume sends it now', async () => {
  seedPlan();
  await api('/config', { defaults: { autoStop: '75' } }, 'PATCH');
  try {
    const s = await api('/sessions', { prompt: 'make it work', cwd: makeRepo(), agent: 'claude', mode: 'edits', goal: { text: 'it works [met after 3]' } });
    const x = await until(async () => {
      const y = await api(`/sessions/${s.id}`);
      return y.goal?.held && y;
    }, { timeout: 30_000 });
    assert.equal(x.turns.length, 1, 'round 2 didn’t start');
    assert.deepEqual([x.state, x.unread, x.goal.status, x.goal.round], ['done', false, 'paused', 2], 'under Scheduled, nobody pinged');
    assert.match(x.goal.why, /^Waits for your plan: Claude Code’s weekly window is at 80%/);
    assert.deepEqual(x.later.map((l) => [l.by, l.goal, !!l.held]), [['wisp', 2, true]]);
    // The reset comes: the round goes as wisp's, and the next one is held again (still 80% here).
    seedPlan(0.1);
    srv.store.get(s.id).later[0].at = Date.now() - 1000;
    await until(() => !srv.runner.live.has(s.id));
    await srv.later.tick(); // round 2 has started when this returns: it's checked against 80% again
    seedPlan(0.8);
    await until(async () => (await api(`/sessions/${s.id}`)).turns.length === 2, { timeout: 30_000 });
    const y = await until(async () => {
      const z = await api(`/sessions/${s.id}`);
      return z.goal?.held && z.goal.round === 3 && z;
    }, { timeout: 30_000 });
    assert.equal(y.turns[1].by, 'wisp');
    assert.equal(y.turns[1].goal, 2);
    // Resume: you said go, so round 3 goes now, without waiting.
    await api(`/sessions/${s.id}/goal`, { action: 'resume' }, 'PATCH');
    const done = await until(async () => {
      const z = await api(`/sessions/${s.id}`);
      return z.goal?.status === 'met' && z;
    }, { timeout: 30_000 });
    assert.equal(done.turns.length, 3);
    assert.equal(done.later, undefined);
  } finally {
    await api('/config', { defaults: { autoStop: 'off' } }, 'PATCH');
  }
});

test('Automations stop at: a scheduled check-in and a trigger are skipped and say why; Check in now and Run now still run', async () => {
  seedPlan();
  await api('/config', { defaults: { autoStop: '75' } }, 'PATCH');
  const repo = makeRepo();
  const m = await api('/crew', { name: 'Nell', role: 'Watcher', agent: 'claude', cwd: repo, brief: 'Look. CREWQUIET' });
  const t = await api('/triggers', { kind: 'schedule', cron: '* * * * *', prompt: 'nightly sweep', cwd: repo, agent: 'claude' });
  try {
    const before = srv.store.all().length;
    const live = srv.crew.get(m.id);
    live.wakeAt = Date.now() - 1000;
    await srv.crew.tick();
    assert.equal(srv.store.all().length, before, 'no job started');
    const nell = (await api('/crew')).find((x) => x.id === m.id);
    assert.match(nell.held.why, /weekly window is at 80%/);
    assert.ok(nell.held.until > Date.now());
    assert.equal(nell.checkins || 0, 0, 'a skipped check-in isn’t counted');
    assert.equal(nell.log[0].title, 'Skipped: waits for the plan');
    live.wakeAt = Date.now() - 1000;
    await srv.crew.tick();
    assert.equal(srv.crew.get(m.id).log.filter((e) => e.skipped).length, 1, 'skips in a row share a line');
    assert.equal(srv.crew.get(m.id).log[0].skipped, 2);
    await srv.triggers.tick();
    const tr = (await api('/triggers')).find((x) => x.id === t.id);
    assert.match(tr.held.why, /past your 75%/);
    assert.equal(tr.lastError, '', 'not a failure');
    assert.equal(srv.store.all().length, before);
    // By hand, they run.
    const { started } = await api(`/triggers/${t.id}/run`, {});
    assert.equal(started.length, 1);
    await ended(started[0].id, 'review');
    const c = await api(`/crew/${m.id}/checkin`, {});
    assert.ok(c.session?.id || c.id, 'Check in now started a job');
  } finally {
    await api(`/triggers/${t.id}`, {}, 'DELETE');
    await api('/config', { defaults: { autoStop: 'off' } }, 'PATCH');
  }
});

test('where it went, end to end: a run’s report gives the turns before it their share; the task and Settings show it', async () => {
  const R = Math.round((Date.now() + 4 * 24 * H) / 1000);
  const report = (used) => JSON.stringify({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.05, resetsAt: Math.round((Date.now() + 3 * H) / 1000) }, seven_day: { utilization: used, resetsAt: R } } });
  const cwd = makeRepo();
  // A plan of its own: the 80% the tests before left would read as an early reset, and send the
  // follow-ups they left waiting (app.resetEarly), which would take part of the move.
  delete srv.budget.state.claude;
  try {
    process.env.FAKE_LIMITS = report(0.3);
    const a = await api('/sessions', { prompt: 'fix the add bug please', title: 'Fix the add bug', cwd, agent: 'claude', worktree: false });
    await ended(a.id, 'review');
    process.env.FAKE_LIMITS = report(0.36); // the next run says 6 points went since: a's
    const b = await api('/sessions', { prompt: 'write the docs please', cwd, agent: 'claude', worktree: false });
    await ended(b.id, 'review');
    // Shared by how long each ran since the last report: a's whole turn, b's start up to its report.
    const list = await api('/sessions');
    const [pa, pb] = [a, b].map((x) => list.find((y) => y.id === x.id).plan?.seven_day || 0);
    assert.equal(Math.round((pa + pb) * 100), 6, 'on their summaries, for their details');
    assert.ok(pa > 0, 'a ran after the first report'); // which got more depends on how fast the CLI starts
    const claude = (await api('/agents')).find((x) => x.id === 'claude');
    const where = claude.budget.find((x) => x.account === 'default').where;
    assert.equal(where.window, 'seven_day', 'the longest window');
    assert.ok(where.tasks.some((t) => t.id === a.id && t.title));
    assert.equal(Math.round(where.used * 100), 36);
    assert.ok(where.traced < where.used, 'the rest ran outside wisp, or before it kept track');
  } finally {
    delete process.env.FAKE_LIMITS;
  }
});

const { stopFor, drainWhy } = await import('../server/budget.js');

test('a harness’s own Automations stop at line: same (or unset) follows autoStop, anything else wins', () => {
  assert.equal(stopFor({ autoStop: '75' }, 'claude'), 0.75);
  assert.equal(stopFor({ autoStop: '75', autoStopClaude: 'same' }, 'claude'), 0.75);
  assert.equal(stopFor({ autoStop: '75', autoStopCodex: '50' }, 'codex'), 0.5);
  assert.equal(stopFor({ autoStop: '75', autoStopCodex: 'off' }, 'codex'), null, 'off for Codex only');
  assert.equal(stopFor({ autoStop: '75', autoStopCodex: 'off' }, 'claude'), 0.75);
  assert.equal(stopFor({ autoStop: 'off', autoStopCodex: '90' }, 'codex'), 0.9);
  assert.equal(stopFor({ autoStop: '75', autoStopCodex: '80' }, 'codex'), 0.75, 'not a choice: the row above');
  assert.equal(stopFor({ autoStop: '50' }, 'opencode'), 0.5, 'a harness without its own row');
});

test('Drain watch: two hours of runs taking twice their usual share per unit of work stand out; dismiss hides it until the next run', () => {
  let now = 1_000 * H;
  const drains = [];
  const b = new Budget(tmp('budget-drain'), { now: () => now, onDrain: (agent, account, d) => drains.push([agent, account, d.id]) });
  let used = 0.1;
  const R = now + 6 * 24 * H;
  // A run: the reading before it, the one it reports 10 minutes later, then its units of work.
  const run = (du, units, opts) => {
    b.record('claude', 'default', { windows: [{ id: 'seven_day', used, resetsAt: R, ms: 7 * 24 * H }] });
    now += 10 * 60_000;
    used += du;
    b.record('claude', 'default', { windows: [{ id: 'seven_day', used, resetsAt: R, ms: 7 * 24 * H }] });
    b.spend('claude', 'default', units, opts);
  };
  for (let i = 0; i < 6; i++) run(0.01, 1), (now += 3 * H); // usual: 1 point per $1
  assert.equal(b.drain('claude', 'default'), null, 'nothing recent yet');
  run(0.03, 1);
  assert.equal(b.drain('claude', 'default'), null, 'one run is not a pattern');
  now += 20 * 60_000;
  run(0.03, 1, { failed: true });
  const d = b.drain('claude', 'default');
  assert.equal(d.id, 'seven_day');
  assert.equal(d.runs, 2);
  assert.ok(Math.abs(d.ratio - 3) < 1e-6, `3× the usual (${d.ratio})`);
  assert.ok(Math.abs(d.du - 0.06) < 1e-9 && d.units === 2);
  assert.deepEqual([d.failed.runs, Math.round(d.failed.du * 100)], [1, 3], 'the run that failed still took 3%');
  assert.deepEqual(drains, [['claude', 'default', 'seven_day']], 'told once per run that shows it');
  assert.equal(b.view('claude')[0].drain.id, 'seven_day', 'on the harness list');
  assert.match(drainWhy(d, 'Claude Code', '', 'claude'), /2 runs took 6% of Claude Code’s weekly window for \$2\.00 of work: 3\.0× its usual share .*1 of them ended in an error and still took 3%/);
  assert.equal(b.dismissDrain('claude', 'default', 'seven_day'), true);
  assert.equal(b.drain('claude', 'default'), null, 'dismissed');
  assert.equal(b.dismissDrain('claude', 'default', 'five_hour'), false, 'no such window');
  now += 5 * 60_000;
  run(0.03, 1);
  assert.equal(b.drain('claude', 'default')?.runs, 3, 'a later run shows it again');
  now += 4 * H; // two quiet hours later, the burst is history
  assert.equal(b.drain('claude', 'default'), null);
  // Not twice as fast: no card.
  run(0.015, 1);
  now += 5 * 60_000;
  run(0.015, 1);
  assert.equal(b.drain('claude', 'default'), null, 'about 1.5×');
  assert.equal(b.drain('codex', 'default'), null, 'an account with no runs');
});

test('per-harness stop and Drain watch reach the server: fixed choices, holds by harness, the card only with the switch on', async () => {
  await assert.rejects(api('/config', { defaults: { autoStopCodex: '80' } }, 'PATCH'), /autoStopCodex must be one of same, off, 50, 75, 90/);
  await assert.rejects(api('/config', { defaults: { drainWatch: 'yes' } }, 'PATCH'), /drainWatch must be on or off/);
  seedPlan(); // Claude Code's weekly at 80%
  try {
    await api('/config', { defaults: { autoStop: 'off', autoStopClaude: '75' } }, 'PATCH');
    assert.equal(srv.later.hold({ agent: 'claude', account: 'default' })?.window, 'seven_day', 'Claude’s own line holds');
    await api('/config', { defaults: { autoStop: '75', autoStopClaude: 'off' } }, 'PATCH');
    assert.equal(srv.later.hold({ agent: 'claude', account: 'default' }), null, 'off for Claude, whatever the row above says');
    await api('/config', { defaults: { autoStopClaude: 'same' } }, 'PATCH');
    assert.equal(srv.later.hold({ agent: 'claude', account: 'default' })?.window, 'seven_day', 'same: the row above');
    // A drain on the account: on the harness list only with Drain watch on.
    const acc = srv.budget.state.claude.default;
    const t = Date.now();
    acc.drain = { seven_day: [...Array.from({ length: 6 }, (_, i) => ({ at: t - (10 + i) * H, du: 0.01, units: 1 })), { at: t - 30 * 60_000, du: 0.04, units: 1 }, { at: t - 10 * 60_000, du: 0.04, units: 1 }] };
    delete acc.drainSeen;
    const card = async () => (await api('/agents')).find((a) => a.id === 'claude').budget.find((x) => x.account === 'default').drain;
    assert.equal(await card(), undefined, 'off by default');
    await api('/config', { defaults: { drainWatch: 'on' } }, 'PATCH');
    assert.equal(Math.round((await card()).ratio), 4);
    await assert.rejects(api('/agents/claude/drain/dismiss', { window: 'nope' }), (e) => e.status === 404);
    await api('/agents/claude/drain/dismiss', { window: 'seven_day' });
    assert.equal(await card(), undefined, 'dismissed');
  } finally {
    await api('/config', { defaults: { autoStop: 'off', autoStopClaude: 'same', drainWatch: 'off' } }, 'PATCH');
  }
});

const { codexLive, resetEarly } = await import('../server/budget.js');

test('an early reset: much less used and a new period, before the old reset; Codex’s drift alone isn’t one', () => {
  const now = 1_000 * H;
  const was = { used: 0.8, resetsAt: now + 3 * 24 * H };
  assert.equal(resetEarly(was, { used: 0.02, resetsAt: now + 7 * 24 * H }, now), true, 'a banked reset');
  assert.equal(resetEarly(was, { used: 0.5, resetsAt: now + 7 * 24 * H }, now), true, '30 points back');
  assert.equal(resetEarly(was, { used: 0.02, resetsAt: was.resetsAt + 2 * 60_000 }, now), false, 'drift of a few minutes');
  assert.equal(resetEarly(was, { used: 0.7, resetsAt: now + 7 * 24 * H }, now), false, 'barely lower');
  assert.equal(resetEarly({ used: 0.8, resetsAt: now - H }, { used: 0, resetsAt: now + 7 * 24 * H }, now), false, 'its reset had passed: the normal roll');
  assert.equal(resetEarly({ used: 0.03, resetsAt: now + H }, { used: 0, resetsAt: now + 6 * H }, now), false, 'nothing was used to begin with');
  assert.equal(resetEarly(undefined, { used: 0, resetsAt: now + H }, now), false);

  // Budget says so, once, and the window carries when it happened.
  let t = now;
  const resets = [];
  const b = new Budget(tmp('budget-early'), { now: () => t, onReset: (...a) => resets.push(a) });
  b.record('codex', 'default', { windows: [{ id: 'seven_day', used: 0.8, resetsAt: now + 3 * 24 * H, ms: 7 * 24 * H }] });
  t += H;
  b.record('codex', 'default', { windows: [{ id: 'seven_day', used: 0.01, resetsAt: t + 7 * 24 * H, ms: 7 * 24 * H }] });
  assert.deepEqual(resets, [['codex', 'default', ['seven_day']]]);
  assert.equal(b.view('codex')[0].windows[0].earlyAt, t);
  t += H;
  b.record('codex', 'default', { windows: [{ id: 'seven_day', used: 0.03, resetsAt: now + H + 7 * 24 * H, ms: 7 * 24 * H }] });
  assert.equal(resets.length, 1, 'the next report of the same period isn’t another');
  assert.equal(b.view('codex')[0].windows[0].earlyAt, now + H, 'still says when');
});

test('codex: what its app-server reads live becomes the same windows a run reports', () => {
  const res = { rateLimits: { limitId: 'premium', primary: null }, rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1792982400 }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1793192400 }, rateLimitReachedType: 'rate_limit_reached' } } };
  assert.deepEqual(codexLive(res), { windows: [{ id: 'five_hour', used: 0.12, resetsAt: 1792982400_000, ms: 5 * H }, { id: 'seven_day', used: 1, resetsAt: 1793192400_000, ms: 7 * 24 * H }], rejected: 'seven_day' });
  assert.equal(codexLive({ rateLimits: { primary: { usedPercent: 40, windowDurationMins: 43200, resetsAt: 1794875575 } } }).windows[0].id, 'w43200m', 'no per-limit list: rateLimits');
  assert.equal(codexLive(null), null);
  assert.equal(codexLive({ rateLimits: { primary: null, secondary: null } }), null);
});

test('early reset, end to end: a follow-up held for the plan and one waiting at a limit go at once; Check Codex while work waits reads only then', async () => {
  const R = seedPlan(); // Claude Code's weekly at 80%
  await api('/config', { defaults: { autoStop: '75' } }, 'PATCH');
  try {
    const s = await api('/sessions', { prompt: 'fix the add bug please', cwd: makeRepo(), agent: 'claude', worktree: false });
    await ended(s.id, 'review');
    await until(() => !srv.runner.live.has(s.id));
    const live = srv.store.get(s.id);
    srv.later.add(live, { text: 'look at CI again', by: 'agent', in: 2 });
    for (const l of live.later) l.at = Date.now() - 1000;
    await srv.later.tick();
    assert.equal(live.later[0].at, R, 'held for the plan');
    // The weekly window resets early (a run's report, or a live read): the follow-up goes now.
    srv.budget.record('claude', 'default', { windows: [{ id: 'seven_day', used: 0.02, resetsAt: Date.now() + 7 * 24 * H, ms: 7 * 24 * H }] });
    const x = await until(async () => {
      const y = await api(`/sessions/${s.id}`);
      return y.turns.length === 2 && y.turns[1].status === 'done' && y;
    }, { timeout: 30_000 });
    assert.equal(x.turns[1].prompt, 'look at CI again');
    assert.equal(x.later, undefined);
    // One waiting at a limit (Wait for the reset) on another account comes due when that one resets.
    const lim = srv.later.add(srv.store.get(s.id), { text: 'carry on', by: 'wisp', in: 600, limit: { agent: 'claude', account: 'work' } });
    assert.equal(srv.later.pullForward('claude', 'default', () => true), 0, 'another account: stays');
    assert.equal(srv.later.pullForward('claude', 'work', () => false), 0, 'still held there: stays');
    assert.equal(srv.later.pullForward('claude', 'work', () => true), 1);
    assert.ok(lim.at <= Date.now());
    srv.store.get(s.id).later = undefined;

    // Check Codex while work waits: off, or nothing waiting on Codex, reads nothing.
    let reads = 0;
    srv.liveLimits.read = async () => (reads++, { rateLimits: { primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 5 * 3600 } } });
    assert.equal(await srv.liveLimits.tick(), 0);
    await api('/config', { defaults: { liveLimits: 'on' } }, 'PATCH');
    await assert.rejects(api('/config', { defaults: { liveLimits: 'yes' } }, 'PATCH'), /liveLimits must be on or off/);
    assert.equal(await srv.liveLimits.tick(), 0, 'nothing waits on Codex');
    const c = srv.store.get(s.id);
    c.later = [{ id: 'l1', at: Date.now() + 3600_000, text: 'go on', by: 'wisp', setAt: Date.now(), limit: { agent: 'codex', account: 'default' } }];
    assert.equal(await srv.liveLimits.tick(), 1);
    assert.equal(reads, 1);
    assert.equal(srv.budget.windows('codex', 'default')[0].used, 0.03, 'its windows, as Codex said');
    assert.equal(await srv.liveLimits.tick(), 0, 'not again for 10 minutes');
    c.later = undefined;
  } finally {
    await api('/config', { defaults: { autoStop: 'off', liveLimits: 'off' } }, 'PATCH');
  }
});

test('spare allowance: /agents carries what the home card needs, and the switch only takes on or off', async () => {
  await assert.rejects(api('/config', { defaults: { spareCard: 'yes' } }, 'PATCH'), /spareCard must be on or off/);
  const { spareOf } = await import('../web/js/spare.js');
  const R = seedPlan(0.4, Date.now() + 10 * H); // Claude Code's weekly: 60% left, resets in 10 hours
  const cards = spareOf(await api('/agents'));
  const c = cards.find((x) => x.agent === 'claude');
  assert.ok(c, 'a card for Claude Code');
  assert.equal(c.window, 'seven_day');
  assert.equal(Math.round(c.left * 100), 60);
  assert.equal(c.resetsAt, R);
  assert.equal(c.account, '', 'the CLI’s own login: the launcher keeps its account');
  assert.ok(!cards.some((x) => x.window === 'five_hour'), 'a 5-hour window always resets soon: never a card');
  await api('/config', { defaults: { spareCard: 'off' } }, 'PATCH');
  assert.equal((await api('/config')).defaults.spareCard, 'off');
  await api('/config', { defaults: { spareCard: 'on' } }, 'PATCH');
  seedPlan(); // back to the other tests' plan
});
