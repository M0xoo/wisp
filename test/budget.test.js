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
const { consoleProfile, forgetAuthStatus, profileIn } = await import('../server/adapters/claude.js');
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
  // Nothing fires on its own here: a test calls tick() itself. A timer left running starts a test's
  // trigger whenever it lands, and on a loaded machine that's mid-test (triggers tick every 20 s).
  for (const timer of [srv.later, srv.triggers, srv.crew, srv.liveLimits]) timer.stop();
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
    complete: true, // unifiedWindows lists every window (window changes)
  });
  assert.deepEqual(claudeLimits({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1792982400 }), { windows: [{ id: 'five_hour', used: 1, resetsAt: 1792982400_000, ms: 5 * H }], rejected: 'five_hour' });
  assert.equal(claudeLimits({ status: 'allowed' }), null, 'nothing to show');
  assert.equal(claudeLimits(null), null);
});

test('codex: primary and secondary from its session file, named by their length', () => {
  const rl = { primary: { used_percent: 41, window_minutes: 300, resets_at: 1792982400 }, secondary: { used_percent: 100, window_minutes: 10080, resets_at: 1793192400 }, rate_limit_reached_type: 'secondary' };
  assert.deepEqual(codexLimits(rl), {
    windows: [
      { id: 'five_hour', used: 0.41, resetsAt: 1792982400_000, ms: 5 * H, slot: 'primary' },
      { id: 'seven_day', used: 1, resetsAt: 1793192400_000, ms: 7 * 24 * H, slot: 'secondary' },
    ],
    complete: true,
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

test('closed periods: a window’s new period keeps the last one’s reading', () => {
  let now = 1_000 * H;
  const b = new Budget(tmp('budget-periods'), { now: () => now });
  const WEEK = 7 * 24 * H;
  const report = (used, resetsAt) => b.record('claude', 'default', { windows: [{ id: 'seven_day', used, resetsAt, ms: WEEK }] });
  const first = now + 24 * H;
  report(0.2, first);
  report(0.6, first);
  assert.deepEqual(b.periods('claude', 'default', 'seven_day'), [], 'the same period closes nothing');
  now = first + H;
  report(0.03, first + WEEK);
  assert.deepEqual(b.periods('claude', 'default', 'seven_day'), [{ resetsAt: first, ms: WEEK, used: 0.6 }]);
  assert.deepEqual(new Budget(b.file.replace(/budget\.json$/, ''), { now: () => now }).periods('claude', 'default', 'seven_day').length, 1, 'kept on disk');
  assert.deepEqual(b.periods('claude', 'other', 'seven_day'), []);
  // Codex's drifting "in n seconds" is the same period.
  report(0.04, first + WEEK + 60_000);
  assert.equal(b.periods('claude', 'default', 'seven_day').length, 1);
});

test('closed periods: an early reset is cut, and a report out of order merges', () => {
  let now = 1_000 * H;
  const b = new Budget(tmp('budget-cut'), { now: () => now });
  const WEEK = 7 * 24 * H;
  const report = (used, resetsAt) => b.record('codex', 'default', { windows: [{ id: 'seven_day', used, resetsAt, ms: WEEK }] });
  const [a, c] = [now + 3 * 24 * H, now + 7 * 24 * H];
  report(0.5, a);
  report(0.02, c); // a banked reset: its old reset hadn't come
  assert.deepEqual(b.periods('codex', 'default', 'seven_day'), [{ resetsAt: a, ms: WEEK, used: 0.5, cut: true }]);
  // A run that started before reports the old period again, higher, once it's really over.
  now = a + H;
  report(0.7, a);
  report(0.03, c);
  now = c + H;
  report(0.4, c); // the same period as c, still current
  report(0.01, c + WEEK);
  assert.deepEqual(b.periods('codex', 'default', 'seven_day').map((p) => [p.resetsAt, p.used, !!p.cut]), [[a, 0.7, false], [c, 0.4, false]], 'the higher reading, a real close clears cut, sorted');
});

test('closed periods: forty are kept per window', () => {
  let now = 1_000 * H;
  const b = new Budget(tmp('budget-keep'), { now: () => now });
  for (let i = 0; i < 45; i++) {
    b.record('claude', 'default', { windows: [{ id: 'five_hour', used: 0.1 + i / 100, resetsAt: now + H, ms: 5 * H }] });
    now += 2 * H;
  }
  const list = b.periods('claude', 'default', 'five_hour');
  assert.equal(list.length, 40);
  assert.ok(list.every((p, i) => !i || p.resetsAt > list[i - 1].resetsAt), 'oldest first');
  assert.ok(Math.abs(list.at(-1).used - 0.53) < 1e-9, 'the newest stay');
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
  assert.deepEqual(codexLive(res), { windows: [{ id: 'five_hour', used: 0.12, resetsAt: 1792982400_000, ms: 5 * H, slot: 'primary' }, { id: 'seven_day', used: 1, resetsAt: 1793192400_000, ms: 7 * 24 * H, slot: 'secondary' }], complete: true, rejected: 'seven_day' });
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

// --- One read before held-back Codex work (createLiveLimits' before) --------------------------------

const { createLiveLimits } = await import('../server/live-limits.js');
const MIN = 60_000;
// What Codex's app-server answers with its weekly window at `used` percent.
const codexAnswer = (used, now = Date.now()) => ({ rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: used, windowDurationMins: 10080, resetsAt: Math.floor((now + 3 * 24 * H) / 1000) } } } });
// A reader on its own clock, with no server. h.reads: the accounts it read, in order.
function reader({ defaults = { autoStop: '75' }, read, envFor } = {}) {
  const h = { now: 5_000 * H, reads: [] };
  h.budget = new Budget(tmp('live-before'), { now: () => h.now });
  h.live = createLiveLimits({
    store: { config: { defaults } },
    budget: h.budget,
    accounts: { supports: () => false, envFor: envFor || ((agent, id) => ({ CODEX_HOME: id })) },
    waiting: () => true,
    now: () => h.now,
    read: async (env) => {
      h.reads.push(env.CODEX_HOME);
      return read ? read(env) : codexAnswer(80, h.now);
    },
  });
  h.report = (id = 'default', used = 0.1) => h.budget.record('codex', id, { windows: [{ id: 'seven_day', used, resetsAt: h.now + 3 * 24 * H, ms: 7 * 24 * H }] });
  return h;
}

test('before: no reading or one over 15 minutes old takes a read; a younger one takes none', async () => {
  const h = reader();
  await h.live.before('codex', '');
  assert.deepEqual(h.reads, ['default'], 'no reading at all is stale');
  assert.equal(h.budget.windows('codex', 'default')[0].used, 0.8, 'its numbers, as Codex said');
  await h.live.before('codex', 'default');
  h.now += 14 * MIN;
  await h.live.before('codex', 'default');
  assert.equal(h.reads.length, 1, 'still fresh');
  h.now += MIN;
  await h.live.before('codex', 'default');
  assert.equal(h.reads.length, 2, '15 minutes on: another');
  h.now += 16 * MIN;
  h.report(); // a run reported just now
  await h.live.before('codex', 'default');
  assert.equal(h.reads.length, 2, 'a run’s report is a fresh reading too');
});

test('before: a failed read resolves, says so, and isn’t tried again for 15 minutes', async (t) => {
  const warned = t.mock.method(console, 'warn', () => {});
  for (const [what, opts] of [['a read that throws', { read: () => { throw new Error('signed out'); } }], ['no usable answer', { read: () => null }], ['an env that throws', { envFor: () => { throw new Error('no such account'); } }]]) {
    warned.mock.resetCalls();
    const h = reader(opts);
    h.report();
    h.now += 20 * MIN;
    await assert.doesNotReject(h.live.before('codex', 'default'), what);
    assert.equal(warned.mock.callCount(), 1, `${what}: warned`);
    assert.match(String(warned.mock.calls[0].arguments[0]), /^wisp: codex usage: /, what);
    assert.equal(h.budget.windows('codex', 'default')[0].used, 0.1, `${what}: the reading stands`);
    const was = h.reads.length;
    h.now += 14 * MIN;
    await h.live.before('codex', 'default');
    assert.equal(h.reads.length, was, `${what}: not again yet`);
    assert.equal(warned.mock.callCount(), 1, `${what}: nothing new to say`);
    h.now += MIN;
    await h.live.before('codex', 'default');
    assert.equal(warned.mock.callCount(), 2, `${what}: tried again after 15 minutes`);
  }
});

test('before: only Codex, only with a stop line; Check Codex while work waits doesn’t come into it', async () => {
  for (const [defaults, n, why] of [
    [{ autoStop: 'off' }, 0, 'no stop line'],
    [{}, 0, 'nothing set'],
    [{ autoStop: '75', autoStopCodex: 'off' }, 0, 'off for Codex only'],
    [{ autoStop: 'off', autoStopCodex: '90' }, 1, 'a line for Codex only'],
    [{ autoStop: '75', liveLimits: 'off' }, 1, 'the polling switch off'],
  ]) {
    const h = reader({ defaults });
    await h.live.before('codex', 'default');
    assert.equal(h.reads.length, n, why);
  }
  const h = reader();
  await h.live.before('claude', 'default');
  await h.live.before('', 'default');
  assert.deepEqual(h.reads, [], 'Claude Code has no such read');
});

test('before: callers at once share one read, and each account has its own', async () => {
  let open;
  const held = new Promise((r) => (open = r));
  const h = reader({ read: () => held.then(() => codexAnswer(80, h.now)) });
  const both = [h.live.before('codex', 'work'), h.live.before('codex', 'work'), h.live.before('codex', 'home'), h.live.before('codex', '')];
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(h.reads, ['work', 'home', 'default']);
  open();
  await Promise.all(both);
  assert.deepEqual(Object.keys(h.budget.state.codex).sort(), ['default', 'home', 'work']);
  assert.equal(h.reads.length, 3);
});

test('before and tick share the 15 minutes: a tick’s failed read counts, and a tick’s read is no run’s report', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let fail = true;
  const h = reader({ defaults: { autoStop: '75', liveLimits: 'on' }, read: () => {
    if (fail) throw new Error('offline');
    return { rateLimits: { primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: R / 1000 } } };
  } });
  const R = h.now + 3 * 24 * H;
  const report = () => h.budget.record('codex', 'default', { windows: [{ id: 'seven_day', used: 0.1, resetsAt: R, ms: 7 * 24 * H }] });
  report();
  h.now += 20 * MIN;
  await h.live.tick();
  assert.equal(h.reads.length, 1);
  await h.live.before('codex', 'default');
  assert.equal(h.reads.length, 1, 'the tick’s try counts');
  // The window moved 30 points with no run in the last 20 minutes: not the next run's to carry.
  h.now += 15 * MIN;
  fail = false;
  report();
  h.now += 20 * MIN;
  await h.live.tick();
  assert.equal(h.budget.state.codex.default.learn, undefined);
  assert.equal(h.budget.state.codex.default.run, undefined);
});

test('a read is no run’s report: what moved in the gap isn’t learned, a run’s report in that gap still learns', () => {
  let now = 6_000 * H;
  const R = now + 3 * 24 * H;
  const at = (used) => ({ windows: [{ id: 'seven_day', used, resetsAt: R, ms: 7 * 24 * H }] });
  const read = new Budget(tmp('record-read'), { now: () => now });
  read.record('codex', 'default', at(0.1));
  now += 20 * MIN;
  read.record('codex', 'default', { ...at(0.3), read: true });
  assert.equal(read.state.codex.default.learn, undefined);
  assert.equal(read.state.codex.default.run, undefined);
  assert.equal(read.windows('codex', 'default')[0].used, 0.3, 'the numbers still land');
  assert.equal(read.state.codex.default.at, now, 'and count as the latest reading');
  const run = new Budget(tmp('record-run'), { now: () => now });
  run.record('codex', 'default', at(0.1));
  now += 20 * MIN;
  run.record('codex', 'default', at(0.3));
  assert.ok(Math.abs(run.state.codex.default.learn.seven_day.du - 0.2) < 1e-9);
  assert.ok(Math.abs(run.state.codex.default.run.seven_day - 0.2) < 1e-9);
});

// The server's Codex reading, 20 minutes old and under the line, and no tries on record.
const staleCodex = (used = 0.1) => {
  delete srv.budget.state.codex;
  srv.budget.record('codex', 'default', { windows: [{ id: 'seven_day', used, resetsAt: Date.now() + 3 * 24 * H, ms: 7 * 24 * H }] });
  srv.budget.state.codex.default.at = Date.now() - 20 * MIN;
  srv.liveLimits.tried.clear();
};
// fn(reader): reader.n counts reads, reader.answer is what the next one says (a function may throw).
async function withStop(fn, defaults = { autoStop: '75' }) {
  const real = srv.liveLimits.read;
  const r = { n: 0, answer: () => codexAnswer(80) };
  srv.liveLimits.read = async () => (r.n++, r.answer());
  await api('/config', { defaults }, 'PATCH');
  try {
    await fn(r);
  } finally {
    srv.liveLimits.read = real;
    await api('/config', { defaults: { autoStop: 'off', autoStopCodex: 'same', liveLimits: 'off' } }, 'PATCH');
    delete srv.budget.state.codex;
  }
}
const codexTask = async () => {
  const s = await api('/sessions', { prompt: 'fix the add bug please', cwd: makeRepo(), agent: 'codex', worktree: false });
  await ended(s.id, 'review');
  await until(() => !srv.runner.live.has(s.id));
  return srv.store.get(s.id);
};
// This trigger's schedule comes due, and no other's.
const runTrigger = async (t) => {
  const list = srv.store.config.triggers;
  const was = list.map((x) => x.enabled);
  list.forEach((x) => Object.assign(x, { enabled: x.id === t.id, lastMinute: null }));
  await srv.triggers.tick();
  list.forEach((x, i) => (x.enabled = was[i]));
  return (await api('/triggers')).find((x) => x.id === t.id);
};

test('a held-back launch: a stale reading under the line, the read says over it: skipped; a failed read runs as today', async (t) => {
  const warned = t.mock.method(console, 'warn', () => {});
  const repo = makeRepo();
  const tr = await api('/triggers', { kind: 'schedule', cron: '* * * * *', prompt: 'nightly sweep', cwd: repo, agent: 'codex' });
  const m = await api('/crew', { name: 'Nora', role: 'Watcher', agent: 'codex', cwd: repo, brief: 'Look. CREWQUIET' });
  try {
    await withStop(async (r) => {
      staleCodex();
      const before = srv.store.all().length;
      const held = await runTrigger(tr);
      assert.equal(r.n, 1, 'one read');
      assert.match(held.held.why, /past your 75%/, 'launch said 409: the trigger skips and says why');
      assert.equal(held.lastError, '');
      assert.equal(srv.store.all().length, before, 'nothing started');
      // A crew check-in goes through the same launch: fresh now, so no second read, and held.
      srv.crew.get(m.id).wakeAt = Date.now() - 1000;
      await srv.crew.tick();
      assert.equal(r.n, 1);
      assert.match((await api('/crew')).find((x) => x.id === m.id).held.why, /past your 75%/);
      assert.equal(srv.store.all().length, before);
      // No new card: nothing asks, nothing lands in Needs you.
      assert.equal(srv.store.all().filter((s) => s.ask || s.reminder).length, 0);

      staleCodex();
      r.answer = () => {
        throw new Error('codex app-server stopped');
      };
      r.n = 0;
      const ran = await runTrigger(tr);
      assert.equal(r.n, 1);
      assert.equal(ran.lastError, '');
      assert.equal(srv.store.all().length, before + 1, 'it ran, as it would have');
      await ended(ran.lastSessionId, 'review');
      assert.ok(warned.mock.calls.some((c) => /codex app-server stopped/.test(c.arguments[0])));
      await until(() => !srv.runner.live.has(ran.lastSessionId));
      srv.budget.state.codex.default.at = Date.now() - 20 * MIN; // whatever that run reported
      await runTrigger(tr);
      assert.equal(r.n, 1, 'no second read within 15 minutes');
      await ended((await api('/triggers')).find((x) => x.id === tr.id).lastSessionId, 'review');
    });
  } finally {
    await api(`/triggers/${tr.id}`, {}, 'DELETE');
    await api(`/crew/${m.id}`, {}, 'DELETE');
  }
});

test('a launch that isn’t held back reads nothing: a fresh reading, no line, Claude Code, by hand; the crew view never reads', async () => {
  const repo = makeRepo();
  const tr = await api('/triggers', { kind: 'schedule', cron: '* * * * *', prompt: 'nightly sweep', cwd: repo, agent: 'codex' });
  const cl = await api('/triggers', { kind: 'schedule', cron: '* * * * *', prompt: 'nightly sweep', cwd: repo, agent: 'claude' });
  const m = await api('/crew', { name: 'Noor', role: 'Watcher', agent: 'codex', cwd: repo, brief: 'Look. CREWQUIET' });
  try {
    const go = async (x) => {
      const out = await runTrigger(x);
      await ended(out.lastSessionId, 'review');
      await until(() => !srv.runner.live.has(out.lastSessionId));
    };
    await withStop(async (r) => {
      srv.budget.record('claude', 'default', { windows: [{ id: 'seven_day', used: 0.1, resetsAt: Date.now() + 3 * 24 * H, ms: 7 * 24 * H }] });
      staleCodex();
      await api('/crew'); // Crew.view calls reserve.check on every render
      assert.equal(r.n, 0, 'the crew view');
      const held = (await api(`/crew`)).find((x) => x.id === m.id);
      assert.equal(held.held, undefined);
      const s = await codexTask();
      assert.equal(r.n, 0, 'started by hand');
      await api(`/sessions/${s.id}`);
      staleCodex();
      await api(`/triggers/${tr.id}/run`, {});
      assert.equal(r.n, 0, 'Run now');
      await until(() => srv.store.all().filter((x) => x.origin?.id === tr.id).every((x) => !srv.runner.live.has(x.id)));
      staleCodex();
      await go(cl);
      assert.equal(r.n, 0, 'Claude Code has no such read');
      staleCodex();
      srv.budget.state.codex.default.at = Date.now() - 14 * MIN;
      await go(tr);
      assert.equal(r.n, 0, 'a reading under 15 minutes old');
    });
    await withStop(async (r) => {
      staleCodex();
      await go(tr);
      assert.equal(r.n, 0, 'no stop line');
    }, { autoStop: 'off' });
    await withStop(async (r) => {
      staleCodex();
      r.answer = () => codexAnswer(10);
      await go(tr);
      assert.equal(r.n, 1, 'Check Codex while work waits off, a stop line on: still reads');
    }, { autoStop: '75', liveLimits: 'off' });
  } finally {
    await api(`/triggers/${tr.id}`, {}, 'DELETE');
    await api(`/triggers/${cl.id}`, {}, 'DELETE');
    await api(`/crew/${m.id}`, {}, 'DELETE');
  }
});

test('a held-back follow-up: read first, moved to the reset in silence; yours or a reminder reads nothing; a failed read sends it', async (t) => {
  t.mock.method(console, 'warn', () => {});
  await withStop(async (r) => {
    const s = await codexTask();
    const pasts = () => s.later.forEach((l) => (l.at = Date.now() - 1000));
    srv.later.add(s, { text: 'mine', by: 'user', in: 2 });
    srv.later.add(s, { text: 'ping me', by: 'agent', in: 2, remind: true });
    pasts();
    srv.later.add(s, { text: 'not yet', by: 'agent', in: 5 });
    staleCodex();
    const nothing = s.later.find((l) => l.text === 'not yet');
    s.later = s.later.filter((l) => l === nothing);
    await srv.later.tick();
    assert.equal(r.n, 0, 'not due');
    s.later = [];
    srv.later.add(s, { text: 'ping me', by: 'agent', in: 2, remind: true });
    pasts();
    await srv.later.tick();
    assert.equal(r.n, 0, 'a reminder runs nothing');
    delete s.reminder;
    s.state = 'review';
    s.later = [];
    srv.later.add(s, { text: 'mine', by: 'user', in: 2 });
    pasts();
    await srv.later.tick();
    assert.equal(r.n, 0, 'yours goes whatever the plan says');
    await ended(s.id, 'review');
    await until(() => !srv.runner.live.has(s.id));

    staleCodex();
    const turns = s.turns.length;
    const { unread } = s;
    s.later = [];
    srv.later.add(s, { text: 'look at CI again', by: 'agent', in: 2 });
    pasts();
    await srv.later.tick();
    assert.equal(r.n, 1, 'one read');
    assert.equal(s.turns.length, turns, 'held');
    assert.ok(s.later[0].at > Date.now() + 24 * H, 'moved to the reset');
    assert.match(s.later[0].held.why, /weekly window is at 80%, past your 75%/);
    assert.deepEqual([s.ask, s.reminder, s.unread], [undefined, undefined, unread], 'no new card');

    staleCodex();
    r.answer = () => {
      throw new Error('offline');
    };
    r.n = 0;
    s.later = [];
    srv.later.add(s, { text: 'carry on then', by: 'agent', in: 2 });
    pasts();
    await srv.later.tick();
    assert.equal(r.n, 1);
    const x = await until(async () => {
      const y = await api(`/sessions/${s.id}`);
      return y.turns.length === turns + 1 && y.turns.at(-1).status === 'done' && y;
    }, { timeout: 30_000 });
    assert.equal(x.turns.at(-1).prompt, 'carry on then', 'as it would have');
  });
});

test('a held-back trigger follow-up to an open task: read first, skipped; Run now reads nothing; a failed read sends it', async (t) => {
  t.mock.method(console, 'warn', () => {});
  await withStop(async (r) => {
    const s = await codexTask();
    s.state = 'review';
    const tr = { id: 'tr-open', kind: 'ci', name: 'CI', prompt: 'CI failed on {branch}', tasks: { 'wisp/x': s.id } };
    staleCodex();
    await assert.rejects(srv.triggers.fire(tr, { branch: 'wisp/x' }), (e) => /past your 75%/.test(e.message) && !!e.held);
    assert.equal(r.n, 1);
    assert.equal(s.turns.length, 1);
    staleCodex(0.8);
    r.n = 0;
    await srv.triggers.fire(tr, { branch: 'wisp/x' }, { manual: true });
    assert.equal(r.n, 0, 'by hand: no read');
    await until(() => s.turns.length === 2 && s.turns[1].status === 'done', { timeout: 30_000 });
    await until(() => !srv.runner.live.has(s.id));
    s.state = 'review';
    staleCodex();
    r.answer = () => {
      throw new Error('offline');
    };
    const out = await srv.triggers.fire(tr, { branch: 'wisp/x' });
    assert.equal(r.n, 1);
    assert.equal(out.followUp, true, 'as it would have');
    await until(() => s.turns.length === 3 && s.turns[2].status === 'done', { timeout: 30_000 });
  });
});

test('a held-back goal round: read first, the round waits under Scheduled; a failed read sends it', async (t) => {
  t.mock.method(console, 'warn', () => {});
  await withStop(async (r) => {
    staleCodex();
    srv.budget.state.codex.default.at = Date.now() - 20 * MIN;
    const s = await api('/sessions', { prompt: 'make it work', cwd: makeRepo(), agent: 'codex', mode: 'edits', goal: { text: 'it works [met after 2]' } });
    const x = await until(async () => {
      const y = await api(`/sessions/${s.id}`);
      return y.goal?.held && y;
    }, { timeout: 30_000 });
    assert.equal(r.n, 1, 'one read');
    assert.equal(x.turns.length, 1, 'round 2 didn’t start');
    assert.deepEqual([x.state, x.unread, x.goal.status, x.goal.round], ['done', false, 'paused', 2], 'under Scheduled, nobody pinged');
    assert.match(x.goal.why, /^Waits for your plan: /);

    staleCodex();
    r.n = 0;
    r.answer = () => {
      throw new Error('offline');
    };
    const b = await api('/sessions', { prompt: 'make it work', cwd: makeRepo(), agent: 'codex', mode: 'edits', goal: { text: 'it works [met after 2]' } });
    const done = await until(async () => {
      const y = await api(`/sessions/${b.id}`);
      return y.goal?.status === 'met' && y;
    }, { timeout: 30_000 });
    assert.equal(r.n, 1);
    assert.equal(done.turns.length, 2, 'round 2 went');
  });
});

test('a goal dropped during the read doesn’t start its round', async () => {
  await withStop(async (r) => {
    let open;
    const held = new Promise((y) => (open = y));
    staleCodex();
    r.answer = () => held.then(() => codexAnswer(10));
    const s = await api('/sessions', { prompt: 'make it work', cwd: makeRepo(), agent: 'codex', mode: 'edits', goal: { text: 'it works [met after 3]' } });
    await until(() => r.n === 1, { timeout: 30_000 });
    await api(`/sessions/${s.id}/goal`, { action: 'pause' }, 'PATCH');
    open();
    await new Promise((y) => setTimeout(y, 50));
    const x = await api(`/sessions/${s.id}`);
    assert.equal(x.turns.length, 1);
    assert.equal(x.goal.status, 'paused');
    assert.equal(x.goal.round, 1, 'its round wasn’t counted');
  });
});

// --- codexLive: a limit that moved to a new id ---------------------------------------------------

const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;
const snap = (used, resetsIn, more = {}) => ({ primary: { usedPercent: used, windowDurationMins: 300, resetsAt: NOW_S + resetsIn }, ...more });
const usedOf = (res) => codexLive(res, { now: NOW_MS })?.windows[0].used;

test('codexLive: the normal codex entry wins over a later side bucket; a reset just gone isn’t frozen', () => {
  const res = { rateLimits: snap(1, 90_000), rateLimitsByLimitId: { codex: snap(50, 3600), codex_bengalfox: snap(2, 90_000, { normalModelSlug: 'gpt-x' }), other: snap(3, 90_000) } };
  assert.equal(usedOf(res), 0.5);
  assert.equal(usedOf({ rateLimitsByLimitId: { codex: snap(50, -240), other: snap(3, 90_000) } }), 0.5, 'clock skew: 4 minutes back');
  assert.equal(usedOf({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: null } }, other: snap(3, 90_000) } }), 0.5, 'no resets at all: not frozen');
});

