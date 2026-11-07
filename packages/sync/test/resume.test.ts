// Resuming topics subscribed while the hello was in flight, and starting a drifted topic over:
// both end to end through the real server, framing and client.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncClient } from '../src/client.ts';
import type { ClientMessage } from '@wisp/protocol';
import type { ClientOutput } from '../src/types.ts';
import { FakeStore, PEER, Sim, SimClient, makeServer, view } from './harness.ts';

const sent = (outs: ClientOutput[]): ClientMessage[] => outs.flatMap((o) => (o.kind === 'send' ? [o.message] : []));

test('a topic subscribed during the hello resumes from its cursor when the store already holds it', () => {
  const c = new SyncClient({ peer: 'laptop', clientId: 'tab', build: 'b', saved: { epoch: 'E1', cursor: 42, synced: ['list', 'session:a'], pending: [] } });
  c.handle({ kind: 'subscribe', topic: 'list' }, 0);
  c.handle({ kind: 'open' }, 0);
  c.handle({ kind: 'subscribe', topic: 'session:a' }, 0); // the view mounted a tick after the open
  c.handle({ kind: 'subscribe', topic: 'session:b' }, 0); // never held: it can only start fresh
  const outs = c.handle({ kind: 'frame', id: 42, messages: [{ t: 'welcome', epoch: 'E1', head_seq: 50, oldest_seq: 0, resume: true, proto: 2, peer: PEER }] }, 0);
  assert.deepEqual(sent(outs), [{ t: 'sub', topic: 'session:a', since: 42 }, { t: 'sub', topic: 'session:b' }]);
  // its ops apply at once: the store holds it as of the cursor
  const ops = c.handle({ kind: 'frame', id: 43, messages: [{ t: 'patch', seq: 43, ops: [{ topic: 'session:a', e: 't', id: '1', op: 'upsert', v: 1 }, { topic: 'session:b', e: 't', id: '1', op: 'upsert', v: 1 }] }] }, 0);
  assert.deepEqual(ops.flatMap((o) => (o.kind === 'entityOps' ? o.ops.map((x) => x.topic) : [])), ['session:a']);
  assert.deepEqual(c.save().synced.sort(), ['list', 'session:a']);
});

test('without a resume, a topic subscribed during the hello starts fresh', () => {
  const c = new SyncClient({ peer: 'laptop', clientId: 'tab', build: 'b', saved: { epoch: 'E1', cursor: 42, synced: ['session:a'], pending: [] } });
  c.handle({ kind: 'open' }, 0);
  c.handle({ kind: 'subscribe', topic: 'session:a' }, 0);
  const outs = c.handle({ kind: 'frame', id: 60, messages: [{ t: 'welcome', epoch: 'E2', head_seq: 60, oldest_seq: 0, resume: false, proto: 2, peer: PEER }] }, 0);
  assert.deepEqual(sent(outs), [{ t: 'sub', topic: 'session:a' }]);
});

test('end to end: a restored client that subscribes after open takes a delta, not the whole topic', () => {
  const store = new FakeStore();
  const rows = Array.from({ length: 50 }, (_, i) => ({ topic: 'session:a' as const, e: 'event', id: `e${i}`, op: 'upsert' as const, v: { text: `step ${i}` } }));
  store.commit(rows);
  const sim = new Sim(store, makeServer(store));
  // a phone that saw everything up to now, then restarted (rows and cursor from IndexedDB)
  const before = new SimClient('phone');
  const clients = [before];
  before.client.handle({ kind: 'subscribe', topic: 'session:a' }, sim.now);
  sim.open(before, clients);
  sim.tick(100, clients);
  const saved = before.client.save();
  sim.lose(before, clients);
  store.commit([{ topic: 'session:a', e: 'event', id: 'e3', op: 'set', v: { text: 'edited' } }]);
  const phone = new SimClient('phone');
  phone.client = new SyncClient({ peer: 'laptop', clientId: 'phone', build: 'test', saved });
  phone.map = before.map;
  sim.requests = [];
  sim.open(phone, [phone]);
  sim.client_(phone, phone.client.handle({ kind: 'subscribe', topic: 'session:a' }, sim.now), [phone]);
  sim.tick(100, [phone]);
  assert.deepEqual(sim.requests.map((r) => [r.topic, r.since]), [['session:a', saved.cursor]]);
  assert.deepEqual(view(phone.map, 'session:a'), view(store.rows, 'session:a'));
  assert.ok(sim.bytes < 3000, `a delta, not 50 rows again (${sim.bytes} B on the wire in all)`);
});

test('drifted: a row the client store lost makes the next patch fail; the topic starts over and heals', () => {
  const store = new FakeStore();
  store.commit([{ topic: 'list', e: 'session', id: 's1', op: 'upsert', v: { title: 'one' } }, { topic: 'list', e: 'session', id: 's2', op: 'upsert', v: { title: 'two' } }]);
  const sim = new Sim(store, makeServer(store));
  const c = new SimClient('tab');
  c.client.handle({ kind: 'subscribe', topic: 'list' }, sim.now);
  sim.open(c, [c]);
  sim.tick(100, [c]);
  c.map.get('list')?.delete('session\u0000s1'); // the client store lost a row (a bug, an eviction)
  sim.requests = [];
  sim.commit([{ topic: 'list', e: 'session', id: 's1', op: 'set', v: { title: 'uno' } }], [c]);
  sim.tick(100, [c]);
  assert.equal(c.drifts, 1);
  assert.deepEqual(sim.requests.map((r) => [r.topic, r.since]), [['list', null]], 'a full snapshot: the copy is not trusted');
  assert.deepEqual(view(c.map, 'list'), view(store.rows, 'list'));
  // and the topic keeps streaming after it
  sim.tick(100, [c]);
  sim.commit([{ topic: 'list', e: 'session', id: 's2', op: 'set', v: { title: 'dos' } }], [c]);
  sim.tick(100, [c]);
  assert.deepEqual(view(c.map, 'list'), view(store.rows, 'list'));
  assert.equal(c.drifts, 1);
});
