import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Notice, Topic } from '@wisp/protocol';
import { createEntityStore } from '../src/entities.ts';
import { compareVersions, hasFeature } from '../src/features.ts';
import { entityKey, peerId } from '../src/ids.ts';
import { createPeers } from '../src/peers.ts';
import { createScope } from '../src/scope.ts';
import { PeerDown } from '../src/transport.ts';
import { fakeTimers, type FakeTimers, fakeTransport, peerInfo, tick, welcome } from './helpers.ts';

const A = peerId('laptop');

let clockNow: FakeTimers | undefined; // the running test's clock
/** lets streams deliver and zero-delay timers (a peer's first open) run */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    clockNow?.advance(0);
    await tick();
  }
}

async function setup() {
  const clock = fakeTimers(1_700_000_000_000);
  clockNow = clock;
  const scope = createScope('test', clock);
  const { reader, writer } = createEntityStore();
  const peers = createPeers({ scope, writer, clientId: 'c1', build: 'test' });
  const t = fakeTransport();
  return { clock, scope, reader, writer, peers, t, conn: () => t.connections.at(-1) };
}

// ---------- features come from the peer ----------

test('hasFeature answers from the welcome, with a reason when the peer lacks it', () => {
  const info = peerInfo({ name: 'studio-mac', plugins: [{ id: 'wisp.crew', version: '2.3.0', commands: ['crew.hire'], topics: ['crew'], blocks: ['crew.card'] }] });
  assert.deepEqual(hasFeature(info, { plugin: 'wisp.crew', command: 'crew.hire' }), { ok: true });
  assert.deepEqual(hasFeature(info, { plugin: 'wisp.crew', minVersion: '2.4', label: 'Crew' }), { ok: false, reason: 'Crew needs wisp.crew 2.4 on studio-mac' });
  assert.deepEqual(hasFeature(info, { plugin: 'wisp.crew', command: 'crew.fire', label: 'Firing' }), { ok: false, reason: 'Firing needs a newer wisp.crew on studio-mac' });
  assert.deepEqual(hasFeature(info, { plugin: 'wisp.crew', block: 'crew.card' }), { ok: true });
  assert.deepEqual(hasFeature(info, { plugin: 'acme.thing', label: 'Thing' }), { ok: false, reason: "Thing isn't installed on studio-mac" });
  assert.deepEqual(hasFeature(undefined, { plugin: 'wisp.crew' }, 'studio-mac'), { ok: false, reason: "studio-mac hasn't connected yet" });
});

test('compareVersions: numeric parts, missing parts are zero, a pre-release sorts first', () => {
  assert.equal(compareVersions('2.10.0', '2.9.9'), 1);
  assert.equal(compareVersions('2.4', '2.4.0'), 0);
  assert.equal(compareVersions('2.4.0-rc.1', '2.4.0'), -1);
  assert.equal(compareVersions('v3', '2.99'), 1);
});

test('the peer manager learns features from the welcome', async () => {
  const { peers, t, conn } = await setup();
  peers.add({ peer: A, name: 'laptop', transport: t });
  await settle();
  assert.equal(peers.hasFeature(A, { plugin: 'wisp.runtime' }).ok, false, 'before the welcome');
  conn()?.push(welcome());
  await settle();
  assert.equal(peers.status(A)().kind, 'online');
  assert.deepEqual(peers.hasFeature(A, { plugin: 'wisp.runtime', command: 'session.rename' }), { ok: true });
  assert.equal(peers.info(A)()?.version, '2.0.0');
});

// ---------- status ----------

test('a peer outside the protocol window is incompatible, and says which side to update', async () => {
  for (const [range, update, reason] of [
    [{ proto_min: 1, proto_max: 1 }, 'peer', 'Update wisp on studio-mac'],
    [{ proto_min: 9, proto_max: 9 }, 'app', 'Update the app to use studio-mac'],
  ] as const) {
    const { peers, t, conn, clock } = await setup();
    peers.add({ peer: A, name: 'laptop', transport: t });
    await settle();
    conn()?.push(welcome({}, { ...range, name: 'studio-mac' }));
    await settle();
    assert.deepEqual(peers.status(A)(), { kind: 'incompatible', reason, update });
    clock.advance(600_000);
    await settle();
    assert.equal(t.connections.length, 1, 'no retries against an incompatible peer');
  }
});

