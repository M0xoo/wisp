// The v2 SDK against a tiny local server: commands over /api/cmd, the sync stream for wait(), types from the
// catalogue. No network beyond 127.0.0.1, no real wisp.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { SseParser, WispClient, WispError, decodeFrame, discover, generateTypes } from '../wisp-agents/client.js';

let server;
let url;
const seen = [];
let state = 'running';
let stream = null;

function handle(req, res, body) {
  seen.push({ method: req.method, url: req.url, headers: req.headers, body: body.length ? JSON.parse(body) : null });
  const json = (status, value) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  if (req.url === '/api/health') return json(200, { ok: true });
  if (req.url.startsWith('/api/events?')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    stream = res;
    // split mid-frame on purpose: the parser buffers across chunks
    res.write('event: sync\nid: 1\ndata: [{"t":"welcome"},');
    res.write('{"t":"snapshot","topic":"session:t1","seq":1,"rows":[]}]\n\n');
    return;
  }
  if (req.url === '/api/cmd') {
    const { cmd, args } = JSON.parse(body);
    if (cmd === 'runtime.get') return json(200, { ok: true, result: { id: args.id, state } });
    if (cmd === 'runtime.create') return json(200, { ok: true, result: { id: 't1', echo: args } });
    if (cmd === 'cli.catalogue') return json(200, { ok: true, result: [{ id: 'runtime.stop', plugin: 'wisp.runtime', title: 'Stop a task', readOnly: false, permission: 'runtime:stop', args: '{ id: string, clear_queue?: boolean }' }, { id: 'x.ui', plugin: 'x', readOnly: false, permission: 'x', uiOnly: 'a page' }] });
    return json(409, { ok: false, error: { code: 'conflict', message: 'It is busy.', retry: true } });
  }
  return json(404, { error: 'not found' });
}

before(async () => {
  server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => handle(req, res, Buffer.concat(parts).toString()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  stream?.end();
  server.closeAllConnections?.();
  server.close();
});

test('a command goes to /api/cmd with an idempotency key, and a refusal comes back in wisp’s words', async () => {
  const w = new WispClient({ url, token: 'tok' });
  const t = await w.run({ prompt: 'fix it', cwd: '/w' });
  assert.equal(t.id, 't1');
  const sent = seen.at(-1);
  assert.deepEqual(sent.body, { cmd: 'runtime.create', args: { cwd: '/w', prompt: 'fix it' } });
  assert.match(sent.headers['idempotency-key'], /^sdk-[0-9a-f]{24}$/);
  assert.equal(sent.headers['x-wisp-token'], 'tok');
  await assert.rejects(w.cmd('runtime.nope', {}), (e) => e instanceof WispError && e.code === 'conflict' && e.retry === true && e.status === 409 && e.message === 'It is busy.');
  await w.cmd('runtime.nope', {}, { key: 'k1' }).catch(() => {});
  assert.equal(seen.at(-1).headers['idempotency-key'], 'k1', 'the same key makes a retry one command');
});

test('wait() looks again on each change of its topic, never on a timer', async () => {
  const w = new WispClient({ url });
  state = 'running';
  const done = w.wait('t1', { timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 50));
  const ev = seen.find((s) => s.url.startsWith('/api/events?'));
  const q = new URL(ev.url, url).searchParams;
  assert.equal(q.get('fresh'), 'session:t1');
  assert.equal(q.get('proto_min'), '2');
  state = 'review';
  stream.write('event: sync\nid: 2\ndata: [{"t":"patch","seq":2,"ops":[]}]\n\n');
  const s = await done;
  assert.equal(s.state, 'review');
  assert.equal(seen.filter((x) => x.body?.cmd === 'runtime.get').length, 3, 'one look first, one per frame');
});

test('types come from the catalogue, ui-only commands left out', async () => {
  const w = new WispClient({ url });
  const d = generateTypes(await w.catalogue());
  assert.match(d, /"runtime\.stop": \{ args: \{ id: string, clear_queue\?: boolean \}; result: unknown \};/);
  assert.match(d, /\/\*\* Stop a task \*\//);
  assert.doesNotMatch(d, /x\.ui/);
});

test('SSE is parsed across chunks; only sync frames carry messages; server.json names the port', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('event: sync\r\ndata: [{"t":"we'), []);
  const [ev] = p.push('lcome"}]\r\n\r\n: ping\n\n');
  assert.deepEqual(decodeFrame(ev), [{ t: 'welcome' }]);
  assert.equal(decodeFrame({ event: 'notice', data: '[]', id: null }), null);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-sdk-'));
  assert.equal(discover(home), null);
  fs.writeFileSync(path.join(home, 'server.json'), JSON.stringify({ port: 4500, pid: 1 }));
  assert.equal(discover(home), 4500);
});
