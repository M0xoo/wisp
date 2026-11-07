import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { StoreError } from '../src/index.ts';
import type { ChangeRow } from '../src/index.ts';
import { open, sessionRow } from './fixture.ts';

test('upsert of a new row writes it and an upsert change with the full row on every topic', () => {
  const { store, session } = open();
  const seen: ChangeRow[][] = [];
  store.onCommit((c) => seen.push([...c]));
  const row = store.tx((w) => w.upsert(session, sessionRow('a', { extra: { tags: ['x'] } })));
  assert.deepEqual(store.get(session, 'a'), row);
  assert.deepEqual(row.extra, { tags: ['x'] });
  assert.equal(row.archived, false);
  const [c] = store.changesSince(0);
  assert.equal(c?.op, 'upsert');
  assert.equal(c?.topic, 'list');
  assert.deepEqual(c?.topics, ['list', 'session:a']);
  assert.deepEqual(c?.patch, row);
  assert.deepEqual(seen, [[c]]);
});

test('upsert of an existing row records the diff; an identical upsert records nothing', () => {
  const { store, session } = open();
  store.tx((w) => w.upsert(session, sessionRow('a')));
  store.tx((w) => w.upsert(session, { id: 'a', title: 'renamed' }));
  store.tx((w) => w.upsert(session, sessionRow('a', { title: 'renamed' })));
  const feed = store.changesSince(0);
  assert.equal(feed.length, 2);
  assert.equal(feed[1]?.op, 'patch');
  assert.deepEqual(feed[1]?.patch, [{ op: 'replace', path: '/title', value: 'renamed' }]);
  assert.equal(store.get(session, 'a')?.state, 'idle', 'columns left out keep their value');
});

test('patch applies RFC 6902 ops inside json columns and records the net diff', () => {
  const { store, session } = open();
  store.tx((w) => w.upsert(session, sessionRow('a', { extra: { tags: [] } })));
  const next = store.tx((w) =>
    w.patch(session, 'a', [
      { op: 'add', path: '/extra/tags/-', value: 'x' },
      { op: 'replace', path: '/title', value: 'one' },
      { op: 'replace', path: '/title', value: 'two' },
    ]),
  );
  assert.deepEqual(next.extra, { tags: ['x'] });
  assert.equal(next.title, 'two');
  assert.deepEqual(store.changesSince(1)[0]?.patch, [
    { op: 'replace', path: '/title', value: 'two' },
    { op: 'add', path: '/extra/tags/-', value: 'x' },
  ]);
});

test('patch refuses a missing row, a key change, an unknown column and a failed test op', () => {
  const { store, session } = open();
  store.tx((w) => w.upsert(session, sessionRow('a')));
  const code = (fn: () => unknown): string => {
    try {
      fn();
    } catch (err) {
      return (err as StoreError).code;
    }
    return 'none';
  };
  assert.equal(code(() => store.tx((w) => w.patch(session, 'zz', [{ op: 'replace', path: '/title', value: 'x' }]))), 'not_found');
  assert.equal(code(() => store.tx((w) => w.patch(session, 'a', [{ op: 'replace', path: '/id', value: 'b' }]))), 'invalid');
  assert.equal(code(() => store.tx((w) => w.patch(session, 'a', [{ op: 'add', path: '/nope', value: 1 }]))), 'invalid');
  assert.equal(code(() => store.tx((w) => w.patch(session, 'a', [{ op: 'test', path: '/title', value: 'other' }]))), 'invalid');
  assert.equal(code(() => store.tx((w) => w.upsert(session, { id: 'b', bogus: 1 } as never))), 'invalid');
  assert.equal(store.headSeq(), 1);
});

test('del removes the row and records a del on the old row’s topics; a second del is a no-op', () => {
  const { store, session } = open();
  store.tx((w) => w.upsert(session, sessionRow('a')));
  assert.equal(store.tx((w) => w.del(session, 'a')), true);
  assert.equal(store.tx((w) => w.del(session, 'a')), false);
  assert.equal(store.get(session, 'a'), undefined);
  const del = store.changesSince(1);
  assert.equal(del.length, 1);
  assert.deepEqual([del[0]?.op, del[0]?.patch, del[0]?.topics], ['del', null, ['list', 'session:a']]);
});

