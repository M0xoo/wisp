import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EntityOp, Topic } from '@wisp/protocol';
import { createEntityStore } from '../src/entities.ts';
import { entityKey, peerId } from '../src/ids.ts';
import type { LocalOp } from '../src/ops.ts';
import { effect } from '../src/signals.ts';
import type { EntityKey, PeerId } from '../src/types.ts';
import { prng } from './helpers.ts';

const A = peerId('laptop');
const B = peerId('box');
const key = (p: PeerId, id: string): EntityKey => entityKey(p, id);

test('rows are keyed by origin, so two peers with the same id never collide', () => {
  const { reader, writer } = createEntityStore();
  writer.applyServer(A, [{ topic: 'list', e: 'session', id: 's1', op: 'upsert', v: { title: 'a' } }]);
  writer.applyServer(B, [{ topic: 'list', e: 'session', id: 's1', op: 'upsert', v: { title: 'b' } }]);
  assert.deepEqual(reader.peek('session', key(A, 's1')), { title: 'a' });
  assert.deepEqual(reader.peek('session', key(B, 's1')), { title: 'b' });
  // an id that already carries its origin isn't prefixed twice
  writer.applyServer(A, [{ topic: 'list', e: 'session', id: 'laptop:s2', op: 'upsert', v: { title: 'c' } }]);
  assert.deepEqual(reader.peek('session', 'laptop:s2' as EntityKey), { title: 'c' });
  assert.equal(reader.keys('session')().length, 3);
});

test('a pending overlay shows at once, and the reject rolls it back', () => {
  const { reader, writer } = createEntityStore();
  writer.applyServer(A, [{ topic: 'list', e: 'session', id: 's1', op: 'upsert', v: { title: 'old' } }]);
  const row = reader.row<{ title: string }>('session', key(A, 's1'));
  const seen: string[] = [];
  const stop = effect(() => void seen.push(row()?.title ?? '-'));
  writer.addPending('m1', A, [{ e: 'session', id: key(A, 's1'), op: 'patch', ops: [{ op: 'replace', path: '/title', value: 'new' }] }]);
  assert.equal(row()?.title, 'new');
  writer.dropPending('m1');
  assert.equal(row()?.title, 'old');
  assert.deepEqual(seen, ['old', 'new', 'old']);
  stop();
});

test('an ack keeps the overlay until the cursor reaches its seq: no flash of the old value', () => {
  const { reader, writer } = createEntityStore();
  writer.applyServer(A, [{ topic: 'list', e: 'session', id: 's1', op: 'upsert', v: { title: 'old' } }]);
  writer.advance(A, 1);
  const k = key(A, 's1');
  writer.addPending('m1', A, [{ e: 'session', id: k, op: 'patch', ops: [{ op: 'replace', path: '/title', value: 'new' }] }]);
  writer.settle('m1', 5); // the POST answered before the stream brought seq 5
  assert.equal(reader.peek<{ title: string }>('session', k)?.title, 'new');
  assert.equal(reader.pending()().length, 1);
  writer.applyServer(A, [{ topic: 'list', e: 'session', id: 's1', op: 'patch', ops: [{ op: 'replace', path: '/title', value: 'new' }] }]);
  writer.advance(A, 5);
  assert.equal(reader.pending()().length, 0);
  assert.equal(reader.peek<{ title: string }>('session', k)?.title, 'new');
});

test('an unchanged value keeps its reference, so nothing repaints', () => {
  const { reader, writer } = createEntityStore();
  writer.applyServer(A, [{ topic: 'list', e: 'session', id: 's1', op: 'upsert', v: { title: 'x', n: [1] } }]);
  const before = reader.peek('session', key(A, 's1'));
  writer.applyServer(A, [{ topic: 'list', e: 'session', id: 's1', op: 'upsert', v: { title: 'x', n: [1] } }]);
  assert.equal(reader.peek('session', key(A, 's1')), before);
});

