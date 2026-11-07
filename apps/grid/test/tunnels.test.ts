// tunnels.ts: the grid's end of a computer's tunnel. A session's 'close' comes a while after
// destroy() (once its socket has closed, slower on Windows); a keep-alive ping that fires in
// between must not throw from its timer, where nothing catches it and the grid would go down.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createTunnels, hostOnly } from '../src/tunnels.ts';

// A connected pair on loopback: the grid's side is the accepted socket.
async function pair(): Promise<{ socket: net.Socket; client: net.Socket; done: () => Promise<void> }> {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const accepted = new Promise<net.Socket>((r) => server.once('connection', r));
  const a = server.address();
  const client = net.connect(typeof a === 'object' && a ? a.port : 0, '127.0.0.1');
  client.on('error', () => {});
  const socket = await accepted;
  socket.on('error', () => {});
  return { socket, client, done: () => (client.destroy(), socket.destroy(), new Promise<void>((r) => server.close(() => r()))) };
}

test('a ping due between destroy() and close: skipped, not thrown from the timer', async (t) => {
  const { socket, done } = await pair();
  t.after(done);
  mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => mock.timers.reset());
  const changes: [string, boolean][] = [];
  const tunnels = createTunnels({ onChange: (id, on) => changes.push([id, on]) });
  tunnels.accept('c1', socket);
  assert.ok(tunnels.online('c1'));
  assert.deepEqual(changes, [['c1', true]]);
  // grid.close() (and a computer that hung up, or reconnected) destroys the session; its 'close'
  // hasn't come yet when the 25 s ping is due.
  tunnels.closeAll();
  assert.doesNotThrow(() => mock.timers.tick(25_000));
  assert.doesNotThrow(() => mock.timers.tick(25_000));
});

test('a computer that reconnects: the old tunnel’s ping stops with it', async (t) => {
  const a = await pair();
  const b = await pair();
  t.after(() => Promise.all([a.done(), b.done()]));
  mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => mock.timers.reset());
  const tunnels = createTunnels();
  tunnels.accept('c1', a.socket);
  tunnels.accept('c1', b.socket); // the new one wins; the old session is destroyed
  assert.doesNotThrow(() => mock.timers.tick(25_000));
  assert.ok(tunnels.online('c1'));
  tunnels.closeAll();
  assert.doesNotThrow(() => mock.timers.tick(25_000));
});

test('hostOnly: a cookie with Domain= is dropped, the rest kept', () => {
  assert.deepEqual(hostOnly(['a=1; Path=/', 'b=2; Domain=wisp.localhost', 'c=3;domain =x']), ['a=1; Path=/']);
  assert.deepEqual(hostOnly('a=1'), ['a=1']);
  assert.deepEqual(hostOnly(undefined), []);
});

test('offline: forward, ask and upgrade say so instead of throwing', async () => {
  const tunnels = createTunnels();
  assert.equal(tunnels.online('nope'), false);
  assert.equal(await tunnels.ask('nope', { path: '/x' }), null);
  assert.equal(tunnels.since('nope'), null);
});
