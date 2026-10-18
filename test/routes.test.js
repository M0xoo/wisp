// The route table and openapi.json describe the same API: every public route is documented,
// and every documented operation has a route behind it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { installFakeBins, tmp } from './helpers.js';

process.env.WISP_HOME = tmp('routes-home');
process.env.WISP_UPDATE_CHECK = '0';
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
before(async () => {
  const port = await freePort();
  srv = await startServer({ port, handleSignals: false });
  base = `http://127.0.0.1:${port}`;
});
after(() => {
  srv.shutdown();
  srv.server.close();
});

// '/sessions/:id' and '/sessions/{id}' both become '/sessions/{}'.
const shape = (p) => p.replace(/:\w+/g, '{}').replace(/\{\w+\}/g, '{}');

test('every public route is in openapi.json, and every documented operation is routed', async () => {
  const spec = await (await fetch(`${base}/api/openapi.json`)).json();
  const documented = new Set();
  for (const [p, ops] of Object.entries(spec.paths)) for (const m of Object.keys(ops)) if (m !== 'parameters') documented.add(`${m.toUpperCase()} ${shape(p)}`);
  const routes = srv.routes.list();
  const routed = new Set(routes.map((r) => `${r.method} ${shape(r.pattern)}`));
  const undocumented = routes.filter((r) => r.doc && !documented.has(`${r.method} ${shape(r.pattern)}`)).map((r) => `${r.method} ${r.pattern}`);
  const unrouted = [...documented].filter((k) => !routed.has(k));
  assert.deepEqual(undocumented, [], 'routes missing from openapi.json (document them, or mark them doc: false)');
  assert.deepEqual(unrouted, [], 'documented operations with no route');
});

test('unknown API paths and methods are 404s with a JSON error', async () => {
  for (const [method, p] of [['GET', '/nope'], ['DELETE', '/health'], ['GET', '/sessions/abc/nope']]) {
    const r = await fetch(`${base}/api${p}`, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json' } });
    assert.equal(r.status, 404, `${method} ${p}`);
    assert.ok((await r.json()).error);
  }
});

test('the web UI is served, and paths outside web/ fall back to the app', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<!doctype html>/i);
  const r = await fetch(`${base}/js/blocks.js`);
  assert.match(r.headers.get('content-type'), /javascript/);
});