test('append fills in integer keys and groups a batch under its parent in one change row', () => {
  const { store, session, event } = open();
  store.tx((w) => {
    w.upsert(session, sessionRow('a'));
    w.upsert(session, sessionRow('b'));
  });
  const rows = store.tx((w) =>
    w.append(event, [
      { session_id: 'a', seq: 1, kind: 'text', body: { t: 'hi' } },
      { session_id: 'b', seq: 1, kind: 'text', body: null },
      { session_id: 'a', seq: 2, kind: 'tool', body: { n: 1 } },
    ]),
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    [1, 2, 3],
  );
  const feed = store.changesSince(2);
  assert.deepEqual(
    feed.map((c) => [c.op, c.id, (c.patch as unknown[]).length]),
    [
      ['append', 'a', 2],
      ['append', 'b', 1],
    ],
  );
  assert.deepEqual(store.get(event, 3)?.body, { n: 1 });
  assert.deepEqual(store.get(event, '3')?.body, { n: 1 }, 'an int key given as a string');
});

test('a duplicate append is a conflict and rolls back the whole batch', () => {
  const { store, session, event } = open();
  store.tx((w) => w.upsert(session, sessionRow('a')));
  store.tx((w) => w.append(event, [{ session_id: 'a', seq: 1, kind: 'x', body: null }]));
  assert.throws(
    () => store.tx((w) => w.append(event, [{ session_id: 'a', seq: 2, kind: 'x', body: null }, { session_id: 'a', seq: 1, kind: 'x', body: null }])),
    (err: StoreError) => err.code === 'conflict',
  );
  assert.equal(store.count(event), 1);
  assert.equal(store.headSeq(), 2);
});

test('crash safety: a throw mid-tx leaves no rows, no change and publishes nothing', () => {
  const { store, session, event } = open();
  let published = 0;
  store.onCommit(() => published++);
  assert.throws(() =>
    store.tx((w) => {
      w.upsert(session, sessionRow('a'));
      w.append(event, [{ session_id: 'a', seq: 1, kind: 'x', body: null }]);
      throw new Error('harness died');
    }),
  );
  assert.equal(store.get(session, 'a'), undefined);
  assert.equal(store.count(event), 0);
  assert.deepEqual(store.changesSince(0), []);
  assert.equal(store.headSeq(), 0);
  assert.equal(published, 0);
});

test('nested tx joins the outer one; a nested throw rolls back everything even when caught', () => {
  const { store, session } = open();
  const seen: number[] = [];
  store.onCommit((c) => seen.push(c.length));
  store.tx((w) => {
    w.upsert(session, sessionRow('a'));
    store.tx((w2) => w2.upsert(session, sessionRow('b')));
    assert.equal(seen.length, 0, 'nothing is published before the outer commit');
  });
  assert.deepEqual(seen, [2]);
  assert.throws(
    () =>
      store.tx((w) => {
        w.upsert(session, sessionRow('c'));
        try {
          store.tx(() => {
            throw new Error('inner');
          });
        } catch {
          // the outer caller swallows it, but the transaction is already doomed
        }
      }),
    /nested store.tx threw/,
  );
  assert.equal(store.get(session, 'c'), undefined);
  assert.deepEqual(seen, [2]);
});

test('tx refuses an async fn and a writer used after its tx ended', async () => {
  const { store, session } = open();
  assert.throws(() => store.tx(async () => {}), /must finish synchronously/);
  let kept: Parameters<Parameters<typeof store.tx>[0]>[0] | undefined;
  store.tx((w) => {
    kept = w;
  });
  assert.throws(() => kept?.upsert(session, sessionRow('late')), /transaction that has ended/);
  assert.equal(store.get(session, 'late'), undefined);
});

