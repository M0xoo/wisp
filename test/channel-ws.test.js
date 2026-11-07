// The WebSocket client against a server written by hand (test/fixtures/fake-slack.mjs), on loopback:
// each test sends exact bytes and waits on what the client does with them, never on a clock.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openWs } from '../server/channels/ws.js';
import { acceptKey, acceptUpgrades, frame, readFrames } from './fixtures/fake-slack.mjs';

let servers = [];
afterEach(() => {
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
  servers = [];
});

// → { url, socket(): the next connection, as { socket, frames(n) } }
async function serve(opts) {
  const server = http.createServer();
  servers.push(server);
  const waiting = [];
  const ready = [];
  acceptUpgrades(server, (socket) => {
    const state = {};
    const seen = [];
    const wanted = [];
    socket.on('data', (d) => {
      seen.push(...readFrames(state, d));
      while (wanted[0] && seen.length >= wanted[0].n) {
        const w = wanted.shift();
        w.done(seen.splice(0, w.n));
      }
    });
    const c = { socket, frames: (n) => new Promise((done) => (seen.length >= n ? done(seen.splice(0, n)) : wanted.push({ n, done }))) };
    if (waiting.length) waiting.shift()(c);
    else ready.push(c);
  }, opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `ws://127.0.0.1:${server.address().port}/x?ticket=abc`, next: () => (ready.length ? Promise.resolve(ready.shift()) : new Promise((r) => waiting.push(r))) };
}
const closed = (ws) => new Promise((r) => ws.once('close', (code, reason) => r({ code, reason })));
const message = (ws) => new Promise((r) => ws.once('message', r));
async function connect(opts) {
  const s = await serve();
  const [ws, c] = await Promise.all([openWs(s.url, opts), s.next()]);
  return { ws, c };
}

test('text both ways; what the client sends is masked; lengths of every size', async () => {
  const { ws, c } = await connect();
  for (const n of [5, 125, 126, 65535, 65536]) {
    const text = 'x'.repeat(n);
    const got = message(ws);
    c.socket.write(frame(1, text));
    assert.equal((await got).length, n);
    ws.send(text);
    const [f] = await c.frames(1); // readFrames throws on a frame with no mask
    assert.equal(f.payload.toString(), text);
  }
  ws.destroy();
});

test('a frame in pieces, byte by byte, is still one frame', async () => {
  const { ws, c } = await connect();
  const got = message(ws);
  for (const byte of frame(1, 'héllo wörld')) c.socket.write(Buffer.from([byte]));
  assert.equal(await got, 'héllo wörld');
  ws.destroy();
});

test('fragmented frames make one message, with a ping between them, and a character cut in two', async () => {
  const { ws, c } = await connect();
  const got = message(ws);
  const bytes = Buffer.from('aé');
  c.socket.write(Buffer.concat([frame(1, bytes.subarray(0, 2), { fin: false }), frame(9, 'between'), frame(0, bytes.subarray(2), { fin: false }), frame(0, 'c')]));
  assert.equal(await got, 'aéc');
  const [pong] = await c.frames(1);
  assert.equal(pong.op, 10);
  assert.equal(pong.payload.toString(), 'between');
  ws.destroy();
});

test('ping: answered with the same bytes; and a pong to ours is heard', async () => {
  const { ws, c } = await connect();
  c.socket.write(frame(9, 'are you there'));
  const [f] = await c.frames(1);
  assert.deepEqual([f.op, f.payload.toString()], [10, 'are you there']);
  const heard = new Promise((r) => ws.once('pong', r));
  ws.ping('hi');
  const [p] = await c.frames(1);
  assert.equal(p.op, 9);
  c.socket.write(frame(10, p.payload));
  assert.equal((await heard).toString(), 'hi');
  ws.destroy();
});

test('an oversized frame is refused by its header, with a 1009, before any of it arrives', async () => {
  const { ws, c } = await connect({ maxFrame: 1024 });
  const end = closed(ws);
  c.socket.write(frame(1, '', { len: 2048 }));
  assert.deepEqual(await end, { code: 1009, reason: 'That frame is too big.' });
  const [f] = await c.frames(1);
  assert.equal(f.op, 8);
  assert.equal(f.payload.readUInt16BE(0), 1009);
});

