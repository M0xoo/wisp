import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClientMessage, Window } from '@wisp/protocol';
import { createEntityStore } from '../src/entities.ts';
import { peerId } from '../src/ids.ts';
import { createPeers } from '../src/peers.ts';
import { createScope } from '../src/scope.ts';
import { createTranscripts } from '../src/transcript.ts';
import { fakeTimers, fakeTransport, tick, welcome, type FakeTimers } from './helpers.ts';

const A = peerId('laptop');
type Ev = { seq: number; session_id: string; text: string };
const evs = (from: number, to: number): Ev[] => Array.from({ length: to - from + 1 }, (_, i) => ({ seq: from + i, session_id: 's1', text: `e${from + i}` }));

let clockNow: FakeTimers | undefined;
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    clockNow?.advance(0);
    await tick();
  }
}

async function setup(opts: { live?: boolean } = {}) {
  const clock = fakeTimers(1_700_000_000_000);
  clockNow = clock;
  const scope = createScope('test', clock);
  const { reader, writer } = createEntityStore();
  const peers = createPeers({ scope, writer, clientId: 'c1', build: 'test' });
  const t = fakeTransport();
  peers.add({ peer: A, name: 'laptop', transport: t });
  const transcripts = createTranscripts({ reader, writer, peers, pageSize: 100, timeoutMs: 5000 });
  const view = scope.child('task-view');
  const tr = transcripts.open<Ev>(A, 's1', view);
  await settle();
  const conn = () => t.connections.at(-1);
  if (opts.live !== false) {
    conn()?.push(welcome());
    await settle();
    conn()?.frame(300, { t: 'snapshot', topic: 'session:s1', seq: 300, rows: [{ e: 'event', id: 's1', v: evs(101, 200) }] });
    await settle();
  }
  const windows = (): Window[] => t.posted.filter((m: ClientMessage): m is Window => m.t === 'window');
  return { clock, scope, view, tr, t, conn, windows, writer };
}

test('a task opens at the tail and pages backwards, oldest first, until the start', async () => {
  const { tr, conn, windows } = await setup();
  assert.equal(tr.events().length, 100);
  assert.equal(tr.events()[0]?.seq, 101, 'the tail came with the subscription');
  const page = tr.older();
  assert.equal(tr.paging().kind, 'loading');
  assert.deepEqual(windows().map((w) => [w.topic, w.before_seq, w.limit]), [['session:s1', 101, 100]]);
  conn()?.push({ t: 'rows', req: windows()[0]?.req ?? '', rows: [{ e: 'event', id: 's1', v: evs(1, 100) }], done: true });
  await settle();
  await page;
  assert.equal(tr.events().length, 200);
  assert.deepEqual([tr.events()[0]?.seq, tr.events()[199]?.seq], [1, 200]);
  assert.deepEqual(tr.paging(), { kind: 'idle', atStart: false });
  void tr.older();
  conn()?.push({ t: 'rows', req: windows()[1]?.req ?? '', rows: [], done: true });
  await settle();
  assert.deepEqual(tr.paging(), { kind: 'idle', atStart: true }, 'a short page is the start');
  await tr.older();
  assert.equal(windows().length, 2, 'at the start, nothing more is asked');
});

test('live appends land after the pages; a page never duplicates what is held', async () => {
  const { tr, conn, windows } = await setup();
  void tr.older();
  // the answer overlaps the tail by a few events, and comes one event per row
  conn()?.push({ t: 'rows', req: windows()[0]?.req ?? '', rows: evs(95, 105).map((v) => ({ e: 'event', id: String(v.seq), v })), done: true });
  await settle();
  conn()?.frame(301, { t: 'patch', seq: 301, ops: [{ topic: 'session:s1', e: 'event', id: 's1', op: 'append', v: evs(201, 201) }] });
  await settle();
  const seqs = tr.events().map((e) => e.seq);
  assert.deepEqual(seqs.slice(0, 7), [95, 96, 97, 98, 99, 100, 101]);
  assert.equal(seqs.at(-1), 201);
  assert.equal(new Set(seqs).size, seqs.length);
  assert.deepEqual(tr.paging(), { kind: 'idle', atStart: true }, '6 new events is a short page');
});

test('older() while a page loads joins it: one window per page', async () => {
  const { tr, windows } = await setup();
  const a = tr.older();
  const b = tr.older();
  assert.equal(a, b);
  assert.equal(windows().length, 1);
});

test('offline, the page waits for the peer and goes after the welcome', async () => {
  const { tr, conn, windows } = await setup({ live: false });
  void tr.older();
  assert.equal(windows().length, 0);
  conn()?.push(welcome());
  await settle();
  assert.equal(windows().length, 1);
  assert.equal(windows()[0]?.before_seq, Number.MAX_SAFE_INTEGER, 'nothing held yet: the latest page');
});

test('a page answer after the task view closed is dropped (#492)', async () => {
  const { tr, view, conn, windows } = await setup();
  void tr.older();
  view.dispose();
  conn()?.push({ t: 'rows', req: windows()[0]?.req ?? '', rows: [{ e: 'event', id: 's1', v: evs(1, 100) }], done: true });
  await settle();
  assert.equal(tr.events().length, 100, 'nothing merged');
});

test('a page that never comes fails with a reason, and the next older() asks again', async () => {
  const { tr, clock, windows } = await setup();
  const page = tr.older();
  clock.advance(5000);
  await page;
  assert.deepEqual(tr.paging(), { kind: 'failed', reason: "laptop didn't answer" });
  void tr.older();
  assert.equal(windows().length, 2);
});