test('a snapshot replaces its topic: rows it no longer has go, rows another topic holds stay', () => {
  const { reader, writer } = createEntityStore();
  writer.snapshot(A, 'list', [
    { e: 'session', id: 's1', v: { t: 1 } },
    { e: 'session', id: 's2', v: { t: 2 } },
  ]);
  writer.applyServer(A, [{ topic: 'session:s2', e: 'session', id: 's2', op: 'upsert', v: { t: 2 } }]);
  writer.snapshot(A, 'list', [{ e: 'session', id: 's3', v: { t: 3 } }]);
  assert.deepEqual([...reader.keys('session')()].sort(), [key(A, 's2'), key(A, 's3')]);
});

test('resetPeer drops one peer\'s base and keeps the other peers and the pending overlay', () => {
  const { reader, writer } = createEntityStore();
  writer.applyServer(A, [{ topic: 'list', e: 'session', id: 's1', op: 'upsert', v: 1 }]);
  writer.applyServer(B, [{ topic: 'list', e: 'session', id: 's1', op: 'upsert', v: 2 }]);
  writer.addPending('m', A, [{ e: 'session', id: key(A, 'new'), op: 'upsert', v: 3 }]);
  writer.resetPeer(A);
  assert.equal(reader.peek('session', key(A, 's1')), undefined);
  assert.equal(reader.peek('session', key(B, 's1')), 2);
  assert.equal(reader.peek('session', key(A, 'new')), 3);
});

test('an op that does not apply is reported for resync and leaves the row as it was', () => {
  const warnings: string[] = [];
  const { reader, writer } = createEntityStore((m) => warnings.push(m));
  const failed = writer.applyServer(A, [{ topic: 'session:s9', e: 'session', id: 's9', op: 'patch', ops: [{ op: 'replace', path: '/x', value: 1 }] }]);
  assert.deepEqual(failed, ['session:s9']);
  assert.equal(reader.peek('session', key(A, 's9')), undefined);
  assert.equal(warnings.length, 1);
});

// ---------- the property: any order converges to the server state ----------

type Model = Map<string, unknown>; // `${e}|${key}` → value

function serverOp(r: ReturnType<typeof prng>, model: Model, peer: PeerId): EntityOp {
  const ids = ['s1', 's2', 's3', 's4'];
  const id = r.pick(ids);
  const k = key(peer, id);
  const sessionTopic = `session:${id}` as Topic;
  const choice = r.int(5);
  const cur = model.get(`session|${k}`) as { title: string; n: number } | undefined;
  if (choice === 0 && cur) return { topic: 'list', e: 'session', id, op: 'patch', ops: [{ op: 'replace', path: '/title', value: `t${r.int(100)}` }] };
  if (choice === 1 && cur) return { topic: 'list', e: 'session', id, op: 'del' };
  if (choice === 2) return { topic: sessionTopic, e: 'event', id, op: 'append', v: [{ n: r.int(1000) }] };
  return { topic: 'list', e: 'session', id, op: 'upsert', v: { title: `t${r.int(100)}`, n: r.int(10) } };
}

function applyModel(model: Model, peer: PeerId, op: EntityOp): void {
  const k = `${op.e}|${key(peer, op.id)}`;
  const cur = model.get(k);
  if (op.op === 'upsert') model.set(k, op.v);
  else if (op.op === 'del') model.delete(k);
  else if (op.op === 'append') model.set(k, [...((cur as unknown[] | undefined) ?? []), ...op.v]);
  else {
    const first = op.ops[0];
    if (first && first.op === 'replace') model.set(k, { ...(cur as object), title: first.value });
  }
}

function optimistic(r: ReturnType<typeof prng>, peer: PeerId): LocalOp[] {
  const id = key(peer, r.pick(['s1', 's2', 's3', 's5']));
  switch (r.int(4)) {
    case 0:
      return [{ e: 'session', id, op: 'patch', ops: [{ op: 'replace', path: '/title', value: 'optimistic' }] }];
    case 1:
      return [{ e: 'session', id, op: 'del' }];
    case 2:
      return [{ e: 'event', id, op: 'append', v: [{ n: -1 }] }];
    default:
      return [{ e: 'session', id, op: 'upsert', v: { title: 'made here', n: 0 } }];
  }
}

