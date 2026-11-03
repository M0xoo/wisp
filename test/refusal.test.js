// A harness that turned the task down (server/refusal.js, server/runner.js #refused): told apart
// conservatively from a failure or an answer, and the task offers to hand the same prompt to another
// harness (turn.refusal), which only happens when you pick it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { installFakeBins, makeRepo, tmp, until } from './helpers.js';

process.env.WISP_HOME = tmp('refusal-wisp');
process.env.WISP_UPDATE_CHECK = '0';
process.env.CLAUDE_CONFIG_DIR = tmp('refusal-claude-home');
process.env.CODEX_HOME = tmp('refusal-codex-home');
installFakeBins();

const { refusalOf } = await import('../server/refusal.js');
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
  assert.deepEqual({ agent: t.refusal?.agent, kind: t.refusal?.kind }, { agent: 'claude', kind: 'policy' });
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