test('codexLive: a frozen codex entry gives way to a newer entry or to rateLimits', () => {
  assert.equal(usedOf({ rateLimitsByLimitId: { codex: snap(50, -3600), plus: snap(7, 3600) } }), 0.07, 'a new id');
  assert.equal(usedOf({ rateLimits: snap(9, 3600), rateLimitsByLimitId: { codex: snap(50, -3600) } }), 0.09, 'rateLimits');
  assert.equal(usedOf({ rateLimits: snap(9, 3600), rateLimitsByLimitId: { codex: snap(50, -3600), plus: snap(7, 7200) } }), 0.07, 'the latest reset');
  assert.equal(usedOf({ rateLimitsByLimitId: { codex: { primary: snap(50, 3600).primary, secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: NOW_S - 3600 } }, plus: snap(7, 3600) } }), 0.07, 'one window gone is enough');
});

test('codexLive: a frozen codex entry stays when all there is are side buckets', () => {
  const frozen = snap(50, -3600);
  assert.equal(usedOf({ rateLimitsByLimitId: { codex: frozen, spark: snap(2, 3600, { normalModelSlug: 'gpt-x' }) } }), 0.5, 'a model’s own bucket');
  assert.equal(usedOf({ rateLimitsByLimitId: { codex: frozen, premium: snap(2, 3600) } }), 0.5, 'premium');
  assert.equal(usedOf({ rateLimits: snap(2, 3600, { limitId: 'premium' }), rateLimitsByLimitId: { codex: frozen } }), 0.5, 'premium in rateLimits');
  assert.equal(usedOf({ rateLimits: frozen, rateLimitsByLimitId: { codex: frozen, plus: snap(2, -7200) } }), 0.5, 'as frozen as it is');
  assert.equal(usedOf({ rateLimitsByLimitId: { codex: frozen, plus: { primary: null } } }), 0.5, 'no usable window');
});

