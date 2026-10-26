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
  fs.writeFileSync(path.join(day, 'rollout-2026-10-24T09-00-00-abc-123.jsonl'), [line(10), '{"type":"event_msg","payload":{"type":"agent_message"}}', line(35), ''].join('\n'));
  assert.equal(codexRollout('abc-123', { home, now }).primary.used_percent, 35, 'the last one written');
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

// --- through the server, with the fake harnesses ---------------------------------------------

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
    const s = await api('/sessions', { prompt: 'fix the add bug please', cwd: makeRepo(), agent: 'claude', worktree: false });
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
