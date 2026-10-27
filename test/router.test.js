// Auto: the router that picks harness × model per task (server/router.js), on its own and
// through a real wisp server with the fake harnesses.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeRepo, tmp, until } from './helpers.js';

const { Router, classify, reward, betaSample, tierOf, infraError, splitKey, levelsFor, canon, ruleMatches } = await import('../server/router.js');
const { adapters } = await import('../server/adapters/index.js');

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

test('a machine\'s harnesses: Auto picks from them, they join the arms, and this computer\'s allowed list never strands it', async () => {
  const { createAuto } = await import('../server/services/auto.js');
  const router = new Router(tmp('router-machine'));
  const here = [AGENTS[0]]; // this computer: Claude Code only
  router.sync(here);
  const there = [
    { id: 'claude', name: 'Claude Code', available: false, signedIn: false, models: [{ id: '' }] },
    { id: 'opencode', name: 'opencode', available: true, models: [{ id: '' }, { id: 'opencode/free-1' }] },
  ];
  const defaults = { router: { allowed: ['claude'] } };
  const auto = createAuto({ store: { config: { defaults } }, router, runner: {}, broadcast: () => {}, telemetry: { track: () => {} }, uploads: {} });
  const body = { prompt: 'fix the login bug', agent: 'auto', model: 'balanced' };
  // Only Claude is allowed, and the machine has it signed out: Auto runs on what's there.
  for (let i = 0; i < 5; i++) assert.equal((await auto.resolve(body, there, { place: 'devbox' })).agent, 'opencode');
  // Its harness is an arm now, and this computer's stay as they were (nothing marked gone).
  assert.ok(router.state.arms['opencode:']);
  assert.equal(router.state.arms['claude:opus'].state, 'ready');
  // Where an allowed harness can run, the list still narrows the pick.
  assert.equal((await auto.resolve(body, [...there, { ...AGENTS[1] }, { ...AGENTS[0] }], { place: 'devbox' })).agent, 'claude');
  // Nothing signed in there: the error names the machine.
  await assert.rejects(auto.resolve(body, [there[0]], { place: 'devbox' }), /no harness installed and signed in on devbox/);
});

