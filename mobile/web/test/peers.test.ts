import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient, createScope, defineCommand, entityKey, peerId, type EntityKey, type Mutate } from '@wisp/client';
import { followComputers, peerOf, phonePeers, PHONE } from '../src/peers.ts';
import { fakeBridge, fakeServer, fakeTimers, grid, settle, ssh, welcome } from './helpers.ts';

test('a computer’s peer id: its wisp’s own once known, else derived from the saved entry', () => {
  assert.equal(peerOf(ssh('k3x9ab')), 'ssh-k3x9ab');
  assert.equal(peerOf(grid('acct.c1')), 'grid-acct.c1');
  assert.equal(peerOf(ssh('k3x9ab', { peer: 'studio-1f3a' })), 'studio-1f3a');
  assert.equal(peerOf(ssh('a b/c')), 'ssh-a-b-c', 'only the characters a peer id may hold');
  assert.equal(peerOf(ssh('x', { peer: 'not ok!' })), 'ssh-x', 'a bad learnt id is not used');
  assert.equal(peerOf(ssh('x', { peer: PHONE })), 'ssh-x', 'never the phone’s own home id');
});

test('phonePeers: one peer per saved computer, with its kind of transport; one wisp saved twice stays two peers', async () => {
  const bridge = fakeBridge([ssh('a', { name: 'Studio', peer: 'studio-1f3a' }), grid('cloud', { name: 'wisp Cloud' }), grid('acct.c1', { name: 'Studio (grid)', peer: 'studio-1f3a' })]);
  const peers = await phonePeers(bridge);
  assert.deepEqual(
    peers.map((p) => [p.peer, p.name, p.transport.kind]),
    [
      ['studio-1f3a', 'Studio', 'ssh'],
      ['grid-cloud', 'wisp Cloud', 'grid'],
      ['grid-acct.c1', 'Studio (grid)', 'grid'],
    ],
  );
  assert.equal(typeof peers[1]?.transport.wake, 'function', 'a grid box can be woken');
});

async function started(computers = [ssh('a'), ssh('b')]) {
  const clock = fakeTimers();
  const bridge = fakeBridge(computers);
  bridge.answers = [{ kind: 'ssh', port: 5001, token: 't', name: 'x' }];
  const srv = fakeServer();
  const client = createClient({ clientId: 'phone-1', build: 'test', home: PHONE, width: 390, timers: clock });
  const known = await bridge.list();
  await client.start(await phonePeers(bridge, known, { fetch: srv.fetch }));
  const scope = createScope('follow', clock);
  followComputers(client, bridge, scope, known, { fetch: srv.fetch });
  await settle(clock);
  return { clock, bridge, srv, client, scope };
}

test('followComputers: a computer saved in the app becomes a peer, a forgotten one goes', async () => {
  const { clock, bridge, client } = await started();
  assert.deepEqual(client.peers.list()(), ['ssh-a', 'ssh-b']);
  await bridge.save(grid('cloud'));
  await settle(clock);
  assert.deepEqual(client.peers.list()(), ['ssh-a', 'ssh-b', 'grid-cloud']);
  await bridge.forget('a');
  await settle(clock);
  assert.deepEqual(client.peers.list()(), ['ssh-b', 'grid-cloud']);
  assert.equal(client.peers.status(peerId('ssh-a'))().kind, 'unreachable');
});

test('the first welcome names the wisp: it is saved on the computer and the peer re-keys to it, once', async () => {
  const { clock, bridge, srv, client } = await started([ssh('a')]);
  srv.streams[0]?.frame(null, welcome('studio-1f3a'));
  await settle(clock);
  assert.deepEqual(bridge.saves, [{ id: 'a', peer: 'studio-1f3a' }]);
  await settle(clock);
  assert.deepEqual(client.peers.list()(), ['studio-1f3a']);
  srv.streams.at(-1)?.frame(null, welcome('studio-1f3a'));
  await settle(clock);
  assert.equal(client.peers.status(peerId('studio-1f3a'))().kind, 'online');
  assert.equal(bridge.saves.length, 1, 'known now: not saved again');
});

test('a tunnel back up skips the client’s backoff', async () => {
  const { clock, bridge, srv, client } = await started([ssh('a')]);
  srv.streams[0]?.end(); // the tunnel dropped
  await settle(clock);
  assert.equal(client.peers.status(peerId('ssh-a'))().kind, 'unreachable');
  const before = bridge.connects.length;
  bridge.emit.tunnel({ id: 'a', state: 'ready', line: '@@wisp open 2.0.0' });
  await settle(clock);
  assert.equal(bridge.connects.length, before + 1, 'connected again at once');
});

test('a disposed follower stops following', async () => {
  const { clock, bridge, client, scope } = await started([ssh('a')]);
  scope.dispose();
  await bridge.save(ssh('c'));
  await settle(clock);
  assert.deepEqual(client.peers.list()(), ['ssh-a']);
});

const followUp = defineCommand<{ id: EntityKey; text: string }>({ id: 'session.followUp', owner: (a) => a.id, optimistic: 'none' });

test('a command run while the computer is down waits, and is sent once it is back, with the same mid and the token', async () => {
  const clock = fakeTimers();
  const bridge = fakeBridge([ssh('a', { peer: 'studio-1f3a' })]);
  bridge.answers = [new Error('Timed out reaching studio:22.'), { kind: 'ssh', port: 5003, token: 'wlt_9', name: 'Studio' }];
  const srv = fakeServer();
  const client = createClient({ clientId: 'phone-1', build: 'test', home: PHONE, width: 390, timers: clock });
  await client.start(await phonePeers(bridge, undefined, { fetch: srv.fetch }));
  await settle(clock);
  const peer = peerId('studio-1f3a');
  assert.deepEqual(client.peers.status(peer)(), { kind: 'unreachable', reason: 'Timed out reaching studio:22.' });

  const done = client.commands.run(followUp, { id: entityKey(peer, 's1'), text: 'ship it' });
  await settle(clock);
  assert.equal(client.commands.pending()().length, 1);
  assert.equal(srv.requests.length, 0, 'nothing sent while it is down');

  clock.advance(30_000); // the client's retry: the tunnel is back, on port 5003
  await settle(clock);
  srv.streams[0]?.frame(null, welcome('studio-1f3a'));
  await settle(clock);
  const posts = srv.requests.filter((r) => r.method === 'POST').map((r) => ({ r, m: JSON.parse(r.body ?? '{}') as Mutate }));
  const sent = posts.find((p) => p.m.t === 'mutate');
  assert.ok(sent, 'the mutate went out after the welcome');
  assert.equal(sent.r.url, 'http://127.0.0.1:5003/api/events');
  assert.equal(sent.r.headers['authorization'], 'Bearer wlt_9');
  assert.equal(sent.m.cmd, 'session.followUp');
  assert.equal(client.commands.pending()()[0]?.mid, sent.m.mid, 'the same idempotency key');

  srv.streams[0]?.frame(4, { t: 'ack', mid: sent.m.mid, seq: 4, result: { ok: true } });
  await settle(clock);
  assert.deepEqual(await done, { ok: true });
  assert.equal(client.commands.pending()().length, 0);
});
