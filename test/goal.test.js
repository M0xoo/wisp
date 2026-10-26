// Goals (server/goal.js): the task keeps going until wisp's check finds the condition holds, can't
// hold, or it runs out of rounds. The fake harness's checker reads its verdict off the goal's text.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { installFakeBins, makeRepo, tmp, until } from './helpers.js';

const { goalCommand, normalizeGoal, goalNote } = await import('../server/goal.js');

test('goalCommand and normalizeGoal read what the user typed', () => {
  assert.equal(goalCommand('/goal all tests pass'), 'all tests pass');
  assert.equal(goalCommand('/goal'), '');
  assert.equal(goalCommand('/goals are nice'), null);
  assert.equal(goalCommand('fix it'), null);
  assert.deepEqual(normalizeGoal('tests pass'), { text: 'tests pass', max: 10 });
  assert.deepEqual(normalizeGoal({ text: ' x ', max: 3 }), { text: 'x', max: 3 });
  assert.equal(normalizeGoal({ text: '  ' }), null);
  assert.throws(() => normalizeGoal({ text: 'x', max: 0 }), /1 to 20/);
  assert.throws(() => normalizeGoal('x'.repeat(1001)), /at most 1000/);
  assert.match(goalNote({ goal: { text: 'it builds', round: 2, max: 5, status: 'working' } }), /## Goal[\s\S]*it builds[\s\S]*round 2 of 5/);
  assert.equal(goalNote({ goal: { text: 'x', status: 'met' } }), '');
});

process.env.FAKE_RECORD = tmp('goal-record');
process.env.WISP_HOME = tmp('goal-home');
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
const landed = (id) => until(async () => {
  const x = await api(`/sessions/${id}`);
  return x.state === 'review' && !['working', 'checking'].includes(x.goal?.status) && x;
}, { timeout: 60_000 });
const summary = async (id) => (await api('/sessions')).find((x) => x.id === id);

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

test('not met yet: wisp sends it back with what is missing, until the check says it holds', async () => {
  const s = await api('/sessions', { prompt: 'make it work', cwd: makeRepo(), agent: 'claude', mode: 'edits', goal: { text: 'it works [met after 3]', max: 5 } });
  assert.equal(s.goal.status, 'working');
  const done = await landed(s.id);
  assert.equal(done.turns.length, 3, 'two rounds sent back');
  assert.equal(done.goal.status, 'met');
  assert.equal(done.goal.round, 3);
  assert.deepEqual(done.goal.checks.map((c) => c.verdict), ['not_yet', 'not_yet', 'met']);
  const back = done.turns[1];
  assert.equal(back.by, 'wisp');
  assert.equal(back.goal, 2);
  assert.match(back.prompt, /isn't met yet[\s\S]*Goal: it works[\s\S]*What's missing: check 1[\s\S]*Next: do part 2/);
  assert.ok(done.turns[2].activity.some((a) => a.kind === 'goal' && /Goal check: met/.test(a.label)));
  const sum = await summary(s.id);
  assert.equal(sum.goal.status, 'met');
  assert.equal(sum.goal.last.verdict, 'met');
  assert.equal(sum.followups, 0, "wisp's rounds aren't your follow-ups");
  // The agent was told about its goal.
  const { records } = await import('./helpers.js');
  assert.ok(records(process.env.FAKE_RECORD, 'claude').some((r) => r.argv.join(' ').includes('## Goal')));
});

test('a goal that cannot be met stops at once, with why', async () => {
  const s = await api('/sessions', { prompt: 'deploy it', cwd: makeRepo(), agent: 'claude', mode: 'edits', goal: { text: 'live in prod [impossible]' } });
  const done = await landed(s.id);
  assert.equal(done.turns.length, 1);
  assert.equal(done.goal.status, 'impossible');
  assert.match(done.goal.why, /impossible/);
});

test('out of rounds: it stops at max, and Resume gives it a fresh budget', async () => {
  const s = await api('/sessions', { prompt: 'do it', cwd: makeRepo(), agent: 'claude', mode: 'edits', goal: { text: 'never true', max: 2 } });
  let done = await landed(s.id);
  assert.equal(done.turns.length, 2);
  assert.equal(done.goal.status, 'out');
  await api(`/sessions/${s.id}/goal`, { action: 'resume' }, 'PATCH');
  done = await landed(s.id);
  assert.equal(done.goal.status, 'out');
  assert.equal(done.goal.max, 4);
  assert.equal(done.turns.length, 4, 'resumed: checked, then two more rounds');
});

test('/goal in a follow-up sets one on an idle task and goes after it; /goal drop drops it', async () => {
  const s = await api('/sessions', { prompt: 'look around', cwd: makeRepo(), agent: 'claude', mode: 'edits' });
  await landed(s.id);
  const r = await api(`/sessions/${s.id}/reply`, { text: '/goal it is tidy [met after 2]' });
  assert.equal(r.goal.text, 'it is tidy [met after 2]');
  const done = await landed(s.id);
  assert.equal(done.goal.status, 'met');
  assert.equal(done.turns.length, 2, 'checked at once: not yet, one round, met');
  await api(`/sessions/${s.id}/reply`, { text: '/goal drop' });
  assert.equal((await api(`/sessions/${s.id}`)).goal, undefined);
  await assert.rejects(api(`/sessions/${s.id}/goal`, {}, 'DELETE'), /no goal/);
});

test('a launch that is just /goal makes the condition the task; pause lands it after its round', async () => {
  const s = await api('/sessions', { prompt: '/goal the readme is clear', cwd: makeRepo(), agent: 'claude', mode: 'edits' });
  assert.equal(s.goal.text, 'the readme is clear');
  assert.equal((await api(`/sessions/${s.id}`)).turns[0].prompt, 'the readme is clear');
  await until(async () => (await api(`/sessions/${s.id}`)).turns.length >= 2, { timeout: 30_000 });
  await api(`/sessions/${s.id}/goal`, { action: 'pause' }, 'PATCH');
  const done = await landed(s.id);
  assert.equal(done.goal.status, 'paused');
  const n = done.turns.length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await api(`/sessions/${s.id}`)).turns.length, n, 'nothing more after a pause');
  await assert.rejects(api(`/sessions/${s.id}/goal`, { text: '' }, 'PUT'), /Say what has to be true/);
});
