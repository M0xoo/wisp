// Projects in your own order (#drag to reorder): the order they show in everywhere
// (web/js/project-order.js) and PUT /projects/order, which stores it as each project's `order`.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { tmp } from './helpers.js';

process.env.WISP_HOME = tmp('project-order-home');
process.env.WISP_UPDATE_CHECK = '0';

const { startServer } = await import('../server/index.js');
const { byOrder, moved, recentFirst } = await import('../web/js/project-order.js');

let srv;
let base;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
async function call(p, body, method) {
  const r = await fetch(`${base}/api${p}`, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

test('never dragged: most recent first; dragged: that order, with any added since first', () => {
  const a = { id: 'a', addedAt: 1 };
  const b = { id: 'b', addedAt: 2, lastUsedAt: 9 };
  const c = { id: 'c', addedAt: 3 };
  assert.deepEqual([a, b, c].sort(recentFirst).map((p) => p.id), ['b', 'c', 'a']);
  assert.deepEqual([a, b, c].sort(byOrder).map((p) => p.id), ['b', 'c', 'a']);
  const ordered = [{ ...a, order: 0 }, { ...b, order: 2 }, { ...c, order: 1 }];
  assert.deepEqual(ordered.sort(byOrder).map((p) => p.id), ['a', 'c', 'b']);
  const added = { id: 'd', addedAt: 4 };
  assert.deepEqual([...ordered, added].sort(byOrder).map((p) => p.id), ['d', 'a', 'c', 'b']);
});

test('moved: before or after another, and the same list back when nothing moves', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moved(ids, 'd', 'a'), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moved(ids, 'a', 'c', true), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moved(ids, 'b', 'd', true), ['a', 'c', 'd', 'b']);
  assert.equal(moved(ids, 'b', 'c'), ids, 'just before the next one is where it is');
  assert.equal(moved(ids, 'b', 'a', true), ids, 'just after the one before is where it is');
  assert.equal(moved(ids, 'b', 'b'), ids);
  assert.equal(moved(ids, 'x', 'a'), ids);
});

test('PUT /projects/order stores the order; left out or [] goes back to recent', async () => {
  const dirs = ['one', 'two', 'three'].map((n) => {
    const d = path.join(tmp('project-order-dirs'), n);
    fs.mkdirSync(d, { recursive: true });
    return d;
  });
  const ps = [];
  for (const d of dirs) ps.push((await call('/projects', { path: d })).json);
  const [one, two, three] = ps.map((p) => p.id);
  let r = await call('/projects/order', { ids: [three, one, two] }, 'PUT');
  assert.equal(r.status, 200);
  const order = async () => Object.fromEntries((await call('/projects')).json.map((p) => [p.id, p.order]));
  assert.deepEqual(await order(), { [three]: 0, [one]: 1, [two]: 2 });
  r = await call('/projects/order', { ids: [two, one] }, 'PUT');
  assert.deepEqual(await order(), { [two]: 0, [one]: 1, [three]: undefined });
  await call('/projects/order', { ids: [] }, 'PUT');
  assert.deepEqual(await order(), { [one]: undefined, [two]: undefined, [three]: undefined });
  assert.equal((await call('/projects/order', { ids: 'nope' }, 'PUT')).status, 400);
});
