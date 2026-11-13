// A task's older turns come as stubs (src/frame/turn-window.ts, v1 #788): Show this turn asks for only that turn,
// once, and again when a resync sends it back as a stub.
import { createRoot, createSignal } from 'solid-js';
import { expect, test, vi } from 'vitest';
import { createScope, type Scope } from '@wisp/client';
import { OPEN_TIMEOUT_MS, isStub, keepTurnsWhole, turnOpener, turnTopic, turnsTopic } from '../src/frame/turn-window.ts';

test('a stub is a body that says so_v1_788', () => {
  expect(isStub({ stub: true })).toBe(true);
  expect(isStub({ prompt: 'p' })).toBe(false);
  expect(isStub(undefined)).toBe(false);
  expect(turnTopic('s1', 't9')).toBe('session:s1/turn/t9');
  expect(turnsTopic('s1')).toBe('session:s1/turns');
});

test('opening a stubbed turn watches only that turn, once, and again after a resync re-stubs it_v1_788', () => {
  const [stub, setStub] = createSignal<boolean | undefined>(true);
  const watched: { topic: string; scope: Scope }[] = [];
  // effects run once the root is made: act on the opener from outside it
  const { o, dispose } = createRoot((dispose) => ({
    o: turnOpener({ scope: createScope('view'), bare: 's1', watch: (topic, scope) => watched.push({ topic, scope }), stubOf: (id) => (id === 't1' ? stub() : undefined) }),
    dispose,
  }));
  expect(o.opening('t1')).toBe(false);
  o.open('t1');
  o.open('t1');
  expect(watched.map((w) => w.topic)).toEqual(['session:s1/turn/t1']);
  expect(o.opening('t1')).toBe(true); // its control shows pending until the turn lands
  setStub(false);
  expect(o.opening('t1')).toBe(false);
  setStub(true); // the task's topic resynced: the turn is a stub again
  expect(watched).toHaveLength(2);
  expect(watched[0]?.scope.alive).toBe(false); // the first watch unsubscribed before the new one
  o.open('gone'); // a turn the task no longer has: nothing is asked
  expect(watched).toHaveLength(2);
  dispose();
});

test('a turn that never comes (a peer without the window) gives its control back after a while_v1_788', () => {
  vi.useFakeTimers();
  const failed: string[] = [];
  const { o, dispose } = createRoot((dispose) => ({
    o: turnOpener({ scope: createScope('view'), bare: 's1', watch: () => undefined, stubOf: () => true, failed: (id) => failed.push(id) }),
    dispose,
  }));
  o.open('t1');
  expect(o.opening('t1')).toBe(true);
  vi.advanceTimersByTime(OPEN_TIMEOUT_MS);
  expect(o.opening('t1')).toBe(false);
  expect(failed).toEqual(['t1']);
  dispose();
  vi.useRealTimers();
});

test('every turn stays whole for the Changes pane: a resync that stubs them asks again_v1_788', () => {
  const [stubbed, setStubbed] = createSignal(true);
  const watched: { topic: string; scope: Scope }[] = [];
  const dispose = createRoot((dispose) => {
    keepTurnsWhole({ scope: createScope('pane'), bare: 's1', watch: (topic, scope) => watched.push({ topic, scope }), stubbed });
    return dispose;
  });
  expect(watched.map((w) => w.topic)).toEqual(['session:s1/turns']);
  setStubbed(false); // landed
  expect(watched).toHaveLength(1);
  setStubbed(true); // the window resynced over them
  expect(watched).toHaveLength(2);
  expect(watched[0]?.scope.alive).toBe(false);
  dispose();
});
