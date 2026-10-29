// Watch (server/watch.js): the page an agent keeps beside its task while it works, through
// wisp_watch. What the agent can send, what the page and other machines see, and the sealed
// document the page runs in (web/js/watch-doc.js).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { installFakeBins, makeRepo, tmp, until } from './helpers.js';
import { watchDoc } from '../web/js/watch-doc.js';
import { WATCH_MAX_STATE } from '../server/watch.js';

process.env.WISP_HOME = tmp('watch-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.WISP_NO_OPEN = '1';
process.env.FAKE_RECORD = tmp('watch-rec');
installFakeBins();
const { startServer } = await import('../server/index.js');
const { systemPrompt } = await import('../server/protocol.js');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

let srv;
let base;
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

async function api(p, body, method = body ? 'POST' : 'GET', headers = {}) {
  const r = await fetch(`${base}/api${p}`, { method, headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${p}: ${j.error}`), { status: r.status });
  return j;
}
const task = async (prompt, cwd = makeRepo()) => {
  const s = await api('/sessions', { prompt, cwd, agent: 'claude', worktree: false });
  await until(async () => (await api(`/sessions/${s.id}`)).state !== 'running' && !srv.runner.live.has(s.id));
  return s;
};
const summary = async (id) => (await api('/sessions')).find((x) => x.id === id);

test('wisp_watch: open, state, caption, reload, close; the summary moves, the page reads it all', async () => {
  const s = await task('migrate the files');
  const token = { 'x-wisp-token': srv.token };
  const watch = (body) => api('/internal/watch', { session: s.id, ...body }, 'POST', token);
  await assert.rejects(api(`/sessions/${s.id}/watch`), /nothing to watch/);
  await assert.rejects(watch({ action: 'state', state: { done: 1 } }), /open.*first/);
  await assert.rejects(watch({ action: 'open', title: 'x' }), /html .* or path/);

  const html = '<!doctype html><html><body><div id="bar"></div><script>wisp.on("state", (s) => (bar.textContent = s.done))</script></body></html>';
  const opened = await watch({ action: 'open', title: 'TS migration', html, state: { done: 0, total: 40 }, run: { command: 'npm test', cwd: '.', note: 're-runs on save' } });
  assert.match(opened.text, /Opened “TS migration”/);
  const sum = await summary(s.id);
  assert.deepEqual(sum.watch, { title: 'TS migration', caption: '', seq: 1, rev: 1 }, 'the summary says it is there');
  const turn = srv.store.get(s.id).turns.at(-1);
  assert.ok(turn.activity.some((a) => a.kind === 'watch' && a.label === 'Opened Watch: TS migration'), 'a line in the task’s activity');

  let doc = await api(`/sessions/${s.id}/watch`);
  assert.equal(doc.html, html);
  assert.deepEqual(doc.state, { done: 0, total: 40 });
  assert.equal(doc.run.command, 'npm test');
  assert.equal(doc.run.cwd, srv.store.get(s.id).cwd, 'the run folder is resolved against the task’s');
  assert.equal(doc.run.note, 're-runs on save');

  // A state moves seq, not rev: the frame gets it without reloading.
  await watch({ action: 'state', state: { done: 12 }, merge: true, caption: 'Converting auth/ (12 of 40)' });
  doc = await api(`/sessions/${s.id}/watch`);
  assert.deepEqual(doc.state, { done: 12, total: 40 }, 'merged into the last state');
  assert.equal(doc.caption, 'Converting auth/ (12 of 40)');
  assert.deepEqual([doc.seq, doc.rev], [2, 1]);
  await watch({ action: 'state', state: { done: 13 } });
  assert.deepEqual((await api(`/sessions/${s.id}/watch`)).state, { done: 13 }, 'replaced without merge');
  await assert.rejects(watch({ action: 'state', state: { big: 'x'.repeat(WATCH_MAX_STATE) } }), /larger than 64 KB/);

  await watch({ action: 'caption', caption: '  Running   the tests  ' });
  assert.equal((await summary(s.id)).watch.caption, 'Running the tests');

  // Reopening replaces the page (rev moves) and doesn't add another activity line.
  await watch({ action: 'open', title: 'TS migration', html: '<p>v2</p>' });
  doc = await api(`/sessions/${s.id}/watch`);
  assert.equal(doc.html, '<p>v2</p>');
  assert.equal(doc.rev, 2);
  assert.equal(srv.store.get(s.id).turns.at(-1).activity.filter((a) => a.kind === 'watch').length, 1);

  await watch({ action: 'close', caption: 'All 40 converted' });
  const closed = await summary(s.id);
  assert.equal(closed.watch.closed, true);
  assert.equal(closed.watch.caption, 'All 40 converted');
  assert.equal((await api(`/sessions/${s.id}/watch`)).html, '<p>v2</p>', 'the page stays to look back at');
  await assert.rejects(watch({ action: 'dance' }), /action must be/);
  assert.equal((await fetch(`${base}/api/internal/watch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: s.id, action: 'close' }) })).status, 403);

  // Deleting the task takes the page wisp kept with it.
  const file = srv.store.get(s.id).watch.file;
  assert.ok(fs.existsSync(file));
  await api(`/sessions/${s.id}`, undefined, 'DELETE');
  assert.ok(!fs.existsSync(file));
});