test('codexLive: no codex entry reads rateLimits; garbage reads nothing', () => {
  assert.equal(usedOf({ rateLimits: snap(9, 3600) }), 0.09);
  assert.equal(usedOf({ rateLimits: snap(9, -3600), rateLimitsByLimitId: { other: snap(3, 3600) } }), 0.09, 'as today');
  for (const res of [null, undefined, 'x', 3, {}, { rateLimits: 'x' }, { rateLimitsByLimitId: 'x' }, { rateLimitsByLimitId: { codex: 7 } }]) assert.equal(codexLive(res, { now: NOW_MS }), null, JSON.stringify(res));
  assert.equal(usedOf({ rateLimitsByLimitId: { codex: snap(50, -3600), x: null, y: 'z', w: 3 } }), 0.5, 'junk beside it');
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

test('window changes: /agents carries the notice, × hides it, the switch hides them all and only takes on or off', async () => {
  await assert.rejects(api('/config', { defaults: { windowNotice: 'yes' } }, 'PATCH'), /windowNotice must be on or off/);
  const at = Date.now() + 2 * 24 * H;
  const report = (R) => srv.budget.record('codex', 'default', codexLimits({ primary: { used_percent: 5, window_minutes: 300, resets_at: (Date.now() + 2 * H) / 1000 }, secondary: { used_percent: 30, window_minutes: 10080, resets_at: R / 1000 } }));
  report(at);
  report(at + 12 * H); // the weekly now resets 12 hours later than it did
  const codexOf = async () => (await api('/agents')).find((a) => a.id === 'codex');
  const notes = (a) => (a.budget || []).flatMap((b) => b.notices || []);
  let [n] = notes(await codexOf());
  assert.equal(n?.kind, 'reset');
  assert.equal(n.window, 'seven_day');
  await api('/config', { defaults: { windowNotice: 'off' } }, 'PATCH');
  assert.deepEqual(notes(await codexOf()), [], 'off: the API leaves them out too');
  await api('/config', { defaults: { windowNotice: 'on' } }, 'PATCH');
  await assert.rejects(api('/agents/codex/windows/dismiss', { window: 'five_hour' }), (e) => e.status === 404);
  assert.deepEqual(await api('/agents/codex/windows/dismiss', { account: 'default', window: 'seven_day' }), { ok: true });
  assert.deepEqual(notes(await codexOf()), []);
});

// --- Plan windows with no 5-hour window (Claude Ultra since 2026-11) -----------------------------

test('only a weekly window: no 5-hour row, Wait until picks the weekly reset, Automations stop at waits for it', () => {
  let now = 2_000 * H;
  const b = new Budget(tmp('budget-weekly-only'), { now: () => now });
  const R = now + 3 * 24 * H;
  const ev = (used, status = 'allowed') => claudeLimits({ status, rateLimitType: 'seven_day', utilization: used, resetsAt: R / 1000, unifiedWindows: { seven_day: { utilization: used, resetsAt: R / 1000 } } });
  b.record('claude', 'default', ev(0.4));
  const v = b.view('claude')[0];
  assert.deepEqual(v.windows.map((w) => w.id), ['seven_day'], 'no empty 5-hour row');
  assert.equal(v.notices, undefined, 'the first report only sets what was seen');
  assert.equal(b.resetAt('claude', 'default'), null, 'not at its limit');
  now += H;
  b.record('claude', 'default', ev(1, 'rejected'));
  assert.equal(b.resetAt('claude', 'default'), R, 'Wait until: the weekly reset');
  assert.equal(b.hold('claude', 'default', 0.75).until, R);
  assert.equal(b.hold('claude', 'default', 0.75).label, 'Weekly');
  assert.deepEqual(b.windows('claude', 'default').map((w) => w.id), ['seven_day']);
});

test('the 5-hour window goes: its row leaves once it resets, the change is told once over a day of polls', () => {
  let now = 3_000 * H;
  let changes = 0;
  const b = new Budget(tmp('budget-five-gone'), { now: () => now, onChange: () => changes++ });
  const R7 = now + 4 * 24 * H;
  const both = claudeLimits({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.3, resetsAt: (now + H) / 1000 }, seven_day: { utilization: 0.2, resetsAt: R7 / 1000 } } });
  b.record('claude', 'default', both);
  assert.deepEqual(b.view('claude')[0].windows.map((w) => w.id), ['five_hour', 'seven_day']);
  // From now on every report lists the weekly window alone, every 10 minutes for a day.
  const told = [];
  for (let i = 1; i <= 6 * 24; i++) {
    now += 10 * 60_000;
    b.record('claude', 'default', claudeLimits({ status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.2 + i / 1000, resetsAt: R7 / 1000 } } }));
    const v = b.view('claude')[0];
    for (const n of v.notices || []) if (!told.some((x) => x.window === n.window && x.at === n.at)) told.push(n);
    // Before the 5-hour one's reset its last numbers still hold; after it, no empty bar.
    if (now > 3_000 * H + H) assert.deepEqual(v.windows.map((w) => w.id), ['seven_day'], `poll ${i}: no stale 5-hour row`);
  }
  assert.deepEqual(told.map((n) => [n.kind, n.window]), [['gone', 'five_hour']], 'told once, not on every poll');
  assert.ok(b.dismissNotice('claude', 'default', 'five_hour'));
  const before = changes;
  for (let i = 0; i < 12; i++) {
    now += 10 * 60_000;
    b.record('claude', 'default', claudeLimits({ status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.4, resetsAt: R7 / 1000 } } }));
  }
  assert.equal(b.view('claude')[0].notices, undefined, 'dismissed stays dismissed');
  assert.ok(changes - before <= 1, 'same numbers: nobody told');
  assert.equal(b.resetAt('claude', 'default'), null);
});

test('Codex reporting only its weekly window (primary empty) has no 5-hour row', () => {
  const now = Date.now();
  const b = new Budget(tmp('budget-codex-weekly'), { now: () => now });
  const R = Math.round((now + 2 * 24 * H) / 1000);
  b.record('codex', 'default', codexLimits({ primary: null, secondary: { used_percent: 100, window_minutes: 10080, resets_at: R } }));
  assert.deepEqual(b.view('codex')[0].windows.map((w) => w.id), ['seven_day']);
  assert.equal(b.resetAt('codex', 'default'), R * 1000, 'Wait until: the weekly reset');
});

// --- A Codex account with no 5-hour window -----------------------------------------------------------

// Secondary sources say Pro has none; OpenAI hasn't said, nor how the answer would look. So each shape
// it could take: the weekly window in either slot, or beside a slot with no length.
const WEEK_MS = 7 * 24 * H;
const weekly = (used, resetsAt) => ({ usedPercent: used, windowDurationMins: 10080, resetsAt: Math.floor(resetsAt / 1000) });
const NO_FIVE = {
  'weekly first': (w) => ({ limitId: 'codex', primary: w, secondary: null }),
  'weekly second': (w) => ({ limitId: 'codex', primary: null, secondary: w }),
  'an empty slot first': (w) => ({ limitId: 'codex', primary: { usedPercent: 0, windowDurationMins: null, resetsAt: null }, secondary: w }),
};
const shapes = Object.entries(NO_FIVE);
const answer = (shape, used, resetsAt) => ({ rateLimitsByLimitId: { codex: shape(weekly(used, resetsAt)) } });

