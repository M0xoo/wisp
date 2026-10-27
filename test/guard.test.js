// Ask near the limit (server/guard.js, web/js/limit-hold.js): what a run will likely take of its
// account's 5-hour and weekly windows, and holding it when that crosses your line. Yours are refused
// until you say yes; a schedule's wait as a held turn that starts at the reset or when you start it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { installFakeBins, makeRepo, tmp, until } from './helpers.js';

process.env.WISP_HOME = tmp('guard-wisp');
process.env.WISP_UPDATE_CHECK = '0';
process.env.CLAUDE_CONFIG_DIR = tmp('guard-claude-home');
installFakeBins();
const { startServer } = await import('../server/index.js');
const { holdFor, holdLine, holdTo, nextLine } = await import('../web/js/limit-hold.js');
const { Guard, spread, unitsOf, originKey } = await import('../server/guard.js');
const { Budget } = await import('../server/budget.js');

let srv;
let base;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
async function call(p, body, method) {
  const r = await fetch(`${base}/api${p}`, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
async function api(p, body, method) {
  const r = await call(p, body, method);
  if (r.status >= 400) throw Object.assign(new Error(`${p}: ${r.body.error}`), { status: r.status, hold: r.body.hold });
  return r.body;
}
const settled = (id) => until(async () => {
  const x = await api(`/sessions/${id}`);
  return x.turns.at(-1)?.status !== 'running' && x.state !== 'running' && x;
}, { timeout: 30_000 });

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

const H = 3600_000;

test('the rule: the line, the next one after a yes, the window nearest its limit, plain numbers', () => {
  assert.equal(holdLine('90'), 0.9);
  assert.equal(holdLine('off'), null);
  assert.equal(holdLine(undefined), 0.9, 'on at 90% unless you say otherwise');
  assert.equal(holdLine('42'), 0.9, 'an unknown value is the default, not a surprise');
  assert.equal(nextLine(0.9, 0), 0.9);
  assert.equal(nextLine(0.9, 0.9), 0.95, 'after a yes at 90%, the next ask is at 95%');
  assert.equal(nextLine(0.9, 0.95), 0.99);
  assert.equal(nextLine(0.9, 0.99), null, 'then quiet until the reset');
  assert.equal(nextLine(0.8, 0.8), 0.95);

  const five = { id: 'five_hour', label: '5-hour', used: 0.84, resetsAt: 1, line: 0.9, est: { first: [0.01, 0.02, 0.04], followUp: [0.04, 0.08, 0.12] } };
  const week = { id: 'seven_day', label: 'Weekly', used: 0.5, resetsAt: 2, line: 0.9, est: { first: [0, 0, 0], followUp: [0, 0, 0] } };
  assert.equal(holdFor([five, week], 'first'), null, 'a small task stays under the line');
  const h = holdFor([five, week], 'followUp');
  assert.equal(h.id, 'five_hour');
  assert.deepEqual(h.to.map((x) => Math.round(x * 100)), [88, 96]);
  assert.equal(holdTo(h), '88–96%');
  assert.equal(holdFor([{ ...week, used: 0.91 }, five], 'first').id, 'seven_day', 'already over the line holds, with no estimate at all');
  assert.equal(holdFor([{ ...week, used: 0.97, line: null }], 'first'), null, 'off, or quiet after a yes');
  assert.equal(holdTo({ to: [0.92, 0.93] }), 'about 93%');
  assert.equal(holdTo({ to: [1, 1] }), 'past the limit');
});

test('units and spread: cost where the harness says it, tokens otherwise; p50, p75, p90', () => {
  assert.equal(unitsOf({ costUsd: 0.6 }), 0.6);
  assert.equal(unitsOf({ inputTokens: 900_000, cachedInputTokens: 400_000, outputTokens: 500_000 }), 1);
  assert.equal(unitsOf(null), 0);
  assert.equal(spread([1, 2]), null, 'too few to say');
  assert.deepEqual(spread([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), [6, 8, 10]);
  assert.equal(originKey({ origin: { kind: 'trigger', id: 't1' } }), 'trigger:t1');
  assert.equal(originKey({ crew: { id: 'c1', job: 'checkin' } }), 'crew:c1:checkin');
});

// A stub store of finished runs, and a budget with the windows Claude reported.
function guardWith({ runs = [], windows, setting = '90', now = Date.now() }) {
  const sessions = runs.map((r, i) => ({ id: `s${i}`, agent: 'claude', createdAt: now - 10 * H, ...(r.origin && { origin: r.origin }), turns: (r.turns || [r.cost]).map((c) => ({ agent: 'claude', status: 'done', startedAt: r.at ?? now - H, endedAt: r.at ?? now - H, stats: { costUsd: c } })) }));
  const store = { all: () => sessions, config: { defaults: { limitHold: setting } } };
  const budget = new Budget(tmp('guard-budget'), { now: () => now });
  budget.record('claude', 'default', { windows });
  return { guard: new Guard({ store, budget, now: () => now }), budget, sessions };
}

test('learning: what the window moved while runs worked, over their units; long gaps don’t count', () => {
  let now = Date.now();
  const b = new Budget(tmp('guard-learn'), { now: () => now });
  const at = (used) => b.record('claude', 'default', { windows: [{ id: 'five_hour', used, resetsAt: 1e13, ms: 5 * H }] });
  at(0.2);
  now += 60_000;
  at(0.21);
  assert.equal(b.rate('claude', 'default', 'five_hour'), null, 'one point is too little to tell');
  now += 60_000;
  at(0.23);
  b.spend('claude', 'default', 6);
  assert.equal(b.rate('claude', 'default', 'five_hour').toFixed(4), '0.0050', '3 points for $6');
  now += 5 * H; // overnight: someone else may have used it meanwhile
  at(0.6);
  assert.equal(b.rate('claude', 'default', 'five_hour').toFixed(4), '0.0050');
});

test('estimate: the window’s share per unit of work, times what runs like this took', () => {
  const now = Date.now();
  const runs = [...Array(20).fill({ cost: 1 }), ...Array(10).fill({ cost: 3 })];
  const { guard, budget } = guardWith({ runs, now, windows: [{ id: 'five_hour', used: 0.25, resetsAt: now + H, ms: 5 * H }] });
  budget.state.claude.default.learn = { five_hour: { du: 0.1, units: 20 } }; // 0.5% per dollar
  const [w] = guard.windows('claude', 'default', { kind: 'first' });
  assert.equal(w.line, 0.9);
  assert.deepEqual(w.est.first.map((x) => +x.toFixed(4)), [0.005, 0.015, 0.015]);
  assert.equal(guard.check({ agent: 'claude', kind: 'first' }), null, '25% is nowhere near 90%');
  // Learned while someone else used the account a lot: never more than the whole window over wisp's $50.
  budget.state.claude.default.learn = { five_hour: { du: 0.2, units: 2 } };
  assert.equal(guard.rate('claude', 'default', budget.windows('claude', 'default')[0]), 0.005);
});

test('estimate: a schedule with five runs of its own uses them; a follow-up at least the task’s own median', () => {
  const now = Date.now();
  const nightly = { kind: 'trigger', id: 'nightly' };
  const runs = [...Array(10).fill({ cost: 1 }), ...Array(5).fill({ cost: 8, origin: nightly }), { turns: [1, 20, 20] }];
  const { guard, sessions } = guardWith({ runs, now, windows: [{ id: 'five_hour', used: 0.3, resetsAt: now + H, ms: 5 * H }] });
  assert.deepEqual(guard.units('claude', { kind: 'first' }), [1, 8, 8]);
  assert.deepEqual(guard.units('claude', { kind: 'first', origin: nightly }), [8, 8, 8]);
  assert.deepEqual(guard.units('claude', { kind: 'followUp', session: sessions.at(-1) }), [1, 20, 20]);
});

test('estimate: nothing learned yet adds nothing; runs going now count at half', () => {
  const now = Date.now();
  const { guard, budget, sessions } = guardWith({ runs: Array(10).fill({ cost: 1 }), now, windows: [{ id: 'five_hour', used: 0.5, resetsAt: now + H, ms: 5 * H }] });
  assert.equal(guard.rate('claude', 'default', budget.windows('claude', 'default')[0]), null);
  assert.deepEqual(guard.windows('claude', 'default')[0].est.first, [0, 0, 0]);
  budget.state.claude.default.learn = { five_hour: { du: 0.05, units: 5 } };
  assert.equal(guard.rate('claude', 'default', budget.windows('claude', 'default')[0]), 0.01);
  sessions.push({ id: 'live', agent: 'claude', turns: [{ agent: 'claude', status: 'running', startedAt: now }] });
  const [w] = guard.windows('claude', 'default', { kind: 'first' });
  assert.deepEqual(w.est.first.map((x) => +x.toFixed(4)), [0.015, 0.015, 0.015], '$1 for this one, plus half of the running one’s $1');
});

test('a yes asks again only higher up, until the window resets; Off never asks', () => {
  const now = Date.now();
  const { guard, budget } = guardWith({ now, windows: [{ id: 'seven_day', used: 0.92, resetsAt: now + 24 * H, ms: 168 * H }] });
  const h = guard.check({ agent: 'claude' });
  assert.equal(h.id, 'seven_day');
  assert.equal(h.line, 0.9);
  guard.confirm({ agent: 'claude' });
  assert.equal(guard.check({ agent: 'claude' }), null);
  budget.record('claude', 'default', { windows: [{ id: 'seven_day', used: 0.96, resetsAt: now + 24 * H, ms: 168 * H }] });
  assert.equal(guard.check({ agent: 'claude' }).line, 0.95);
  // A new window: the yes was for the old one.
  budget.record('claude', 'default', { windows: [{ id: 'seven_day', used: 0.91, resetsAt: now + 200 * H, ms: 168 * H }] });
  assert.equal(guard.check({ agent: 'claude' }).line, 0.9);
  const off = guardWith({ now, setting: 'off', windows: [{ id: 'seven_day', used: 0.99, resetsAt: now + H, ms: 168 * H }] });
  assert.equal(off.guard.check({ agent: 'claude' }), null);
});

// Through the API, with the fake Claude reporting its windows.
const weekly = (used, resetsAt) => ({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: used, resetsAt: Math.round(resetsAt / 1000), unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: Math.round((Date.now() + H) / 1000) }, seven_day: { utilization: used, resetsAt: Math.round(resetsAt / 1000) } } });

test('your task near the limit: refused with what it would take, sent once you say yes, quiet until 95%', async () => {
  const repo = makeRepo();
  const reset = Date.now() + 30 * H;
  process.env.FAKE_LIMITS = JSON.stringify(weekly(0.92, reset));
  try {
    const first = await api('/sessions', { prompt: 'fix the tests', cwd: repo, agent: 'claude', worktree: false });
    await settled(first.id); // the budget now knows the weekly window is at 92%
    const agents = await api('/agents');
    const w = agents.find((a) => a.id === 'claude').budget[0].windows.find((x) => x.id === 'seven_day');
    assert.equal(w.line, 0.9, 'the page gets the line to decide before it sends');
    assert.ok(Array.isArray(w.est.first) && Array.isArray(w.est.followUp));

    const refused = await call('/sessions', { prompt: 'and the docs', cwd: repo, agent: 'claude', worktree: false });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.hold.id, 'seven_day');
    assert.equal(refused.body.hold.label, 'Weekly');
    assert.equal(refused.body.hold.resetsAt, Math.round(reset / 1000) * 1000);
    assert.match(refused.body.error, /confirmLimit/);
    const reply = await call(`/sessions/${first.id}/reply`, { text: 'one more thing' });
    assert.equal(reply.status, 409, 'a follow-up is asked about too');

    const ok = await api('/sessions', { prompt: 'and the docs', cwd: repo, agent: 'claude', worktree: false, confirmLimit: true });
    await settled(ok.id);
    const quiet = await call(`/sessions/${first.id}/reply`, { text: 'one more thing' });
    assert.equal(quiet.status, 200, `after a yes, quiet until the next step: ${JSON.stringify(quiet.body)}`);
    await settled(first.id);

    process.env.FAKE_LIMITS = JSON.stringify(weekly(0.96, reset));
    await settled((await api('/sessions', { prompt: 'x', cwd: repo, agent: 'claude', worktree: false })).id);
    const again = await call('/sessions', { prompt: 'y', cwd: repo, agent: 'claude', worktree: false });
    assert.equal(again.status, 409);
    assert.equal(again.body.hold.line, 0.95);
  } finally {
    delete process.env.FAKE_LIMITS;
  }
});

