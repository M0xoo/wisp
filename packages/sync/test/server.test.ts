// SyncServer rules, one by one, on a scripted clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessage, Topic } from '@wisp/protocol';
import { FakeStore, makeServer } from './harness.ts';
import type { Change } from './harness.ts';
import type { ConnectQuery, ServerOutput } from '../src/types.ts';
import type { SyncServer } from '../src/server.ts';

type Out = ServerOutput<string>;
const sends = (outs: Out[]): Extract<Out, { kind: 'send' }>[] => outs.filter((o): o is Extract<Out, { kind: 'send' }> => o.kind === 'send');
const msgs = (outs: Out[]): ServerMessage[] => sends(outs).flatMap((s) => s.messages);
const of = <K extends Out['kind']>(outs: Out[], kind: K): Extract<Out, { kind: K }>[] => outs.filter((o): o is Extract<Out, { kind: K }> => o.kind === kind);

/** A server with one connection whose snapshots the store answers at once. */
function setup(query: ConnectQuery = { topics: '', fresh: 'list' }, over: Parameters<typeof makeServer>[1] = {}) {
  const store = new FakeStore();
  store.commit([{ topic: 'list', e: 'session', id: 's1', op: 'upsert', v: { title: 'one' } }]);
  const server = makeServer(store, over);
  let now = 1000;
  const run = (outs: Out[]): Out[] => {
    const all = [...outs];
    for (const o of outs) {
      if (o.kind === 'snapshotRequest') {
        const d = o.since === null ? { rows: store.snapshot(o.topic), full: true } : { ...store.delta(o.topic, o.since), full: false };
        all.push(...run(server.handle({ kind: 'snapshotRows', conn: o.conn, topic: o.topic, req: o.req, seq: store.seq, ...d }, now)));
      }
    }
    return all;
  };
  const connect = (conn = 'c1', q = query, caller = 'me'): Out[] => run(server.handle({ kind: 'connect', conn, caller, query: q }, now));
  const commit = (changes: Change[]): Out[] => run(server.handle({ kind: 'committed', rows: store.commit(changes, now) }, now));
  const tick = (ms: number): Out[] => {
    now += ms;
    return run(server.handle({ kind: 'tick' }, now));
  };
  const send = (conn: string, message: unknown): Out[] => run(server.handle({ kind: 'message', conn, message }, now));
  return { store, server: server as SyncServer<string>, connect, commit, tick, send, run, at: () => now, drained: (conn: string, bytes: number) => run(server.handle({ kind: 'drained', conn, bufferedBytes: bytes }, now)) };
}

const title = (t: string, id = 's1'): Change => ({ topic: 'list', e: 'session', id, op: 'set', v: { title: t } });

test('welcome: resume only with the same epoch and a cursor the change log still covers', () => {
  const cases: [ConnectQuery, boolean][] = [
    [{ epoch: 'E1', cursor: '1', topics: 'list' }, true],
    [{ epoch: 'E1', cursor: '0', topics: 'list' }, true], // oldest_seq is 0: everything after 0 is kept
    [{ epoch: 'E0', cursor: '1', topics: 'list' }, false], // a restore made a new epoch
    [{ epoch: 'E1', topics: 'list' }, false], // no cursor
    [{ epoch: 'E1', cursor: '9', topics: 'list' }, false], // from the future: not this log
    [{ epoch: 'E1', last_event_id: '1', topics: 'list' }, true], // the browser's own reconnect
  ];
  for (const [q, resume] of cases) {
    const s = setup(q);
    const outs = s.connect();
    const w = msgs(outs)[0];
    assert.equal(w?.t === 'welcome' && w.resume, resume, JSON.stringify(q));
    // resume asks for the delta since the cursor; otherwise the whole topic
    assert.deepEqual(of(outs, 'snapshotRequest').map((r) => r.since), [resume ? Number(q.cursor ?? q.last_event_id) : null]);
  }
  const s = setup({ epoch: 'E1', cursor: '0', topics: 'list' }, { oldestSeq: 1 });
  assert.equal((msgs(s.connect())[0] as { resume: boolean }).resume, false, 'retention passed the cursor');
});

test('welcome carries the peer, epoch, head and oldest; a client outside the window is told and closed', () => {
  const s = setup();
  const w = msgs(s.connect())[0];
  assert.deepEqual(w && w.t === 'welcome' && { epoch: w.epoch, head: w.head_seq, oldest: w.oldest_seq, proto: w.proto, peer: w.peer.peer }, { epoch: 'E1', head: 1, oldest: 0, proto: 2, peer: 'laptop' });
  const old = s.connect('c2', { proto_min: '1', proto_max: '1', fresh: 'list' });
  assert.equal(msgs(old)[0]?.t, 'welcome');
  assert.deepEqual(of(old, 'closeConn').map((c) => c.reason), ['incompatible']);
  assert.equal(of(old, 'snapshotRequest').length, 0);
});

