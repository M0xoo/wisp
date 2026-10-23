// Pictures and videos in a reply: kept in ~/.wisp/shots, streamed with Range so the player can
// seek, and shown in their folder.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, tmp } from './helpers.js';

process.env.WISP_HOME = tmp('media-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.WISP_NO_OPEN = '1';
installFakeBins();
const { startServer } = await import('../server/index.js');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let srv;
let base;
const project = tmp('media-project');
const outside = tmp('media-outside');
const clip = path.join(outside, 'demo.mp4');
const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));

before(async () => {
  fs.writeFileSync(clip, bytes);
  fs.writeFileSync(path.join(outside, 'secret.mp4'), bytes);
  const port = await freePort();
  srv = await startServer({ port, handleSignals: false });
  base = `http://127.0.0.1:${port}`;
  const turn = { id: 't1', status: 'done', presentation: { blocks: [{ type: 'video', path: clip, caption: 'Demo' }] } };
  const s = { id: 'media1', title: 'Media', cwd: project, agent: 'claude', state: 'idle', turns: [turn], createdAt: Date.now(), updatedAt: Date.now() };
  srv.store.keepImages(s, turn);
  srv.store.put(s);
});
after(() => {
  srv.shutdown();
  srv.server.close();
});

const file = (p, headers) => fetch(`${base}/api/sessions/media1/file?path=${encodeURIComponent(p)}`, { headers });
const reveal = (p) => fetch(`${base}/api/sessions/media1/reveal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) });

test('a video block is copied into shots, and the original stays its source', () => {
  const b = srv.store.get('media1').turns[0].presentation.blocks[0];
  assert.equal(b.source, clip);
  assert.ok(b.path.includes(`${path.sep}shots${path.sep}`), b.path);
  assert.deepEqual(fs.readFileSync(b.path), bytes);
});

test('a video plays from its original path, whole or in ranges', async () => {
  const whole = await file(clip);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'video/mp4');
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.equal(Buffer.from(await whole.arrayBuffer()).length, 1000);

  const part = await file(clip, { range: 'bytes=100-199' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 100-199/1000');
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(100, 200));

  const open = await file(clip, { range: 'bytes=900-' });
  assert.equal(open.status, 206);
  assert.equal(open.headers.get('content-range'), 'bytes 900-999/1000');
  await open.arrayBuffer();

  const tail = await file(clip, { range: 'bytes=-10' });
  assert.equal(tail.headers.get('content-range'), 'bytes 990-999/1000');
  await tail.arrayBuffer();

  const past = await file(clip, { range: 'bytes=5000-' });
  assert.equal(past.status, 416);
  await past.arrayBuffer();
});

test('files no block names, outside the project, are refused', async () => {
  const r = await file(path.join(outside, 'secret.mp4'));
  assert.equal(r.status, 404);
  await r.arrayBuffer();
  const rv = await reveal(path.join(outside, 'secret.mp4'));
  assert.equal(rv.status, 404);
  await rv.arrayBuffer();
});

test('Show in folder reveals where the agent saved it, then wisp’s copy once that’s gone', async () => {
  let r = await reveal(clip);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).path, clip);
  fs.rmSync(clip);
  r = await reveal(clip);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).path, srv.store.get('media1').turns[0].presentation.blocks[0].path);
});
