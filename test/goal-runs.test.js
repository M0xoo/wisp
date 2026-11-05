// A goal check's record (server/goal-runs.js): what each judge, or wisp's own check, was told, did
// and voted, kept beside the task and never as a task. The fake harness votes off the goal's text.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeRepo, tmp, until } from './helpers.js';

process.env.FAKE_RECORD = tmp('goal-runs-record');
process.env.WISP_HOME = tmp('goal-runs-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.FAKE_GOAL_STEPS = '1';
installFakeBins();
const { startServer } = await import('../server/index.js');
const { Goals, goalView } = await import('../server/goal.js');
const { GoalRuns, refsOf } = await import('../server/goal-runs.js');
const { Store } = await import('../server/store.js');
const { askJson } = await import('../server/quick.js');
const { maskDiffs } = await import('../server/env-mask.js');
const { adapters } = await import('../server/adapters/index.js');
const { noOutputLine } = await import('../web/js/no-output.js');

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
const home = () => process.env.WISP_HOME;
const runsDir = (id) => path.join(home(), 'goal-runs', id);

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
  await until(() => srv.auto.here().some((a) => a.id === 'grok')); // harnesses are found in the background
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

test('askJson hands every event to onEvent, and its answer is the same with or without it', async () => {
  const agents = [{ id: 'claude', available: true, models: [] }];
  const prompt = 'You check whether a coding agent reached its goal\n<goal>[met after 1]</goal>';
  const seen = [];
  const a = await askJson({ agents, prompt, cwd: makeRepo(), pick: { agent: 'claude', model: '' }, onEvent: (e) => seen.push(e.type) });
  const b = await askJson({ agents, prompt, cwd: makeRepo(), pick: { agent: 'claude', model: '' } });
  assert.deepEqual(a, b);
  assert.equal(a.verdict, 'met');
  assert.ok(['text', 'tool', 'tool_output', 'result'].every((t) => seen.includes(t)), seen.join());
  const thrown = await askJson({ agents, prompt, cwd: makeRepo(), pick: { agent: 'claude', model: '' }, onEvent: () => { throw new Error('no'); } });
  assert.equal(thrown.verdict, 'met', 'a recorder that throws breaks nothing');
});

test('a call that printed nothing still reaches the page: its update carries the stamp', async () => {
  const s = await api('/sessions', { prompt: 'do it', cwd: makeRepo(), agent: 'claude', mode: 'edits', goal: { text: 'it works [met after 1]' } });
  const done = await landed(s.id);
  const runs = srv.runner.goals.runs;
  const rec = runs.start(srv.store.get(s.id), { turnId: done.turns[0].id, round: 1, prompt: 'x', name: 'A' });
  runs.event(rec, { type: 'tool', kind: 'run', id: 'c1', label: 'Waiting', detail: 'until x; do sleep 5; done' });
  const heard = [];
  const was = runs.onChange;
  runs.onChange = (e) => {
    heard.push(e);
    was?.(e);
  };
  runs.event(rec, { type: 'tool_output', id: 'c1', text: '' });
  runs.onChange = was;
  runs.finish(rec, null);
  assert.equal(heard.length, 1);
  assert.equal(heard[0].update, true);
  assert.equal(typeof heard[0].item.outAt, 'number');
  assert.equal(heard[0].item.output, undefined);
});

test('a failed call closes its step: the page hears it, and the error step stays as it was', { concurrency: false }, async (t) => {
  const real = adapters.claude.run;
  t.after(() => (adapters.claude.run = real));
  adapters.claude.run = ({ onEvent }) => {
    onEvent({ type: 'tool', id: 'X', kind: 'agent', label: 'Delegating: read the repo' });
    onEvent({ type: 'tool', id: 'R', kind: 'read', label: 'Reading a.js', file: 'a.js' });
    onEvent({ type: 'tool_error', id: 'X', name: 'Task', text: 'boom' });
    onEvent({ type: 'tool_error', id: 'R', name: 'Read', text: 'no such file' });
    onEvent({ type: 'result', text: 'done' });
    return { done: Promise.resolve(), stop() {} };
  };
  const heard = [];
  const listen = (e) => heard.push(e);
  srv.runner.on('activity', listen);
  t.after(() => srv.runner.off('activity', listen));
  const s = await api('/sessions', { prompt: 'do it', cwd: makeRepo(), agent: 'claude', mode: 'edits' });
  const done = await landed(s.id);
  const steps = done.turns[0].activity.filter((a) => a.label);
  const call = steps.find((a) => a.call === 'X');
  assert.equal(typeof call.outAt, 'number', 'closed');
  const updates = heard.filter((e) => e.sessionId === s.id && e.update);
  assert.equal(updates.length, 1, 'only the step that can be stamped');
  assert.equal(updates[0].item.call, 'X', 'the old step');
  assert.equal(updates[0].turnId, done.turns[0].id);
  assert.equal(updates[0].item.outAt, call.outAt);
  const errors = steps.filter((a) => a.kind === 'error');
  assert.deepEqual(errors.map((a) => a.label), ['Task failed: boom', 'Read failed: no such file']);
  assert.ok(errors.every((a) => !a.call && !a.outAt), 'the error step as it was');
  assert.equal(steps.find((a) => a.call === 'R').outAt, undefined, 'read steps stay as they are');
  // What the fix is for: a run stuck after a failed Task gets its line.
  const stuck = { ...done.turns[0], status: 'running', activity: [call, errors[0]] };
  assert.match(noOutputLine({ state: 'running' }, stuck, errors[0].t + 13 * 60_000), /^No output for 13 min$/);
});

test('each judge that ran has a record the vote points at; one not installed has none', async () => {
  srv.auto.here().find((a) => a.id === 'grok').available = false;
  const s = await api('/sessions', { prompt: 'do it', cwd: makeRepo(), agent: 'claude', mode: 'edits', goal: { text: 'ship [judge claude: met] [judge codex: not_yet]', judges: [{ agent: 'claude', name: 'Claude' }, { agent: 'codex', name: 'Codex' }, { agent: 'grok', name: 'Gone' }], vote: 'all' } });
  const done = await until(async () => {
    const x = await api(`/sessions/${s.id}`);
    return x.goal?.checks?.length && x;
  }, { timeout: 30_000 });
  await api(`/sessions/${s.id}/goal`, { action: 'pause' }, 'PATCH');
  srv.auto.here().find((a) => a.id === 'grok').available = true;
  const [claude, codex, gone] = done.goal.checks[0].votes;
  assert.ok(claude.run && codex.run);
  assert.equal(gone.run, undefined);
  const sum = (await api('/sessions')).find((x) => x.id === s.id);
  assert.deepEqual(sum.goal.last.votes.map((v) => !!v.run), [true, true, false], 'the summary links them');
  assert.equal(sum.goal.checks[0].votes, undefined, 'and stays light');
  const rec = await api(`/sessions/${s.id}/goal-runs/${claude.run}`);
  assert.equal(rec.status, 'done');
  assert.equal(rec.name, 'Claude');
  assert.equal(rec.verdict, claude.verdict);
  assert.equal(rec.round, 1);
  assert.match(rec.turn.prompt, /You are Claude, one of 3 judges/);
  assert.ok(rec.turn.activity.some((a) => a.kind === 'text' && /read the code first/.test(a.label)), 'its text');
  const cmd = rec.turn.activity.find((a) => a.detail === 'git status --short');
  assert.equal(cmd.output, ' M math.js', 'its tool calls with what they printed');
  assert.match(rec.turn.raw, /"verdict"/);
  await assert.rejects(api(`/sessions/${s.id}/goal-runs/${'0'.repeat(12)}`), /isn’t kept/);
  await assert.rejects(api(`/sessions/${s.id}/goal-runs/..%2F..%2Fconfig`), /isn’t kept|no such/);
});

test('a judge that gives no JSON has a record too, and with nobody answering the votes stay', async () => {
  const s = await api('/sessions', { prompt: 'do it', cwd: makeRepo(), agent: 'claude', mode: 'edits', goal: { text: 'ship [judge claude: silent]', judges: [{ agent: 'claude', name: 'Quiet' }], vote: 'all' } });
  const done = await landed(s.id);
  const c = done.goal.checks[0];
  assert.equal(c.verdict, 'unchecked');
  assert.equal(c.why, 'None of the judges could check the goal.');
  assert.equal(done.goal.status, 'paused');
  const rec = await api(`/sessions/${s.id}/goal-runs/${c.votes[0].run}`);
  assert.deepEqual([rec.status, rec.end, rec.verdict], ['done', 'nojson', 'unchecked']);
  assert.ok(rec.turn.activity.some((a) => /read the code first/.test(a.label)));
});

test('wisp’s own check is recorded the same way', async () => {
  const s = await api('/sessions', { prompt: 'do it', cwd: makeRepo(), agent: 'claude', mode: 'edits', goal: { text: 'it works [met after 1]' } });
  const done = await landed(s.id);
  const c = done.goal.checks[0];
  assert.ok(c.run);
  assert.equal((await api('/sessions')).find((x) => x.id === s.id).goal.checks[0].run, c.run);
  const rec = await api(`/sessions/${s.id}/goal-runs/${c.run}`);
  assert.deepEqual([rec.name, rec.verdict], ['wisp’s check', 'met']);
});

test('a crew member who judges is recorded under their name', async () => {
  const m = await api('/crew', { name: 'Rita', role: 'reviews', agent: 'claude' });
  const id = m.id || m.member?.id;
  const s = await api('/sessions', { prompt: 'do it', cwd: makeRepo(), agent: 'claude', mode: 'edits', goal: { text: 'ship [met after 1]', judges: [{ crew: id, name: 'Rita' }] } });
  const done = await landed(s.id);
  const v = done.goal.checks[0].votes[0];
  assert.equal(v.crew, id);
  const rec = await api(`/sessions/${s.id}/goal-runs/${v.run}`);
  assert.deepEqual([rec.name, rec.crew], ['Rita', id]);
  assert.match(rec.turn.prompt, /You are Rita \(reviews\)/);
});

test('records are no tasks, and they go with the task or the goal', async () => {
  const before = (await api('/sessions')).length;
  const stored = srv.store.all().length;
  const s = await api('/sessions', { prompt: 'do it', cwd: makeRepo(), agent: 'claude', mode: 'edits', goal: { text: 'it works [met after 2]', judges: [{ agent: 'claude', name: 'A' }, { agent: 'codex', name: 'B' }], vote: 'any' } });
  const done = await landed(s.id);
  assert.equal(srv.store.all().length, stored + 1, 'not one session more than the task');
  const list = await api('/sessions?children=1');
  assert.equal(list.length, before + 1);
  assert.ok(!list.some((x) => /You check whether/.test(x.prompt || '')));
  const hits = await api(`/search?q=${encodeURIComponent('You check whether a coding agent')}`).catch(() => null);
  assert.ok(!JSON.stringify(hits || {}).includes('goal-runs'));
  const refs = refsOf(done.goal);
  assert.equal(fs.readdirSync(runsDir(s.id)).length, refs.length);
  await api(`/sessions/${s.id}/archive`, {}).catch(() => {});
  assert.equal(fs.readdirSync(runsDir(s.id)).length, refs.length, 'archiving keeps them');
  await api(`/sessions/${s.id}`, {}, 'DELETE');
  assert.equal(fs.existsSync(runsDir(s.id)), false, 'deleting the task takes them');
});

test('dropping the goal takes its records', async () => {
  const s = await api('/sessions', { prompt: 'do it', cwd: makeRepo(), agent: 'claude', mode: 'edits', goal: { text: 'it works [met after 1]' } });
  const done = await landed(s.id);
  assert.ok(fs.existsSync(path.join(runsDir(s.id), `${done.goal.checks[0].run}.json`)));
  await api(`/sessions/${s.id}/goal`, {}, 'DELETE');
  assert.deepEqual(fs.readdirSync(runsDir(s.id)), []);
});

// The rest runs Goals on its own, for a short time limit and a task of its own.
function bench(goal, deps = {}) {
  const dir = tmp('goal-runs-bench');
  const store = new Store(dir);
  const session = { id: 'task1', cwd: makeRepo(), turns: [{ id: 't1', changes: [], status: 'done' }], goal, state: 'running' };
  store.sessions.set(session.id, session);
  const seen = [];
  const goals = new Goals({ store, runner: { note() {}, refresh() {}, settle() {}, reply() {}, live: new Map() }, agents: () => [{ id: 'claude', available: true, models: [] }], broadcast: (e, d) => seen.push(d), ...deps });
  return { store, session, goals, seen };
}

test('a judge stopped by the time limit keeps what it got; live steps go out as they come', async () => {
  const g = { text: 'x [judge claude: hang]', round: 1, status: 'working', checks: [], judges: [{ agent: 'claude', name: 'Slow' }], vote: 'all' };
  const { session, goals, seen } = bench(g, { checkMs: 800 });
  await goals.run(session, session.turns[0]);
  const c = g.checks[0];
  assert.equal(c.verdict, 'unchecked');
  const rec = goals.runs.read(session.id, c.votes[0].run);
  assert.deepEqual([rec.status, rec.end, rec.verdict], ['stopped', 'timeout', 'unchecked']);
  assert.ok(rec.turn.activity.some((a) => /read the code first/.test(a.label)), 'what it did before the limit');
  assert.ok(seen.some((d) => d.item?.kind === 'text'), 'a step went out live');
  assert.ok(seen.at(-1).done, 'and the end of it');
  assert.equal(goalView(g).running, undefined);
});

test('while it checks, the summary names the runs; after a restart a run on disk reads as interrupted', () => {
  const { session, goals } = bench({ text: 'x', round: 2, status: 'checking', checks: [], running: [{ run: 'abc', name: 'A', at: 0 }] });
  assert.deepEqual(goalView(session.goal).running, session.goal.running);
  assert.equal(goalView({ ...session.goal, status: 'working' }).running, undefined, 'a check dropped meanwhile');
  const rec = goals.runs.start(session, { turnId: 't1', round: 2, prompt: 'p', name: 'A' });
  const again = new GoalRuns({ store: goals.store });
  const r = again.read(session.id, rec.id);
  assert.deepEqual([r.status, r.end, r.turn.status], ['stopped', 'interrupted', 'stopped']);
  assert.equal(goals.runs.read('other', rec.id), null, 'a record belongs to its task');
});

test('a record is capped: the prompt, and the oldest steps past the limit', () => {
  const { session, goals } = bench({ text: 'x', round: 1, status: 'working', checks: [] });
  const rec = goals.runs.start(session, { turnId: 't1', round: 1, prompt: 'p'.repeat(90_000), name: 'A' });
  for (let i = 0; i < 300; i++) goals.runs.event(rec, { type: 'tool', kind: 'run', id: `c${i}`, label: `step ${i}`, detail: 'x'.repeat(2000) });
  goals.runs.finish(rec, null);
  const r = goals.runs.read(session.id, rec.id);
  assert.equal(r.turn.prompt.length, 40_000);
  assert.ok(r.turn.activity.length <= 200);
  assert.ok(JSON.stringify(r).length < 200_000, 'in bytes too');
  assert.equal(r.turn.activity.at(-1).label, 'step 299');
  assert.equal(r.turn.trimmed + r.turn.activity.length, 300);
});

test('only what the kept checks point at stays: a round past the last 50 goes', async () => {
  const g = { text: 'x [judge claude: not_yet]', round: 52, status: 'working', checks: [], judges: [{ agent: 'claude', name: 'A' }], vote: 'all' };
  const { session, goals } = bench(g);
  const old = goals.runs.start(session, { turnId: 't1', round: 1, prompt: 'p', name: 'A' });
  goals.runs.finish(old, null);
  const kept = goals.runs.start(session, { turnId: 't1', round: 2, prompt: 'p', name: 'A' });
  goals.runs.finish(kept, null);
  g.checks = Array.from({ length: 50 }, (_, i) => ({ round: i + 1, verdict: 'not_yet', why: 'w', changed: 1, at: i, votes: [{ name: 'A', verdict: 'not_yet', run: i ? (i === 1 ? kept.id : undefined) : old.id }] }));
  await goals.run(session, session.turns[0]);
  assert.equal(g.checks.length, 50);
  assert.equal(goals.runs.read(session.id, old.id), null, 'its check left the list');
  assert.ok(goals.runs.read(session.id, kept.id));
  assert.ok(goals.runs.read(session.id, g.checks.at(-1).votes[0].run));
});

test('a .env file’s lines are masked in the diff a check was told about, and in what it printed', async () => {
  const text = 'x\ndiff --git a/.env b/.env\nindex 1..2 100644\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-API_KEY=old-secret\n+API_KEY=new-secret\ndiff --git a/a.js b/a.js\n+const API_KEY = 1\n</changes>\n- note';
  const out = maskDiffs(text);
  assert.ok(!/secret/.test(out));
  assert.match(out, /\+API_KEY=••••/);
  assert.match(out, /\+const API_KEY = 1/, 'other files stay');
  const s = await api('/sessions', { prompt: 'do it', cwd: makeRepo(), agent: 'claude', mode: 'edits', goal: { text: 'it works [met after 1]' } });
  const done = await landed(s.id);
  const task = srv.store.get(s.id);
  const rec = srv.runner.goals.runs.start(task, { turnId: done.turns[0].id, round: 1, prompt: `+++ b/.env\n+TOKEN=hunter2`, name: 'A' });
  srv.runner.goals.runs.event(rec, { type: 'tool', kind: 'run', id: 'c1', label: 'Reading', detail: 'cat .env' });
  srv.runner.goals.runs.event(rec, { type: 'tool_output', id: 'c1', text: 'TOKEN=hunter2' });
  srv.runner.goals.runs.finish(rec, null);
  const seen = await api(`/sessions/${s.id}/goal-runs/${rec.id}`);
  assert.ok(!JSON.stringify(seen).includes('hunter2'));
  const step = seen.turn.activity[0];
  assert.ok(step.masked);
  const { value } = await api(`/sessions/${s.id}/unmasked?${step.masked}`);
  assert.equal(value.output, 'TOKEN=hunter2', 'Reveal works as in a task');
});
