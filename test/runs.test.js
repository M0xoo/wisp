// Run the app (the side panel's Preview): a task's dev server from its worktree, through a real
// wisp server. PORT set, the address it prints found, the proxy that frames it with the picker,
// Stop ending the whole group, a failing command's exit code and last lines.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { alive, installFakeBins, makeClone, tmp, until } from './helpers.js';

process.env.WISP_HOME = tmp('runs-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.WISP_NO_OPEN = '1';
process.env.SHELL = '/bin/sh';
installFakeBins();

const { startServer } = await import('../server/index.js');
const { cleanLine, frameable, urlIn, withPicker } = await import('../server/runs.js');
const { runCommand } = await import('../server/worktree-setup.js');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let srv;
let base;
async function api(p, { method, body } = {}) {
  const r = await fetch(`${base}/api${p}`, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : method && method !== 'GET' ? '{}' : undefined });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${p}: ${j.error}`), { status: r.status });
  return j;
}
const settled = (id) => until(async () => ((await api(`/sessions/${id}`)).state === 'review' ? api(`/sessions/${id}`) : null));

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

// A tiny app: an HTML page with a button, on PORT, that won't be framed unless something strips that.
const APP = `
import http from 'node:http';
import fs from 'node:fs';
fs.writeFileSync('app.pid', String(process.pid));
const port = Number(process.env.PORT);
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'; img-src 'self'" });
  res.end('<!doctype html><html><head><title>t</title></head><body><main><form><button class="primary">Save</button></form></main></body></html>');
}).listen(port, () => console.log('\\x1b[32mready\\x1b[0m at http://localhost:' + port + '/'));
`;

test('run: starts in the worktree with PORT, finds its address, frames it with the picker, Stop ends it', { skip: process.platform === 'win32' && 'POSIX process groups' }, async () => {
  const repo = makeClone();
  const s = await api('/sessions', { body: { prompt: 'Fix add() so it adds', cwd: repo.dir, agent: 'claude' } });
  const done = await settled(s.id);
  const dir = done.worktree.cwd || done.worktree.path;
  fs.writeFileSync(path.join(dir, 'app.mjs'), APP);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'node app.mjs' } }));

  // Nothing running: how to run it, from package.json (a guess).
  let v = await api(`/sessions/${s.id}/run`);
  assert.equal(v.running, false);
  assert.equal(v.canRun, true);
  assert.deepEqual(v.config, { command: 'npm run dev', port: null, source: 'package.json' });

  v = await api(`/sessions/${s.id}/run`, { body: { command: 'node app.mjs' } });
  assert.equal(v.running, true);
  assert.equal(v.command, 'node app.mjs');
  assert.ok(v.port > 0);
  v = await until(async () => {
    const x = await api(`/sessions/${s.id}/run`);
    return x.ready && x.tail.includes('ready') ? x : null;
  });
  assert.equal(v.url, `http://localhost:${v.port}/`, 'the address it printed');
  assert.match(v.tail, /^ready at http:\/\/localhost:\d+\/$/m, 'colours out');
  const page = await fetch(v.url);
  assert.match(await page.text(), /<button class="primary">Save<\/button>/);

  // Through the proxy: framable, the picker's script in its head, the other CSP rules kept.
  assert.ok(v.proxyUrl);
  const viaProxy = await fetch(v.proxyUrl);
  assert.equal(viaProxy.headers.get('x-frame-options'), null);
  assert.equal(viaProxy.headers.get('content-security-policy'), "img-src 'self'");
  const html = await viaProxy.text();
  assert.match(html, /<head><script src="\/__wisp\/pick\.js"><\/script><title>/);
  const pick = await fetch(new URL('/__wisp/pick.js', v.proxyUrl));
  assert.match(pick.headers.get('content-type'), /javascript/);
  assert.match(await pick.text(), /postMessage/);

  // A second POST leaves it running; restart is a new one.
  assert.equal((await api(`/sessions/${s.id}/run`, { body: { command: 'node app.mjs' } })).startedAt, v.startedAt);

  const pid = Number(fs.readFileSync(path.join(dir, 'app.pid'), 'utf8'));
  assert.ok(alive(pid));
  const stopped = await api(`/sessions/${s.id}/run`, { method: 'DELETE' });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.running, false);
  assert.equal(stopped.stopped, true);
  await until(() => !alive(pid), { what: 'the app gone with Stop' });
  await assert.rejects(fetch(v.url));
});

