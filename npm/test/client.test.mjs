// The SDK against a tiny local server: no network beyond 127.0.0.1, no real wisp.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { DEFAULT_PORT, WispClient, WispError, discover, parseFrame, tryProblem, tryRuns } from '../wisp-agents/client.js';

let server;
let url;
let seen; // the last request the server got

function sse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  // Split mid-frame and mid-line on purpose: the parser must buffer across chunks.
  const chunks = ['event: summary\ndata: {"id":"s1",', '"state":"running"}\n\n: comment\n\nevent: ping\n\n', 'data: line one\ndata: line two\n\n', 'event: turn\r\ndata: {"n":2}\r\n\r\n'];
  let i = 0;
  const next = () => (i < chunks.length ? res.write(chunks[i++], () => setTimeout(next, 5)) : res.end());
  next();
}

function handle(req, res, body) {
  seen = { method: req.method, url: req.url, headers: req.headers, body };
  const json = (status, value) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  if (req.url === '/api/health') return json(200, { ok: true });
  if (req.url === '/api/events') return sse(res);
  if (req.url === '/api/fail') return json(409, { error: 'It is busy.', hold: true });
  if (req.url === '/api/wire-fail') return json(400, { error: { code: 'bad_input', message: 'cwd is required', retry: false } });
  if (req.url === '/api/plain-fail') return res.writeHead(500).end('boom');
  return json(200, { ok: true, echo: true });
}

before(async () => {
  server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => handle(req, res, Buffer.concat(parts)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));
beforeEach(() => {
  seen = null;
  delete process.env.WISP_TOKEN;
});

const bodyOf = () => JSON.parse(seen.body.toString('utf8'));

test('DEFAULT_PORT is 4477', () => assert.equal(DEFAULT_PORT, 4477));

test('sends JSON with the method, path and body', async () => {
  const c = new WispClient({ url: `${url}/` });
  assert.equal(c.url, url, 'trailing slash trimmed');
  await c.update('s 1', { title: 'New' });
  assert.equal(seen.method, 'PATCH');
  assert.equal(seen.url, '/api/sessions/s 1'.replace(' ', '%20'));
  assert.equal(seen.headers['content-type'], 'application/json');
  assert.deepEqual(bodyOf(), { title: 'New' });
});

test('a body-less DELETE still sends {}; a GET sends nothing', async () => {
  const c = new WispClient({ url });
  await c.remove('abc');
  assert.equal(seen.method, 'DELETE');
  assert.deepEqual(bodyOf(), {});
  await c.health();
  assert.equal(seen.body.length, 0);
  assert.equal(seen.headers['content-type'], undefined);
});

test('sessions() builds a query from the filter, skipping empty values', async () => {
  const c = new WispClient({ url });
  await c.sessions({ state: 'running,review', archived: false, cwd: '', limit: 5, project: undefined });
  assert.equal(seen.url, '/api/sessions?state=running%2Creview&archived=false&limit=5');
  await c.sessions();
  assert.equal(seen.url, '/api/sessions');
});

test('launch() posts the resolved cwd and the given settings', async () => {
  const c = new WispClient({ url });
  await c.launch({ prompt: 'fix it', cwd: '.', agent: 'claude', mode: 'auto', model: '' });
  assert.equal(seen.url, '/api/sessions');
  const b = bodyOf();
  assert.equal(b.prompt, 'fix it');
  assert.equal(b.cwd, path.resolve('.'));
  assert.equal(b.agent, 'claude');
});

test('upload() sends the bytes as octet-stream with the name in the query', async () => {
  const c = new WispClient({ url });
  await c.upload(new Uint8Array([1, 2, 3]), { name: 'a.bin' });
  assert.equal(seen.url, '/api/uploads?name=a.bin');
  assert.equal(seen.headers['content-type'], 'application/octet-stream');
  assert.deepEqual([...seen.body], [1, 2, 3]);
});

test('an error response becomes a WispError with the status and body', async () => {
  const c = new WispClient({ url });
  const err = await c.request('GET', '/fail').catch((e) => e);
  assert.ok(err instanceof WispError);
  assert.equal(err.name, 'WispError');
  assert.equal(err.status, 409);
  assert.equal(err.message, 'It is busy.');
  assert.deepEqual(err.body, { error: 'It is busy.', hold: true });

  const wire = await c.request('GET', '/wire-fail').catch((e) => e);
  assert.equal(wire.status, 400);
  assert.equal(wire.message, 'cwd is required', 'a WireError {code, message} is read too');

  const plain = await c.request('GET', '/plain-fail').catch((e) => e);
  assert.equal(plain.status, 500);
  assert.deepEqual(plain.body, { text: 'boom' });
});

test('x-wisp-token is sent only when WISP_TOKEN is set', async () => {
  const c = new WispClient({ url });
  await c.health();
  assert.equal(seen.headers['x-wisp-token'], undefined);
  process.env.WISP_TOKEN = 'tok-123';
  await c.health();
  assert.equal(seen.headers['x-wisp-token'], 'tok-123');
});

test('ping() and connect() find a running server; connect({start:false}) refuses a dead one', async () => {
  assert.equal(await new WispClient({ url }).ping(), true);
  const c = await WispClient.connect({ url, start: false });
  assert.equal(c.url, url);
  const dead = await WispClient.connect({ url: 'http://127.0.0.1:1', start: false }).catch((e) => e);
  assert.ok(dead instanceof WispError);
  assert.equal(dead.status, 0);
});

test('discover() reads server.json and ignores one whose pid is dead', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-home-'));
  try {
    assert.equal(discover(home), null, 'no file');
    fs.writeFileSync(path.join(home, 'server.json'), JSON.stringify({ pid: process.pid, port: 5123 }));
    assert.deepEqual(discover(home), { pid: process.pid, port: 5123 });
    // A pid that just exited is as dead as a pid can be on this machine.
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    fs.writeFileSync(path.join(home, 'server.json'), JSON.stringify({ pid: Number(gone.stdout), port: 5124 }));
    assert.equal(discover(home), null);
    fs.writeFileSync(path.join(home, 'server.json'), '{not json');
    assert.equal(discover(home), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('events() parses SSE frames split across chunks', async () => {
  const c = new WispClient({ url });
  const got = [];
  for await (const e of c.events()) got.push(e);
  assert.deepEqual(got, [
    { event: 'summary', data: { id: 's1', state: 'running' } },
    { event: 'message', data: null },
    { event: 'ping', data: null },
    { event: 'message', data: 'line one\nline two' },
    { event: 'turn', data: { n: 2 } },
  ]);
});

test('parseFrame accepts data: with or without the space', () => {
  assert.deepEqual(parseFrame('event:x\ndata:{"a":1}'), { event: 'x', data: { a: 1 } });
});

test('tryRuns and tryProblem keep the v1 rules', () => {
  assert.deepEqual(tryRuns(['subagents=task,skills=off']), { subagentModel: '', skills: 'off' });
  assert.throws(() => tryRuns(['nope=1']), /--try subagents/);
  assert.match(tryProblem({ agent: 'auto' }), /needs --agent/);
  assert.equal(tryProblem({ agent: 'claude' }), null);
});