test('learning: outcomes move the estimate, per kind of task, and survive a restart', () => {
  const home = tmp('router-learn');
  const r = new Router(home);
  r.sync(AGENTS);
  const before = r.estimate('bug', 'codex:');
  for (let i = 0; i < 6; i++) {
    r.record(`s${i}`, { key: 'codex:', type: 'bug', label: 'Codex', at: Date.now() });
    r.signal(`s${i}`, { hero: 'done', costUsd: 0.1, ms: 60_000 });
    r.signal(`s${i}`, { feedback: 'down' }); // a later, stronger signal replaces the first
  }
  const after = r.estimate('bug', 'codex:');
  assert.ok(after.mean < before.mean, `${after.mean} < ${before.mean}`);
  assert.equal(after.n, 6);
  assert.ok(after.usd > 0.1 && after.usd < before.usd, `cost moves from the benchmarks toward what runs cost: ${after.usd}`);
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

test('tiers: from the benchmarks where they cover a model, else its name; "gemini" is not "mini"', () => {
  const keys = ['claude:haiku', 'claude:sonnet', 'claude:opus', 'claude:', 'codex:', 'codex:gpt-5.6-terra', 'codex:gpt-5.6-luna', 'grok:grok-4.7', 'grok:grok-4.6', 'grok:grok-4.7-build-fast', 'antigravity:gemini-4-argon-medium', 'antigravity:gemini-3.8-flash-medium', 'opencode:opencode/deepseek-v4.1-flash-free', 'opencode:ollama/llama3-ultra'];
  assert.deepEqual(keys.map(tierOf), [1, 2, 3, 3, 3, 3, 2, 2, 2, 1, 3, 2, 1, 3]);
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

test('Balanced runs on the strongest tier you have, whatever the record of the weaker ones; Cheap learns across tiers', () => {
  const r = new Router(tmp('router-tiers'));
  const everyday = [{ id: 'cursor', name: 'Cursor', available: true, models: [{ id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' }] }, { id: 'opencode', name: 'opencode', available: true, models: [{ id: 'opencode/deepseek-v4.1-flash-free', label: 'DeepSeek Flash' }] }];
  const tiers = (goal, agents = AGENTS) => new Set(Array.from({ length: 40 }, (_, i) => tierOf(r.choose({ prompt: 'fix the bug', agents, goal, rng: seeded(i + 3) }).key)));
  assert.deepEqual([...tiers('balanced')], [3], 'frontier when you have one');
  assert.deepEqual([...tiers('balanced', everyday)], [2], 'else everyday, never small');
  assert.deepEqual([...tiers('best')], [3], 'Best is frontier only');
  // A hand-over asks for a stronger tier than the run it replaces.
  for (let i = 0; i < 20; i++) assert.equal(tierOf(r.choose({ prompt: 'x', agents: AGENTS, goal: 'best', important: true, minTier: 3, rng: seeded(i + 1) }).key), 3);
  // DeepSeek winning every task makes it Cheap's pick, not Balanced's.
  const ds = 'opencode:opencode/deepseek-v4.1-flash-free';
  for (let i = 0; i < 25; i++) (r.record(`h${i}`, { key: ds, type: 'bug', at: Date.now() }), r.signal(`h${i}`, { feedback: 'up' }));
  assert.deepEqual([...tiers('balanced', everyday)], [2]);
  assert.ok(tiers('cheap', everyday).has(1), 'Cheap may pick it');
});
test('Balanced runs frontier models as their makers ship them or a level up; Best thinks high', () => {
  const LEVELS = [
    { id: 'claude', name: 'Claude Code', available: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], models: [{ id: '' }, { id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' }] },
    { id: 'antigravity', name: 'Antigravity', available: true, efforts: ['low', 'medium', 'high'], models: [{ id: '' }, ...['low', 'medium', 'high'].map((l) => ({ id: `gemini-4-argon-${l}`, label: `Argon ${l}`, efforts: [] })), { id: 'gemini-3.8-flash-medium', label: 'Flash', efforts: [] }] },
  ];
  const r = new Router(tmp('router-balanced'));
  // Sonnet and Haiku win every task, Opus loses some.
  for (let i = 0; i < 30; i++) {
    for (const key of ['claude:sonnet', 'claude:haiku:medium']) (r.record(`${key}${i}`, { key, type: 'bug', at: Date.now() }), r.signal(`${key}${i}`, { merged: true }));
    (r.record(`o${i}`, { key: 'claude:opus:medium', type: 'bug', at: Date.now() }), r.signal(`o${i}`, { hero: i % 2 ? 'done' : 'partial' }));
  }
  const picks = (goal, opts = {}) => Array.from({ length: 40 }, (_, i) => r.choose({ prompt: 'fix the bug', agents: LEVELS, goal, rng: seeded(i + 7), ...opts }));
  for (const p of picks('balanced')) {
    assert.equal(tierOf(p.key), 3, p.key);
    // Opus runs at medium in Claude Code: Balanced runs it there ('' or named) or at high, never lower.
    assert.ok(p.model === 'gemini-4-argon-medium' || (['', 'opus'].includes(p.model) && ['', 'high'].includes(p.effort)), p.key);
  }
  for (const p of picks('best')) assert.ok(p.key === 'antigravity:gemini-4-argon-high' || /^claude:(opus)?:(high|xhigh)$/.test(p.key), p.key);
  for (const p of picks('cheap', { allowed: ['antigravity'] })) assert.notEqual(p.model, 'gemini-4-argon-high', p.key);
  // Taking a model takes every variant of it.
  assert.equal(r.choose({ prompt: 'x', agents: LEVELS, goal: 'best', allowed: ['antigravity'], exclude: ['antigravity:gemini-4-argon-high'] }), null);
  // Every frontier model at its limit: Balanced steps down so the task still runs (Best doesn't),
  // and Sonnet goes a level up from its Claude Code default: 15 points more at high.
  r.cool('claude:opus', { scope: 'arm', ms: 60_000 });
  const down = r.choose({ prompt: 'x', agents: LEVELS, goal: 'balanced', allowed: ['claude'], important: true });
  assert.equal(down.model, 'sonnet');
  assert.equal(r.choose({ prompt: 'x', agents: LEVELS, goal: 'best', allowed: ['claude'] }), null);
  const fresh = new Router(tmp('router-sonnet'));
  assert.equal(fresh.choose({ prompt: 'x', agents: [{ ...LEVELS[0], models: [{ id: 'sonnet', label: 'Sonnet' }] }], goal: 'balanced', important: true, exclude: ['claude:opus'] }).key, 'claude:sonnet:high');
});
test('Best runs frontier models only, whatever the record of the others', () => {
  const r = new Router(tmp('router-frontier'));
  // Sonnet and Haiku win every task, Opus loses them: Best still never picks them.
  for (let i = 0; i < 30; i++) {
    for (const key of ['claude:sonnet:high', 'claude:haiku:high']) (r.record(`${key}${i}`, { key, type: 'bug', at: Date.now() }), r.signal(`${key}${i}`, { merged: true }));
    (r.record(`o${i}`, { key: 'claude:opus:high', type: 'bug', at: Date.now() }), r.signal(`o${i}`, { hero: 'blocked' }));
  }
  for (let i = 0; i < 40; i++) {
    const p = r.choose({ prompt: 'fix the bug', agents: AGENTS, goal: 'best', rng: seeded(i + 1) });
    assert.equal(tierOf(p.key), 3, p.key);
  }
  const top = r.choose({ prompt: 'fix the bug', agents: AGENTS, goal: 'best', allowed: ['claude'], important: true });
  assert.equal(canon(top.key).split(':')[1], 'opus', top.key);
  // Every frontier model taken or at its limit: nothing, not a step down. Taking Opus takes the
  // harness default too: it's the same model.
  assert.equal(r.choose({ prompt: 'x', agents: AGENTS, goal: 'best', allowed: ['claude'], exclude: ['claude:opus'] }), null);
  r.cool('claude:opus', { scope: 'arm', ms: 60_000 });
  assert.equal(r.choose({ prompt: 'x', agents: AGENTS, goal: 'best', allowed: ['claude'] }), null);
  // No frontier model installed or allowed: the strongest there is.
  const everyday = [{ id: 'cursor', name: 'Cursor', available: true, models: [{ id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' }] }, { id: 'opencode', name: 'opencode', available: true, models: [{ id: 'opencode/deepseek-v4.1-flash-free' }] }];
  assert.equal(r.choose({ prompt: 'x', agents: everyday, goal: 'best', important: true, allowed: ['opencode'] }).model, '', 'opencode\'s default is everyday, DeepSeek Flash small');
});
test('thinking levels: the goal sets the band from the model\'s own default, levels are learned, a model shares its record across them', () => {
  const LEVELS = [
    { id: 'claude', name: 'Claude Code', available: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }] },
    { id: 'antigravity', name: 'Antigravity', available: true, efforts: ['low', 'medium', 'high'], models: [{ id: 'gemini-3.8-flash-low', label: 'Flash Low', efforts: [] }] },
  ];
  assert.deepEqual(splitKey('claude:opus:high'), { agent: 'claude', model: 'opus', effort: 'high' });
  assert.deepEqual(splitKey('opencode:ollama/llama3:8b'), { agent: 'opencode', model: 'ollama/llama3:8b', effort: '' }, 'a colon in a model id is not a level');
  assert.deepEqual(splitKey('codex::low'), { agent: 'codex', model: '', effort: 'low' });
  assert.equal(tierOf('claude:sonnet:high'), 2, 'the level does not make a model stronger');
  const ALL = ['low', 'medium', 'high', 'xhigh', 'max'];
  assert.deepEqual(levelsFor(ALL, 'cheap'), ['low']);
  assert.deepEqual(levelsFor(ALL, 'balanced', 'medium'), ['', 'high'], 'the default or one up');
  assert.deepEqual(levelsFor(ALL, 'balanced', 'high'), [''], 'never up to xhigh: that is Best');
  assert.deepEqual(levelsFor(ALL, 'best'), ['high', 'xhigh']);
  assert.deepEqual(levelsFor([], 'best'), [''], 'no levels: the default');
  // One run, three names.
  assert.equal(canon('claude:'), 'claude:opus:medium');
  assert.equal(canon('claude:opus'), 'claude:opus:medium');
  assert.equal(canon('claude:sonnet'), 'claude:sonnet:medium');
  assert.equal(canon('cursor:gpt-5.3-codex'), 'cursor:gpt-5.3-codex');

  const r = new Router(tmp('router-levels'));
  const picks = (goal, opts = {}) => Array.from({ length: 30 }, (_, i) => r.choose({ prompt: 'fix the bug', agents: LEVELS, goal, rng: seeded(i + 5), ...opts }));
  for (const p of picks('cheap')) assert.equal(p.effort, p.model === 'gemini-3.8-flash-low' ? '' : 'low', p.key);
  for (const p of picks('balanced')) assert.ok(['', 'high'].includes(p.effort), p.key);
  for (const p of picks('best')) assert.ok(['high', 'xhigh'].includes(p.effort), p.key);
  // Before any outcomes Best starts on high: xhigh costs 2.5× for a point or two.
  const best = r.choose({ prompt: 'fix the bug', agents: LEVELS, goal: 'best', important: true });
  assert.equal(best.key, 'claude:opus:high');
  assert.equal(best.route.effort, 'high');
  assert.equal(best.label, 'Claude Code · Opus · High');
  assert.ok(r.estimate('bug', 'claude:opus:high').usd > r.estimate('bug', 'claude:opus').usd, 'thinking harder costs more');
  // The benchmarks' numbers come through: Opus low < medium < high, Sonnet medium well below high.
  const m = (k) => r.estimate('bug', k).mean;
  assert.ok(m('claude:opus:low') < m('claude:opus') && m('claude:opus') < m('claude:opus:high'));
  assert.ok(m('claude:sonnet:high') - m('claude:sonnet') > 0.1, 'Sonnet at medium loses 15 points');
  assert.ok(r.estimate('bug', 'claude:opus:high').prior);

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
test('taste: Auto starts from what you pick yourself, per kind of task, and says so', () => {
  const r = new Router(tmp('router-taste'));
  const ALL = [
    { id: 'claude', name: 'Claude Code', available: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], models: [{ id: '' }, { id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }] },
    { id: 'codex', name: 'Codex', available: true, efforts: ['low', 'medium', 'high', 'xhigh'], models: [{ id: '' }, { id: 'gpt-5.6-terra', label: 'Terra' }] },
  ];
  const pick = (prompt, opts = {}) => r.choose({ prompt, agents: ALL, preview: true, ...opts });
  // Before any habit the benchmarks decide: Terra at high is cheaper than Opus for about the same.
  assert.equal(pick('fix the bug').agent, 'codex');
  // You run Claude Code's default on bugs, and Codex on UI work.
  for (let i = 0; i < 20; i++) r.observe({ agent: 'claude', prompt: `fix the crash ${i}` });
  for (let i = 0; i < 8; i++) r.observe({ agent: 'codex', model: 'gpt-5.6-terra', prompt: `restyle the settings button ${i}` });
  const bug = pick('fix the login bug');
  assert.equal(bug.key, 'claude:', 'launched by the name you use');
  assert.match(bug.route.why, /your usual for bug tasks \(20 of yours\)/);
  assert.ok(bug.route.taste > 0.9, String(bug.route.taste));
  assert.equal(pick('make the button blue').agent, 'codex');
  // Habits off: back to the record alone.
  assert.equal(pick('fix the login bug', { habits: false }).agent, 'codex');
  // Best still thinks high on your model, not at its default.
  assert.equal(pick('fix the login bug', { goal: 'best' }).key, 'claude:opus:high');
  // A kind you've rarely done leans on your picks overall.
  assert.equal(pick('update the README').agent, 'claude');
});

test('taste: a backfill reads your launches once; a run you picked teaches the record at half weight', () => {
  const r = new Router(tmp('router-backfill'));
  const sessions = [
    { id: 'a', agent: 'claude', model: '', effort: '', createdAt: 1, turns: [{ prompt: 'fix it' }] },
    { id: 'b', agent: 'claude', model: 'opus', effort: '', createdAt: 2, turns: [{ prompt: 'fix that' }] },
    { id: 'c', agent: 'codex', model: '', createdAt: 3, route: { key: 'codex:' }, turns: [{ prompt: 'x' }] }, // Auto's, not yours
    { id: 'd', agent: 'wisp', createdAt: 4, turns: [{ prompt: 'x' }] },
    { id: 'e', agent: 'claude', kind: 'spell', createdAt: 5, turns: [{ prompt: 'x' }] },
  ];
  assert.equal(r.backfill(sessions), 2);
  assert.equal(r.backfill(sessions), 0, 'once');
  assert.equal(r.picks('bug', 'claude:opus:medium').here, 2, 'claude: and claude:opus are one run');
  r.record('m', { key: 'claude:', type: 'bug', manual: true, at: Date.now() });
  r.record('a1', { key: 'claude:', type: 'bug', at: Date.now() });
  r.signal('m', { hero: 'done' });
  r.signal('a1', { hero: 'done' });
  const s = r.state.stats['bug|claude:'];
  assert.ok(Math.abs(s.a - 0.9) < 1e-9 && Math.abs(s.b - 0.6) < 1e-9, JSON.stringify(s));
  assert.equal(r.report([]).routed, 1, "your own runs aren't Auto's picks");
});

test('rules: never pick and prefer, per model or per kind of task; a preview pin runs what you saw', () => {
  const r = new Router(tmp('router-rules'));
  const agents = AGENTS.filter((a) => a.id !== 'antigravity');
  assert.ok(ruleMatches('claude', 'claude:opus:high'));
  assert.ok(ruleMatches('claude:opus', 'claude::high'), 'the harness default is Opus');
  assert.ok(ruleMatches('claude:opus:high', 'claude:opus:high') && !ruleMatches('claude:opus:high', 'claude:opus'));
  assert.ok(ruleMatches('claude:sonnet@ui', 'claude:sonnet', 'ui') && !ruleMatches('claude:sonnet@ui', 'claude:sonnet', 'bug'));
  for (let i = 0; i < 20; i++) assert.notEqual(r.choose({ prompt: 'fix it', agents, blocked: ['claude'], rng: seeded(i + 1) }).agent, 'claude');
  for (let i = 0; i < 20; i++) assert.equal(r.choose({ prompt: 'fix it', agents, blocked: ['codex'], rng: seeded(i + 1) }).agent, 'claude');
  assert.equal(r.choose({ prompt: 'fix it', agents, blocked: ['claude', 'codex'] }), null);
  // Rules come from Settings when the caller passes none (the pipeline's hand-overs, subagents).
  r.prefs = () => ({ blocked: ['codex@bug'] });
  for (let i = 0; i < 10; i++) assert.equal(r.choose({ prompt: 'fix the bug', agents, rng: seeded(i + 1) }).agent, 'claude');
  r.prefs = () => ({ prefer: ['codex'] });
  assert.equal(r.choose({ prompt: 'fix the bug', agents, preview: true }).agent, 'codex');
  assert.match(r.choose({ prompt: 'fix the bug', agents, preview: true }).route.why, /you prefer it/);
  r.prefs = () => ({});
  // A preview is the same every time; the launch keeps it.
  const a = r.choose({ prompt: 'fix the bug', agents, preview: true, rng: seeded(1) });
  const b = r.choose({ prompt: 'fix the bug', agents, preview: true, rng: seeded(77) });
  assert.equal(a.key, b.key);
  const other = a.route.alternatives[0];
  for (let i = 0; i < 10; i++) {
    const p = r.choose({ prompt: 'fix the bug', agents, pin: other.key, rng: seeded(i + 1) });
    assert.equal(p.key, other.key);
    assert.match(p.route.why, /as previewed/);
  }
  // A pin that can't run any more (at its limit) falls back to a fresh pick.
  r.cool(other.key, { scope: 'agent', ms: 60_000 });
  assert.notEqual(r.choose({ prompt: 'fix the bug', agents, pin: other.key }).agent, splitKey(other.key).agent);
});

test('corrections: changing the preview counts against it and for yours; a better arm is suggested, not run', () => {
  const r = new Router(tmp('router-override'));
  const agents = AGENTS.filter((a) => a.id !== 'antigravity');
  const shown = r.choose({ prompt: 'fix the bug', agents, preview: true });
  const chose = shown.agent === 'codex' ? 'claude:opus:high' : 'codex:';
  const before = r.estimate('bug', shown.key).mean;
  r.override({ type: 'bug', auto: shown.key, chose, prompt: 'fix the bug' });
  assert.ok(r.estimate('bug', shown.key).mean < before);
  assert.equal(r.picks('bug', chose).here, 2, 'a correction counts double');
  assert.equal(r.report([]).corrections, 1);
  // Codex wins every bug here, but it isn't your habit any more than Sonnet: it's offered.
  const s2 = new Router(tmp('router-suggest'));
  for (let i = 0; i < 30; i++) s2.observe({ agent: 'claude', model: 'opus', prompt: `fix bug ${i}` });
  for (let i = 0; i < 6; i++) (s2.record(`c${i}`, { key: 'codex:', type: 'bug', at: Date.now() }), s2.signal(`c${i}`, { merged: true }));
  const p = s2.choose({ prompt: 'fix the bug', agents, preview: true });
  assert.equal(p.agent, 'claude', 'your habit runs');
  assert.equal(p.route.suggest?.agent, 'codex', JSON.stringify(p.route.suggest));
  assert.match(p.route.suggest.why, /on your bug tasks/);
  // A record far worse than the alternative's outweighs the habit: then the record runs, and says why.
  for (let i = 0; i < 30; i++) (s2.record(`o${i}`, { key: 'claude:opus', type: 'bug', at: Date.now() }), s2.signal(`o${i}`, { hero: 'blocked' }));
  const worse = s2.choose({ prompt: 'fix the bug', agents, preview: true });
  assert.equal(worse.agent, 'codex');
  assert.match(worse.route.why, /on your bug tasks \(6\)/);
  assert.equal(new Router(tmp('router-suggest-off')).choose({ prompt: 'fix the bug', agents, preview: true, explore: false }).route.suggest, undefined, 'no suggestions with trying new models off');
});

test('level up: a run at low or medium that failed goes again at high on the same model', () => {
  const r = new Router(tmp('router-levelup'));
  const LV = [{ id: 'claude', name: 'Claude Code', available: true, efforts: ['low', 'medium', 'high'], models: [{ id: 'opus', label: 'Opus' }] }];
  const low = r.choose({ prompt: 'fix the bug', agents: LV, goal: 'cheap', important: true });
  assert.equal(low.key, 'claude:opus:low');
  const up = r.levelUp(low.route, LV);
  assert.equal(up.key, 'claude:opus:high');
  assert.equal(up.label, 'Claude Code · Opus · High');
  assert.equal(r.levelUp({ ...low.route, key: 'claude:opus' }, LV).key, 'claude:opus:high', 'from the default (medium) too');
  assert.equal(r.levelUp({ ...low.route, key: 'claude:opus:high' }, LV), null, 'no x-high here');
  assert.equal(r.levelUp({ ...low.route, key: 'claude:opus:high', label: 'Claude Code · Opus · High' }, [{ ...LV[0], efforts: ['low', 'medium', 'high', 'xhigh'] }]).label, 'Claude Code · Opus · X-High', 'high goes to x-high');
  assert.equal(r.levelUp({ key: 'cursor:gpt-5.3-codex' }, [{ id: 'cursor', available: true, models: [{ id: 'gpt-5.3-codex' }] }]), null, 'no levels');
});

test('priors: the shipped file is what the sources make, every number has a source', async () => {
  const { buildPriors } = await import('../server/priors-build.js');
  const src = JSON.parse(fs.readFileSync(new URL('../scripts/priors-sources.json', import.meta.url), 'utf8'));
  const shipped = JSON.parse(fs.readFileSync(new URL('../server/router-priors.json', import.meta.url), 'utf8'));
  assert.deepEqual(buildPriors(src), shipped, 'run node scripts/priors.mjs');
  for (const row of src.rows) {
    assert.ok(src.sources[row.source]?.url?.startsWith('https://'), `${row.arm}: source ${row.source}`);
    assert.ok(row.score > 0 && row.score <= 100, row.arm);
  }
  for (const [k, v] of Object.entries(shipped.arms)) {
    const m = v.a / (v.a + v.b);
    assert.ok(m > 0.3 && m < 0.96 && v.usd >= 0 && v.min > 0, k);
    assert.ok(v.from.length, `${k} names where it came from`);
  }
  const mean = (k) => shipped.arms[k].a / (shipped.arms[k].a + shipped.arms[k].b);
  assert.equal(mean('claude:opus:medium'), src.anchor.chance, 'the anchor');
  assert.ok(mean('claude:opus:high') > mean('claude:opus:medium') && mean('claude:opus:medium') > mean('claude:opus:low'));
  assert.ok(mean('codex:gpt-5.6-sol:medium') > mean('codex:gpt-5.6-terra:medium') && mean('codex:gpt-5.6-terra:medium') > mean('codex:gpt-5.6-luna:medium'));
  assert.ok(mean('opencode:opencode/deepseek-v4.1-flash-free') < 0.75, 'no more 10 wins out of 10');
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
  // Any registered harness: Auto may pick a different one from run to run.
  assert.ok(Object.hasOwn(adapters, s.agent), s.agent);
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

test('preview: what Auto would run, then the launch keeps it; a harness you pick after a preview is a correction', async () => {
  const p = await api('/router/preview', { prompt: 'fix the add bug', goal: 'balanced' });
  assert.ok(p.pick?.key && p.why && Array.isArray(p.alternatives), JSON.stringify(p));
  assert.equal(p.type, 'bug');
  assert.deepEqual((await api('/router/preview', { prompt: 'fix the add bug', goal: 'balanced' })).pick, p.pick, 'no dice');
  const alt = p.alternatives.find((a) => a.agent !== p.pick.agent) || p.alternatives[0];
  const s = await api('/sessions', { prompt: 'fix the add bug', cwd: makeRepo(), agent: 'auto', model: 'balanced', worktree: false, autoPin: alt.key });
  assert.deepEqual([s.agent, s.model || '', s.effort || ''], [alt.agent, alt.model, alt.effort]);
  assert.equal(s.route.pinned, true);
  // You picked a harness yourself instead of the preview.
  const before = (await api('/router')).corrections;
  const own = await api('/sessions', { prompt: 'fix the add bug', cwd: makeRepo(), agent: 'codex', worktree: false, autoOverride: { key: p.pick.key, type: 'bug' } });
  assert.equal(own.agent, 'codex');
  assert.equal((await api('/router')).corrections, before + 1);
  await until(async () => (await api('/router')).picks >= 2);
  // Rules are checked.
  await assert.rejects(api('/router', { blocked: ['nope:x'] }, 'PATCH'), /isn't a harness/);
  await assert.rejects(api('/router', { blocked: ['claude@sometimes'] }, 'PATCH'), /isn't a harness/);
  const set = await api('/router', { blocked: ['claude:sonnet@ui', 'codex'], prefer: ['claude'], habits: false }, 'PATCH');
  assert.deepEqual(set.settings.blocked, ['claude:sonnet@ui', 'codex']);
  assert.equal(set.settings.habits, false);
  for (let i = 0; i < 5; i++) assert.notEqual((await api('/router/preview', { prompt: `fix bug ${i}` })).pick?.agent, 'codex');
  await api('/router', { blocked: [], prefer: [], habits: true }, 'PATCH');
});
