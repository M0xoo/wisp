import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coalescer } from '../src/index.ts';
import type { Disposable, Scheduler } from '../src/index.ts';
import { open, sessionRow } from './fixture.ts';

/** A scheduler driven by hand: time moves only when the test says so. */
function fakeScheduler(): Scheduler & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let timers: { at: number; fn: () => void; gone: boolean }[] = [];
  return {
    after(ms, fn): Disposable {
      const t = { at: now + ms, fn, gone: false };
      timers.push(t);
      return { dispose: () => void (t.gone = true) };
    },
    advance(ms) {
      now += ms;
      const due = timers.filter((t) => !t.gone && t.at <= now);
      timers = timers.filter((t) => !t.gone && t.at > now);
      for (const t of due) t.fn();
    },
    pending: () => timers.filter((t) => !t.gone).length,
  };
}

test('appends and patches commit together 250 ms after the first one, as one tx', () => {
  const { store, session, event } = open();
  store.tx((w) => w.upsert(session, sessionRow('a', { title: '' })));
  const commits: number[] = [];
  store.onCommit((c) => commits.push(c.length));
  const clock = fakeScheduler();
  const c = new Coalescer(store, { scheduler: clock });
  let text = '';
  for (let i = 0; i < 20; i++) {
    text += `t${i}`;
    c.patch(session, 'a', [{ op: 'replace', path: '/title', value: text }]);
    c.append(event, [{ session_id: 'a', seq: i, kind: 'delta', body: { i } }]);
    clock.advance(10);
  }
  assert.deepEqual(commits, [], 'nothing within the first 200 ms');
  clock.advance(49);
  assert.deepEqual(commits, []);
  clock.advance(1);
  assert.deepEqual(commits, [2], 'one patch change (net diff) and one append change');
  assert.equal(store.get(session, 'a')?.title, text);
  assert.equal(store.count(event), 20);
  const [p, a] = store.changesSince(1);
  assert.deepEqual(p?.patch, [{ op: 'replace', path: '/title', value: text }]);
  assert.equal((a?.patch as unknown[]).length, 20);
  assert.equal(clock.pending(), 0);
});

test('step() flushes at once and cancels the timer; an idle coalescer arms nothing', () => {
  const { store, session } = open();
  store.tx((w) => w.upsert(session, sessionRow('a')));
  const clock = fakeScheduler();
  const c = new Coalescer(store, { scheduler: clock, intervalMs: 100 });
  c.step();
  assert.equal(clock.pending(), 0);
  c.patch(session, 'a', [{ op: 'replace', path: '/state', value: 'running' }]);
  assert.equal(c.size, 1);
  c.step();
  assert.equal(c.size, 0);
  assert.equal(clock.pending(), 0);
  assert.equal(store.get(session, 'a')?.state, 'running');
  c.patch(session, 'a', [{ op: 'replace', path: '/state', value: 'idle' }]);
  clock.advance(100);
  assert.equal(store.get(session, 'a')?.state, 'idle');
});

test('one refused write is reported and the rest of the batch still commits', () => {
  const { store, session, event } = open();
  store.tx((w) => w.upsert(session, sessionRow('a')));
  const refused: unknown[] = [];
  const clock = fakeScheduler();
  const c = new Coalescer(store, { scheduler: clock, onError: (_e, item) => refused.push(item.op) });
  c.patch(session, 'gone', [{ op: 'replace', path: '/title', value: 'x' }]);
  c.append(event, [{ session_id: 'a', seq: 1, kind: 'x', body: null }]);
  c.flush();
  assert.deepEqual(refused, ['patch']);
  assert.equal(store.count(event), 1);
});

test('dispose flushes what is buffered and refuses more', () => {
  const { store, session } = open();
  store.tx((w) => w.upsert(session, sessionRow('a')));
  const c = new Coalescer(store, { scheduler: fakeScheduler() });
  c.patch(session, 'a', [{ op: 'replace', path: '/title', value: 'last words' }]);
  c.dispose();
  assert.equal(store.get(session, 'a')?.title, 'last words');
  assert.throws(() => c.patch(session, 'a', [{ op: 'replace', path: '/title', value: 'x' }]), /disposed/);
});