test('no 5-hour window: codexLive reads the one weekly bar, whichever slot it’s in', () => {
  const R = NOW_MS + 3 * 24 * H;
  for (const [name, shape] of shapes) {
    const l = codexLive(answer(shape, 40, R), { now: NOW_MS });
    assert.deepEqual(l.windows.map(({ id, used, resetsAt, ms }) => ({ id, used, resetsAt, ms })), [{ id: 'seven_day', used: 0.4, resetsAt: R, ms: WEEK_MS }], name);
    assert.equal(l.complete, true, `${name}: it lists every window, so an old 5-hour one can go`);
    assert.equal(l.rejected, undefined, name);
    assert.equal(codexLive(answer(shape, 100, R), { now: NOW_MS }).rejected, 'seven_day', `${name}: full`);
    assert.equal(codexLive({ rateLimits: shape(weekly(40, R)) }, { now: NOW_MS }).windows[0].id, 'seven_day', `${name}: under rateLimits alone`);
    let now = NOW_MS;
    const b = new Budget(tmp('no-five-bars'), { now: () => now });
    b.record('codex', 'default', { ...l, read: true });
    const v = b.view('codex')[0];
    assert.deepEqual(v.windows.map((w) => [w.id, w.label, w.used, w.ms]), [['seven_day', 'Weekly', 0.4, WEEK_MS]], `${name}: one bar, no empty 5-hour row`);
    assert.deepEqual(b.windows('codex', 'default').map((w) => w.id), ['seven_day'], name);
    now = R + 1;
    assert.deepEqual(b.view('codex')[0].windows.map((w) => [w.used, w.resetsAt]), [[0, null]], `${name}: past its reset it reads as fresh`);
  }
});

test('no 5-hour window: frozen goes by the weekly reset alone', () => {
  const skew = 4 * 60_000;
  const later = NOW_MS + 3 * 24 * H;
  for (const [name, shape] of shapes) {
    const moved = (ours, theirs) => usedOf({ rateLimitsByLimitId: { codex: shape(weekly(ours, NOW_MS - H)), plus: shape(weekly(theirs, later)) } });
    assert.equal(moved(50, 7), 0.07, `${name}: reset gone, the new id takes over`);
    assert.equal(usedOf({ rateLimits: shape(weekly(9, later)), rateLimitsByLimitId: { codex: shape(weekly(50, NOW_MS - H)) } }), 0.09, `${name}: or rateLimits`);
    assert.equal(usedOf({ rateLimitsByLimitId: { codex: shape(weekly(50, later)), plus: shape(weekly(7, later + H)) } }), 0.5, `${name}: a live entry stays, whatever else is listed`);
    assert.equal(usedOf({ rateLimitsByLimitId: { codex: shape(weekly(50, NOW_MS - skew)), plus: shape(weekly(7, later)) } }), 0.5, `${name}: clock skew isn’t frozen`);
    assert.equal(usedOf({ rateLimitsByLimitId: { codex: shape(weekly(50, NOW_MS - H)), spark: shape(weekly(2, later)) } }), 0.02, `${name}: an id we don’t know is the new limit`);
    assert.equal(usedOf({ rateLimitsByLimitId: { codex: shape(weekly(50, NOW_MS - H)), spark: { ...shape(weekly(2, later)), normalModelSlug: 'gpt-x' } } }), 0.5, `${name}: a model’s own bucket never takes over`);
  }
  // A frozen 5-hour-and-weekly entry whose successor has no 5-hour window: the account is on it now.
  const old = { primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: NOW_S - 3600 }, secondary: weekly(50, later) };
  const next = codexLive({ rateLimitsByLimitId: { codex: old, plus: NO_FIVE['weekly first'](weekly(7, later)) } }, { now: NOW_MS });
  assert.deepEqual(next.windows.map((w) => [w.id, w.used]), [['seven_day', 0.07]]);
});

test('no 5-hour window: the stale read and hold, whichever slot the week is in', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const [name, shape] of shapes) {
    let used = 80;
    let fail = false;
    const h = reader({
      read: () => {
        if (fail) throw new Error('offline');
        return answer(shape, used, R());
      },
    });
    const start = h.now;
    const R = () => start + 3 * 24 * H;
    const go = async () => {
      await h.live.before('codex', 'default');
      return h.budget.hold('codex', 'default', 0.75);
    };
    const held = await go();
    assert.deepEqual(h.reads, ['default'], `${name}: no reading reads`);
    assert.deepEqual([held.window, held.label, held.used, held.until], ['seven_day', 'Weekly', 0.8, R()], `${name}: it waits for the weekly reset`);
    assert.equal(holdWhy(held, 'Codex'), 'Codex’s weekly window is at 80%, past your 75%', name);
    h.now += 14 * MIN;
    used = 10;
    assert.ok(await go(), `${name}: 14 minutes on the reading stands`);
    assert.equal(h.reads.length, 1, name);
    h.now += MIN;
    assert.equal(await go(), null, `${name}: the read frees it`);
    assert.equal(h.reads.length, 2, name);
    used = 90;
    h.now += 15 * MIN;
    fail = true;
    assert.equal(await go(), null, `${name}: a failed read goes on what wisp knew`);
    assert.equal(h.budget.windows('codex', 'default')[0].used, 0.1, name);
    fail = false;
    h.now += 15 * MIN;
    assert.ok(await go(), `${name}: the line again`);
    h.now = R() + 1;
    fail = true;
    assert.equal(await go(), null, `${name}: past the reset an old reading holds nothing, even if the read fails`);
    assert.equal(h.budget.resetAt('codex', 'default'), null, name);
  }
});

test('no 5-hour window: a frozen weekly entry with nothing to replace it holds nothing once its reset is gone', async () => {
  for (const [name, shape] of shapes) {
    const h = reader({ read: () => answer(shape, 90, h.now - H) });
    h.budget.record('codex', 'default', { windows: [{ id: 'seven_day', used: 0.9, resetsAt: h.now - H, ms: WEEK_MS }] });
    h.now += 16 * MIN;
    await h.live.before('codex', 'default');
    assert.equal(h.reads.length, 1, name);
    assert.equal(h.budget.hold('codex', 'default', 0.75), null, `${name}: wisp can’t say until when`);
    assert.equal(h.budget.windows('codex', 'default')[0].used, 0, `${name}: the bar reads fresh, not 90%`);
  }
});

test('no 5-hour window: a banked weekly reset the read finds lets held work go', async () => {
  for (const [name, shape] of shapes) {
    let R;
    let used = 80;
    const h = reader({ read: () => answer(shape, used, R) });
    R = h.now + 3 * 24 * H;
    const resets = [];
    h.budget.onReset = (agent, account, ids) => resets.push([agent, account, ids]);
    await h.live.before('codex', 'default');
    assert.ok(h.budget.hold('codex', 'default', 0.75), name);
    h.now += 16 * MIN;
    used = 0;
    R = h.now + 7 * 24 * H;
    await h.live.before('codex', 'default');
    assert.deepEqual(resets, [['codex', 'default', ['seven_day']]], name);
    assert.equal(h.budget.hold('codex', 'default', 0.75), null, name);
  }
});

test('an account loses its 5-hour window: told once as gone, never as a length change; the weekly period goes on', () => {
  for (const [name, shape] of shapes) {
    let now = 7_000 * H;
    const b = new Budget(tmp('no-five-loses'), { now: () => now });
    const R7 = now + 4 * 24 * H;
    const R5 = now + 2 * H;
    const fiveW = { usedPercent: 90, windowDurationMins: 300, resetsAt: Math.floor(R5 / 1000) };
    b.record('codex', 'default', { ...codexLive({ rateLimits: { primary: fiveW, secondary: weekly(30, R7) } }, { now }), read: true });
    assert.deepEqual(b.view('codex')[0].windows.map((w) => w.id), ['five_hour', 'seven_day'], name);
    const report = (used) => b.record('codex', 'default', { ...codexLive(answer(shape, used, R7), { now }), read: true });
    now += 10 * MIN;
    report(31);
    const v = b.view('codex')[0];
    assert.equal(v.notices, undefined, `${name}: not told yet: a report can skip one`);
    assert.deepEqual(v.windows.map((w) => [w.id, w.used]), [['five_hour', 0.9], ['seven_day', 0.31]], `${name}: its last numbers stand until its reset`);
    assert.equal(b.hold('codex', 'default', 0.75).until, R5, `${name}: at worst the old 5-hour window holds until its own reset`);
    assert.equal(b.hold('codex', 'default', 0.75).label, '5-hour', name);
    now = R5 + 1;
    report(32);
    assert.deepEqual(b.view('codex')[0].windows.map((w) => w.id), ['seven_day'], `${name}: past its reset, no empty row`);
    assert.equal(b.hold('codex', 'default', 0.75), null, name);
    assert.equal(b.resetAt('codex', 'default'), null, name);
    const told = [];
    for (let i = 0; i < 6 * 24; i++) {
      now += 10 * 60_000;
      report(33);
      for (const n of b.view('codex')[0].notices || []) if (!told.some((x) => x.window === n.window && x.at === n.at)) told.push(n);
    }
    assert.deepEqual(told.map((n) => [n.kind, n.window]), [['gone', 'five_hour']], `${name}: told once`);
    assert.equal(b.state.codex.default.windows.five_hour, undefined, name);
    assert.deepEqual(b.periods('codex', 'default', 'seven_day'), [], `${name}: the weekly period never closed`);
    assert.equal(b.windows('codex', 'default')[0].resetsAt, R7, name);
    assert.equal(b.windows('codex', 'default')[0].used, 0.33, name);
  }
});

test('an account gets its 5-hour window back: told as new, the weekly window untouched', () => {
  for (const [name, shape] of shapes) {
    let now = 8_000 * H;
    const b = new Budget(tmp('no-five-back'), { now: () => now });
    const R7 = now + 4 * 24 * H;
    b.record('codex', 'default', codexLive(answer(shape, 30, R7), { now }));
    now += H;
    b.record('codex', 'default', codexLive({ rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: Math.floor((now + 4 * H) / 1000) }, secondary: weekly(31, R7) } }, { now }));
    const v = b.view('codex')[0];
    assert.deepEqual(v.windows.map((w) => [w.id, w.used]), [['five_hour', 0.05], ['seven_day', 0.31]], name);
    assert.deepEqual(v.notices.map((n) => [n.kind, n.window]), [['new', 'five_hour']], name);
  }
});

// --- Past your plan: runs billed beyond the plan's windows -----------------------------------------

test('past your plan: Claude’s extra usage and a Codex credit drop flag the run; “overage” is never a window', () => {
  const x = claudeLimits({ ...CLAUDE_EVENT, isUsingOverage: true, overageStatus: 'allowed' });
  assert.equal(x.overage, true);
  assert.deepEqual(x.windows.map((w) => w.id), ['five_hour', 'seven_day']);
  assert.equal(claudeLimits(CLAUDE_EVENT).overage, undefined, 'isUsingOverage false: on the plan');
  const only = claudeLimits({ status: 'allowed', rateLimitType: 'overage', utilization: 0.2, isUsingOverage: true });
  assert.deepEqual(only, { windows: [], overage: true }, 'the extra-usage allowance is not a plan window');
  assert.equal(claudeLimits({ status: 'rejected', rateLimitType: 'overage', utilization: 1 }), null);

  let now = 4_000 * H;
  let changes = 0;
  const b = new Budget(tmp('budget-over'), { now: () => now, onChange: () => changes++ });
  assert.equal(b.record('claude', 'default', x), 'extra');
  assert.equal(b.record('claude', 'default', claudeLimits(CLAUDE_EVENT)), null);
  assert.equal(b.record('claude', 'default', only), 'extra', 'no windows, still flagged');

  const rl = (balance) => ({ secondary: { used_percent: 100, window_minutes: 10080, resets_at: Math.round((now + 24 * H) / 1000) }, credits: { has_credits: true, unlimited: false, balance } });
  assert.equal(codexLimits(rl('12.5')).credits, 12.5);
  assert.equal(codexLimits({ ...rl('1'), credits: { unlimited: true, balance: null } }).credits, undefined);
  assert.equal(b.record('codex', 'default', codexLimits(rl('12.5'))), null, 'the first balance only sets it');
  assert.equal(b.record('codex', 'default', codexLimits(rl('12.5'))), null, 'unchanged');
  assert.equal(b.record('codex', 'default', codexLimits(rl('11.75'))), 'credits', 'went down: this run took credits');
  assert.equal(b.record('codex', 'default', codexLimits(rl('20'))), null, 'topped up');

  // Plan budget counts them for a week, once per turn, and names the last one's task.
  b.overage('claude', 'default', 'extra', 's1', 't1');
  b.overage('claude', 'default', 'extra', 's1', 't1');
  now += H;
  b.overage('claude', 'default', 'api', 's2', 't1');
  assert.deepEqual(b.view('claude')[0].overage, { runs: 2, at: now, kind: 'api', sid: 's2' });
  assert.ok(changes > 0);
  now += 7 * 24 * H - H / 2;
  assert.deepEqual(b.view('claude')[0].overage, { runs: 1, at: now - 7 * 24 * H + H / 2, kind: 'api', sid: 's2' }, 'older than a week: gone');
});

