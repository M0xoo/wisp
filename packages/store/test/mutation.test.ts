import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open, sessionRow } from './fixture.ts';

test('a mutation runs once: a retry with the same (client, mid) gets the recorded result', () => {
  const { store, session } = open();
  let runs = 0;
  const run = (): ReturnType<typeof store.recordMutation<{ id: string }>> =>
    store.recordMutation('phone', 'mid-1', (w) => {
      runs++;
      w.upsert(session, sessionRow('a'));
      return { id: 'a' };
    });
  const first = run();
  const again = run();
  assert.deepEqual(first, { result: { id: 'a' }, seq: 1, replayed: false });
  assert.deepEqual(again, { result: { id: 'a' }, seq: 1, replayed: true });
  assert.equal(runs, 1);
  assert.equal(store.headSeq(), 1, 'the retry wrote nothing');
});

test('mids are per client, an undefined result replays as undefined, seq is the head at commit', () => {
  const { store, session } = open();
  store.tx((w) => w.upsert(session, sessionRow('a')));
  const a = store.recordMutation('laptop', 'm', () => undefined);
  const b = store.recordMutation('phone', 'm', (w) => w.patch(session, 'a', [{ op: 'replace', path: '/title', value: 'x' }]).title);
  assert.deepEqual(a, { result: undefined, seq: 1, replayed: false });
  assert.deepEqual(b, { result: 'x', seq: 2, replayed: false });
  assert.deepEqual(store.recordMutation('laptop', 'm', () => 'never'), { result: undefined, seq: 1, replayed: true });
});

test('a mutation that throws records nothing, so a retry runs it again', () => {
  const { store, session } = open();
  let runs = 0;
  const attempt = (fail: boolean): unknown =>
    store.recordMutation('c', 'm', (w) => {
      runs++;
      w.upsert(session, sessionRow('a'));
      if (fail) throw new Error('tunnel dropped');
      return 'ok';
    });
  assert.throws(() => attempt(true), /tunnel dropped/);
  assert.equal(store.get(session, 'a'), undefined);
  assert.deepEqual(attempt(false), { result: 'ok', seq: 1, replayed: false });
  assert.equal(runs, 2);
});

test('a mutation inside an outer tx that rolls back is forgotten with it', () => {
  const { store } = open();
  assert.throws(() =>
    store.tx(() => {
      store.recordMutation('c', 'm', () => 1);
      throw new Error('outer');
    }),
  );
  assert.equal(store.recordMutation('c', 'm', () => 2).replayed, false);
});

test('retention: change rows past 7 days go, mutation records past 24 h go', () => {
  const { store, session, clock } = open();
  const DAY = 24 * 3600 * 1000;
  store.tx((w) => w.upsert(session, sessionRow('old')));
  store.recordMutation('c', 'old', () => 1);
  clock.t += 2 * DAY;
  store.tx((w) => w.upsert(session, sessionRow('mid')));
  store.recordMutation('c', 'new', () => 1);
  clock.t += 6 * DAY;
  store.tx((w) => w.upsert(session, sessionRow('new')));
  assert.deepEqual(store.prune(), { changes: 1, mutations: 2 });
  assert.deepEqual(
    store.changesSince(0).map((c) => c.id),
    ['mid', 'new'],
  );
  assert.equal(store.oldestSeq(), 2);
  assert.equal(store.canResume(0), false, 'a cursor before the oldest kept change must take a snapshot');
  assert.equal(store.canResume(1), true);
  assert.equal(store.recordMutation('c', 'old', () => 2).replayed, false);
});

test('retention: the row cap wins when it keeps fewer, and seqs are never reused after a full prune', () => {
  const { store, session, clock } = open({ retention: { changeRows: 3 } });
  store.tx((w) => {
    for (let i = 0; i < 10; i++) w.upsert(session, sessionRow(`s${i}`));
  });
  assert.deepEqual(store.prune(), { changes: 7, mutations: 0 });
  assert.deepEqual(
    store.changesSince(0).map((c) => c.seq),
    [8, 9, 10],
  );
  clock.t += 8 * 24 * 3600 * 1000;
  store.prune();
  assert.deepEqual([store.headSeq(), store.oldestSeq()], [10, 11]);
  assert.equal(store.canResume(10), true, 'a client that saw everything still resumes');
  store.tx((w) => w.upsert(session, sessionRow('after')));
  assert.equal(store.headSeq(), 11);
});

test('pruned changes take their extra topics with them', () => {
  const { store, session, clock } = open();
  store.tx((w) => w.upsert(session, sessionRow('a')));
  clock.t += 8 * 24 * 3600 * 1000;
  store.prune();
  store.tx((w) => w.upsert(session, sessionRow('b')));
  assert.deepEqual(
    store.changesSince(0, ['session:a']).map((c) => c.id),
    [],
  );
  assert.deepEqual(store.changesSince(0, ['session:b'])[0]?.topics, ['list', 'session:b']);
});
