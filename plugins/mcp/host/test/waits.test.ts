// The waits wisp.mcp owns (ask_user, approve, delegate's reports, wisp_task's wait) re-check when the
// runtime says something moved, never on a 1.5 s timer as v1's child did, and they end when their side
// goes (v1 mcp-gone): the call's signal (the harness), or the plugin's scope (wisp).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type AgentEnv, askUser, approve, callAgentTool } from '../src/agent-tools.ts';
import { Changes } from '../src/waits.ts';
import { makeScope, tick } from './fake.ts';

function env(answers: Map<string, Record<string, unknown>>, o: { signal?: AbortSignal; capped?: boolean } = {}) {
  const scope = makeScope();
  const changes = new Changes({ timeout: (ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } }, scope.signal);
  const ran: { cmd: string; args: Record<string, unknown> }[] = [];
  let n = 0;
  const run = async <R,>(cmd: string, args: unknown): Promise<R> => {
    const a = args as Record<string, unknown>;
    ran.push({ cmd, args: a });
    if (cmd === 'runtime.ask') {
      const id = `q${++n}`;
      answers.set(id, answers.get(id) ?? { pending: true });
      return { askId: id } as R;
    }
    if (cmd === 'runtime.pollAnswer') return (answers.get(String(a['askId'])) ?? { cancelled: true }) as R;
    if (cmd === 'runtime.approval') return { id: 'q9' } as R;
    throw new Error(`unexpected ${cmd}`);
  };
  const e: AgentEnv = { session: 's', info: { ...(o.capped && { capped: true }) }, run, changes, now: Date.now, signal: o.signal, chain: new Map() };
  return { e, ran, changes, scope, polls: () => ran.filter((r) => r.cmd === 'runtime.pollAnswer').length };
}

test('ask_user waits for an event, not a timer: no read between changes', async () => {
  const answers = new Map<string, Record<string, unknown>>();
  const { e, changes, polls, scope } = env(answers);
  const got = askUser(e, { question: 'Ship it?' });
  await tick(30);
  assert.equal(polls(), 1, 'one read when it opens, then it sleeps');
  changes.poke(); // something else changed: one more read, still pending
  await tick(5);
  assert.equal(polls(), 2);
  answers.set('q1', { answer: 'Yes' });
  changes.poke();
  assert.equal(await got, 'Yes');
  scope.dispose();
});

test('an answer that lands while a read is in flight is not missed', async () => {
  const answers = new Map<string, Record<string, unknown>>();
  const { e, changes, scope } = env(answers);
  const original = e.run;
  e.run = async (cmd, args) => {
    const r = await original(cmd, args);
    if (cmd === 'runtime.pollAnswer') {
      answers.set('q1', { answer: 'late' });
      changes.poke(); // lands between the read and the wait
    }
    return r as never;
  };
  assert.equal(await askUser(e, { question: 'q?' }), 'late');
  scope.dispose();
});

test('the harness goes while a question waits: the wait ends with no answer', async () => {
  const ac = new AbortController();
  const { e, scope } = env(new Map(), { signal: ac.signal });
  const got = askUser(e, { question: 'q?' });
  await tick(10);
  ac.abort();
  assert.equal(await got, null);
  scope.dispose();
});

test('wisp goes while a question waits (its scope ends): ask_user, approve and the reports end', async () => {
  const { e, scope } = env(new Map());
  const asked = callAgentTool(e, 'ask_user', { question: 'q?' });
  const approved = approve(e, { tool_name: 'Bash', input: {} });
  await tick(10);
  scope.dispose();
  assert.match(String(await asked), /did not answer/);
  assert.equal((await approved).behavior, 'deny', 'the gate fails closed');
});

test('a cancelled question (the turn ended) reads as no answer', async () => {
  const answers = new Map<string, Record<string, unknown>>();
  const { e, changes, scope } = env(answers);
  const got = askUser(e, { question: 'q?' });
  await tick(5);
  answers.set('q1', { cancelled: true });
  changes.poke();
  assert.equal(await got, null);
  scope.dispose();
});

test('one question at a time per task: the second opens once the first is answered', async () => {
  const answers = new Map<string, Record<string, unknown>>();
  const { e, changes, ran, scope } = env(answers);
  const first = askUser(e, { question: 'one?' });
  const second = askUser(e, { question: 'two?' });
  await tick(10);
  assert.equal(ran.filter((r) => r.cmd === 'runtime.ask').length, 1, 'the second waits its turn');
  answers.set('q1', { answer: 'a' });
  changes.poke();
  assert.equal(await first, 'a');
  await tick(10);
  answers.set('q2', { answer: 'b' });
  changes.poke();
  assert.equal(await second, 'b');
  assert.deepEqual(ran.filter((r) => r.cmd === 'runtime.ask').map((r) => r.args['question']), ['one?', 'two?']);
  scope.dispose();
});

test('a capped task asks a question, never an approval or sign-in card dressed as one', async () => {
  const answers = new Map<string, Record<string, unknown>>([['q1', { answer: 'ok' }]]);
  const { e, ran, scope } = env(answers, { capped: true });
  await askUser(e, { question: 'q?', permission: { tool: 'Bash', action: 'rm -rf /' }, connector: { name: 'x' } });
  assert.deepEqual(Object.keys(ran[0]?.args ?? {}).sort(), ['context', 'id', 'options', 'question']);
  scope.dispose();
});

test('a wait with a deadline returns at the deadline', async () => {
  const scope = makeScope();
  const changes = new Changes({ timeout: (ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } }, scope.signal);
  const t0 = Date.now();
  const r = await changes.until(async () => undefined, { until: t0 + 40, now: Date.now });
  assert.equal(r, undefined);
  assert.ok(Date.now() - t0 >= 35);
  scope.dispose();
});
