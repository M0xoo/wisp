// The terminal flow (plan §4.6.3), tested as the plan asks: every state and every event, and a path
// to every state, so a new state without its test path fails here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TermState } from '@wisp-plugin/terminal-api';
import { EVENTS, FLOW, type FlowEvent, isLive, isOver, STATES, step } from '../src/flow.ts';

test('flow: every state takes only the events of its row; the rest change nothing', () => {
  for (const s of STATES)
    for (const e of EVENTS) {
      const want = FLOW[s][e] ?? s;
      assert.equal(step(s, e), want, `${s} --${e}`);
    }
});

test('flow: every state is reachable from idle, and each has a way out to a fresh start', () => {
  const paths = new Map<TermState, FlowEvent[]>([['idle', []]]);
  const queue: TermState[] = ['idle'];
  while (queue.length) {
    const s = queue.shift() as TermState; // the queue is non-empty inside the loop
    for (const e of EVENTS) {
      const n = step(s, e);
      if (!paths.has(n)) (paths.set(n, [...(paths.get(s) ?? []), e]), queue.push(n));
    }
  }
  assert.deepEqual([...paths.keys()].sort(), [...STATES].sort(), 'no state without a path');
  for (const s of STATES) {
    if (s === 'idle') continue;
    // from anywhere, STOP/EXIT/DONE then START gets a terminal starting again
    let x: TermState = s;
    for (const e of ['STOP', 'DONE', 'EXIT', 'START'] as const) x = step(x, e);
    assert.equal(x, 'starting', `${s} can start again`);
  }
});

test('flow: a STOP while starting cancels the start; it never becomes running after', () => {
  for (const from of ['starting', 'slow'] as const) {
    const s = step(from, 'STOP');
    assert.equal(s, 'stopping');
    assert.equal(step(s, 'READY'), 'stopping', 'late output of the cancelled start');
    assert.equal(step(s, 'START'), 'stopping', 'a start can’t race the stop');
    assert.equal(step(s, 'DONE'), 'ended');
  }
});

test('flow: ended and failed never reopen the dead screen; only a fresh START leaves them', () => {
  for (const s of ['ended', 'failed'] as const) {
    assert.ok(isOver(s) && !isLive(s));
    for (const e of EVENTS) assert.equal(step(s, e), e === 'START' ? 'starting' : s);
  }
  assert.equal(step('starting', 'SLOW'), 'slow', 'a slow start says so');
  assert.equal(step('running', 'SLOW'), 'running');
  assert.ok(['starting', 'slow', 'running'].every((s) => isLive(s as TermState)));
});