test('the first change after quiet goes at once; the rest coalesce into one frame per 50 ms', () => {
  const s = setup();
  s.connect();
  s.tick(100);
  assert.equal(sends(s.commit([title('a')])).length, 1, 'idle: at once');
  let frames = 0;
  for (let i = 0; i < 100; i++) frames += sends(s.commit([title(`t${i}`)])).length; // within the same ms
  assert.equal(frames, 0, 'held for the flush');
  const out = s.tick(50);
  assert.equal(sends(out).length, 1);
  const ops = (msgs(out).find((m) => m.t === 'patch') as Extract<ServerMessage, { t: 'patch' }>).ops;
  assert.deepEqual(ops, [{ topic: 'list', e: 'session', id: 's1', op: 'patch', ops: [{ op: 'replace', path: '/title', value: 't99' }] }], '100 changes, one op');
});

test('streaming 10 entities for 1 s: frames are bounded by the flush rate, not the change rate', () => {
  const s = setup({ fresh: 'list,session:x' });
  s.connect();
  let frames = 0;
  let changes = 0;
  for (let ms = 0; ms < 1000; ms += 5) {
    for (let e = 0; e < 10; e++, changes++) frames += sends(s.commit([{ topic: 'session:x', e: 'turn', id: `t${e}`, op: 'append', v: [ms] }])).length;
    frames += sends(s.tick(5)).length;
  }
  assert.equal(changes, 2000);
  assert.ok(frames <= 21, `${frames} frames`);
  assert.ok(s.server.stats.frames <= 22);
});

test('priority: acks, then the session, then the list, then the rest; the watermark never passes what is queued', () => {
  const s = setup({ fresh: 'list,session:a,machines' }, { highWaterBytes: 500 });
  s.connect();
  s.drained('c1', 0);
  s.tick(100); // the snapshots go
  s.drained('c1', 0);
  s.tick(100);
  const big = 'x'.repeat(150);
  const rows = s.store.commit([
    { topic: 'machines', e: 'm', id: 'm1', op: 'upsert', v: big },
    { topic: 'list', e: 'session', id: 's9', op: 'upsert', v: big },
    { topic: 'session:a', e: 'turn', id: 't1', op: 'upsert', v: big },
  ]);
  const f = sends(s.server.handle({ kind: 'committed', rows }, s.at()))[0];
  // the budget fits two: the session first, then the list; machines waits
  const patch = f?.messages.find((m) => m.t === 'patch') as Extract<ServerMessage, { t: 'patch' }>;
  assert.deepEqual(patch.ops.map((o) => o.topic), ['session:a', 'list']);
  const machines = rows[0]?.seq as number;
  assert.equal(f?.id, machines - 1, 'a resume from this frame must still get the queued machines row');
  s.server.handle({ kind: 'commandResult', conn: 'c1', mid: 'm1', outcome: { ok: true, seq: 1 } }, s.at());
  s.drained('c1', 0);
  const next = sends(s.tick(50))[0];
  assert.deepEqual(next?.messages.map((m) => m.t), ['ack', 'patch']);
  assert.equal(next?.id, s.store.seq);
});

test('an ack waits until the effects it reports have been sent', () => {
  const s = setup({ fresh: 'list' }, { highWaterBytes: 300 });
  s.connect();
  s.drained('c1', 0);
  s.tick(100);
  const rows = s.store.commit([{ topic: 'list', e: 'session', id: 's2', op: 'upsert', v: 'y'.repeat(400) }, title('t')]);
  const first = s.server.handle({ kind: 'committed', rows }, s.at()); // the budget takes the first row only
  assert.deepEqual(msgs(first).map((m) => m.t), ['patch']);
  assert.equal(sends(first)[0]?.id, s.store.seq - 1);
  s.server.handle({ kind: 'commandResult', conn: 'c1', mid: 'm1', outcome: { ok: true, seq: s.store.seq, result: { id: 's2' } } }, s.at());
  s.drained('c1', 0);
  const second = msgs(s.tick(50));
  assert.deepEqual(second[0], { t: 'ack', mid: 'm1', seq: s.store.seq, result: { id: 's2' } });
  // a reject has nothing to wait for
  s.server.handle({ kind: 'commandResult', conn: 'c1', mid: 'm2', outcome: { ok: false, code: 'vetoed', message: 'over budget' } }, s.at());
  assert.deepEqual(msgs(s.tick(50)), [{ t: 'reject', mid: 'm2', code: 'vetoed', message: 'over budget' }]);
});

