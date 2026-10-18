// Auto: the router that picks harness × model per task (server/router.js), on its own and
// through a real wisp server with the fake harnesses.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeRepo, tmp, until } from './helpers.js';

const { Router, classify, reward, betaSample } = await import('../server/router.js');

const AGENTS = [
  { id: 'claude', name: 'Claude Code', available: true, models: [{ id: '' }, { id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' }] },
  { id: 'codex', name: 'Codex', available: true, models: [{ id: '' }] },
  { id: 'cursor', name: 'Cursor', available: false, models: [{ id: '' }] },
  { id: 'antigravity', name: 'Antigravity', available: true, delegates: false, models: [{ id: '' }, { id: 'gemini-3.8-flash-medium', label: 'Flash' }] },
];
// A Lehmer generator, warmed up so small seeds don't start with tiny numbers.
const seeded = (seed = 1) => {
  let x = (seed * 7919 + 104729) % 2147483647;
  const next = () => ((x = (x * 48271) % 2147483647) / 2147483647);
  for (let i = 0; i < 10; i++) next();
  return next;
};

test('classify: a coarse kind of task and a size bucket', () => {
  assert.equal(classify('Fix the crash when the list is empty').type, 'bug');
  assert.equal(classify('make the settings button match the dark mode colors').type, 'ui');
  assert.equal(classify('Update the README install section').type, 'docs');
  assert.equal(classify('bump the version and prepare the release').type, 'release');
  assert.equal(classify('add a flaky test retry').type, 'test');
  assert.equal(classify('add CSV export to reports').type, 'feature');
  assert.equal(classify('why does the build take so long?').type, 'question');
  assert.equal(classify('x').size, 'S');
  assert.equal(classify('touch a.js b.js c.js d.js e.js').size, 'L');
});

test('reward: the strongest signal wins, follow-ups count against the run', () => {
  assert.equal(reward({}), null);
  assert.equal(reward({ hero: 'done' }), 0.6);
  assert.equal(reward({ hero: 'done', followups: 2 }), 0.4);
  assert.equal(reward({ hero: 'done', feedback: 'down' }), 0);
  assert.equal(reward({ hero: 'blocked', merged: true }), 1);
  assert.equal(reward({ hero: 'done', rolledBack: true }), 0.1);
  assert.equal(reward({ error: true }), 0);
  // Moved to another harness or model in a follow-up: a merge after that isn't this pick's.
  assert.equal(reward({ hero: 'done', switched: true, merged: true }), 0.1);
  const rng = seeded(42);
  const xs = Array.from({ length: 4000 }, () => betaSample(8, 2, rng));
  assert.ok(Math.abs(xs.reduce((a, b) => a + b) / xs.length - 0.8) < 0.02, 'Beta(8,2) averages 0.8');
});

test('choose: only installed harnesses, with the reason and how likely the pick was', () => {
  const r = new Router(tmp('router'));
  const pick = r.choose({ prompt: 'fix the failing login test', agents: AGENTS, rng: seeded(3) });
  assert.ok(['claude', 'codex', 'antigravity'].includes(pick.agent), pick.agent);
  assert.equal(pick.route.type, 'test');
  assert.ok(pick.route.propensity > 0 && pick.route.propensity <= 1);
  assert.ok(pick.route.alternatives.length > 0);
  // Important: no exploring, the same pick every time.
  const a = r.choose({ prompt: 'fix it', agents: AGENTS, important: true, rng: seeded(1) });
  const b = r.choose({ prompt: 'fix it', agents: AGENTS, important: true, rng: seeded(99) });
  assert.equal(a.key, b.key);
  // Compare runs never get the same arm; a team lead must be able to delegate; allowed narrows it.
  assert.notEqual(r.choose({ prompt: 'fix it', agents: AGENTS, exclude: [a.key], important: true }).key, a.key);
  for (let i = 0; i < 20; i++) assert.notEqual(r.choose({ prompt: 'x', agents: AGENTS, needDelegate: true, rng: seeded(i + 1) }).agent, 'antigravity');
  for (let i = 0; i < 20; i++) assert.equal(r.choose({ prompt: 'x', agents: AGENTS, allowed: ['codex'], rng: seeded(i + 1) }).agent, 'codex');
  assert.equal(r.choose({ prompt: 'x', agents: [{ id: 'claude', available: false }] }), null);
});

test('learning: outcomes move the estimate, per kind of task, and survive a restart', () => {
  const home = tmp('router-learn');
  const r = new Router(home);
  r.sync(AGENTS);
  const before = r.estimate('bug', 'codex:').mean;
  for (let i = 0; i < 6; i++) {
    r.record(`s${i}`, { key: 'codex:', type: 'bug', label: 'Codex', at: Date.now() });
    r.signal(`s${i}`, { hero: 'done', costUsd: 0.1, ms: 60_000 });
    r.signal(`s${i}`, { feedback: 'down' }); // a later, stronger signal replaces the first
  }
  const after = r.estimate('bug', 'codex:');
  assert.ok(after.mean < before, `${after.mean} < ${before}`);
  assert.equal(after.n, 6);
  assert.ok(after.usd > 0.1 && after.usd < 0.129, `cost moves from the prior toward what runs cost: ${after.usd}`);
  assert.ok(r.estimate('docs', 'codex:').mean > after.mean, 'other kinds only count half');
  const again = new Router(home);
  assert.equal(again.estimate('bug', 'codex:').n, 6);
  // The quality floor: a harness that keeps failing a kind of task here is left out of it.
  for (let i = 0; i < 20; i++) assert.notEqual(again.choose({ prompt: 'fix the bug', agents: AGENTS, rng: seeded(i + 7) }).key, 'codex:');
  again.reset();
  assert.equal(again.estimate('bug', 'codex:').n, 0);
});

test('new harnesses and models: found after the first look, on probation, a new version starts from its family', () => {
  const r = new Router(tmp('router-new'));
  assert.deepEqual(r.sync(AGENTS), [], 'the first look only learns what is there');
  const more = [...AGENTS.map((a) => (a.id === 'claude' ? { ...a, models: [...a.models, { id: 'sonnet-9', label: 'Sonnet 9' }] } : a)), { id: 'grok', name: 'Grok', available: true, models: [{ id: '' }] }];
  const added = r.sync(more);
  assert.deepEqual(added.map((a) => a.key).sort(), ['claude:sonnet-9', 'grok:']);
  assert.equal(added.find((a) => a.key === 'grok:').state, 'new');
  // sonnet-9 shares the sonnet family's record (shipped priors): not a blank slate.
  const fam = r.estimate('bug', 'claude:sonnet-9');
  assert.ok(fam.inherited && fam.mean > 0.6, JSON.stringify(fam));
  // A new arm only takes exploring slots: never when the task is important or exploring is off.
  for (let i = 0; i < 30; i++) {
    assert.notEqual(r.choose({ prompt: 'x', agents: more, important: true, rng: seeded(i + 1) }).key, 'grok:');
    assert.notEqual(r.choose({ prompt: 'x', agents: more, explore: false, rng: seeded(i + 1) }).key, 'grok:');
  }
  // Three outcomes end probation.
  for (let i = 0; i < 3; i++) (r.record(`g${i}`, { key: 'grok:', type: 'bug', at: Date.now() }), r.signal(`g${i}`, { hero: 'done' }));
  assert.equal(r.report(more).arms.find((a) => a.key === 'grok:').state, 'ready');
  // A harness that goes away is kept, marked gone.
  r.sync(more.map((a) => (a.id === 'grok' ? { ...a, available: false } : a)));
  assert.equal(r.state.arms['grok:'].state, 'gone');
});

// --- through the server --------------------------------------------------------------------

process.env.WISP_HOME = tmp('router-home');
process.env.WISP_UPDATE_CHECK = '0';
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
before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

test('Auto is the default harness, and a launch with it runs on a real one, with the route on the card', async () => {
  assert.equal((await api('/config')).defaults.agent, 'auto');
  const cwd = makeRepo();
  const s = await api('/sessions', { prompt: 'fix the add bug', cwd, agent: 'auto', model: 'cheap', mode: 'edits', worktree: false });
  assert.notEqual(s.agent, 'auto');
  assert.ok(['claude', 'codex', 'opencode', 'cursor', 'antigravity', 'grok'].includes(s.agent));
  assert.equal(s.route.goal, 'cheap');
  assert.equal(s.route.type, 'bug');
  const done = await until(async () => {
    const x = await api(`/sessions/${s.id}`);
    return x.state === 'review' && x;
  });
  assert.equal(done.turns[0].status, 'done');
  // The outcome is learned: the route has a reward, and a 👎 replaces it.
  const routed = await until(async () => (await api('/router')).recent.find((x) => x.id === s.id && x.r !== null));
  assert.equal(routed.r, 0.6);
  await api('/feedback', { rating: 'down', sessionId: s.id, turnId: done.turns[0].id });
  assert.equal((await api('/router')).recent.find((x) => x.id === s.id).r, 0);
  assert.equal((await api('/router')).learned, 1);
});

test('Auto settings: goal, trying new models and allowed harnesses', async () => {
  let r = await api('/router', { goal: 'best', explore: false, allowed: ['codex', 'nope'] }, 'PATCH');
  assert.equal(r.goal, 'best');
  assert.equal(r.settings.explore, false);
  assert.deepEqual(r.settings.allowed, ['codex']);
  const s = await api('/sessions', { prompt: 'add a CSV export', cwd: makeRepo(), agent: 'auto', worktree: false });
  assert.equal(s.agent, 'codex');
  assert.equal(s.route.goal, 'best');
  await assert.rejects(api('/router', { goal: 'fastest' }, 'PATCH'), /goal must be/);
  r = await api('/router/reset', {});
  assert.equal(r.learned, 0);
  await api('/router', { allowed: [], explore: true }, 'PATCH');
});

test('compare with Auto picks different harnesses; a team lead is one that can delegate', async () => {
  const [a, b] = (await api('/sessions', { prompt: 'refactor the parser', cwd: makeRepo(), agent: 'auto', compare: [{ agent: 'auto' }] })).group || [];
  assert.ok(a && b);
  assert.notEqual(`${a.agent}:${a.model}`, `${b.agent}:${b.model}`);
  const lead = await api('/sessions', { prompt: 'split the work', cwd: makeRepo(), agent: 'auto', worktree: false, subagents: [{ agent: 'auto', name: 'helper' }] });
  assert.notEqual(lead.agent, 'antigravity');
  assert.equal(lead.subagents?.[0]?.agent ?? 'auto', 'auto');
  assert.ok(fs.existsSync(path.join(process.env.WISP_HOME, 'router.json')));
});