const { receiptOf, receiptParts, tokenWords } = await import('../web/js/receipt.js');

test('usage receipt: tokens with Anthropic’s cache counted apart, OpenAI’s inside; the longest window; Past your plan', () => {
  // Claude: 2k fresh + 30k read from cache + 4k written to it, 2k out.
  const c = receiptOf({ stats: { inputTokens: 2000, cacheReadTokens: 30000, cacheWriteTokens: 4000, outputTokens: 2000 }, plan: [{ window: 'five_hour', used: 0.12 }, { window: 'seven_day', used: 0.031 }] });
  assert.equal(c.tokens, 38000);
  assert.equal(Math.round(c.cache * 100), 83);
  assert.deepEqual(receiptParts(c), ['38k tokens', '83% cache', '3% of weekly'], 'the weekly window, not the 5-hour one');
  // Codex: input_tokens holds the cached ones.
  const x = receiptOf({ stats: { inputTokens: 100000, cachedInputTokens: 71000, outputTokens: 1500 } });
  assert.deepEqual(receiptParts(x), ['102k tokens', '71% cache']);
  // Only a weekly window (no 5-hour): that's the one on the line; a month-long one beats it.
  assert.deepEqual(receiptParts(receiptOf({ plan: [{ window: 'seven_day', used: 0.002 }] })), ['<1% of weekly']);
  assert.deepEqual(receiptParts(receiptOf({ plan: [{ window: 'seven_day', used: 0.1 }, { window: 'w43200m', used: 0.05 }] })), ['5% of 30-day']);
  // Two shares of the same window (two periods, two accounts) add up.
  assert.deepEqual(receiptParts(receiptOf({ plan: [{ window: 'seven_day', used: 0.02 }, { window: 'seven_day', used: 0.01 }] })), ['3% of weekly']);
  assert.equal(receiptOf({ stats: { inputTokens: 1000 }, overage: { kind: 'extra' } }).overage, 'extra');
  assert.equal(receiptOf({ stats: {}, overage: { kind: 'nonsense' } }), null, 'nothing to say');
  assert.equal(receiptOf({}), null);
  assert.deepEqual(receiptParts(receiptOf({ stats: { inputTokens: 10, cacheReadTokens: 31000, cacheWriteTokens: 20, outputTokens: 5 } })), ['31k tokens', '99% cache'], 'not all of it: never 100%');
  assert.deepEqual([tokenWords(820), tokenWords(38400), tokenWords(1_250_000), tokenWords(12_000_000)], ['820', '38k', '1.3M', '12M']);
});

test('past your plan, end to end: a run on extra usage or an API key is flagged on its turn and in Plan budget; the receipt’s tokens land on it', async () => {
  delete srv.budget.state.claude;
  const cwd = makeRepo();
  try {
    process.env.FAKE_LIMITS = JSON.stringify({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 1, isUsingOverage: true, overageStatus: 'allowed', resetsAt: Math.round((Date.now() + 2 * 24 * H) / 1000), unifiedWindows: { seven_day: { utilization: 1, resetsAt: Math.round((Date.now() + 2 * 24 * H) / 1000) } } });
    process.env.FAKE_CACHE_READ = '3000';
    const a = await api('/sessions', { prompt: 'fix the add bug please', cwd, agent: 'claude', worktree: false });
    const x = await ended(a.id, 'review');
    assert.equal(x.turns[0].overage?.kind, 'extra');
    assert.deepEqual([x.turns[0].stats.cacheReadTokens, x.turns[0].stats.cacheWriteTokens], [3000, 20]);
    const claude = (await api('/agents')).find((y) => y.id === 'claude');
    const over = claude.budget.find((y) => y.account === 'default').overage;
    assert.deepEqual([over.runs, over.kind, over.sid], [1, 'extra', a.id]);
    assert.deepEqual(claude.budget.find((y) => y.account === 'default').windows.map((w) => w.id), ['seven_day']);

    delete process.env.FAKE_LIMITS;
    delete process.env.FAKE_CACHE_READ;
    delete srv.budget.state.claude; // the weekly window at 100% would hold the next launch
    process.env.FAKE_API_KEY_SOURCE = 'ANTHROPIC_API_KEY';
    const b = await api('/sessions', { prompt: 'write the docs please', cwd, agent: 'claude', worktree: false });
    assert.equal((await ended(b.id, 'review')).turns[0].overage?.kind, 'api');
    process.env.FAKE_API_KEY_SOURCE = 'none';
    const c = await api('/sessions', { prompt: 'write the docs again please', cwd, agent: 'claude', worktree: false });
    assert.equal((await ended(c.id, 'review')).turns[0].overage, undefined, 'on the plan: no flag');
  } finally {
    delete process.env.FAKE_LIMITS;
    delete process.env.FAKE_CACHE_READ;
    delete process.env.FAKE_API_KEY_SOURCE;
  }
});

// A Console sign-in (check-in 30 §1): Claude Code falls back to an `ant` or keyless Console profile
// when the claude.ai login stops working, and stream-json never says. `claude auth status --text`'s
// Profile: line does: a notice on the turn and in Plan budget, never a hold, never in the run's way.
const PROFILE = 'credentials-file · user_oauth · profile default';
const authEnv = ['FAKE_AUTH_PROFILE', 'FAKE_AUTH_FAIL', 'FAKE_AUTH_DELAY', 'FAKE_RECORD'];

test('console profile: the Profile: line of `claude auth status --text`, cached a minute per account folder', async () => {
  assert.equal(profileIn(`Login method: Claude Console account\nOrganization: Fake Console Org\nProfile: ${PROFILE}\n`), PROFILE);
  assert.equal(profileIn('Login method: Claude Max account\r\nOrganization: Someone\r\n'), '', 'the plan: no line');
  assert.equal(profileIn('Profile:   \nOrganization: x'), '', 'an empty one is no profile');
  assert.equal(profileIn(''), '');
  const rec = tmp('auth-rec');
  forgetAuthStatus();
  try {
    process.env.FAKE_RECORD = rec;
    process.env.FAKE_AUTH_PROFILE = PROFILE;
    const a = { ...process.env, CLAUDE_CONFIG_DIR: tmp('acct-a') };
    const b = { ...process.env, CLAUDE_CONFIG_DIR: tmp('acct-b') };
    const now = Date.now();
    assert.deepEqual(await Promise.all([consoleProfile(a, now), consoleProfile(a, now + 1000)]), [PROFILE, PROFILE]);
    const calls = () => fs.readFileSync(path.join(rec, 'auth.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).configDir);
    assert.deepEqual(calls(), [a.CLAUDE_CONFIG_DIR], 'two starts in a minute on one account: one check');
    delete process.env.FAKE_AUTH_PROFILE;
    assert.equal(await consoleProfile({ ...b, FAKE_AUTH_PROFILE: '' }, now), '', 'another account folder is its own');
    assert.equal(await consoleProfile({ ...a, FAKE_AUTH_PROFILE: '' }, now + 61_000), '', 'a minute on: read again');
    assert.deepEqual(calls(), [a.CLAUDE_CONFIG_DIR, b.CLAUDE_CONFIG_DIR, a.CLAUDE_CONFIG_DIR]);
    assert.equal(await consoleProfile({ ...b, FAKE_AUTH_FAIL: '1', FAKE_AUTH_PROFILE: PROFILE }, now + 61_000), '', 'a failing check: no profile');
  } finally {
    for (const k of authEnv) delete process.env[k];
    forgetAuthStatus();
  }
});

test('console profile, end to end: a notice on the turn and in Plan budget; none without one, when the check fails, or when it is slow', async () => {
  delete srv.budget.state.claude;
  const cwd = makeRepo();
  const rec = tmp('auth-e2e');
  const start = async (prompt) => {
    forgetAuthStatus();
    return api('/sessions', { prompt, cwd, agent: 'claude', worktree: false });
  };
  // What the run's check said, once it has (the runner heard it first: same promise, earlier then).
  const settled = () => consoleProfile();
  try {
    process.env.FAKE_RECORD = rec;
    // Present: Past your plan, as a Console sign-in.
    process.env.FAKE_AUTH_PROFILE = PROFILE;
    const a = await start('fix the add bug please');
    assert.equal(await settled(), PROFILE);
    const x = await until(async () => {
      const t = await ended(a.id, 'review');
      return t.turns[0].overage && t;
    });
    assert.equal(x.turns[0].overage.kind, 'profile');
    assert.equal(x.turns[0].status, 'done', 'a notice, not a hold: the turn ends as it would');
    assert.ok(!x.turns[0].question && !x.turns[0].approval, 'no ask card');
    const over = (await api('/agents')).find((y) => y.id === 'claude').budget.find((y) => y.account === 'default').overage;
    assert.deepEqual([over.runs, over.kind, over.sid], [1, 'profile', a.id]);

    // Absent: the plan, no notice.
    delete process.env.FAKE_AUTH_PROFILE;
    const b = await start('write the docs please');
    assert.equal(await settled(), '');
    const y = await ended(b.id, 'review');
    assert.equal(y.turns[0].overage, undefined, 'on the plan: no flag');

    // The check fails: no notice, and the run is fine.
    process.env.FAKE_AUTH_FAIL = '1';
    process.env.FAKE_AUTH_PROFILE = PROFILE; // never printed: it exits first
    const c = await start('write the docs again please');
    assert.equal(await settled(), '');
    const z = await ended(c.id, 'review');
    assert.equal(z.turns[0].status, 'done');
    assert.equal(z.turns[0].overage, undefined);
    delete process.env.FAKE_AUTH_FAIL;

    // Slow, past the 5 s timeout: the run starts and ends on its own time, and no notice comes.
    process.env.FAKE_AUTH_DELAY = '8000';
    const t0 = Date.now();
    const d = await start('one more change please');
    let done = false;
    const check = settled().then((p) => ((done = true), p));
    const w = await ended(d.id, 'review');
    assert.equal(done, false, `the turn ended (${Date.now() - t0} ms) before the check did: it never waits for it`);
    assert.equal(w.turns[0].status, 'done');
    assert.equal(await check, '', 'timed out: no profile');
    assert.ok(Date.now() - t0 < 7500, 'the check was cut off at its timeout');
    assert.equal((await api(`/sessions/${d.id}`)).turns[0].overage, undefined);

    // Slow but in time, landing after a quick turn ended: the notice still reaches it.
    process.env.FAKE_AUTH_DELAY = '2500';
    const e = await start('and the last change please');
    let late = false;
    settled().then(() => (late = true));
    await ended(e.id, 'review');
    const lateOnTurn = !late; // the usual case: the turn was over first
    const v = await until(async () => {
      const t = await api(`/sessions/${e.id}`);
      return t.turns[0].overage && t;
    });
    assert.equal(v.turns[0].overage.kind, 'profile', lateOnTurn ? 'after the turn ended' : 'during the turn');
  } finally {
    for (const k of authEnv) delete process.env[k];
    forgetAuthStatus();
  }
});

// Tokens per turn by account (Moris check-in 11 #1): the same harness and model on two logins, each
// account's median turn, once each has 5 finished turns on it. Numbers only, never a pick.
const { compareAccounts } = await import('../server/budget.js');
const { compareRatio, compareWords, compareTip, compareParts, median } = await import('../web/js/receipt.js');

const NOW = Date.UTC(2026, 10, 3, 12);
const turnOf = (account, output, input, extra = {}) => ({ agent: 'claude', model: 'opus', status: 'done', startedAt: NOW - 36e5, ...(account !== 'default' && { account }), stats: { inputTokens: input, cacheReadTokens: input * 4, cacheWriteTokens: 0, outputTokens: output }, ...extra });
const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test('compareAccounts: per model, each account’s median turn, only with ≥5 turns on two accounts', () => {
  const sessions = [
    { agent: 'claude', turns: [...many(6, (i) => turnOf('work', 4000 + i * 100, 1000)), ...many(5, () => turnOf('default', 2000, 1000))] },
    // Too few on the second account for sonnet; one account only for haiku; another harness; old, running, errored and empty turns.
    { agent: 'claude', turns: [...many(5, () => turnOf('work', 10, 10, { model: 'sonnet' })), ...many(4, () => turnOf('default', 10, 10, { model: 'sonnet' })), ...many(9, () => turnOf('work', 10, 10, { model: 'haiku' }))] },
    { agent: 'codex', turns: many(9, () => turnOf('default', 5, 5, { agent: 'codex' })) },
    { agent: 'claude', turns: [turnOf('default', 99999, 1, { startedAt: NOW - 8 * 864e5 }), turnOf('default', 99999, 1, { status: 'running' }), turnOf('default', 99999, 1, { status: 'error' }), turnOf('default', 0, 1)] },
  ];
  const c = compareAccounts(sessions, 'claude', { now: NOW });
  assert.equal(c.length, 1);
  assert.equal(c[0].model, 'opus');
  assert.deepEqual(c[0].accounts.map((x) => [x.account, x.turns, x.output, x.input]), [['work', 6, 4250, 5000], ['default', 5, 2000, 5000]], 'most output first; input counts cache reads');
  assert.equal(c[0].accounts[0].cache, 0.8);
  assert.deepEqual(compareAccounts(sessions, 'codex', { now: NOW }), [], 'one account: nothing to compare');
  assert.deepEqual(compareAccounts(sessions, 'claude', { now: NOW, min: 4 }).map((x) => x.model), ['opus', 'sonnet']);
  // A Codex turn: cached input is already inside input_tokens.
  const cx = compareAccounts([{ agent: 'codex', turns: [...many(5, () => ({ agent: 'codex', model: '', status: 'done', startedAt: NOW, stats: { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 50 } })), ...many(5, () => ({ agent: 'codex', model: '', account: 'b', status: 'done', startedAt: NOW, stats: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 50 } }))] }], 'codex', { now: NOW });
  assert.deepEqual(cx[0].accounts.map((x) => [x.input, x.cache]), [[1000, 0.6], [1000, 0.2]]);
  assert.equal(cx[0].model, '', 'the harness default is its own row');
});

test('compare words: a ratio only past 1.2×, n per account, never a suggestion', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), 0);
  const label = (id) => ({ work: 'Work', default: 'Personal' })[id];
  const c = { model: 'opus', accounts: [{ account: 'work', turns: 14, output: 3800, input: 52000, cache: 0.81 }, { account: 'default', turns: 11, output: 2000, input: 49000, cache: 0.79 }] };
  assert.equal(compareWords(c, label), 'Work uses 1.9× the output tokens per turn of Personal (n=14 / 11)');
  assert.equal(compareRatio({ accounts: [{ output: 1100 }, { output: 1000 }] }), null);
  assert.equal(compareWords({ accounts: [{ account: 'work', turns: 5, output: 1100 }, { account: 'default', turns: 6, output: 1000 }] }, label), 'Work and Personal use about the same output tokens per turn (n=5 / 6)');
  assert.doesNotMatch(compareWords(c, label), /switch|move|use Personal|cheaper|instead/i);
  assert.deepEqual(compareParts(c.accounts[0]), ['4k out', '52k in', '81% cache', '14 turns']);
  assert.match(compareTip([c], 'opus', 'work', label), /^Median turn on this model over the last 7 days: Work 4k out \/ 52k in, Personal 2k out \/ 49k in/);
  assert.equal(compareTip([c], 'sonnet', 'work', label), '', 'another model: nothing');
  assert.equal(compareTip([c], 'opus', 'other', label), '', 'an account not in the comparison: nothing');
  assert.equal(compareTip(undefined, 'opus', 'work', label), '');
});

