// The integration surface: the public HTTP additions (health, discovery file, OpenAPI, wait,
// presentation, filters, webhooks), the client SDK, the `wisp mcp` server and the scripting CLI,
// all against a real wisp server driving the fake harnesses.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { installFakeBins, makeRepo, tmp, until } from './helpers.js';

const HOME = tmp('int-home');
process.env.WISP_HOME = HOME;
process.env.FAKE_RECORD = tmp('int-record');
installFakeBins();

const BIN = fileURLToPath(new URL('../bin/wisp.js', import.meta.url));
const { startServer } = await import('../server/index.js');
const { WispClient, discover } = await import('../server/client.js');
const { blocksToMarkdown } = await import('../server/render.js');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let srv;
let port;
let wisp;
before(async () => {
  port = await freePort();
  srv = await startServer({ port, handleSignals: false });
  wisp = new WispClient({ port });
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

test('health, server.json discovery and the OpenAPI document', async () => {
  const h = await wisp.health();
  assert.equal(h.ok, true);
  assert.equal(h.pid, process.pid);
  assert.equal(h.apiVersion, 1);
  const info = JSON.parse(fs.readFileSync(path.join(HOME, 'server.json'), 'utf8'));
  assert.equal(info.port, port);
  assert.equal(discover().port, port);
  const spec = await wisp.request('GET', '/openapi.json');
  assert.equal(spec.openapi, '3.1.0');
  for (const p of ['/sessions', '/sessions/{id}/wait', '/sessions/{id}/presentation', '/sessions/{id}/reply', '/sessions/{id}/revert', '/sessions/{id}/rollback', '/sessions/{id}/exec']) assert.ok(spec.paths[p], p);
});

test('client: launch → wait → presentation as blocks and markdown; filters', async () => {
  const cwd = makeRepo();
  const s = await wisp.launch({ prompt: 'fix add()', cwd, agent: 'claude', mode: 'edits' });
  const done = await wisp.wait(s.id, { timeoutMs: 20_000 });
  assert.equal(done.state, 'review');
  assert.equal(done.timedOut, false);
  const p = await wisp.presentation(s.id);
  assert.equal(p.status, 'done');
  assert.equal(p.blocks[0].title, 'Fake claude finished');
  assert.match(p.markdown, /^## Fake claude finished/);
  assert.ok(p.changes.some((c) => c.file === 'math.js'));
  assert.ok(p.checkpoint?.commit, 'turn checkpoint captured');
  const md = await (await wisp.request('GET', `/sessions/${s.id}/presentation?format=markdown`, undefined, { raw: true })).text();
  assert.equal(md, p.markdown);

  assert.ok((await wisp.sessions({ cwd })).every((x) => x.id === s.id));
  assert.equal((await wisp.sessions({ cwd, state: 'running' })).length, 0);
  assert.equal((await wisp.sessions({ limit: 1 })).length, 1);
});

test('client: file revert/restore, turn checkpoint rollback/restore, and action command execution', async () => {
  const cwd = makeRepo();
  const s = await wisp.launch({ prompt: 'fix add()', cwd, agent: 'claude', mode: 'edits', worktree: false });
  await wisp.wait(s.id, { timeoutMs: 20_000 });
  const full = await wisp.session(s.id);
  const turn = full.turns[0];
  assert.ok(turn.checkpoint?.commit);
  assert.equal(turn.checkpoint.dirty, true);
  assert.match(fs.readFileSync(path.join(cwd, 'math.js'), 'utf8'), /return a \+ b;/);

  // Single-file revert restores pre-turn file content (including uncommitted line)
  const rev = await wisp.revert(s.id, 'math.js', { turnId: turn.id });
  assert.equal(rev.reverted, true);
  assert.equal(fs.readFileSync(path.join(cwd, 'math.js'), 'utf8'), 'export function add(a, b) {\n  return a - b;\n}\n// uncommitted\n');
  assert.equal((await wisp.presentation(s.id)).changes.find((c) => c.file === 'math.js').reverted, true);

  // Re-apply single file change
  const reapplied = await wisp.revert(s.id, 'math.js', { turnId: turn.id, restore: true });
  assert.equal(reapplied.reverted, false);
  assert.match(fs.readFileSync(path.join(cwd, 'math.js'), 'utf8'), /return a \+ b;/);

  // Simulate an untracked file created during the turn, then roll back the whole turn to checkpoint
  fs.writeFileSync(path.join(cwd, 'extra-turn-file.txt'), 'created in turn\n');
  const rb = await wisp.rollback(s.id, { turnId: turn.id });
  assert.equal(rb.rolledBack, true);
  assert.equal(fs.readFileSync(path.join(cwd, 'math.js'), 'utf8'), 'export function add(a, b) {\n  return a - b;\n}\n// uncommitted\n');
  assert.equal(fs.existsSync(path.join(cwd, 'extra-turn-file.txt')), false, 'untracked file created after pre-turn checkpoint is removed');

  // Re-apply the turn changes
  const unrb = await wisp.rollback(s.id, { turnId: turn.id, restore: true });
  assert.equal(unrb.rolledBack, false);
  assert.match(fs.readFileSync(path.join(cwd, 'math.js'), 'utf8'), /return a \+ b;/);

  // Execute an actionable block command in the session's project directory
  const runOk = await wisp.exec(s.id, 'node -e "console.log(2 + 2)"', { turnId: turn.id });
  assert.equal(runOk.exitCode, 0);
  assert.equal(runOk.output.trim(), '4');
});

test('wait returns when the agent asks; reply answers it', async () => {
  const s = await wisp.launch({ prompt: 'ASK first', cwd: makeRepo(), agent: 'codex', mode: 'edits' });
  const w = await wisp.wait(s.id, { timeoutMs: 20_000 });
  assert.equal(w.state, 'waiting');
  assert.equal(w.question, 'Proceed with the fix?');
  assert.match((await wisp.presentation(s.id)).markdown, /waiting for your answer:\*\* Proceed with the fix\?/);
  assert.deepEqual(await wisp.reply(s.id, 'Yes'), { answered: true });
  const done = await wisp.wait(s.id, { timeoutMs: 20_000 });
  assert.equal(done.state, 'review');
  assert.match(done.preview, /The user answered: Yes/);
});

test('wait times out while still running', async () => {
  process.env.FAKE_HANG = '1';
  try {
    const s = await wisp.launch({ prompt: 'long', cwd: makeRepo(), agent: 'claude' });
    const w = await wisp.request('GET', `/sessions/${s.id}/wait?timeout=1`);
    assert.equal(w.timedOut, true);
    assert.equal(w.state, 'running');
    await wisp.stop(s.id);
  } finally {
    delete process.env.FAKE_HANG;
  }
});

test('webhooks get session.finished with the markdown', async () => {
  const got = [];
  const hook = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c)).on('end', () => (got.push(JSON.parse(b)), res.end()));
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(wisp.updateConfig({ webhooks: ['ftp://nope'] }), /Not an http/);
    await wisp.updateConfig({ webhooks: [{ url: `http://127.0.0.1:${hook.address().port}/x`, events: ['session.finished'] }] });
    const s = await wisp.launch({ prompt: 'hook me', cwd: makeRepo(), agent: 'opencode' });
    const ev = await until(() => got.find((e) => e.session.id === s.id));
    assert.equal(ev.event, 'session.finished');
    assert.match(ev.markdown, /Fake opencode finished/);
  } finally {
    await wisp.updateConfig({ webhooks: [] });
    hook.close();
  }
});

