import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDevtools } from '../src/devtools.ts';
import { createDrafts } from '../src/drafts.ts';
import { memoryPersist } from '../src/persist.ts';
import { createScope } from '../src/scope.ts';
import { byKeys, count, family, filterBy, groupBy, sortBy } from '../src/selectors.ts';
import { effect, signal, subscribe } from '../src/signals.ts';
import { fakeTimers } from './helpers.ts';

test('scope: timers and children go with it, newest cleanup first, and late registrations run at once', () => {
  const clock = fakeTimers();
  const root = createScope('root', clock);
  const order: string[] = [];
  const child = root.child('a');
  child.add(() => order.push('child'));
  root.add(() => order.push('root-first'));
  let fired = 0;
  root.timeout(100, () => fired++);
  root.interval(10, () => fired++);
  clock.advance(35);
  assert.equal(fired, 3);
  root.dispose();
  clock.advance(1000);
  assert.equal(fired, 3, 'no timer outlives its scope');
  assert.equal(clock.waiting, 0);
  assert.deepEqual(order, ['root-first', 'child']);
  assert.equal(child.signal.aborted, true);
  let late = false;
  root.add(() => (late = true));
  assert.equal(late, true);
});

test('scope: a child disposed on its own leaves its parent', () => {
  const root = createScope();
  for (let i = 0; i < 100; i++) root.child(`c${i}`).dispose();
  let ran = 0;
  root.add(() => ran++);
  root.dispose();
  assert.equal(ran, 1);
});

test('selectors are memoised and compose', () => {
  const rows = signal<readonly { id: string; state: string; at: number }[]>([
    { id: 'a', state: 'running', at: 2 },
    { id: 'b', state: 'done', at: 1 },
    { id: 'c', state: 'running', at: 1 },
  ]);
  let runs = 0;
  const running = filterBy(rows, (r) => (runs++, r.state === 'running'));
  const sorted = sortBy(running, byKeys({ of: (r) => r.at }, { of: (r) => r.id, desc: true }));
  assert.deepEqual(sorted().map((r) => r.id), ['c', 'a']);
  sorted();
  assert.equal(runs, 3, 'a second read recomputes nothing');
  assert.equal(count(rows, (r) => r.state === 'done')(), 1);
  assert.deepEqual([...groupBy(rows, (r) => r.state)().keys()], ['running', 'done']);
  const byId = family((id: string) => () => rows().find((r) => r.id === id));
  assert.equal(byId('a'), byId('a'));
  assert.equal(byId.size, 1);
  byId.drop('a');
  assert.equal(byId.size, 0);
});

test('subscribe: the view adapter hears new values, not the current one', () => {
  const s = signal(1);
  const seen: number[] = [];
  const stop = subscribe(s, (v) => seen.push(v));
  s(2);
  s(3);
  stop();
  s(4);
  assert.deepEqual(seen, [2, 3]);
});

test('drafts: keyed by (entity, field), the UI sees them at once, the disk after the debounce', async () => {
  const clock = fakeTimers();
  const scope = createScope('t', clock);
  const persist = memoryPersist();
  const drafts = createDrafts({ scope, persist, debounceMs: 400 });
  const text = drafts.get('laptop:s1', 'composer');
  let renders = 0;
  effect(() => void (text(), renders++));
  drafts.set('laptop:s1', 'composer', 'h');
  drafts.set('laptop:s1', 'composer', 'he');
  drafts.set('laptop:s1', 'composer', 'hey');
  assert.equal(text(), 'hey');
  assert.equal(renders, 4);
  assert.equal(drafts.get('laptop:s2', 'composer')(), undefined, 'another task has its own draft');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await persist.entries('drafts:laptop'), [], 'not written yet');
  clock.advance(400);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await persist.entries('drafts:laptop'), [['laptop:s1\u0000composer', 'hey']]);
  drafts.set('box:s9', 'composer', 'other peer');
  await drafts.flush();
  assert.deepEqual(await persist.namespaces('drafts:'), ['drafts:laptop', 'drafts:box'], 'one namespace per peer');

  const again = createDrafts({ scope: createScope('t2', clock), persist });
  await again.load();
  assert.equal(again.get('laptop:s1', 'composer')(), 'hey');
  again.clear('laptop:s1', 'composer');
  await again.flush();
  assert.deepEqual(await persist.entries('drafts:laptop'), [], 'an emptied draft is deleted');
});

test('drafts: what is waiting is written when the scope ends', async () => {
  const clock = fakeTimers();
  const scope = createScope('t', clock);
  const persist = memoryPersist();
  createDrafts({ scope, persist }).set('laptop:s1', 'composer', 'unsaved');
  scope.dispose();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await persist.entries('drafts:laptop'), [['laptop:s1\u0000composer', 'unsaved']]);
});

test('devtools: a ring of the last 500 entries, machine states, exportable', () => {
  const dev = createDevtools(() => 42, 500);
  for (let i = 0; i < 600; i++) dev.record({ kind: 'command', mid: `m${i}`, cmd: 'x', peer: 'p' });
  const entries = dev.entries();
  assert.equal(entries.length, 500);
  assert.equal(entries[0]?.kind === 'command' && entries[0].mid, 'm100');
  assert.equal(entries.at(-1)?.kind === 'command' && entries.at(-1)?.kind === 'command' ? (entries.at(-1) as { mid: string }).mid : '', 'm599');
  const s = signal('idle');
  const drop = dev.machine('terminal.shell', s);
  s('running');
  assert.deepEqual(dev.machines(), { 'terminal.shell': 'running' });
  const out = JSON.parse(dev.export({ build: 't' })) as { entries: unknown[]; machines: unknown; build: string };
  assert.equal(out.entries.length, 500);
  assert.equal(out.build, 't');
  drop();
  assert.deepEqual(dev.machines(), {});
});