test('wisp_watch: a page the agent wrote, by path, read again on reload', async () => {
  const cwd = makeRepo();
  const s = await task('run the benchmarks', cwd);
  const token = { 'x-wisp-token': srv.token };
  const watch = (body) => api('/internal/watch', { session: s.id, ...body }, 'POST', token);
  fs.mkdirSync(path.join(cwd, 'progress'));
  fs.writeFileSync(path.join(cwd, 'progress', 'index.html'), '<p>one</p>');
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'x');
  await assert.rejects(watch({ action: 'open', path: 'nope.html' }), /No such file/);
  await assert.rejects(watch({ action: 'open', path: 'notes.txt' }), /\.html file/);
  await watch({ action: 'open', path: 'progress', title: 'Bench' });
  assert.equal((await api(`/sessions/${s.id}/watch`)).html, '<p>one</p>', 'a folder gives its index.html');
  fs.writeFileSync(path.join(cwd, 'progress', 'index.html'), '<p>two</p>');
  await watch({ action: 'reload' });
  const doc = await api(`/sessions/${s.id}/watch`);
  assert.equal(doc.html, '<p>two</p>');
  assert.equal(doc.rev, 2);
  fs.rmSync(path.join(cwd, 'progress'), { recursive: true });
  assert.match((await api(`/sessions/${s.id}/watch`)).problem, /gone/);
});

test('an agent watched end to end: wisp_watch through the injected MCP server, a state per file', async () => {
  const s = await task('Convert the project to TypeScript. WATCH');
  const sum = await summary(s.id);
  assert.equal(sum.watch.title, 'TS migration');
  assert.equal(sum.watch.closed, true);
  assert.equal(sum.watch.caption, 'All 6 files converted');
  assert.deepEqual([sum.watch.rev, sum.watch.seq], [1, 8], 'opened once, six states, closed');
  const doc = await api(`/sessions/${s.id}/watch`);
  assert.equal(doc.state.done, 6);
  assert.equal(doc.run.command, 'npx tsc --noEmit');
  assert.match(doc.html, /wisp\.on\('state'/);
});

test('wisp_watch is offered to agents unless Settings → Watch agents work is off', async () => {
  assert.match(systemPrompt({ watch: true }), /wisp_watch/);
  assert.doesNotMatch(systemPrompt({ watch: false }), /wisp_watch/);
  assert.doesNotMatch(systemPrompt({ ask: 'no tools here', watch: true }), /wisp_watch/, 'not where wisp’s tools aren’t');

  const list = async (env) => {
    const p = spawn(process.execPath, [path.resolve('server/mcp-ask.js')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
    const lines = readline.createInterface({ input: p.stdout });
    const got = new Promise((resolve) => lines.once('line', (l) => resolve(JSON.parse(l))));
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    const { result } = await got;
    p.kill();
    return result.tools.map((t) => t.name);
  };
  assert.ok((await list({ WISP_WATCH: '1' })).includes('wisp_watch'));
  assert.ok(!(await list({ WISP_WATCH: '' })).includes('wisp_watch'));
});

test('watchDoc: wisp’s CSP and bridge come before the agent’s page', () => {
  const doc = watchDoc('<!DOCTYPE html><html><head><script src="https://cdn.jsdelivr.net/npm/chart.js"></script></head><body>hi</body></html>', { vars: { '--ink': '#111' }, scheme: 'dark', state: { a: '</script>' } });
  assert.ok(doc.startsWith('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"'), 'the policy first');
  assert.equal(doc.match(/<!doctype/gi).length, 1, 'the page’s own doctype goes');
  assert.match(doc, /connect-src 'none'/, 'it can’t fetch or send');
  assert.match(doc, /script-src 'unsafe-inline' https:/, 'scripts from a CDN load');
  assert.match(doc, /--ink:#111/);
  assert.match(doc, /color-scheme:dark/);
  assert.ok(!doc.includes('"</script>"'), 'state can’t close the bridge’s script');
  assert.ok(doc.indexOf('window.wisp') < doc.indexOf('chart.js'), 'wisp is there before the page’s scripts run');
});