test('wisp mcp: tools/list, launch with wait, list', async () => {
  const child = spawn(process.execPath, [BIN, 'mcp'], { cwd: makeRepo(), env: { ...process.env, WISP_PORT: String(port) }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    pending.get(m.id)?.(m);
  });
  let n = 0;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = ++n;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    assert.equal(init.result.serverInfo.name, 'wisp');
    const { result } = await rpc('tools/list', {});
    assert.deepEqual(result.tools.map((t) => t.name), ['wisp_launch', 'wisp_list', 'wisp_get', 'wisp_wait', 'wisp_reply', 'wisp_stop', 'wisp_agents']);
    const launched = await rpc('tools/call', { name: 'wisp_launch', arguments: { prompt: 'fix it', agent: 'claude', wait: true, timeout_seconds: 20 } });
    const text = launched.result.content[0].text;
    assert.ok(!launched.result.isError, text);
    assert.match(text, /state: \*\*review\*\*/);
    assert.match(text, /## Fake claude finished/);
    const listed = await rpc('tools/call', { name: 'wisp_list', arguments: { limit: 3 } });
    assert.match(listed.result.content[0].text, /Fake claude finished/);
    const bad = await rpc('tools/call', { name: 'wisp_get', arguments: { id: 'nope' } });
    assert.equal(bad.result.isError, true);
  } finally {
    child.kill();
  }
});

const cli = (args, env = {}) => promisify(execFile)(process.execPath, [BIN, ...args], { env: { ...process.env, ...env } });