test('a throwing listener is reported and the others still hear the commit', () => {
  const errors: unknown[] = [];
  const { store, session } = open({ onListenerError: (e) => errors.push(e) });
  let heard = 0;
  store.onCommit(() => {
    throw new Error('bad listener');
  });
  const sub = store.onCommit(() => heard++);
  store.tx((w) => w.upsert(session, sessionRow('a')));
  sub.dispose();
  store.tx((w) => w.upsert(session, sessionRow('b')));
  assert.equal(heard, 1);
  assert.equal(errors.length, 2);
});

test('query: where (eq, in, null, ranges), order, limit/offset; names are checked, values bound', () => {
  const { store, session } = open();
  store.tx((w) => {
    for (let i = 0; i < 10; i++) w.upsert(session, sessionRow(`s${i}`, { archived: i % 3 === 0, updated_at: i, state: i === 4 ? null : 'idle' }));
  });
  const live = store.query(session, { where: { archived: false }, order: [['updated_at', 'desc']], limit: 3 });
  assert.deepEqual(
    live.map((r) => r.id),
    ['s8', 's7', 's5'],
  );
  assert.deepEqual(
    store.query(session, { where: { updated_at: { gte: 2, lt: 4 } }, order: [['id', 'asc']] }).map((r) => r.id),
    ['s2', 's3'],
  );
  assert.deepEqual(
    store.query(session, { where: { id: ['s1', 's2', "x' OR 1=1 --"] } }).map((r) => r.id),
    ['s1', 's2'],
  );
  assert.deepEqual(
    store.query(session, { where: { state: null } }).map((r) => r.id),
    ['s4'],
  );
  assert.equal(store.query(session, { where: { id: [] } }).length, 0);
  assert.equal(store.query(session, { order: [['updated_at', 'asc']], limit: 2, offset: 8 })[0]?.id, 's8');
  assert.equal(store.count(session, { archived: true }), 4);
  assert.throws(() => store.query(session, { where: { 'id; DROP TABLE t_session': 1 } as never }), /unknown column/);
  assert.throws(() => store.query(session, { order: [['nope' as 'id', 'asc']] }), /unknown column/);
});

test('changesSince filters by topic, delivers a change on two topics once, and pages by limit', () => {
  const { store, session, event } = open();
  store.tx((w) => {
    w.upsert(session, sessionRow('a'));
    w.upsert(session, sessionRow('b'));
    w.append(event, [{ session_id: 'a', seq: 1, kind: 'x', body: null }]);
  });
  assert.deepEqual(
    store.changesSince(0, ['session:a']).map((c) => c.seq),
    [1, 3],
  );
  assert.deepEqual(
    store.changesSince(0, ['list', 'session:a']).map((c) => c.seq),
    [1, 2, 3],
  );
  assert.deepEqual(
    store.changesSince(0, undefined, 2).map((c) => c.seq),
    [1, 2],
  );
  assert.deepEqual(store.changesSince(0, []), []);
  assert.deepEqual(store.changesSince(3), []);
  assert.deepEqual(store.changesSince(0, ['session:b'])[0]?.topics, ['list', 'session:b']);
  assert.throws(() => store.changesSince(-1), /seq must be/);
});

test('topics are validated: none, or a malformed one, is refused', () => {
  const { store } = open();
  const bad = store.defineEntity({ kind: 'bad', table: 't_session', key: 'id', columns: { id: 'text' }, topics: () => [] });
  const worse = store.defineEntity({ kind: 'worse', table: 't_session', key: 'id', columns: { id: 'text' }, topics: () => ['nope' as 'list'] });
  assert.throws(() => store.tx((w) => w.upsert(bad, { id: 'x' })), /at least one topic/);
  assert.throws(() => store.tx((w) => w.upsert(worse, { id: 'x' })), /bad topic/);
});

test('entity definitions are checked, and a kind cannot be registered twice', () => {
  const { store } = open();
  assert.throws(() => store.defineEntity({ kind: 'Bad Kind', table: 't', key: 'id', columns: { id: 'text' }, topics: () => ['list'] }), /bad entity kind/);
  assert.throws(() => store.defineEntity({ kind: 'k', table: 't; drop', key: 'id', columns: { id: 'text' }, topics: () => ['list'] }), /bad table/);
  assert.throws(() => store.defineEntity({ kind: 'k', table: 't', key: 'nope' as 'id', columns: { id: 'text' }, topics: () => ['list'] }), /not a column/);
  assert.throws(() => store.defineEntity({ kind: 'k', table: 't', key: 'id', columns: { id: 'int' }, json: ['id'], topics: () => ['list'] }), /json column must be text/);
  assert.throws(() => store.defineEntity({ kind: 'session', table: 't_session', key: 'id', columns: { id: 'text' }, topics: () => ['list'] }), /already registered/);
  assert.throws(() => store.get('ghost', 'x'), /unknown entity kind/);
});