test('a scheduled task near the limit starts held in Needs you; Start now, Skip this run, and the reset', async () => {
  const repo = makeRepo();
  const reset = Date.now() + 40 * H;
  srv.budget.record('claude', 'default', { windows: [{ id: 'seven_day', used: 0.995, resetsAt: reset, ms: 168 * H }] });
  const plan = async (prompt) => {
    const p = await api('/later', { kind: 'task', in: 5, cwd: repo, prompt, agent: 'claude', worktree: false });
    return (await api(`/later/${p.id}`, { now: true }, 'PATCH')).session;
  };

  const s = await plan('nightly triage');
  assert.equal(s.held.label, 'Weekly');
  assert.equal(s.held.until, reset);
  assert.equal(s.state, 'review');
  assert.equal(s.unread, true, 'in Needs you');
  const full = await api(`/sessions/${s.id}`);
  assert.equal(full.turns.length, 1);
  assert.equal(full.turns[0].status, 'held');
  assert.equal(full.turns[0].prompt, 'nightly triage');

  const started = await api(`/sessions/${s.id}/held`, { action: 'start' }, 'POST');
  assert.equal(started.held, undefined);
  const done = await settled(s.id);
  assert.equal(done.turns.length, 1, 'the held turn became the run');
  assert.equal(done.turns[0].status, 'done');

  const skipped = await plan('weekly report');
  await api(`/sessions/${skipped.id}/held`, { action: 'skip' }, 'POST');
  const sk = await api(`/sessions/${skipped.id}`);
  assert.equal(sk.turns[0].status, 'stopped');
  assert.equal(sk.turns[0].skipped, true);
  assert.equal(sk.state, 'done');

  const waits = await plan('dependency bumps');
  const w = await api(`/sessions/${waits.id}/held`, { action: 'wait' }, 'POST');
  assert.equal(w.held.waiting, true);
  assert.equal(w.unread, false, 'out of Needs you');
  // The reset came: the window reads fresh and the tick sends it.
  srv.store.get(waits.id).turns.at(-1).held.until = Date.now() - 1;
  srv.budget.record('claude', 'default', { windows: [{ id: 'seven_day', used: 0.01, resetsAt: Date.now() + 168 * H, ms: 168 * H }] });
  await srv.later.tick();
  const ran = await settled(waits.id);
  assert.equal(ran.turns[0].status, 'done');
  assert.equal((await call(`/sessions/${waits.id}/held`, { action: 'start' })).status, 404);
});