test('a length past what a number holds is refused too', async () => {
  const { ws, c } = await connect();
  const end = closed(ws);
  c.socket.write(Buffer.from([0x81, 127, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
  assert.equal((await end).code, 1009);
});

test('so is a message that only grows too big in pieces', async () => {
  const { ws, c } = await connect({ maxFrame: 1024 });
  const end = closed(ws);
  c.socket.write(Buffer.concat([frame(1, 'x'.repeat(1000), { fin: false }), frame(0, 'x'.repeat(1000))]));
  assert.deepEqual(await end, { code: 1009, reason: 'That message is too big.' });
});

test('a close during a read: the frame is dropped, close fires once, 1006', async () => {
  const { ws, c } = await connect();
  let messages = 0;
  let closes = 0;
  ws.on('message', () => messages++);
  ws.on('close', () => closes++);
  const end = closed(ws);
  c.socket.write(frame(1, 'x'.repeat(1000)).subarray(0, 200));
  await new Promise((r) => c.socket.write(Buffer.alloc(0), r));
  c.socket.destroy();
  assert.equal((await end).code, 1006);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([messages, closes], [0, 1]);
  assert.equal(ws.send('too late'), false);
});

test('a reset in the middle of it all is a close, not a crash', async () => {
  const { ws, c } = await connect();
  const end = closed(ws);
  c.socket.resetAndDestroy();
  assert.equal((await end).code, 1006);
});

test('the server closes: echoed with its code, and that’s the close', async () => {
  const { ws, c } = await connect();
  const end = closed(ws);
  const body = Buffer.alloc(6);
  body.writeUInt16BE(4001, 0);
  body.write('bye!', 2);
  c.socket.write(frame(8, body));
  assert.deepEqual(await end, { code: 4001, reason: 'bye!' });
  const [f] = await c.frames(1);
  assert.deepEqual([f.op, f.payload.readUInt16BE(0)], [8, 4001]);
});

test('we close: a goodbye, then the answer ends it', async () => {
  const { ws, c } = await connect();
  const end = closed(ws);
  ws.close(1000, 'done');
  const [f] = await c.frames(1);
  assert.equal(f.payload.readUInt16BE(0), 1000);
  assert.equal(ws.open, false);
  c.socket.write(frame(8, f.payload));
  assert.equal((await end).code, 1000);
});

test('we close and nobody answers: over all the same', async () => {
  const { ws } = await connect();
  const end = closed(ws);
  ws.close();
  assert.equal((await end).code, 1000);
});

test('an abort closes it cleanly', async () => {
  const ac = new AbortController();
  const { ws, c } = await connect({ signal: ac.signal });
  const end = closed(ws);
  ac.abort();
  const [f] = await c.frames(1);
  assert.equal(f.op, 8);
  c.socket.write(frame(8, f.payload));
  assert.equal((await end).code, 1000);
});

test('an abort during the handshake rejects, and one before it never connects', async () => {
  const server = http.createServer();
  servers.push(server);
  server.on('upgrade', () => {}); // never answers
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ac = new AbortController();
  const url = `ws://127.0.0.1:${server.address().port}/`;
  const opening = openWs(url, { signal: ac.signal });
  server.once('upgrade', () => ac.abort());
  await assert.rejects(opening, /Aborted/);
  await assert.rejects(openWs(url, { signal: ac.signal }), /Aborted/);
});

test('the rules: a masked server frame, a reserved bit, a stray continuation, a long ping, bad UTF-8', async () => {
  for (const [bytes, code] of [
    [frame(1, 'x', { mask: true }), 1002],
    [frame(1, 'x', { rsv: 4 }), 1002],
    [frame(0, 'x'), 1002],
    [frame(3, 'x'), 1002],
    [Buffer.concat([frame(1, 'a', { fin: false }), frame(1, 'b')]), 1002],
    [frame(9, 'x'.repeat(126)), 1002],
    [frame(9, 'x', { fin: false }), 1002],
    [frame(1, Buffer.from([0xff, 0xfe])), 1007],
  ]) {
    const { ws, c } = await connect();
    const end = closed(ws);
    c.socket.write(bytes);
    assert.equal((await end).code, code, bytes.toString('hex').slice(0, 20));
  }
});

test('a masked frame from a server is refused for that, and nothing of it is read as a message', async () => {
  const { ws, c } = await connect();
  let heard = 0;
  ws.on('message', () => heard++);
  const end = closed(ws);
  c.socket.write(frame(1, 'x', { mask: true }));
  assert.deepEqual(await end, { code: 1002, reason: 'A server’s frames aren’t masked.' });
  assert.equal(heard, 0);
});

test('frames right behind the 101, in the same write, aren’t lost', async () => {
  const server = http.createServer();
  servers.push(server);
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => {});
    socket.write(Buffer.concat([Buffer.from(`HTTP/1.1 101 OK\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\n\r\n`), frame(1, 'first')]));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ws = await openWs(`ws://127.0.0.1:${server.address().port}/`);
  assert.equal(await message(ws), 'first');
  ws.destroy();
});

test('a bad handshake is refused, and its error never repeats the URL’s ticket', async () => {
  for (const [reply, re] of [
    [() => 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n', /answered 403/],
    [() => 'HTTP/1.1 101 OK\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n', /answered the handshake wrongly/],
    [(req) => `HTTP/1.1 101 OK\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n`, /extension/],
  ]) {
    const s = await serve({ reply });
    await assert.rejects(openWs(s.url), (err) => {
      assert.match(err.message, re);
      assert.ok(!err.message.includes('abc'), err.message);
      return true;
    });
  }
  await assert.rejects(openWs('http://127.0.0.1/'), /ws:\/\/ or wss:\/\//);
});

test('nobody home: rejected, not thrown', async () => {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  await assert.rejects(openWs(`ws://127.0.0.1:${port}/`), /Can’t reach 127\.0\.0\.1/);
});