test('run: a command that fails says its exit code and last lines; refused without a folder', { skip: process.platform === 'win32' && 'POSIX shell' }, async () => {
  const repo = makeClone();
  const s = await api('/sessions', { body: { prompt: 'Fix add() so it adds', cwd: repo.dir, agent: 'claude' } });
  await settled(s.id);
  await api(`/sessions/${s.id}/run`, { body: { command: `node -e "console.log('boom'); process.exit(3)"` } });
  const v = await until(async () => {
    const x = await api(`/sessions/${s.id}/run`);
    return x.running ? null : x;
  });
  assert.equal(v.exitCode, 3);
  assert.equal(v.stopped, false);
  assert.match(v.tail, /boom/);
  // Nothing to run and nothing to guess from: a sentence that says what to do.
  await assert.rejects(api(`/sessions/${s.id}/run`, { body: {} }), (e) => e.status === 400 && /Nothing to run/.test(e.message));
  await assert.rejects(api(`/sessions/${s.id}/run`, { body: { command: 5 } }), (e) => e.status === 400);

  // A folder-less task (its scratch folder doesn't count).
  const q = await api('/sessions', { body: { prompt: 'What is 2+2?', scratch: true, agent: 'claude' } });
  await settled(q.id);
  assert.equal((await api(`/sessions/${q.id}/run`)).canRun, false);
  await assert.rejects(api(`/sessions/${q.id}/run`, { body: { command: 'node -v' } }), (e) => e.status === 409 && /no folder/.test(e.message));
  await assert.rejects(api('/sessions/nope/run'), (e) => e.status === 404);
});

test('runCommand: .wisp/worktree.json’s run and port, else a guess from package.json', () => {
  const dir = tmp('run-cfg');
  assert.equal(runCommand(dir), null);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node .' } }));
  assert.deepEqual(runCommand(dir), { command: 'npm start', port: null, source: 'package.json' });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node .', dev: 'vite' } }));
  assert.deepEqual(runCommand(dir), { command: 'npm run dev', port: null, source: 'package.json' });
  fs.mkdirSync(path.join(dir, '.wisp'));
  fs.writeFileSync(path.join(dir, '.wisp/worktree.json'), JSON.stringify({ setup: 'npm ci', run: 'pnpm dev --host', port: 5173 }));
  assert.deepEqual(runCommand(dir), { command: 'pnpm dev --host', port: 5173, source: 'config' });
  fs.writeFileSync(path.join(dir, '.wisp/worktree.json'), JSON.stringify({ port: 99999 }));
  assert.deepEqual(runCommand(dir), { command: 'npm run dev', port: null, source: 'package.json' }, 'a port out of range is ignored');
});

test('the address in a line, clean lines, framable headers, the picker tag', () => {
  assert.deepEqual(urlIn('  ➜  Local:   http://localhost:5173/'), { port: 5173, path: '/' });
  assert.deepEqual(urlIn('ready on http://0.0.0.0:3000/app.'), { port: 3000, path: '/app' });
  assert.deepEqual(urlIn('see http://127.0.0.1:8080'), { port: 8080, path: '/' });
  assert.equal(urlIn('https://example.com:443/'), null);
  assert.equal(cleanLine('\x1b[32mok\x1b[0m'), 'ok');
  assert.equal(cleanLine('10%\r50%\r100%'), '100%');
  assert.deepEqual(frameable({ 'x-frame-options': 'SAMEORIGIN', 'content-security-policy': "frame-ancestors 'self'" }), {});
  assert.deepEqual(frameable({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }), { 'content-security-policy': ["default-src 'self'"] });
  assert.equal(withPicker('<html><body>x</body></html>'), '<html><script src="/__wisp/pick.js"></script><body>x</body></html>');
  assert.equal(withPicker('hi'), '<script src="/__wisp/pick.js"></script>hi');
  assert.equal(withPicker(withPicker('<head></head>')), '<head><script src="/__wisp/pick.js"></script></head>');
});
