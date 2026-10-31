// The page's files (server/http/static.js): kept in memory, compressed, revalidated by ETag, and
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

// Compressed on the thread pool after the first read: plain until it's ready.
async function compressed(path, ae, enc) {
  for (let i = 0; i < 100; i++) {
    const r = await get(path, { 'accept-encoding': ae });
    if (r.headers['content-encoding'] === enc) return r;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`${path} never came ${enc}`);
}

test('text is gzipped for browsers that take it, plain for those that don’t', async () => {
  const plain = await get('/css/base.css');
  const gz = await compressed('/css/base.css', 'gzip, deflate', 'gzip');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(gz.headers.vary, 'accept-encoding');
  assert.ok(gz.body.length < plain.body.length);
  assert.equal(zlib.gunzipSync(gz.body).toString(), plain.body.toString());
});

test('text goes brotli’d to a browser that takes it, once it’s compressed', async () => {
  const plain = await get('/css/split.css');
  const br = await compressed('/css/split.css', 'gzip, deflate, br', 'br');
  assert.equal(zlib.brotliDecompressSync(br.body).toString(), plain.body.toString());
  const gz = await compressed('/css/split.css', 'gzip, deflate', 'gzip');
  assert.ok(br.body.length < gz.body.length);
});

test('index.html preloads every module app.js imports and names its build', async () => {
  const graph = moduleGraph();
  assert.ok(graph.includes('/js/app.js'));
  assert.ok(graph.includes('/js/core/state.js'));
  assert.ok(!graph.includes('/js/features/spell-actions.js'), 'dynamic imports load when used');
  const r = await get('/');
  const html = r.body.toString();
  for (const u of graph) assert.match(html, new RegExp(`<link rel="modulepreload" href="${u}\\?v=[\\w-]+">`), u);
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

test('index.html names scripts and styles by content, and those URLs are cached for good', async () => {
  const html = (await get('/')).body.toString();
  const map = JSON.parse(/<script type="importmap">([^<]*)<\/script>/.exec(html)[1]).imports;
  // Every module, dynamic imports too: they import each other by plain paths.
  assert.match(map['/js/app.js'], /^\/js\/app\.js\?v=[\w-]+$/);
  assert.match(map['/js/features/spell-actions.js'], /\?v=/);
  assert.ok(html.indexOf('type="importmap"') < html.indexOf('rel="modulepreload"'), 'the map comes before any module loads');
  assert.ok(html.includes(`<script type="module" src="${map['/js/app.js']}">`));
  const css = /href="(\/css\/base\.css\?v=[\w-]+)"/.exec(html)[1];
  const kept = await get(css);
  assert.equal(kept.status, 200);
  assert.equal(kept.headers['cache-control'], 'public, max-age=31536000, immutable');
  // A stale or made-up version isn't this content: asked about every time, as without one.
  assert.equal((await get('/css/base.css?v=old')).headers['cache-control'], 'no-cache');
  assert.equal((await get('/css/base.css')).headers['cache-control'], 'no-cache');
});

test('the service worker is served, and paths outside web/ are not', async () => {
  const sw = await get('/sw.js');
  assert.equal(sw.status, 200);
  assert.match(sw.body.toString(), /wisp-shell/);
  const escape = await get('/../package.json');
  assert.match(escape.headers['content-type'], /text\/html/);
});

// The API's JSON (server/http/respond.js): big answers go compressed to a client that asks for it.
test('big JSON answers are brotli’d or gzipped when the client takes it, small ones and others go plain', async () => {
  const { send } = await import('../server/http/respond.js');
  const big = { items: Array.from({ length: 2000 }, (_, i) => ({ id: i, title: `task ${i}` })) };
  const api = http.createServer((req, res) => send(res, 200, req.url === '/big' ? big : { ok: true }));
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${api.address().port}`;
  const raw = (path, headers) =>
    new Promise((resolve, reject) => {
      http
        .request(`${at}${path}`, { headers }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
        })
        .on('error', reject)
        .end();
    });
  try {
    const br = await raw('/big', { 'accept-encoding': 'gzip, deflate, br' });
    assert.equal(br.headers['content-encoding'], 'br');
    assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(br.body)), big);
    const gz = await raw('/big', { 'accept-encoding': 'gzip, deflate' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.ok(br.body.length < gz.body.length);
    assert.equal(gz.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(zlib.gunzipSync(gz.body)), big);
    assert.ok(gz.body.length < JSON.stringify(big).length / 3);
    const plain = await raw('/big', {});
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.deepEqual(JSON.parse(plain.body), big);
    const small = await raw('/small', { 'accept-encoding': 'gzip' });
    assert.equal(small.headers['content-encoding'], undefined);
    assert.deepEqual(JSON.parse(small.body), { ok: true });
  } finally {
    api.close();
  }
});