test('backpressure: past the high-water mark a topic is dropped with resync, and recovers from its since', () => {
  const s = setup({ fresh: 'list,session:a' }, { highWaterBytes: 1000 });
  s.connect();
  s.tick(100);
  const before = s.store.seq;
  s.drained('c1', 5000); // the phone stopped reading
  for (let i = 0; i < 20; i++) s.commit([{ topic: 'session:a', e: 'turn', id: `t${i}`, op: 'upsert', v: i }, title(`x${i}`)]);
  const shed = s.tick(50);
  assert.deepEqual(msgs(shed).filter((m) => m.t === 'resync').map((m) => (m as { topic: Topic }).topic).sort(), ['list', 'session:a']);
  assert.ok(!msgs(shed).some((m) => m.t === 'patch'), 'nothing heavy goes into a full socket');
  assert.equal(sends(shed)[0]?.id, before, 'the cursor stays before what was dropped');
  assert.equal(s.server.stats.resyncs, 2);
  // while dropped, new changes for the topic are not queued
  s.commit([title('late')]);
  // the client resubscribes from its cursor; the socket is still full, so the delta waits
  assert.equal(of(s.send('c1', { t: 'sub', topic: 'list', since: before }), 'snapshotRequest').length, 0);
  const recover = s.drained('c1', 0);
  const req = of(recover, 'snapshotRequest');
  assert.deepEqual(req.map((r) => [r.topic, r.since]), [['list', before]]);
  const patch = msgs(s.tick(50)).find((m) => m.t === 'patch') as Extract<ServerMessage, { t: 'patch' }>;
  assert.deepEqual(patch.ops.map((o) => [o.id, o.op, o.op === 'upsert' && o.v]), [['s1', 'upsert', { title: 'late' }]]);
});

test('changes during a snapshot are held and sent after it, without the ones it already has', () => {
  const store = new FakeStore();
  const server = makeServer(store);
  const out = server.handle({ kind: 'connect', conn: 'c1', caller: 'me', query: { fresh: 'list' } }, 0);
  const req = of(out, 'snapshotRequest')[0];
  assert.ok(req !== undefined);
  const r1 = store.commit([title('a')]);
  server.handle({ kind: 'committed', rows: r1 }, 100); // read by the snapshot below
  const snapAt = store.seq;
  const snapRows = store.snapshot('list');
  const r2 = store.commit([title('b')]);
  server.handle({ kind: 'committed', rows: r2 }, 100); // after the snapshot's read
  // an answer to an older request is ignored
  assert.deepEqual(server.handle({ kind: 'snapshotRows', conn: 'c1', topic: 'list', req: req.req + 7, seq: 0, rows: [], full: true }, 100), []);
  const sent = msgs(server.handle({ kind: 'snapshotRows', conn: 'c1', topic: 'list', req: req.req, seq: snapAt, rows: snapRows, full: true }, 200));
  assert.deepEqual(sent.map((m) => m.t), ['snapshot', 'patch']);
  assert.deepEqual((sent[1] as Extract<ServerMessage, { t: 'patch' }>).ops.map((o) => o.op === 'patch' && o.ops), [[{ op: 'replace', path: '/title', value: 'b' }]]);
});

test('snapshot pages go out in order, and the cursor holds for a resumed topic until the last page', () => {
  const store = new FakeStore();
  const server = makeServer(store, { headSeq: 5, oldestSeq: 0 });
  const req = of(server.handle({ kind: 'connect', conn: 'c1', caller: 'me', query: { epoch: 'E1', cursor: '3', topics: 'list' } }, 0), 'snapshotRequest')[0];
  assert.equal(req?.since, 3);
  const page = (rows: number, more: boolean) => server.handle({ kind: 'snapshotRows', conn: 'c1', topic: 'list', req: req?.req ?? 0, seq: 5, rows: [{ e: 'x', id: String(rows), v: rows }], full: true, more }, 100);
  const p1 = sends(page(1, true))[0];
  assert.equal(p1?.id, 3, 'not past the since until the whole topic is there');
  page(2, false); // within the flush interval: it waits for the tick
  const p2 = sends(server.handle({ kind: 'tick' }, 150))[0];
  assert.deepEqual(p2?.messages.map((m) => m.t === 'snapshot' && (m.more ?? false)), [false]);
  assert.equal(p2?.id, 5);
});

test('a client that reconnects replaces its old stream', () => {
  const s = setup({ client_id: 'phone', fresh: 'list' });
  s.connect('c1');
  const out = s.connect('c2');
  assert.deepEqual(of(out, 'closeConn'), [{ kind: 'closeConn', conn: 'c1', reason: 'replaced' }]);
  assert.equal(s.server.connOf('phone'), 'c2');
});