test('built-in setting and plugin kinds write the kernel tables on the config topic', () => {
  const { store } = open();
  store.tx((w) => {
    w.upsert('setting', { key: 'claude.model', value: { name: 'opus' }, locked_by: null });
    w.upsert('plugin', { id: 'wisp.claude', version: '1.0.0', enabled: true, config: {}, grants: ['proc'] });
  });
  assert.deepEqual(store.get('setting', 'claude.model')?.['value'], { name: 'opus' });
  assert.equal(store.get('plugin', 'wisp.claude')?.['enabled'], true);
  assert.deepEqual(
    store.changesSince(0).map((c) => c.topic),
    ['config', 'config'],
  );
});

test('meta: owners keep bookkeeping; store-managed keys are refused', () => {
  const { store } = open();
  store.setMeta('import:x', '1');
  assert.equal(store.getMeta('import:x'), '1');
  store.setMeta('import:x', undefined);
  assert.equal(store.getMeta('import:x'), undefined);
  assert.throws(() => store.setMeta('epoch', 'mine'), /belongs to the store/);
  assert.throws(() => store.setMeta('schema:test', '9'), /belongs to the store/);
});

test('epoch: made once, kept across reopen, fresh on rotateEpoch and announced', () => {
  const f = open({ disk: true });
  assert.equal(f.store.epoch, 'epoch-1');
  const heard: string[] = [];
  f.store.onEpoch((e) => heard.push(e));
  let n = 1;
  const g = open({ disk: true, home: f.home as string, epoch: () => `epoch-${++n}` });
  assert.equal(g.store.epoch, 'epoch-1', 'reopening keeps it');
  g.store.close();
  f.store.close();
  const h = open({ disk: true, home: f.home as string, epoch: () => 'epoch-new' });
  h.store.onEpoch((e) => heard.push(e));
  assert.equal(h.store.rotateEpoch(), 'epoch-new');
  assert.equal(h.store.epoch, 'epoch-new');
  assert.deepEqual(heard, ['epoch-new']);
  h.store.close();
});

test('a file store runs in WAL with foreign keys on', () => {
  const { store, home } = open({ disk: true });
  store.tx((w) => w.upsert('setting', { key: 'k', value: 1, locked_by: null }));
  assert.equal(fs.existsSync(path.join(home as string, 'wisp.db-wal')), true);
  assert.throws(() => store.tx((w) => w.append('event', [{ session_id: 'ghost', seq: 1, kind: 'x', body: null }])), (e: StoreError) => e.code === 'conflict');
  store.close();
});

test('head and oldest seq, and whether a cursor can resume', () => {
  const { store, session } = open();
  assert.deepEqual([store.headSeq(), store.oldestSeq()], [0, 1]);
  assert.equal(store.canResume(0), true);
  store.tx((w) => {
    for (const id of ['a', 'b', 'c']) w.upsert(session, sessionRow(id));
  });
  assert.deepEqual([store.headSeq(), store.oldestSeq()], [3, 1]);
  assert.equal(store.canResume(0), true);
  assert.equal(store.canResume(4), false, 'a cursor from the future (another epoch)');
});

test('query select: a projection reads and decodes only the columns asked for', () => {
  const { store, session } = open();
  store.tx((w) => w.upsert(session, sessionRow('a', { archived: true, extra: { big: 'x'.repeat(1000) } })));
  const rows = store.query(session, { select: ['id', 'archived'], where: { archived: true } });
  assert.deepEqual(rows, [{ id: 'a', archived: true }]);
  assert.throws(() => store.query(session, { select: ['id', 'nope' as 'id'] }), /unknown column/);
});