// Moris check-in 12 #1: Claude's system/init tool list per turn, and the comparison says when two
// accounts' tools differ ("Personal has no WebFetch").
const { toolSet } = await import('../server/budget.js');
const { toolWords } = await import('../web/js/receipt.js');

test('toolSet: sorted, deduped, wisp’s own MCP tools left out; a repeat keeps only the hash', () => {
  const a = toolSet(['WebFetch', 'Read', 'Read', 'mcp__wisp__ask_user', 'mcp__github__create_issue']);
  assert.deepEqual(a.list, ['Read', 'WebFetch', 'mcp__github__create_issue']);
  assert.match(a.hash, /^[0-9a-f]{12}$/);
  assert.equal(toolSet(['Read', 'mcp__github__create_issue', 'WebFetch', 'mcp__wisp__delegate']).hash, a.hash, 'order and wisp tools don’t move the hash');
  assert.notEqual(toolSet(['Read']).hash, a.hash);
  assert.deepEqual(toolSet(['WebFetch', 'Read', 'mcp__github__create_issue'], [a.hash]), { hash: a.hash });
});

test('compareAccounts: tools another account had and this one didn’t, from each account’s latest turn', () => {
  const full = toolSet(['Read', 'WebFetch', 'mcp__github__a', 'mcp__github__b']);
  const lean = toolSet(['Read']);
  const old = toolSet(['Read', 'WebFetch']);
  const sessions = [
    { agent: 'claude', turns: [...many(5, () => turnOf('work', 4000, 1000, { details: { tools: full } })), turnOf('default', 2000, 1000, { startedAt: NOW - 72e5, details: { tools: old } })] },
    // The list is stored on another task's turn; this account's latest turn has only the hash.
    { agent: 'claude', turns: [{ agent: 'claude', status: 'error', startedAt: NOW - 9 * 864e5, details: { tools: lean } }, ...many(4, () => turnOf('default', 2000, 1000, { details: { tools: { hash: lean.hash } } }))] },
  ];
  const [c] = compareAccounts(sessions, 'claude', { now: NOW });
  assert.deepEqual(c.accounts.map((x) => [x.account, x.missing]), [['work', undefined], ['default', ['WebFetch', 'mcp__github__a', 'mcp__github__b']]]);
  assert.equal(c.accounts[0].tools, undefined, 'the lists stay on the server');
  const label = (id) => ({ work: 'Work', default: 'Personal' })[id];
  assert.equal(compareWords(c, label), 'Work uses 2.0× the output tokens per turn of Personal (n=5 / 5); Personal has no WebFetch or the github MCP tools');
  // Only one account reported tools: nothing to say.
  const one = [{ agent: 'claude', turns: [...many(5, () => turnOf('work', 10, 10, { details: { tools: full } })), ...many(5, () => turnOf('default', 10, 10))] }];
  assert.ok(compareAccounts(one, 'claude', { now: NOW })[0].accounts.every((x) => !x.missing));
});

test('toolWords: names, MCP servers by name, three at most', () => {
  assert.equal(toolWords(['WebFetch']), 'WebFetch');
  assert.equal(toolWords(['WebFetch', 'WebSearch']), 'WebFetch or WebSearch');
  assert.equal(toolWords(['A', 'B', 'C', 'D', 'mcp__x__1', 'mcp__x__2']), 'A, B, C and 2 more');
  assert.equal(toolWords([]), '');
});

test('the Claude init tool list lands on the turn as details.tools; a repeat turn keeps only the hash', async () => {
  const cwd = makeRepo();
  try {
    process.env.FAKE_TOOLS = 'Read,Edit,WebFetch,mcp__wisp__ask_user';
    const a = await api('/sessions', { prompt: 'fix the add bug please', cwd, agent: 'claude', worktree: false });
    let x = await ended(a.id, 'review');
    assert.deepEqual(x.turns[0].details?.tools?.list, ['Edit', 'Read', 'WebFetch']);
    await api(`/sessions/${a.id}/reply`, { text: 'and the docs please' });
    x = await until(async () => {
      const y = await api(`/sessions/${a.id}`);
      return y.turns.length === 2 && y.turns[1].status !== 'running' && y;
    }, { timeout: 30_000 });
    assert.deepEqual(x.turns[1].details.tools, { hash: x.turns[0].details.tools.hash });
    delete process.env.FAKE_TOOLS;
    const b = await api('/sessions', { prompt: 'write the docs please', cwd, agent: 'claude', worktree: false });
    assert.equal((await ended(b.id, 'review')).turns[0].details, undefined, 'no tools in init: nothing stored');
  } finally {
    delete process.env.FAKE_TOOLS;
  }
});

test('compare on /agents: only for a harness with several accounts', async () => {
  const all = srv.store.all;
  const multi = srv.accounts.multi;
  try {
    srv.store.all = () => [{ id: 'x', agent: 'claude', turns: [...many(5, () => turnOf('work', 4000, 1000, { startedAt: Date.now() - 36e5 })), ...many(5, () => turnOf('default', 2000, 1000, { startedAt: Date.now() - 36e5 }))] }];
    srv.accounts.multi = () => false;
    assert.equal((await api('/agents')).find((y) => y.id === 'claude').compare, undefined, 'one account: no field');
    srv.accounts.multi = (id) => id === 'claude';
    const claude = (await api('/agents')).find((y) => y.id === 'claude');
    assert.deepEqual(claude.compare.map((c) => [c.model, c.accounts.map((x) => x.account)]), [['opus', ['work', 'default']]]);
  } finally {
    srv.store.all = all;
    srv.accounts.multi = multi;
  }
});

// Where a turn's tokens went (check-in 14): tokens per model from the result's modelUsage, and per
// subagent type from the messages carrying each Agent call's id as parent_tool_use_id.
const { costSince, countedFrom, modelsOf, restoredFrom, subagentTally } = await import('../server/adapters/claude.js');
const { unitsOf } = await import('../server/budget.js');
const { turnUsage } = await import('../server/adapters/codex.js');
const { usage, tokensOf } = await import('../server/usage.js');
const { modelWords, subagentParts, subagentTip, insteadWords, turnOutput, sameModelShare, offerSubagentModel, turnTokens } = await import('../web/js/receipt.js');
const { whereSubagents } = await import('../server/budget.js');