test('cli: launch --wait --json, ls --json, show, reply', async () => {
  const cwd = makeRepo();
  const { stdout } = await cli(['--port', String(port), '--cwd', cwd, '--agent', 'claude', '--wait', '--json', 'fix', 'add()']);
  const s = JSON.parse(stdout);
  assert.equal(s.state, 'review');
  assert.equal(s.presentation.blocks[0].title, 'Fake claude finished');
  const list = JSON.parse((await cli(['ls', '--json', '--port', String(port), '--cwd', cwd])).stdout);
  assert.deepEqual(list.map((x) => x.id), [s.id]);
  // --state=x is --state x, needs is review + waiting, archived only with --all, a typo is refused.
  const ls = async (...a) => JSON.parse((await cli(['ls', '--json', '--port', String(port), '--cwd', cwd, ...a])).stdout).map((x) => x.id);
  assert.deepEqual(await ls('--state=review'), [s.id]);
  assert.deepEqual(await ls('--state', 'needs'), [s.id]);
  assert.deepEqual(await ls('--state', 'done'), []);
  await wisp.update(s.id, { archived: true });
  assert.deepEqual(await ls('--state', 'review'), []);
  assert.deepEqual(await ls('--state', 'review', '--all'), [s.id]);
  await wisp.update(s.id, { archived: false });
  await assert.rejects(cli(['ls', '--port', String(port), '--state', 'reviw']), (e) => /unknown state reviw/.test(e.stderr));
  assert.match((await cli(['show', s.id, '--port', String(port)])).stdout, /## Fake claude finished/);
  assert.match((await cli(['reply', s.id, 'and', 'a', 'test', '--wait', '--port', String(port)])).stdout, /Fake claude finished/);
  assert.equal((await wisp.session(s.id)).turns.length, 2);
});

test('cli: skill prints and installs for every harness', async () => {
  const home = tmp('skill-home');
  const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: '', CODEX_HOME: '' };
  assert.match((await cli(['skill'], env)).stdout, /^---\r?\nname: wisp/);
  await cli(['skill', 'install', '--agent', 'all'], env);
  for (const p of [['.claude', 'skills'], ['.codex', 'skills'], ['.config', 'opencode', 'skill']]) assert.ok(fs.existsSync(path.join(home, ...p, 'wisp', 'SKILL.md')), p.join('/'));
});

test('render: every block type becomes markdown; diffs come from captured edits', () => {
  const turn = { changes: [{ file: 'src/a.js', op: 'edit', edits: [{ before: 'a\nb\n', after: 'a\nc\n' }] }] };
  const blocks = [
    { type: 'hero', title: 'T', summary: 'S', status: 'partial' },
    { type: 'markdown', text: 'hi' },
    { type: 'steps', items: [{ title: 'x', status: 'failed' }] },
    { type: 'stats', items: [{ label: 'n', value: 3 }] },
    { type: 'files', items: [{ path: 'a', change: 'added' }] },
    { type: 'tree', items: [{ path: 'a' }] },
    { type: 'diff', file: 'a.js' },
    { type: 'code', code: 'x ``` y', language: 'js' },
    { type: 'tests', command: 'npm t', passed: 1, failed: 1, failures: [{ name: 'f' }] },
    { type: 'commits', items: [{ hash: 'abcdef123', message: 'm' }] },
    { type: 'graph', title: 'PR', into: 'main', merge: 'conflict', commits: [{ hash: 'd29f50', message: 'tests', branch: 'feat' }, { hash: '5be27d', message: 'rotate', branch: 'main', conflict: true }], conflicts: [{ file: 'src/auth.ts', line: 42, ours: 'a', theirs: 'b' }] },
    { type: 'terminal', command: 'ls', output: 'o', exitCode: 2 },
    { type: 'compare', before: { items: ['a'] }, after: { items: ['b'] } },
    { type: 'flow', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    { type: 'chart', items: [{ label: 'x', value: 1 }], unit: 'ms' },
    { type: 'checklist', items: [{ text: 't', done: true }] },
    { type: 'callout', tone: 'warn', title: 'c', text: 'x' },
    { type: 'image', path: 'p.png' },
    { type: 'question', question: 'q?', options: [{ label: 'y' }] },
    { type: 'actions', title: 'Verify', items: [{ label: 'Run tests', command: 'npm test', detail: 'suite' }] },
    { type: 'next', items: ['n'] },
    { type: 'unknown', x: 1 },
  ];
  const md = blocksToMarkdown(blocks, turn);
  for (const s of ['## T', '🟡 Partly done', '```diff\n a\n-b\n+c', '````js\nx ``` y\n````', '1 passed, 1 failed', '`abcdef1` m', '⚠️ `5be27d` rotate [main]', '`src/auth.ts:42`', '[exit 2]', 'A → B', '- [x] t', '> **⚠️ c**', '1. y', '**Run tests** — `$ npm test` (suite)', '"type": "unknown"']) assert.ok(md.includes(s), s);
});