interface Script {
  frames: Map<PeerId, { seq: number; ops: EntityOp[] }[]>;
  model: Model;
}

/** The server's history per peer: frames of ops, each with its seq. */
function serverHistory(r: ReturnType<typeof prng>): Script {
  const model: Model = new Map();
  const frames = new Map<PeerId, { seq: number; ops: EntityOp[] }[]>();
  for (const peer of [A, B]) {
    const list: { seq: number; ops: EntityOp[] }[] = [];
    for (let seq = 1; seq <= 4 + r.int(12); seq++) {
      const ops: EntityOp[] = [];
      for (let i = 0; i <= r.int(3); i++) {
        const op = serverOp(r, model, peer);
        applyModel(model, peer, op);
        ops.push(op);
      }
      list.push({ seq, ops });
    }
    frames.set(peer, list);
  }
  return { frames, model };
}

function runCase(seed: number): void {
  const r = prng(seed);
  const { frames, model } = serverHistory(r);
  const { reader, writer } = createEntityStore();
  const list = (kind: string) => reader.list(kind); // read from the start, so every change goes through the incremental path
  list('session')();
  list('event')();
  const delivered = new Map<PeerId, number>([
    [A, 0],
    [B, 0],
  ]);
  const seen: Model = new Map(); // what the store has been sent so far
  const inflight: { mid: string; peer: PeerId }[] = [];
  let mids = 0;
  const lastSeq = (p: PeerId): number => frames.get(p)?.at(-1)?.seq ?? 0;
  const deliver = (p: PeerId): void => {
    const i = delivered.get(p) ?? 0;
    const f = frames.get(p)?.[i];
    if (!f) return;
    for (const op of f.ops) applyModel(seen, p, op);
    writer.applyServer(p, f.ops);
    writer.advance(p, f.seq);
    delivered.set(p, i + 1);
  };
  const answer = (): void => {
    const c = inflight.splice(r.int(inflight.length), 1)[0];
    if (!c) return;
    // an ack names a seq the peer will reach; a reject rolls back now
    if (r.int(3) === 0) writer.dropPending(c.mid);
    else writer.settle(c.mid, 1 + r.int(lastSeq(c.peer)));
  };
  for (let step = 0; step < 60; step++) {
    const peer = r.pick([A, B]);
    const what = r.int(4);
    if (what === 0) deliver(peer);
    else if (what === 1) {
      const mid = `m${++mids}`;
      writer.addPending(mid, peer, optimistic(r, peer));
      inflight.push({ mid, peer });
    } else if (what === 2) answer();
    else if (what === 3) {
      // a resync: the whole list topic again, as the server has it at the delivered point
      const prefix = `session|${peer}:`;
      const rows = [...seen].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ e: 'session', id: k.slice(prefix.length), v }));
      writer.snapshot(peer, 'list', rows);
    }
  }
  for (const p of [A, B]) while ((delivered.get(p) ?? 0) < (frames.get(p)?.length ?? 0)) deliver(p);
  while (inflight.length > 0) answer();

  assert.equal(reader.pending()().length, 0, `seed ${seed}: every answered command left the overlay`);
  // the incrementally kept list holds exactly the rows, in member order
  for (const kind of ['session', 'event']) assert.deepEqual(list(kind)(), reader.keys(kind)().map((k) => reader.peek(kind, k)), `seed ${seed}: ${kind} list`);
  for (const kind of ['session', 'event']) {
    const got = new Map(reader.keys(kind)().map((k) => [`${kind}|${k}`, reader.peek(kind, k)]));
    const want = new Map([...model].filter(([k]) => k.startsWith(`${kind}|`)));
    assert.deepEqual(got, want, `seed ${seed}: ${kind} rows converge to the server state`);
  }
}

test('property: any interleaving of patches from two peers and commands acked or rejected in any order converges to the server state', () => {
  for (let seed = 1; seed <= 400; seed++) runCase(seed);
});