test('subagent tally: per type, output from modelUsage past the main thread, one message id once; modelUsage deltas', () => {
  const t = subagentTally();
  t.init(['Read', 'Bash']);
  t.message({ message: { id: 'x', model: 'claude-opus-5-5', usage: { output_tokens: 1 } } }); // the main thread's
  t.call('a1', 'Agent', { subagent_type: 'web-fetch' });
  t.call('a2', 'Agent', { subagent_type: 'web-fetch' });
  t.call('a3', 'Agent', { subagent_type: 'Explore' }); // started again by task_started: kept once
  t.call('a3', 'Agent', { subagent_type: 'Explore' });
  t.call('b1', 'Bash', { command: 'ls' }); // not an agent
  const u = { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 1 };
  t.message({ parent_tool_use_id: 'a1', message: { id: 'm1', model: 'claude-opus-5-5', usage: u } });
  t.message({ parent_tool_use_id: 'a1', message: { id: 'm1', model: 'claude-opus-5-5', usage: u } });
  t.message({ parent_tool_use_id: 'a1', message: { id: 'm2', model: 'claude-opus-5-5', usage: { input_tokens: 5, output_tokens: 1 } } });
  t.message({ parent_tool_use_id: 'a2', message: { id: 'm3', model: 'claude-opus-5-5', usage: u } });
  t.message({ parent_tool_use_id: 'a3', message: { id: 'm4', model: 'claude-haiku-4-5', usage: u } });
  t.message({ parent_tool_use_id: 'nope', message: { id: 'm5', usage: u } });
  t.result('a2', { isAsync: true, status: 'async_launched' }); // no usage: nothing changes
  // Opus wrote 9000, 3000 of it the main thread's: 6000 shared 2:1 by the messages' counts.
  const models = modelsOf({ 'claude-opus-5-5': { outputTokens: 9000 }, 'claude-haiku-4-5': { outputTokens: 400 } });
  const subs = t.take({ models, mainOut: 3000 });
  assert.deepEqual(subs, [
    { type: 'web-fetch', calls: 2, read: 105 + 100, output: 6000, model: 'claude-opus-5-5', same: true, instead: 'WebFetch' }, // same: the main thread's model
    { type: 'Explore', calls: 1, read: 100, output: 400, model: 'claude-haiku-4-5' },
  ]);
  assert.equal(t.take(), undefined, 'take clears it');
  // An Agent result with its own usage wins.
  const t2 = subagentTally();
  t2.init(['Read', 'WebFetch']);
  t2.call('a1', 'Agent', { subagent_type: 'web-fetch' });
  t2.result('a1', { usage: { input_tokens: 7, output_tokens: 70 }, resolvedModel: 'claude-sonnet-4-5' });
  assert.deepEqual(t2.take({ models: modelsOf({ 'claude-sonnet-4-5': { outputTokens: 500 } }) }), [{ type: 'web-fetch', calls: 1, read: 7, output: 70, model: 'claude-sonnet-4-5' }], 'WebFetch was there: no note; no main-thread message, so not same');
  // modelUsage adds up over a process's results: each keeps what's new.
  const first = { 'claude-haiku-5-5': { inputTokens: 6, outputTokens: 299, cacheReadInputTokens: 39658, cacheCreationInputTokens: 36759 } };
  const second = { 'claude-haiku-5-5': { inputTokens: 10, outputTokens: 302, cacheReadInputTokens: 68461, cacheCreationInputTokens: 37421 } };
  assert.deepEqual(modelsOf(second, first), [{ model: 'claude-haiku-5-5', input: 4, output: 3, cacheRead: 28803, cacheWrite: 662 }]);
  assert.equal(modelsOf(first, first), undefined, 'nothing new: nothing');
  assert.equal(modelsOf(undefined), undefined);
});

test('receipt: where the tokens went, by subagent and by model, and page reads run as an agent', () => {
  assert.deepEqual(['claude-opus-5-5', 'claude-haiku-4-5-20251001', 'claude-3-5-sonnet-20241022', 'claude-sonnet-4-5[1m]', 'opus', 'gpt-5.5'].map(modelWords), ['Opus 5.5', 'Haiku 4.5', 'Sonnet 3.5', 'Sonnet 4.5 (1M)', 'Opus', 'gpt-5.5']);
  const t = { stats: { inputTokens: 10, outputTokens: 5, models: [{ model: 'claude-opus-5-5', input: 4000, output: 41000, cacheRead: 20000, cacheWrite: 0 }, { model: 'claude-haiku-4-5', input: 900, output: 120, cacheRead: 0, cacheWrite: 0 }], totals: {}, subagents: [{ type: 'web-fetch', calls: 3, model: 'claude-opus-5-5', read: 3150, output: 27000, instead: 'WebFetch' }] } };
  assert.equal(turnOutput(t), 41120);
  assert.deepEqual(subagentParts(t), ['3 web-fetch agents', 'Opus 5.5', '27k of 41k output']);
  assert.equal(insteadWords(t.stats.subagents[0]), 'Claude Code ran page reads as an agent on Opus 5.5 on this account');
  const tip = subagentTip(t);
  assert.match(tip, /Subagents: 3 web-fetch agents on Opus 5\.5: 27k of 41k output tokens/);
  assert.match(tip, /By model: Opus 5\.5 41k out \/ 24k in, Haiku 4\.5 120 out \/ 900 in/);
  assert.match(tip, /ran page reads as an agent/);
  assert.deepEqual(subagentParts({ stats: { outputTokens: 5 } }), [], 'no subagent: no line');
  assert.deepEqual(subagentParts({ stats: { outputTokens: 900, subagents: [{ type: 'Explore', calls: 1, model: '', read: 0, output: 0 }] } }), ['1 Explore agent']);
});

test('where it went: subagents, a turn’s share of the window split by the output each type wrote', () => {
  const R = NOW + 2 * 864e5;
  const plan = (used) => [{ agent: 'claude', account: 'default', window: 'seven_day', used, resetsAt: R }];
  const sessions = [
    { id: 'a', turns: [{ stats: { totals: {}, outputTokens: 5000, subagents: [{ type: 'web-fetch', calls: 2, model: 'claude-opus-5-5', read: 10, output: 5000, instead: 'WebFetch' }] }, plan: plan(0.1) }] },
    { id: 'b', turns: [{ stats: { totals: {}, outputTokens: 0, subagents: [{ type: 'web-fetch', calls: 1, model: 'claude-opus-5-5', read: 10, output: 1000 }, { type: 'Explore', calls: 1, model: 'claude-haiku-4-5', read: 5, output: 3000 }] }, plan: plan(0.04) }] },
    { id: 'c', turns: [{ stats: { totals: {}, outputTokens: 0, subagents: [{ type: 'Explore', calls: 9, output: 4000 }] }, plan: [{ ...plan(0.5)[0], account: 'work' }] }] },
    { id: 'd', turns: [{ stats: { outputTokens: 4000 }, plan: plan(0.2) }] },
  ];
  const w = whereSubagents(sessions, 'claude', 'default', 'seven_day', R);
  assert.equal(w.length, 2);
  assert.deepEqual([w[0].type, w[0].calls, w[0].output, w[0].model, w[0].instead], ['web-fetch', 3, 6000, 'claude-opus-5-5', 'WebFetch']);
  assert.ok(Math.abs(w[0].used - (0.05 + 0.01)) < 1e-9);
  assert.ok(Math.abs(w[1].used - 0.03) < 1e-9);
  assert.equal(whereSubagents(sessions, 'claude', 'other', 'seven_day', R), null);
});

test('a Claude run with web-fetch agents and no WebFetch lands models and subagents on its turn', async () => {
  const cwd = makeRepo();
  try {
    process.env.FAKE_SUBAGENTS = '3';
    process.env.FAKE_TOOLS = 'Read,Edit,Bash,Agent';
    const a = await api('/sessions', { prompt: 'fix the add bug please', cwd, agent: 'claude', worktree: false });
    const t = (await ended(a.id, 'review')).turns[0];
    assert.deepEqual(t.stats.subagents, [{ type: 'web-fetch', calls: 3, read: 3150, output: 27000, model: 'claude-opus-5-5', same: true, instead: 'WebFetch' }]);
    assert.deepEqual(t.stats.models.map((m) => [m.model, m.output]), [['claude-opus-5-5', 41000], ['claude-haiku-4-5-20251001', 120]]);
    assert.deepEqual(subagentParts(t), ['3 web-fetch agents', 'Opus 5.5', '27k of 41k output']);
    delete process.env.FAKE_SUBAGENTS;
    const b = await api('/sessions', { prompt: 'write the docs please', cwd, agent: 'claude', worktree: false });
    const u = (await ended(b.id, 'review')).turns[0];
    assert.equal(u.stats.subagents, undefined);
    assert.equal(u.stats.models, undefined);
  } finally {
    delete process.env.FAKE_SUBAGENTS;
    delete process.env.FAKE_TOOLS;
  }
});

// Task 6f3272b8089a, turn 3, stored before #602: modelUsage held the whole conversation (260,711),
// so the subagent's share read 260,711 - 14,438. Its transcript says it wrote 18,468.
const OLD_TURN = { agent: 'claude', stats: { outputTokens: 14438, models: [{ model: 'claude-opus-5-5', input: 432, output: 260711, cacheRead: 43268183, cacheWrite: 1228181 }], subagents: [{ type: 'general-purpose', calls: 1, read: 503596, output: 246273, model: 'claude-opus-5-5', same: true }] } };

test('subagent output: what the transcript says, once the turn’s own modelUsage is known', () => {
  const t = subagentTally();
  t.message({ message: { id: 'x', model: 'claude-opus-5-5', usage: { output_tokens: 1 } } });
  t.call('a1', 'Agent', { subagent_type: 'general-purpose' });
  t.message({ parent_tool_use_id: 'a1', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 } } });
  const models = modelsOf({ 'claude-opus-5-5': { outputTokens: 260711 } }, { 'claude-opus-5-5': { outputTokens: 227805 } });
  assert.equal(t.take({ models, mainOut: 14438 })[0].output, 18468);
});

test('subagent output: a stored turn from before stats.totals says none, rather than the conversation’s', () => {
  assert.deepEqual(subagentParts(OLD_TURN), ['1 general-purpose agent', 'Opus 5.5']);
  assert.equal(turnOutput(OLD_TURN), 14438);
  assert.doesNotMatch(subagentTip(OLD_TURN), /246k/);
  assert.equal(sameModelShare(OLD_TURN), 0);
  assert.equal(offerSubagentModel(OLD_TURN), false, 'no Haiku offer from a number that isn’t the turn’s');
  const plan = [{ agent: 'claude', account: 'default', window: 'seven_day', used: 0.1, resetsAt: NOW + 864e5 }];
  const [w] = whereSubagents([{ id: 'a', turns: [{ ...OLD_TURN, plan }] }], 'claude', 'default', 'seven_day', NOW + 864e5);
  assert.deepEqual([w.calls, w.output, w.used], [1, 0, 0], 'it can’t use 17 times the turn’s share of the window');
});

test('subagent output: with no modelUsage the turn’s total is the main thread’s plus theirs, not the bigger of the two', () => {
  const t = { stats: { totals: {}, outputTokens: 900, subagents: [{ type: 'Explore', calls: 1, model: 'claude-opus-5-5', read: 1, output: 3000 }] } };
  assert.equal(turnOutput(t), 3900);
  assert.deepEqual(subagentParts(t), ['1 Explore agent', 'Opus 5.5', '3k of 4k output']);
});

test('a resumed Claude run whose last turn left no models: the counters hold the conversation and can’t be split', async () => {
  const cwd = makeRepo();
  try {
    const a = await api('/sessions', { prompt: 'fix the add bug please', cwd, agent: 'claude', worktree: false });
    await ended(a.id, 'review');
    const again = async (i, restored) => {
      process.env.FAKE_RESTORED = restored;
      await api(`/sessions/${a.id}/reply`, { text: 'and again' });
      await until(async () => {
        const x = await api(`/sessions/${a.id}`);
        return x.turns.length === i + 1 && x.state === 'review';
      });
      return (await api(`/sessions/${a.id}`)).turns[i];
    };
    process.env.FAKE_SUBAGENTS = '3';
    const t = await again(1, '1'); // modelUsage: two runs' worth, and nothing stored to take off
    assert.equal(t.stats.costUsd, 0.01);
    assert.equal(t.stats.models, undefined, 'not this turn’s alone, so not stored as if it were');
    assert.deepEqual(t.stats.subagents.map((x) => [x.type, x.calls, x.output]), [['web-fetch', 3, 0]]);
    assert.equal(turnOutput(t), 14000);
    assert.equal(turnTokens(t).output, 14000);
    assert.deepEqual(subagentParts(t), ['3 web-fetch agents', 'Opus 5.5']);
    const u = await again(2, '2'); // it kept the counters: the next turn is exact again
    assert.equal(u.stats.models[0].output, 41000);
    assert.equal(u.stats.subagents[0].output, 27000);
  } finally {
    delete process.env.FAKE_SUBAGENTS;
    delete process.env.FAKE_RESTORED;
  }
});

