// A harness that turned the task down (server/refusal.js, server/runner.js #refused): told apart
// conservatively from a failure or an answer, and the task offers to hand the same prompt to another
// harness (turn.refusal), which only happens when you pick it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeRepo, tmp, until } from './helpers.js';

process.env.WISP_HOME = tmp('refusal-wisp');
process.env.WISP_UPDATE_CHECK = '0';
process.env.CLAUDE_CONFIG_DIR = tmp('refusal-claude-home');
process.env.CODEX_HOME = tmp('refusal-codex-home');
installFakeBins();

const { refusalOf } = await import('../server/refusal.js');
const { vendorOf, handoffTargets } = await import('../web/js/vendors.js');
const { constraintsOf, handoffNote, mapEffort } = await import('../server/handoff.js');
const { startServer } = await import('../server/index.js');

const CC = 'API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Please double press esc to edit your last message or start a new session for Claude Code to assist with a different task.';

test('refusalOf: the API\'s stop_reason and the CLIs\' usage-policy errors are refusals', () => {
  assert.equal(refusalOf({ text: 'anything', stopReason: 'refusal' })?.kind, 'policy');
  assert.equal(refusalOf({ text: CC, isError: true })?.kind, 'policy');
  assert.match(refusalOf({ text: CC, isError: true }).line, /Usage Policy/);
  assert.equal(refusalOf({ text: 'Invalid prompt: your prompt was flagged as potentially violating our usage policy.', isError: true })?.kind, 'policy');
  // Even after the run changed files: the policy error is the CLI's, not the model's wording.
  assert.equal(refusalOf({ text: CC, changes: 3 })?.kind, 'policy');
});

test('refusalOf: a short answer that opens by declining is one; a real answer or a failure is not', () => {
  for (const t of ["I'm sorry, but I can't help with that.", 'I can’t assist with creating malware.', 'Sorry, I won\'t write an aimbot for that game.', '**I cannot help with reverse engineering this DRM.**', 'Unfortunately, I am unable to help with this request.'])
    assert.equal(refusalOf({ text: t })?.kind, 'declined', t);
  for (const t of [
    "I can't find the file src/a.js; which one did you mean?", // not a verb of helping
    "I couldn't run the tests because npm isn't installed.",
    'Fixed the bug. Note that I cannot help it if the API is down.', // doesn't open with it
    `I can't help with the deploy step, but here is everything else.\n\n${'x'.repeat(700)}`, // a long answer
    '',
  ])
    assert.equal(refusalOf({ text: t }), null, t);
  assert.equal(refusalOf({ text: "I'm sorry, but I can't help with that.", changes: 1 }), null, 'it changed files: it worked on the task');
  assert.equal(refusalOf({ text: "fake: I can't help, not logged in (401)", isError: true }), null, 'an error is a refusal only with the policy wording');
  assert.equal(refusalOf({ text: 'You\'ve hit your session limit · resets 9pm', isError: true }), null, 'a usage limit is not a refusal');
});