test('an unreachable peer says why and is retried with backoff', async () => {
  const { peers, t, conn, clock } = await setup();
  peers.add({ peer: A, name: 'laptop', transport: t });
  await settle();
  conn()?.end(new Error('ECONNREFUSED'));
  await settle();
  assert.deepEqual(peers.status(A)(), { kind: 'unreachable', reason: 'ECONNREFUSED' });
  clock.advance(499);
  await settle();
  assert.equal(t.connections.length, 1);
  clock.advance(1);
  await settle();
  assert.equal(t.connections.length, 2);
  conn()?.push(welcome());
  await settle();
  assert.equal(peers.status(A)().kind, 'online');
});

test('a sleeping box stays asleep: no retries, a passive watch does not wake it, opening its task does', async () => {
  const { peers, t, clock, scope } = await setup();
  t.failNext = new PeerDown('asleep', 'asleep');
  peers.add({ peer: A, name: 'box', transport: t });
  await settle();
  assert.equal(peers.status(A)().kind, 'asleep');
  clock.advance(600_000);
  await settle();
  assert.equal(t.connections.length, 0, 'not retried');
  peers.watch(A, 'list', scope, { passive: true });
  await settle();
  assert.equal(t.wakes, 0, 'a passive subscription never counts as use');
  peers.watch(A, 'session:s1', scope);
  await settle();
  assert.equal(t.wakes, 1);
  assert.equal(peers.status(A)().kind, 'waking');
  t.connections.at(-1)?.push(welcome());
  await settle();
  assert.equal(peers.status(A)().kind, 'online');
});

test('a command for a sleeping box wakes it', async () => {
  const { peers, t } = await setup();
  t.failNext = new PeerDown('asleep', 'asleep');
  peers.add({ peer: A, name: 'box', transport: t });
  await settle();
  peers.mutate(A, { mid: 'm1', cmd: 'session.followUp', args: {} });
  await settle();
  assert.equal(t.wakes, 1);
  t.connections.at(-1)?.push(welcome());
  await settle();
  assert.deepEqual(t.posted.filter((m) => m.t === 'mutate').map((m) => (m.t === 'mutate' ? m.mid : '')), ['m1']);
});

// ---------- subscriptions ----------

test('two views of one task share one subscription; the last to go ends it', async () => {
  const { peers, t, conn, scope } = await setup();
  peers.add({ peer: A, name: 'laptop', transport: t });
  await settle();
  conn()?.push(welcome());
  await settle();
  const topic: Topic = 'session:s1';
  const v1 = scope.child('view1');
  const v2 = scope.child('view2');
  peers.watch(A, topic, v1);
  peers.watch(A, topic, v2);
  const subs = () => t.posted.filter((m) => m.t === 'sub' && m.topic === topic).length;
  const unsubs = () => t.posted.filter((m) => m.t === 'unsub' && m.topic === topic).length;
  assert.equal(subs(), 1);
  v1.dispose();
  assert.equal(unsubs(), 0);
  v2.dispose();
  assert.equal(unsubs(), 1);
});

test('frames reach the store, rows from every peer side by side, notices reach their listeners', async () => {
  const { peers, scope, reader } = await setup();
  const notices: Notice[] = [];
  peers.onNotice((_p, n) => notices.push(n));
  const boxes = ['laptop', 'box'].map((name) => {
    const t = fakeTransport();
    peers.add({ peer: peerId(name), name, transport: t });
    peers.watch(peerId(name), 'list', scope);
    return t;
  });
  await settle();
  for (const [i, t] of boxes.entries()) {
    t.connections[0]?.push(welcome({}, { peer: i === 0 ? 'laptop' : 'box' }));
    await settle();
    t.connections[0]?.frame(3, { t: 'snapshot', topic: 'list', seq: 3, rows: [{ e: 'session', id: 's1', v: { from: i } }] });
  }
  boxes[1]?.connections[0]?.push({ t: 'notice', kind: 'toast', data: { text: 'done' } });
  await settle();
  assert.deepEqual(reader.peek('session', entityKey(peerId('laptop'), 's1')), { from: 0 });
  assert.deepEqual(reader.peek('session', entityKey(peerId('box'), 's1')), { from: 1 });
  assert.equal(reader.list('session')().length, 2);
  assert.deepEqual(notices.map((n) => n.kind), ['toast']);
  assert.equal(peers.save(peerId('box'))?.cursor, 3, 'the cursor to persist is the last frame id');
});

test('removing a peer ends its connection and its scope', async () => {
  const { peers, t, conn } = await setup();
  peers.add({ peer: A, name: 'laptop', transport: t });
  await settle();
  peers.remove(A);
  assert.equal(conn()?.aborted, true);
  assert.deepEqual(peers.list()(), []);
  peers.add({ peer: A, name: 'again', transport: t }); // a removed peer can come back
  assert.throws(() => peers.add({ peer: A, name: 'x', transport: t }), /twice/);
});
