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
const { modelWords, subagentParts, subagentTip, insteadWords, turnOutput } = await import('../web/js/receipt.js');
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
    { id: 'a', turns: [{ stats: { outputTokens: 10000, subagents: [{ type: 'web-fetch', calls: 2, model: 'claude-opus-5-5', read: 10, output: 5000, instead: 'WebFetch' }] }, plan: plan(0.1) }] },
    { id: 'b', turns: [{ stats: { outputTokens: 4000, subagents: [{ type: 'web-fetch', calls: 1, model: 'claude-opus-5-5', read: 10, output: 1000 }, { type: 'Explore', calls: 1, model: 'claude-haiku-4-5', read: 5, output: 3000 }] }, plan: plan(0.04) }] },
    { id: 'c', turns: [{ stats: { outputTokens: 4000, subagents: [{ type: 'Explore', calls: 9, output: 4000 }] }, plan: [{ ...plan(0.5)[0], account: 'work' }] }] },
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