test('authorization and topic checks: denied topics get a notice and no data', () => {
  const store = new FakeStore();
  const server = makeServer(store, { canRead: (caller, topic) => caller === 'owner' || !topic.startsWith('session:') });
  const out = server.handle({ kind: 'connect', conn: 'c1', caller: 'agent', query: { fresh: 'list,session:secret,bogus topic' } }, 0);
  assert.deepEqual(of(out, 'snapshotRequest').map((r) => r.topic), ['list']);
  assert.deepEqual(msgs(out).filter((m) => m.t === 'notice'), [
    { t: 'notice', kind: 'denied', data: { topic: 'bogus topic', code: 'invalid' } },
    { t: 'notice', kind: 'denied', data: { topic: 'session:secret', code: 'forbidden' } },
  ]);
  const win = server.handle({ kind: 'message', conn: 'c1', message: { t: 'window', req: 'w1', topic: 'session:secret', before_seq: 9, limit: 50 } }, 100);
  assert.equal(of(win, 'windowRequest').length, 0);
  const committed = store.commit([{ topic: 'session:secret', e: 'turn', id: 't', op: 'upsert', v: 1 }]);
  assert.equal(server.handle({ kind: 'committed', rows: committed }, 200).length, 0);
});

test('passive subscriptions never count as use; one active sub does', () => {
  const s = setup({ fresh: 'list,machines', passive: '1' });
  const out = s.connect();
  assert.equal(of(out, 'activity').length, 0);
  assert.equal(s.server.activeCount(), 0);
  assert.deepEqual(of(s.send('c1', { t: 'sub', topic: 'session:a' }), 'activity'), [{ kind: 'activity', conn: 'c1', active: true }]);
  assert.equal(s.server.activeCount(), 1);
  // the same sub again, passive: only the flag changes (no second snapshot)
  const again = s.send('c1', { t: 'sub', topic: 'session:a', passive: true });
  assert.deepEqual(again.map((o) => o.kind), ['activity']);
  assert.equal(s.server.activeCount(), 0);
  const mixed = setup({ fresh: 'list,machines', passive: 'machines' });
  mixed.connect();
  assert.equal(mixed.server.activeCount(), 1);
});

test('window paging: the request goes to the host and its rows come back on the stream', () => {
  const s = setup({ fresh: 'session:a' });
  s.connect();
  const req = of(s.send('c1', { t: 'window', req: 'w1', topic: 'session:a', before_seq: 900, limit: 5000 }), 'windowRequest');
  assert.deepEqual(req, [{ kind: 'windowRequest', conn: 'c1', req: 'w1', topic: 'session:a', beforeSeq: 900, limit: 1000 }]);
  s.tick(100);
  const out = s.run(s.server.handle({ kind: 'windowRows', conn: 'c1', req: 'w1', rows: [{ e: 'event', id: '1', v: 'old' }], done: true }, s.at()));
  assert.deepEqual(msgs(out), [{ t: 'rows', req: 'w1', rows: [{ e: 'event', id: '1', v: 'old' }], done: true }]);
});

test('mutate goes to the host as a command with the caller; malformed messages are dropped', () => {
  const s = setup();
  s.connect();
  assert.deepEqual(of(s.send('c1', { t: 'mutate', mid: 'm1', cmd: 'session.followUp', args: { text: 'hi' }, base_seq: 3 }), 'command'), [
    { kind: 'command', conn: 'c1', caller: 'me', mid: 'm1', cmd: 'session.followUp', args: { text: 'hi' }, baseSeq: 3 },
  ]);
  for (const bad of [null, 'x', { t: 'mutate' }, { t: 'sub', topic: 'nope' }, { t: 'sub', topic: 'list', since: -1 }, { t: 'boom' }]) assert.deepEqual(s.send('c1', bad), []);
});

test('heartbeats keep a quiet stream open; nextWakeAt says when', () => {
  const s = setup({ fresh: 'list' }, { heartbeatMs: 15_000 });
  s.connect();
  assert.equal(s.server.nextWakeAt(), s.at() + 15_000);
  assert.equal(sends(s.tick(14_000)).length, 0);
  const hb = sends(s.tick(1000));
  assert.deepEqual(hb.map((f) => [f.frame, f.id]), [[': hb\n\n', null]]);
  s.commit([title('z')]);
  s.server.handle({ kind: 'close', conn: 'c1' }, s.at());
  assert.equal(s.server.nextWakeAt(), null);
});

test('notices go to every stream, or only to those on the topic', () => {
  const s = setup({ client_id: 'a', fresh: 'list' });
  s.connect('c1');
  s.connect('c2', { client_id: 'b', fresh: 'machines' });
  s.tick(100);
  const out = s.server.handle({ kind: 'notice', notice: { t: 'notice', kind: 'toast', data: 'hi' }, topic: 'machines' }, s.at());
  assert.deepEqual(sends(out).map((f) => f.conn), ['c2']);
});
