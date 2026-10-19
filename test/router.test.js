// Auto: the router that picks harness × model per task (server/router.js), on its own and
// through a real wisp server with the fake harnesses.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeRepo, tmp, until } from './helpers.js';

const { Router, classify, reward, betaSample, tierOf, infraError, splitKey, levelsFor } = await import('../server/router.js');

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

test('tiers: small, everyday, frontier; "gemini" is not "mini"', () => {
  assert.deepEqual(['claude:haiku', 'claude:sonnet', 'claude:opus', 'codex:', 'grok:grok-4.7', 'grok:grok-4.7-build-fast', 'antigravity:gemini-4-argon-medium', 'antigravity:gemini-3.8-flash-medium', 'opencode:opencode/deepseek-v4.1-flash-free'].map(tierOf), [1, 2, 3, 3, 3, 1, 3, 1, 1]);
});

test('limits: a usage or rate limit is the harness being unavailable, not the model failing', () => {
  assert.equal(infraError("You've hit your session limit · resets 9pm (Europe/Zurich)").scope, 'agent');
  assert.equal(infraError('API error (status 402 Payment Required): Grok Build usage balance exhausted').scope, 'agent');
  assert.equal(infraError('`opencode/deepseek` is rate-limited right now').scope, 'arm');
  assert.equal(infraError('TypeError: cannot read properties of undefined'), null);
  let t = 1_000_000;
  const r = new Router(tmp('router-cool'), { now: () => t });
  r.sync(AGENTS);
  // A run that hit the limit counted as a failure first, then is voided: no trace in the stats.
  r.record('x', { key: 'claude:opus', type: 'bug', at: t });
  r.signal('x', { error: true });
  assert.equal(r.estimate('bug', 'claude:opus').n, 1);
  r.void('x');
  assert.equal(r.estimate('bug', 'claude:opus').n, 0);
  assert.equal(r.route('x').r, null);
  r.signal('x', { hero: 'done' });
  assert.equal(r.route('x').r, null, 'a voided route stays out');
  // Every Claude model cools down until the limit resets; then they're back.
  r.cool('claude:opus', { scope: 'agent', ms: 60_000, why: 'session limit' });
  for (let i = 0; i < 30; i++) assert.notEqual(r.choose({ prompt: 'fix it', agents: AGENTS, rng: seeded(i + 1) }).agent, 'claude');
  assert.equal(r.report(AGENTS).arms.find((a) => a.key === 'claude:sonnet').state, 'cooling');
  assert.equal(r.choose({ prompt: 'x', agents: AGENTS, allowed: ['claude'] }), null, 'nothing allowed can run now');
  t += 61_000;
  assert.equal(r.choose({ prompt: 'x', agents: AGENTS, allowed: ['claude'], important: true }).agent, 'claude');
});

test('cold start: Balanced leans to stronger tiers until there are enough of your outcomes', () => {
  const r = new Router(tmp('router-cold'));
  const tiers = (goal) => new Set(Array.from({ length: 40 }, (_, i) => tierOf(r.choose({ prompt: 'fix the bug', agents: AGENTS, goal, rng: seeded(i + 3) }).key)));
  assert.ok(!tiers('balanced').has(1), 'no small models for Balanced yet');
  assert.deepEqual([...tiers('best')], [3], 'Best is frontier only');
  assert.ok(r.choose({ prompt: 'x', agents: AGENTS, goal: 'balanced' }).route.coldStart);
  // A hand-over asks for a stronger tier than the run it replaces.
  for (let i = 0; i < 20; i++) assert.equal(tierOf(r.choose({ prompt: 'x', agents: AGENTS, goal: 'best', important: true, minTier: 3, rng: seeded(i + 1) }).key), 3);
  // With enough of your outcomes, it's your data that decides, whatever the tier.
  for (let i = 0; i < 25; i++) (r.record(`h${i}`, { key: 'claude:haiku', type: 'bug', at: Date.now() }), r.signal(`h${i}`, { feedback: 'up' }));
  assert.ok(!r.choose({ prompt: 'fix the bug', agents: AGENTS, goal: 'balanced' }).route.coldStart);
  assert.ok(tiers('balanced').has(1), 'haiku earned its place');
});

