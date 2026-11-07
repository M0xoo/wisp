// Property: any interleaving of commits, ticks, slow sockets (resync), lost frames, reconnects that
// resume and reconnects that can't (retention, a restored epoch), late snapshot answers and
// sub/unsub churn leaves every client's map equal to the store, topic by topic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Topic } from '@wisp/protocol';
import { FakeStore, SimClient, Sim, makeServer, rng, view } from './harness.ts';
import type { Change } from './harness.ts';

const TOPICS: Topic[] = ['list', 'session:a', 'session:b', 'machines'];

function value(r: () => number): unknown {
  const n = Math.floor(r() * 4);
  return { title: `t${Math.floor(r() * 5)}`, n: Math.floor(r() * 3), tags: Array.from({ length: n }, (_, i) => `x${i}`), ...(r() < 0.5 && { extra: { deep: r() < 0.5 ? 1 : 'a/b~c' } }) };
}

function change(r: () => number): Change {
  const topic = TOPICS[Math.floor(r() * TOPICS.length)] as Topic;
  const id = `r${Math.floor(r() * 5)}`;
  const k = r();
  if (k < 0.15) return { topic, e: 'log', id: 'l0', op: 'append', v: [Math.floor(r() * 100)] };
  if (k < 0.3) return { topic, e: 'row', id, op: 'del' };
  if (k < 0.45) return { topic, e: 'row', id, op: 'upsert', v: value(r) };
  return { topic, e: 'row', id, op: 'set', v: value(r) };
}

const seen = { resyncs: 0, resumes: 0, resets: 0, drifts: 0 };

interface World {
  r: () => number;
  store: FakeStore;
  sim: Sim;
  clients: SimClient[];
  subs: Map<SimClient, Set<Topic>>;
  flush: number;
  epoch: number;
}

function setup(seed: number): World {
  const r = rng(seed);
  const store = new FakeStore();
  const flush = 20 + Math.floor(r() * 60);
  const sim = new Sim(store, makeServer(store, { flushMs: flush, highWaterBytes: 4000 }), r, { asyncAnswers: true, wire: true, chunked: r() < 0.5 });
  const clients = [new SimClient('A'), new SimClient('B'), new SimClient('C')];
  const subs = new Map<SimClient, Set<Topic>>();
  for (const c of clients) {
    const mine = new Set<Topic>(['list', TOPICS[1 + Math.floor(r() * 3)] as Topic]);
    subs.set(c, mine);
    for (const t of mine) c.client.handle({ kind: 'subscribe', topic: t, passive: r() < 0.3 }, sim.now);
    sim.open(c, clients);
  }
  return { r, store, sim, clients, subs, flush, epoch: 1 };
}

/** One random thing happens. */
function step(w: World): void {
  const { r, store, sim, clients } = w;
  const k = r();
  const c = clients[Math.floor(r() * clients.length)] as SimClient;
  if (k < 0.35) sim.commit(Array.from({ length: 1 + Math.floor(r() * 3) }, () => change(r)), clients);
  else if (k < 0.55) sim.tick(Math.floor(r() * 80), clients);
  else if (k < 0.68) sim.deliver(c, clients, 1 + Math.floor(r() * 3));
  else if (k < 0.74) sim.answerAll();
  else if (k < 0.79) c.backlog = r() < 0.5 ? 10_000 : 0; // a slow phone: past the high-water mark
  else if (k < 0.85) {
    sim.lose(c, clients);
    sim.open(c, clients);
  } else if (k < 0.88) {
    store.trim(store.seq - Math.floor(r() * 3)); // retention passes the client's cursor
    sim.server.handle({ kind: 'retained', oldestSeq: store.oldest }, sim.now);
  } else if (k < 0.9) {
    // a restore: a new epoch, every cursor from before is void
    sim.server = makeServer(store, { epoch: `E${++w.epoch}`, flushMs: w.flush, highWaterBytes: 4000 });
    for (const x of clients) sim.lose(x, clients);
    sim.answers = [];
    for (const x of clients) sim.open(x, clients);
  } else if (k < 0.96) toggle(w, c, TOPICS[Math.floor(r() * TOPICS.length)] as Topic);
  else if (c.conn === null) sim.open(c, clients);
}

function toggle(w: World, c: SimClient, t: Topic): void {
  const mine = w.subs.get(c) as Set<Topic>; // every client is in the map
  if (mine.has(t)) {
    if (t === 'list') return;
    mine.delete(t);
    w.sim.client_(c, c.client.handle({ kind: 'unsubscribe', topic: t }, w.sim.now), w.clients);
  } else {
    mine.add(t);
    w.sim.client_(c, c.client.handle({ kind: 'subscribe', topic: t }, w.sim.now), w.clients);
  }
}

/** Sockets drain, answers come, every client is connected, until nothing is left to send. */
function settle({ sim, clients, flush }: World): void {
  for (const c of clients) {
    c.backlog = 0;
    if (c.conn !== null) sim.server_(sim.server.handle({ kind: 'drained', conn: c.conn, bufferedBytes: 0 }, sim.now), clients);
    else sim.open(c, clients);
  }
  for (let i = 0; i < 200; i++) {
    sim.answerAll();
    sim.tick(flush, clients);
    for (const c of clients) sim.deliver(c, clients);
    if (sim.answers.length === 0 && clients.every((c) => c.transit.length === 0)) {
      const wake = sim.server.nextWakeAt();
      if (wake === null || wake > sim.now + flush * 2) break;
    }
  }
}

function run(seed: number): void {
  const w = setup(seed);
  for (let i = 0; i < 250; i++) step(w);
  settle(w);
  for (const c of w.clients) {
    seen.resyncs += c.resyncs;
    seen.resets += c.resets;
    seen.resumes += c.lives - c.resets;
    seen.drifts += c.drifts;
    for (const t of w.subs.get(c) as Set<Topic>) {
      assert.deepEqual(view(c.map, t), view(w.store.rows, t), `seed ${seed}: client ${c.name}, topic ${t} (cursor ${c.client.cursor}, head ${w.store.seq})`);
    }
  }
}

test('any interleaving leaves every client equal to the store', () => {
  for (let seed = 1; seed <= 400; seed++) run(seed);
  // every path was taken, and no op ever failed to apply (a drift heals itself, so it would hide a bug)
  assert.ok(seen.resyncs > 100 && seen.resumes > 500 && seen.resets > 500, JSON.stringify(seen));
  assert.equal(seen.drifts, 0);
});
