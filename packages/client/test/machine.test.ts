import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDevtools } from '../src/devtools.ts';
import { interpret, machine, paths, type Step } from '../src/machine.ts';
import { createScope } from '../src/scope.ts';
import { fakeTimers, tick } from './helpers.ts';

/** A controllable PTY: each start/stop call waits until the test settles it. */
function fakePty() {
  const calls: { kind: 'start' | 'stop'; signal: AbortSignal; resolve(e?: 'READY' | 'DONE'): void; reject(err: Error): void }[] = [];
  const call = (kind: 'start' | 'stop', signal: AbortSignal) =>
    new Promise<'READY' | 'DONE' | void>((resolve, reject) => calls.push({ kind, signal, resolve, reject }));
  return { calls, start: (signal: AbortSignal) => call('start', signal), stop: (signal: AbortSignal) => call('stop', signal), last: () => calls.at(-1) };
}
type Pty = ReturnType<typeof fakePty>;

// The terminal.shell machine of plan §4.6.3.
const shell = machine({
  id: 'terminal.shell',
  initial: 'idle',
  states: {
    idle: { on: { START: 'starting' } },
    starting: {
      invoke: (pty: Pty, signal) => pty.start(signal),
      on: { READY: 'running', FAIL: 'failed', STOP: 'stopping' },
      onError: 'failed',
      after: { 8000: 'slow' }, // "a slow start says so" (#440)
    },
    slow: { on: { READY: 'running', FAIL: 'failed', STOP: 'stopping' } },
    running: { on: { EXIT: 'ended', STOP: 'stopping' } },
    stopping: { invoke: (pty: Pty, signal) => pty.stop(signal), on: { DONE: 'ended' } },
    ended: { on: { START: 'starting' } }, // never reopens a dead screen (#432)
    failed: { on: { START: 'starting' } },
  },
});

function setup() {
  const clock = fakeTimers();
  const scope = createScope('test', clock);
  const pty = fakePty();
  const devtools = createDevtools(clock.now);
  const m = interpret(shell, scope, pty, { onTransition: (machine, from, via, to) => devtools.record({ kind: 'transition', machine, from, via, to }) });
  return { clock, scope, pty, m, devtools };
}

test('shell: start, ready, exit, and a new start runs afresh (#432)', async () => {
  const { m, pty } = setup();
  assert.equal(m.state(), 'idle');
  m.send('START');
  assert.equal(m.state(), 'starting');
  pty.last()?.resolve('READY');
  await tick();
  assert.equal(m.state(), 'running');
  assert.equal(m.send('START'), false, 'START means nothing while running');
  m.send('EXIT');
  assert.equal(m.state(), 'ended');
  m.send('START');
  assert.equal(pty.calls.filter((c) => c.kind === 'start').length, 2, 'a second start is a new PTY, not the dead one');
});

test('shell: a slow start says so after 8 s, on the fake clock (#440)', async () => {
  const { m, clock } = setup();
  m.send('START');
  clock.advance(7999);
  assert.equal(m.state(), 'starting');
  clock.advance(1);
  assert.equal(m.state(), 'slow');
  m.send('READY');
  assert.equal(m.state(), 'running');
});

test('shell: leaving a state clears its timer, so a fast start never turns slow', () => {
  const { m, clock } = setup();
  m.send('START');
  m.send('READY');
  clock.advance(60_000);
  assert.equal(m.state(), 'running');
  assert.equal(clock.waiting, 0);
});

test('shell: STOP during starting cancels the start; its late READY is dropped (#435)', async () => {
  const { m, pty } = setup();
  m.send('START');
  const start = pty.last();
  m.send('STOP');
  assert.equal(m.state(), 'stopping');
  assert.equal(start?.signal.aborted, true, 'the start was aborted');
  start?.resolve('READY'); // the PTY answers anyway, late
  await tick();
  assert.equal(m.state(), 'stopping', 'a late answer never lands on the wrong state');
  pty.last()?.resolve('DONE');
  await tick();
  assert.equal(m.state(), 'ended');
});

test('shell: a start that throws goes to failed; a throw after leaving is not a failure', async () => {
  const { m, pty } = setup();
  m.send('START');
  pty.last()?.reject(new Error('no pty'));
  await tick();
  assert.equal(m.state(), 'failed');
  m.send('START');
  const second = pty.last();
  m.send('STOP');
  second?.reject(new Error('aborted'));
  await tick();
  assert.equal(m.state(), 'stopping');
});

test('disposing the owner scope stops the machine, aborts what it invoked and clears its timers', () => {
  const { m, pty, scope, clock } = setup();
  m.send('START');
  scope.dispose();
  assert.equal(pty.last()?.signal.aborted, true);
  assert.equal(clock.waiting, 0);
  assert.equal(m.alive, false);
  assert.equal(m.send('READY'), false);
  assert.equal(m.state(), 'starting', 'a stopped machine keeps its last state for the devtools');
});

test('devtools see every transition with what caused it', async () => {
  const { m, clock, devtools } = setup();
  m.send('START');
  clock.advance(8000);
  const log = devtools.entries().map((e) => (e.kind === 'transition' ? `${e.from}-${e.via}->${e.to}` : ''));
  assert.deepEqual(log, ['idle-START->starting', 'starting-after 8000->slow']);
});

test('the types refuse a transition to a state that does not exist', () => {
  // @ts-expect-error: 'nowhere' is not a state of this machine
  machine({ id: 'bad', initial: 'a', states: { a: { on: { GO: 'nowhere' } } } });
  assert.throws(() => machine({ id: 'bad2', initial: 'zz' as 'a', states: { a: {} } }), /no initial state/);
});

// ---------- model-based: every transition, walked ----------

async function walk(path: readonly Step<string>[]): Promise<string> {
  const { m, pty, clock } = setup();
  for (const step of path) {
    if (step.kind === 'event') m.send(step.event as never);
    else if (step.kind === 'after') clock.advance(step.ms);
    else pty.last()?.reject(new Error('boom'));
    await tick();
  }
  return m.state();
}

test('paths: every state of the shell is reachable and every transition has a test path', async () => {
  const p = paths(shell);
  assert.deepEqual(p.unreachable, []);
  assert.deepEqual(p.states.map((s) => s.state).sort(), ['ended', 'failed', 'idle', 'running', 'slow', 'starting', 'stopping']);
  assert.equal(p.transitions.length, 14); // 1 + 5 (3 events, after, error) + 3 + 2 + 1 + 1 + 1
  for (const { transition, path } of p.transitions) {
    assert.equal(await walk(path), transition.to, `${transition.from} --${JSON.stringify(transition.via)}--> ${transition.to}`);
  }
});

test('paths: a state no transition reaches is reported', () => {
  const orphan = machine({ id: 'o', initial: 'a', states: { a: { on: { GO: 'b' } }, b: {}, lost: { on: { BACK: 'a' } } } });
  assert.deepEqual(paths(orphan).unreachable, ['lost']);
});