test('Best runs frontier models only, whatever the record of the others', () => {
  const r = new Router(tmp('router-frontier'));
  // Sonnet and Haiku win every task, Opus loses them: Best still never picks them.
  for (let i = 0; i < 30; i++) {
    for (const key of ['claude:sonnet:high', 'claude:haiku:high']) (r.record(`${key}${i}`, { key, type: 'bug', at: Date.now() }), r.signal(`${key}${i}`, { merged: true }));
    (r.record(`o${i}`, { key: 'claude:opus:high', type: 'bug', at: Date.now() }), r.signal(`o${i}`, { hero: 'blocked' }));
  }
  assert.ok(r.learned() >= 20, 'past the cold start');
  for (let i = 0; i < 40; i++) {
    const p = r.choose({ prompt: 'fix the bug', agents: AGENTS, goal: 'best', rng: seeded(i + 1) });
    assert.equal(tierOf(p.key), 3, p.key);
    assert.ok(!p.route.coldStart);
  }
  assert.equal(r.choose({ prompt: 'fix the bug', agents: AGENTS, goal: 'best', allowed: ['claude'], important: true }).model, 'opus');
  // Every frontier model taken or at its limit: nothing, not a step down.
  assert.equal(r.choose({ prompt: 'x', agents: AGENTS, goal: 'best', allowed: ['claude'], exclude: ['claude:opus'] }), null);
  r.cool('claude:opus', { scope: 'arm', ms: 60_000 });
  assert.equal(r.choose({ prompt: 'x', agents: AGENTS, goal: 'best', allowed: ['claude'] }), null);
  // No frontier model installed or allowed: the strongest there is.
  const everyday = [{ id: 'claude', name: 'Claude Code', available: true, models: [{ id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' }] }];
  assert.equal(r.choose({ prompt: 'x', agents: everyday, goal: 'best', important: true }).model, 'sonnet');
});

test('thinking levels: the goal sets the band, levels are learned, a model shares its record across them', () => {
  const LEVELS = [
    { id: 'claude', name: 'Claude Code', available: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }] },
    { id: 'antigravity', name: 'Antigravity', available: true, efforts: ['low', 'medium', 'high'], models: [{ id: 'gemini-3.8-flash-low', label: 'Flash Low', efforts: [] }] },
  ];
  assert.deepEqual(splitKey('claude:opus:high'), { agent: 'claude', model: 'opus', effort: 'high' });
  assert.deepEqual(splitKey('opencode:ollama/llama3:8b'), { agent: 'opencode', model: 'ollama/llama3:8b', effort: '' }, 'a colon in a model id is not a level');
  assert.deepEqual(splitKey('codex::low'), { agent: 'codex', model: '', effort: 'low' });
  assert.equal(tierOf('claude:sonnet:high'), 2, 'the level does not make a model stronger');
  assert.deepEqual(levelsFor(['low', 'medium', 'high', 'xhigh', 'max'], 'cheap'), ['low']);
  assert.deepEqual(levelsFor(['low', 'medium', 'high', 'xhigh', 'max'], 'balanced'), ['', 'medium']);
  assert.deepEqual(levelsFor(['low', 'medium', 'high', 'xhigh', 'max'], 'best'), ['high', 'xhigh']);
  assert.deepEqual(levelsFor([], 'best'), [''], 'no levels: the default');

  const r = new Router(tmp('router-levels'));
  const picks = (goal, opts = {}) => Array.from({ length: 30 }, (_, i) => r.choose({ prompt: 'fix the bug', agents: LEVELS, goal, rng: seeded(i + 5), ...opts }));
  for (const p of picks('cheap')) assert.equal(p.effort, p.model === 'gemini-3.8-flash-low' ? '' : 'low', p.key);
  for (const p of picks('balanced')) assert.ok(['', 'medium'].includes(p.effort), p.key);
  for (const p of picks('best')) assert.ok(['high', 'xhigh'].includes(p.effort), p.key);
  // Before any outcomes Best starts on high: xhigh costs more for about the same chance.
  const best = r.choose({ prompt: 'fix the bug', agents: LEVELS, goal: 'best', important: true });
  assert.equal(best.key, 'claude:opus:high');
  assert.equal(best.route.effort, 'high');
  assert.equal(best.label, 'Claude Code · Opus · High');
  assert.ok(r.estimate('bug', 'claude:opus:high').usd > r.estimate('bug', 'claude:opus').usd, 'thinking harder costs more');

  // xhigh earns its place on bugs; high on the same model learns from it at half weight.
  const highBefore = r.estimate('bug', 'claude:opus:high').mean;
  const sonnetBefore = r.estimate('bug', 'claude:sonnet:high').mean;
  for (let i = 0; i < 8; i++) (r.record(`x${i}`, { key: 'claude:opus:xhigh', type: 'bug', at: Date.now() }), r.signal(`x${i}`, { merged: true }));
  assert.ok(r.estimate('bug', 'claude:opus:high').mean > highBefore, 'the same model at another level counts');
  assert.equal(r.estimate('bug', 'claude:sonnet:high').mean, sonnetBefore, 'another model does not');
  for (let i = 0; i < 8; i++) (r.record(`h${i}`, { key: 'claude:opus:high', type: 'bug', at: Date.now() }), r.signal(`h${i}`, { hero: 'blocked' }));
  assert.equal(r.choose({ prompt: 'fix the bug', agents: LEVELS, goal: 'best', important: true }).key, 'claude:opus:xhigh');
  // Compare and hand-overs exclude every level of a taken model.
  for (const p of picks('balanced', { exclude: ['claude:opus:xhigh'] })) assert.notEqual(p.model, 'opus', p.key);
  assert.equal(r.choose({ prompt: 'fix the bug', agents: LEVELS, goal: 'best', exclude: ['claude:opus:xhigh'] }), null, 'Best never steps down to Sonnet');
  // A rate limit on one level rests the model at every level.
  r.cool('claude:opus:high', { scope: 'arm', ms: 60_000 });
  assert.ok(r.cooling('claude:opus:xhigh') && r.cooling('claude:opus') && !r.cooling('claude:sonnet:high'));
  // Settings shows the levels it has a record at, labelled.
  const rep = r.report(LEVELS);
  const x = rep.arms.find((a) => a.key === 'claude:opus:xhigh');
  assert.equal(x.label, 'Claude Code · Opus · X-High');
  assert.equal(x.effort, 'xhigh');
  assert.equal(x.n, 8);
  assert.ok(!rep.arms.some((a) => a.key === 'claude:sonnet:low'), 'levels without a record stay out of the list');
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
  // Cheap thinks low wherever the harness has levels, and the session runs at the level Auto picked.
  assert.equal(s.effort, s.route.effort ?? '');
  assert.ok(['', 'minimal', 'low'].includes(s.effort), s.effort);
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
