// The page's files (server/http/static.js): kept in memory, gzipped, revalidated by ETag, and
// index.html preloads the module graph and names its build for the phone's service worker.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { moduleGraph, serveStatic } from '../server/http/static.js';

let server;
let base;
before(async () => {
  server = http.createServer((req, res) => serveStatic(req, res, new URL(req.url, 'http://x').pathname));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// Raw, so the test sees content-encoding and 304s the way the browser does.
const get = (path, headers = {}, method = 'GET') =>
  new Promise((resolve, reject) => {
    http
      .request(`${base}${path}`, { method, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on('error', reject)
      .end();
  });

test('files carry an ETag and an unchanged one costs a 304', async () => {
  const a = await get('/js/app.js');
  assert.equal(a.status, 200);
  assert.match(a.headers['content-type'], /javascript/);
  assert.equal(a.headers['cache-control'], 'no-cache');
  assert.ok(a.headers.etag);
  const b = await get('/js/app.js', { 'if-none-match': a.headers.etag });
  assert.equal(b.status, 304);
  assert.equal(b.body.length, 0);
});

test('text is gzipped for browsers that take it, plain for those that don’t', async () => {
  const plain = await get('/css/base.css');
  const gz = await get('/css/base.css', { 'accept-encoding': 'gzip, deflate' });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(gz.headers.vary, 'accept-encoding');
  assert.ok(gz.body.length < plain.body.length);
  assert.equal(zlib.gunzipSync(gz.body).toString(), plain.body.toString());
});

test('index.html preloads every module app.js imports and names its build', async () => {
  const graph = moduleGraph();
  assert.ok(graph.includes('/js/app.js'));
  assert.ok(graph.includes('/js/core/state.js'));
  assert.ok(!graph.includes('/js/features/spell-actions.js'), 'dynamic imports load when used');
  const r = await get('/');
  const html = r.body.toString();
  for (const u of graph) assert.ok(html.includes(`<link rel="modulepreload" href="${u}">`), u);
  const build = r.headers['x-wisp-build'];
  assert.ok(build);
  assert.ok(html.includes(`<meta name="wisp-build" content="${build}">`));
  assert.equal(r.headers.etag, `"${build}"`);
  // Every other path is the same page; HEAD is how the phone checks the build.
  const other = await get('/some/route', {}, 'HEAD');
  assert.equal(other.status, 200);
  assert.equal(other.headers['x-wisp-build'], build);
  assert.equal(other.body.length, 0);
});

test('the service worker is served, and paths outside web/ are not', async () => {
  const sw = await get('/sw.js');
  assert.equal(sw.status, 200);
  assert.match(sw.body.toString(), /wisp-shell/);
  const escape = await get('/../package.json');
  assert.match(escape.headers['content-type'], /text\/html/);
});
