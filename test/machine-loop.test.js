// Two wisps that each list the other as a machine: two computers on one grid do, since each adds
// every other computer of the account (services/computer.js sync). One task used to echo between
// them forever, an id longer by one "@machine" on each lap (x@b@a@b…), until both fell over.
// Each wisp shows a machine's own tasks only, never the ones that machine shows from elsewhere.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { installFakeBins, tmp, until } from './helpers.js';

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

async function start() {
  process.env.WISP_HOME = tmp('loop');
  const port = await freePort();
  const srv = await startServer({ port, handleSignals: false });
  return { srv, base: `http://127.0.0.1:${port}` };
}

async function call(base, method, p, body) {
  const r = await fetch(`${base}/api${p}`, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p}: ${j.error}`);
  return j;
}

let a;
let b;
before(async () => {
  a = await start();
  b = await start();
  // Each the other's computer on a grid, as sync() would add them (here straight to its loopback).
  const link = (from, to, name) => from.srv.machines.addComputer({ url: to.base, grid: 'http://grid.test', handle: 'me', name, token: 'tok', computer: `c-${name}` }).m;
  const ma = link(a, b, 'b');
  const mb = link(b, a, 'a');
  await a.srv.machines.connect(ma.id);
  await b.srv.machines.connect(mb.id);
  await until(() => a.srv.machines.isOnline(ma.id) && b.srv.machines.isOnline(mb.id), { timeout: 20_000 });
});
after(() => {
  for (const w of [a, b]) {
    if (!w) continue;
    w.srv.machines.stop?.();
    w.srv.shutdown();
    w.srv.server.closeAllConnections?.();
    w.srv.server.close();
  }
});

test('two wisps that list each other: one task shows once on each, and stops echoing', { timeout: 60_000 }, async () => {
  const cwd = tmp('loop-proj');
  const s = await call(a.base, 'POST', '/sessions', { prompt: 'hello', cwd, agent: 'claude', worktree: false });
  await until(async () => (await call(a.base, 'GET', `/sessions/${s.id}`)).state !== 'running', { timeout: 20_000 });
  // Long enough for a few laps of the echo, had there been one.
  await new Promise((r) => setTimeout(r, 1500));
  // Real tasks only: each wisp also has its own welcome tour (agent 'wisp'), never relayed.
  const ids = async (w) => (await call(w.base, 'GET', '/sessions')).filter((x) => x.agent !== 'wisp').map((x) => x.id);
  const onA = await ids(a);
  const onB = await ids(b);
  assert.deepEqual(onA, [s.id], `A lists only its own task: ${onA.join(', ')}`);
  assert.equal(onB.length, 1, `B lists A's task once: ${onB.join(', ')}`);
  assert.match(onB[0], new RegExp(`^${s.id}@[\\w-]+$`), 'qualified once, not again per lap');
  // And nothing keeps coming: neither store grew a copy.
  assert.equal(a.srv.store.all().filter((x) => x.agent !== 'wisp').length, 1);
  assert.equal(b.srv.store.all().filter((x) => x.agent !== 'wisp').length, 0);
});

test('an older wisp that still sends its machines’ tasks: only its own show, and it’s asked for those', { timeout: 30_000 }, async () => {
  // Stands in for an older wisp on the other computer: it lists and streams a task of its own and
  // one it shows from a machine of its own (this wisp's, come back: x@<id>).
  const seen = [];
  const now = Date.now();
  const task = (id) => ({ id, title: id, agent: 'claude', state: 'idle', cwd: '/tmp', scratch: true, turns: 1, updatedAt: now });
  const old = http.createServer((req, res) => {
    seen.push(req.url);
    const json = (v) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(v)));
    if (req.url === '/api/health') return json({ ok: true, version: '0.43.0', pid: 1 });
    if (req.url === '/api/agents') return json([]);
    if (req.url === '/api/config') return json({ home: '/tmp' });
    if (req.url.startsWith('/api/sessions')) return json([task('own000000001'), task('mine00000001@zz')]);
    if (req.url === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const t of [task('mine00000001@zz'), task('own000000002')]) res.write(`event: summary\ndata: ${JSON.stringify(t)}\n\n`);
      res.write(`event: activity\ndata: ${JSON.stringify({ sessionId: 'mine00000001@zz', text: 'echo' })}\n\n`);
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise((r) => old.listen(0, '127.0.0.1', r));
  const relayed = [];
  const page = new AbortController();
  const events = await fetch(`${a.base}/api/events`, { signal: page.signal });
  (async () => {
    const dec = new TextDecoder();
    for await (const chunk of events.body) relayed.push(dec.decode(chunk));
  })().catch(() => {});
  try {
    const m = a.srv.machines.addComputer({ url: `http://127.0.0.1:${old.address().port}`, grid: 'http://grid.test', handle: 'me', name: 'old', token: 'tok', computer: 'c-old' }).m;
    await a.srv.machines.connect(m.id);
    await until(() => a.srv.machines.isOnline(m.id), { timeout: 10_000 });
    await until(() => relayed.join('').includes(`own000000002@${m.id}`), { timeout: 10_000 });
    const list = (await call(a.base, 'GET', '/sessions')).map((x) => x.id).filter((id) => id.endsWith(`@${m.id}`));
    assert.deepEqual(list, [`own000000001@${m.id}`]); // its fresh list, without the one come back
    assert.ok(seen.some((u) => /^\/api\/sessions\?(.*&)?here=1$/.test(u)), `asked for its own tasks only: ${seen.join(' ')}`);
    assert.doesNotMatch(relayed.join(''), /mine00000001@zz/, 'the echoed task isn’t passed on');
    a.srv.machines.remove(m.id);
  } finally {
    page.abort();
    old.closeAllConnections?.();
    old.close();
  }
});

test('a machine’s events reach the page, not another wisp relaying this one', async () => {
  const { eventStream } = await import('../server/http/respond.js');
  const ev = eventStream();
  const out = { page: '', wisp: '' };
  const client = (name, headers) => {
    const req = new EventEmitter();
    req.headers = headers;
    ev.attach(req, { writeHead() {}, write: (f) => (out[name] += f) });
  };
  client('page', {});
  client('wisp', { 'x-wisp-relay': '1' });
  ev.broadcast('summary', { id: 'here00000001' });
  ev.broadcast('summary', { id: 'there0000001@m1' }, { fromMachine: true });
  assert.match(out.page, /here00000001/);
  assert.match(out.page, /there0000001@m1/);
  assert.match(out.wisp, /here00000001/);
  assert.doesNotMatch(out.wisp, /there0000001/);
});