test('a scheduled follow-up near the limit is held on its task; still over at the reset, it waits for the next one', async () => {
  const repo = makeRepo();
  const s = await api('/sessions', { prompt: 'start', cwd: repo, agent: 'claude', worktree: false });
  await settled(s.id);
  const reset = Date.now() + 2 * H;
  srv.budget.record('claude', 'default', { windows: [{ id: 'five_hour', used: 0.97, resetsAt: reset, ms: 5 * H }] });
  const l = await api(`/sessions/${s.id}/later`, { text: 'carry on', in: 5 });
  await api(`/sessions/${s.id}/later`, { item: l.id, now: true }, 'PATCH');
  const held = await api(`/sessions/${s.id}`);
  assert.equal(held.turns.at(-1).status, 'held');
  assert.equal(held.turns.at(-1).held.kind, 'followUp');
  assert.equal(held.turns.at(-1).later.by, 'user', 'it still says who scheduled it');

  // Its time came, but the weekly window is over the line now: it waits for that reset instead.
  const week = Date.now() + 50 * H;
  srv.store.get(s.id).turns.at(-1).held.until = Date.now() - 1;
  srv.budget.record('claude', 'default', { windows: [{ id: 'five_hour', used: 0.01, resetsAt: Date.now() + 5 * H, ms: 5 * H }, { id: 'seven_day', used: 0.95, resetsAt: week, ms: 168 * H }] });
  await srv.later.tick();
  const still = srv.store.get(s.id).turns.at(-1);
  assert.equal(still.status, 'held');
  assert.equal(still.held.until, week);
  assert.equal(still.held.label, 'Weekly');

  // A follow-up of yours (you said yes) sends the held one first and queues behind it.
  const r = await api(`/sessions/${s.id}/reply`, { text: 'and this', confirmLimit: true });
  assert.equal(r.queued, true);
  const after = await until(async () => {
    const x = await api(`/sessions/${s.id}`);
    return x.turns.length === 3 && x.turns.every((t) => t.status === 'done') && x;
  }, { timeout: 30_000 });
  assert.deepEqual(after.turns.map((t) => t.prompt), ['start', 'carry on', 'and this']);
  srv.budget.record('claude', 'default', { windows: [{ id: 'seven_day', used: 0.1, resetsAt: week, ms: 168 * H }] });
});