// End to end through a real server with the fake claude and codex.
let srv;
let base;
const freePort = () => new Promise((resolve) => {
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
const settled = (id, n = 1) => until(async () => {
  const v = await api(`/sessions/${id}`);
  return v.state !== 'running' && v.turns.length >= n && v.turns.at(-1).status !== 'running' && v;
}, { timeout: 30_000 });
before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
  srv.later.stop();
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

test('Claude Code refuses: the turn says so and offers a hand-off; nothing moves until you pick it', async () => {
  const prompt = 'REFUSEME reverse engineer the license check in ./bin/app';
  const s = await api('/sessions', { prompt, cwd: makeRepo(), agent: 'claude', worktree: false });
  const x = await settled(s.id);
  const t = x.turns[0];
  assert.deepEqual({ agent: t.refusal?.agent, kind: t.refusal?.kind, vendor: t.refusal?.vendor }, { agent: 'claude', kind: 'policy', vendor: 'anthropic' });
  assert.match(t.refusal.line, /Usage Policy/);
  assert.equal(t.limit, undefined, 'not a usage limit');
  const hero = t.presentation.blocks[0];
  assert.equal(hero.type, 'hero');
  assert.match(hero.title, /Claude Code turned this task down/);
  assert.equal(hero.status, 'blocked');
  assert.ok(t.presentation.blocks.some((b) => /Usage Policy/.test(b.output || b.text || '')), 'what the CLI said stays on the turn');
  assert.equal(x.agent, 'claude', 'never handed over by itself');
  assert.equal(x.turns.length, 1);

  // Hand to Codex: the card sends the same prompt to the other harness, which hears the task first.
  await api(`/sessions/${s.id}/reply`, { text: prompt, agent: 'codex' });
  const y = await settled(s.id, 2);
  assert.equal(y.agent, 'codex');
  assert.equal(y.turns[1].prompt, prompt);
  assert.equal(y.turns[1].status, 'done');
  assert.equal(y.turns[1].refusal, undefined);
});

test('a plain "I can\'t help with that" is a refusal too; an ordinary answer is not', async () => {
  const a = await api('/sessions', { prompt: 'DECLINEME look at the binary', cwd: makeRepo(), agent: 'claude', worktree: false });
  const x = await settled(a.id);
  assert.equal(x.turns[0].status, 'done');
  assert.equal(x.turns[0].refusal?.kind, 'declined');
  assert.match(x.turns[0].presentation.blocks[0].title, /turned this task down/);

  const b = await api('/sessions', { prompt: 'fix the add bug please', cwd: makeRepo(), agent: 'claude', worktree: false });
  const y = await settled(b.id);
  assert.equal(y.turns[0].refusal, undefined);
});

test('vendorOf: whose model a harness runs, from the model id or the single-vendor harness', () => {
  for (const [m, a, v] of [
    ['', 'claude', 'anthropic'], ['opus', 'claude', 'anthropic'], ['claude-sonnet-4.5', 'copilot', 'anthropic'],
    ['anthropic/claude-opus-4-1', 'opencode', 'anthropic'], ['github-copilot/claude-sonnet-4', 'opencode', 'anthropic'],
    ['sonnet-4.5-thinking', 'cursor', 'anthropic'], ['claude-sonnet-4-5', 'antigravity', 'anthropic'],
    ['', 'codex', 'openai'], ['gpt-5.1-codex', 'codex', 'openai'], ['gpt-5', 'copilot', 'openai'], ['o4-mini', 'opencode', 'openai'],
    ['openrouter/openai/gpt-5', 'opencode', 'openai'], ['gemini-3-pro', 'antigravity', 'google'], ['', 'grok', 'xai'],
    ['composer-1', 'cursor', 'cursor'], ['deepseek/deepseek-chat', 'opencode', 'deepseek'],
    ['', 'copilot', ''], ['', 'opencode', ''], ['auto', 'cursor', ''], ['', 'antigravity', ''],
  ]) assert.equal(vendorOf(m, a), v, `${a} ${m || '(default)'}`);
});

test('handoffTargets: a refusal is only offered to another vendor\'s model, pinned on the hand-off', () => {
  const agents = [
    { id: 'claude', available: true, models: [{ id: '' }, { id: 'opus' }, { id: 'sonnet' }] },
    { id: 'copilot', available: true, models: [{ id: '' }, { id: 'claude-sonnet-4.5' }, { id: 'gpt-5' }] },
    { id: 'opencode', available: true, models: [{ id: '' }, { id: 'anthropic/claude-opus-4-1' }, { id: 'openai/gpt-5' }] },
    { id: 'cursor', available: true, models: [{ id: '' }, { id: 'sonnet-4.5' }] },
    { id: 'codex', available: true, models: [{ id: '' }] },
    { id: 'grok', available: false, models: [{ id: '' }] },
    { id: 'wisp', available: true },
  ];
  const pairs = (xs) => xs.map((x) => `${x.agent}:${x.model}`);
  // Claude refused: Copilot and opencode go on their GPT model, Cursor (only Claude listed) and
  // the unavailable Grok are left out, Codex goes as it is.
  const claude = handoffTargets({ from: 'claude', fromModel: '', agents, max: 9 });
  assert.deepEqual(pairs(claude), ['copilot:gpt-5', 'opencode:openai/gpt-5', 'codex:']);
  for (const x of claude) assert.notEqual(vendorOf(x.model, x.agent), 'anthropic');
  // Copilot set to Claude in wisp: still pinned to GPT. Set to GPT: kept.
  assert.deepEqual(pairs(handoffTargets({ from: 'claude', agents, models: { copilot: 'claude-sonnet-4.5' }, max: 9 })).slice(0, 1), ['copilot:gpt-5']);
  assert.deepEqual(pairs(handoffTargets({ from: 'claude', agents, models: { copilot: 'gpt-5' }, max: 9 })).slice(0, 1), ['copilot:gpt-5']);
  // Codex refused: no OpenAI model again, Claude Code goes as it is.
  const codex = handoffTargets({ from: 'codex', agents, max: 9 });
  assert.deepEqual(pairs(codex), ['claude:', 'copilot:claude-sonnet-4.5', 'opencode:anthropic/claude-opus-4-1', 'cursor:sonnet-4.5']);
  for (const x of codex) assert.notEqual(vendorOf(x.model, x.agent), 'openai');
  // Copilot refused on Claude: Claude Code is the same vendor, so it's out.
  assert.deepEqual(pairs(handoffTargets({ from: 'copilot', fromModel: 'claude-sonnet-4.5', agents, max: 9 })), ['opencode:openai/gpt-5', 'codex:']);
  // A harness whose only models are unknown never qualifies; at most `max`.
  assert.deepEqual(handoffTargets({ from: 'claude', agents: [{ id: 'copilot', available: true, models: [{ id: '' }] }] }), []);
  assert.equal(handoffTargets({ from: 'grok', agents }).length, 3);
});

// Moris check-in 12 #2: the hand-off carries the user's constraints, the task's effort and its Done when.
test('constraintsOf: the user\'s "don\'t touch / only change / leave … alone" lines, from their own turns, once each', () => {
  const s = {
    turns: [
      { prompt: 'Fix the login bug. Don\u2019t touch the migrations folder.\n- only change server/auth\nLeave the tests alone please. Make it fast.' },
      { prompt: 'never push to main', by: 'wisp' },
      { prompt: "What's missing: do not modify x", goal: true },
      { prompt: 'Carry on. Never push to main', later: { by: 'user' } },
      { prompt: 'Add a test, but no new dependencies. Don\'t touch the migrations folder.' },
      { prompt: 'Thanks, that looks good' },
    ],
  };
  assert.deepEqual(constraintsOf(s), ["Don't touch the migrations folder.", 'only change server/auth', 'Leave the tests alone please.', 'Add a test, but no new dependencies.']);
  assert.deepEqual(constraintsOf({ turns: [{ prompt: 'fix the add bug please' }] }), []);
  assert.equal(constraintsOf({ turns: Array.from({ length: 20 }, (_, i) => ({ prompt: `Don't touch file${i}.js` })) }).length, 12, 'at most 12, the latest');
});

test('mapEffort: the same level, else the nearest the harness has (the lower on a tie), else none', () => {
  const codex = ['minimal', 'low', 'medium', 'high', 'xhigh'];
  assert.equal(mapEffort('medium', codex), 'medium');
  assert.equal(mapEffort('max', codex), 'xhigh');
  assert.equal(mapEffort('minimal', ['low', 'medium', 'high']), 'low');
  assert.equal(mapEffort('medium', ['low', 'high']), 'low');
  assert.equal(mapEffort('high', []), '', 'a harness without levels');
  assert.equal(mapEffort('', codex), '');
  assert.equal(mapEffort('turbo', codex), '', 'a level wisp doesn\'t know');
});

test('handoffNote: What still holds, with the constraints and Done when, ahead of the turns', () => {
  const s = { turns: [{ agent: 'claude', prompt: 'Refactor auth. Don\'t touch the migrations.', status: 'done', raw: 'I can\'t help with that.' }, { agent: 'codex', prompt: 'x', status: 'running' }], goal: { text: 'npm test passes', status: 'working' } };
  const note = handoffNote(s, 'codex', null, (t) => t.agent);
  assert.match(note, /### What still holds\n\n.*\n\n- Don't touch the migrations\.\n- Done when: npm test passes/);
  assert.ok(note.indexOf('What still holds') < note.indexOf('### Turn 1'));
  assert.doesNotMatch(handoffNote({ ...s, goal: { text: 'npm test passes', status: 'met' } }, 'codex', null, (t) => t.agent), /Done when/, 'a met goal is over');
  assert.doesNotMatch(handoffNote({ turns: [{ agent: 'claude', prompt: 'fix it', status: 'done' }, { prompt: 'x' }] }, 'codex', null, (t) => t.agent), /What still holds/, 'nothing to carry: no section');
});

test('Hand to Codex after a refusal: Codex hears the constraints, at the task\'s effort', async () => {
  const rec = tmp('refusal-rec');
  process.env.FAKE_RECORD = rec;
  try {
    const prompt = "REFUSEME reverse engineer the license check in ./bin/app. Don't touch the tests folder.";
    const s = await api('/sessions', { prompt, cwd: makeRepo(), agent: 'claude', effort: 'max', worktree: false });
    await settled(s.id);
    await api(`/sessions/${s.id}/reply`, { text: prompt, agent: 'codex' });
    const y = await settled(s.id, 2);
    assert.equal(y.agent, 'codex');
    assert.equal(y.effort, 'xhigh', 'Claude max → Codex xhigh, not Codex\'s default');
    const runs = fs.readFileSync(path.join(rec, 'codex.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(runs.length, 1);
    const said = [...runs[0].argv, runs[0].stdin || ''].join('\n');
    assert.match(said, /### What still holds\n\n.*\n\n- Don't touch the tests folder\.\n\n### Turn 1/, 'only the constraint, ahead of the turns');
    const run = runs[0];
    assert.ok(run.argv.join(' ').includes('model_reasoning_effort="xhigh"'), run.argv.join(' '));
    // Picking an effort on the switch wins; the same harness keeps its level when none is sent.
    await api(`/sessions/${s.id}/reply`, { text: 'and the docs', agent: 'codex', effort: 'low' });
    assert.equal((await settled(s.id, 3)).effort, 'low');
    await api(`/sessions/${s.id}/reply`, { text: 'and the readme', account: '' });
    assert.equal((await settled(s.id, 4)).effort, 'low');
  } finally {
    delete process.env.FAKE_RECORD;
  }
});