// On --resume the CLI starts from the conversation's saved counters: total_cost_usd and modelUsage
// hold its earlier runs too, usage only this one.
test('a resumed Claude run counts its own cost and tokens, not the conversation’s so far', async () => {
  const cwd = makeRepo();
  try {
    process.env.FAKE_SUBAGENTS = '3';
    const a = await api('/sessions', { prompt: 'fix the add bug please', cwd, agent: 'claude', worktree: false });
    await ended(a.id, 'review');
    for (const [i, restored] of [[1, '1'], [2, '2'], [3, '']]) {
      process.env.FAKE_RESTORED = restored; // '': it started over, so there's nothing to take off
      await api(`/sessions/${a.id}/reply`, { text: 'and again' });
      await until(async () => {
        const x = await api(`/sessions/${a.id}`);
        return x.turns.length === i + 1 && x.state === 'review';
      });
    }
    const { turns } = await api(`/sessions/${a.id}`);
    assert.deepEqual(turns.map((t) => t.stats.costUsd), [0.01, 0.01, 0.01, 0.01]);
    assert.deepEqual(turns.map((t) => t.stats.models[0].output), [41000, 41000, 41000, 41000]);
    assert.deepEqual(turns.map((t) => t.stats.subagents[0].output), [27000, 27000, 27000, 27000]);
    const u = usage([{ id: 's', agent: 'claude', cwd, turns }], { now: Date.now() });
    assert.equal(u.total.cost, 0.04);
    assert.equal(u.total.outputTokens, 4 * 41120);
  } finally {
    delete process.env.FAKE_SUBAGENTS;
    delete process.env.FAKE_RESTORED;
  }
});

test('countedFrom: a chat with unknown earlier counters takes its first result as the baseline', () => {
  const usageOf = (output) => ({ 'claude-haiku-5-5': { inputTokens: 10, outputTokens: output } });
  const first = { total_cost_usd: 4.25, modelUsage: usageOf(9000), usage: { output_tokens: 50 } };
  const counted = countedFrom(first, null, true);
  assert.equal(counted.costUsd, 4.25);
  assert.equal(costSince(first, counted), 0);
  assert.deepEqual(modelsOf(first.modelUsage, first.modelUsage), undefined, 'no model deltas on it');
  const second = { total_cost_usd: 4.3, modelUsage: usageOf(9200), usage: { output_tokens: 200 } };
  assert.equal(costSince(second, counted), 0.05, 'a second result in the process counts from it');
  assert.deepEqual(modelsOf(second.modelUsage, first.modelUsage), [{ model: 'claude-haiku-5-5', input: 0, output: 200, cacheRead: 0, cacheWrite: 0 }]);
  // The flag changes nothing else: no flag, and a known prior, as before.
  assert.equal(countedFrom(first, null), null);
  assert.equal(countedFrom(first, null, false), null);
  const prior = { costUsd: 4, models: [{ model: 'claude-haiku-5-5', output: 8000 }] };
  assert.equal(countedFrom(first, prior), prior);
  assert.equal(countedFrom(first, prior, true), prior);
  assert.equal(countedFrom({ total_cost_usd: 3, modelUsage: usageOf(100), usage: { output_tokens: 100 } }, prior, true), null, 'started over: counted as is');
  assert.equal(countedFrom({ usage: { output_tokens: 5 } }, null, true), null, 'no cost reported: nothing to start from');
  // Not a sample: nothing divides by it, and estimates and Drain watch skip it.
  assert.equal(unitsOf({ costUsd: 0, baseline: true, inputTokens: 5000, outputTokens: 900 }), 0);
  assert.equal(unitsOf({ costUsd: 0, inputTokens: 5000, outputTokens: 900 }), 0.0059, 'an ordinary zero-cost run still counts its tokens');
});

// codex exec's turn.completed prints the thread's running totals: three identical turns against a
// local mock say 1000, 2000, 3000 input tokens on codex-cli 0.163.0 (`exec resume` and `exec fork`).
test('a resumed Codex run counts its own tokens, not the thread’s so far', async () => {
  const cwd = makeRepo();
  const follow = async (id, restored, n) => {
    process.env.FAKE_RESTORED = restored;
    await api(`/sessions/${id}/reply`, { text: 'and again' });
    await until(async () => {
      const x = await api(`/sessions/${id}`);
      return x.turns.length === n && x.state !== 'running' && x.turns.at(-1).status !== 'running';
    }, { timeout: 30_000 });
  };
  try {
    process.env.FAKE_RESTORED = '0'; // a first run has nothing to restore
    const a = await api('/sessions', { prompt: 'fix the add bug please', cwd, agent: 'codex', worktree: false });
    await ended(a.id, 'review');
    await follow(a.id, '1', 2);
    await follow(a.id, '2', 3);
    // A turn that died before turn.completed says nothing, and the counters carry on past it.
    process.env.FAKE_FAIL = '1';
    await follow(a.id, '2', 4);
    delete process.env.FAKE_FAIL;
    await follow(a.id, '3', 5);
    await follow(a.id, '', 6); // started over: less than the last turn's, so nothing to take off
    const { turns } = await api(`/sessions/${a.id}`);
    const ran = turns.filter((t) => t.stats?.inputTokens !== undefined);
    assert.deepEqual(ran.map((t) => t.stats.inputTokens), [10, 10, 10, 10, 10]);
    assert.deepEqual(ran.map((t) => t.stats.outputTokens), [5, 5, 5, 5, 5]);
    assert.deepEqual(ran.map((t) => t.stats.cachedInputTokens), [2, 2, 2, 2, undefined]);
    assert.equal(unitsOf(ran[1].stats), 13 / 1e6, 'what Ask near the limit and Drain watch read');

    // A turn from before stats.totals kept the counters themselves in its token stats.
    const stored = srv.runner.store.get(a.id).turns.at(-1).stats;
    delete stored.totals;
    await follow(a.id, '1', 7);
    const old = (await api(`/sessions/${a.id}`)).turns.at(-1).stats;
    assert.equal(old.inputTokens, 10);

    // Another account keeps its own thread (ACCOUNT_HOMES.codex.resumes false): its counters don't count.
    srv.runner.store.get(a.id).turns.at(-1).stats.totals.thread = 'another-thread';
    await follow(a.id, '1', 8);
    const other = (await api(`/sessions/${a.id}`)).turns.at(-1).stats;
    assert.equal(other.inputTokens, 10, 'taken off the turn before, on this thread');
  } finally {
    delete process.env.FAKE_FAIL;
    delete process.env.FAKE_RESTORED;
  }
});

test('turnUsage: the turn is the thread’s totals past the last turn', () => {
  const usage = { input_tokens: 2000, cached_input_tokens: 200, output_tokens: 20 };
  const totals = { inputTokens: 2000, cachedInputTokens: 200, outputTokens: 20, thread: 't' };
  assert.deepEqual(turnUsage(usage, null, 't'), { inputTokens: 2000, cachedInputTokens: 200, outputTokens: 20, totals });
  const prior = { inputTokens: 1000, cachedInputTokens: 100, outputTokens: 10, thread: 't' };
  assert.deepEqual(turnUsage(usage, prior, 't'), { inputTokens: 1000, cachedInputTokens: 100, outputTokens: 10, totals });
  assert.deepEqual(turnUsage(usage, { inputTokens: 5000, outputTokens: 50 }, 't'), { inputTokens: 2000, cachedInputTokens: 200, outputTokens: 20, totals }, 'started over');
  assert.deepEqual(turnUsage(null, prior, 't'), { totals: prior }, 'no usage: the next turn counts from the same place');
  assert.deepEqual(turnUsage(null, null, 't'), {});
  assert.deepEqual(turnUsage(usage, { costUsd: undefined, models: undefined }, 't').inputTokens, 2000, 'a last turn that ran nothing');
});

test('restoredFrom: what the counters hold past the last turn must cover what this run wrote', () => {
  const prior = { costUsd: 2, models: [{ model: 'o', input: 0, output: 1000, cacheRead: 0, cacheWrite: 0 }] };
  const msg = (cost, out, main) => ({ total_cost_usd: cost, modelUsage: { o: { outputTokens: out } }, usage: { output_tokens: main } });
  assert.equal(restoredFrom(msg(3, 1500, 500), prior), true);
  assert.equal(restoredFrom(msg(3, 1000, 0), prior), true, 'a zero-turn result');
  assert.equal(restoredFrom(msg(3, 600, 600), prior), false, 'fewer than before: it started over');
  assert.equal(restoredFrom(msg(1, 1500, 500), prior), false, 'a cost that went down');
  assert.equal(restoredFrom(msg(3, 1500, 500), null), false, 'nothing to restore');
  assert.equal(restoredFrom(msg(3, 1500, 500), { models: prior.models }), false, 'no cost on record');
});

test('usage totals are the receipt’s, and a turn from before stats.totals isn’t read from its models', () => {
  const now = Date.now();
  const model = { model: 'o', input: 1, output: 900, cacheRead: 5000, cacheWrite: 0 };
  const stats = { inputTokens: 10, cacheReadTokens: 100, outputTokens: 50 };
  const turn = (st) => ({ startedAt: now - 1000, endedAt: now, status: 'done', stats: st });
  const u = usage([{ id: 'a', agent: 'claude', cwd: '/x', turns: [turn({ ...stats, models: [model], totals: {} })] }], { now });
  assert.deepEqual([u.total.inputTokens, u.total.outputTokens], [5001, 900], 'subagents counted, as on the receipt');
  const old = usage([{ id: 'b', agent: 'claude', cwd: '/x', turns: [turn({ ...stats, models: [model] })] }], { now });
  assert.deepEqual([old.total.inputTokens, old.total.outputTokens], [110, 50], 'older models hold the whole conversation');
  assert.deepEqual(receiptOf(turn({ ...stats, models: [model] })).tokens, 160);
  assert.equal(tokensOf(turn({ ...stats, models: [model], totals: {} })), 5901);
});

test('receipt tokens: modelUsage counts in when it holds more than usage (its subagents)', () => {
  const t = { stats: { inputTokens: 10, cacheReadTokens: 31000, cacheWriteTokens: 20, outputTokens: 5, models: [{ model: 'claude-opus-5-5', input: 4000, output: 41000, cacheRead: 20000, cacheWrite: 0 }, { model: 'claude-haiku-4-5', input: 900, output: 120, cacheRead: 0, cacheWrite: 0 }], totals: {} } };
  assert.deepEqual(receiptParts(receiptOf(t)), ['66k tokens', '80% cache']);
  const small = { stats: { inputTokens: 10, cacheReadTokens: 31000, cacheWriteTokens: 20, outputTokens: 5, models: [{ model: 'x', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }], totals: {} } };
  assert.deepEqual(receiptParts(receiptOf(small)), ['31k tokens', '99% cache'], 'usage is larger: usage');
});

// Sh scripts: the point is a process that goes away mid-handshake, and that takes no Windows shim.
test('readCodex: an app-server that closes its stdin rejects; the EPIPE doesn’t reach the process', { skip: process.platform === 'win32' }, async () => {
  const { readCodex } = await import('../server/live-limits.js');
  const dir = tmp('codex-epipe');
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!/bin/sh\nread x\necho '{"id":1,"result":{}}'\nexec 0<&-\nsleep 1\n`);
  fs.chmodSync(bin, 0o755);
  const stray = [];
  const seen = (err) => stray.push(err);
  process.on('uncaughtException', seen);
  try {
    await assert.rejects(readCodex({ bin, timeout: 5000 }));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(stray.map((e) => e.code), []);
  } finally {
    process.off('uncaughtException', seen);
  }
});
