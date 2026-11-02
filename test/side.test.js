// /side side discussions (server/side.js, services/fork.js side) through a real wisp server: a
// read-only task of its own that reads the main task's folder, hears the main task's latest state
// with every message, keeps to Plan and is linked both ways. Plus the command in the page.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { installFakeBins, makeRepo, records, same, tmp, until } from './helpers.js';

const RECORD = tmp('side-record');
process.env.FAKE_RECORD = RECORD;
process.env.WISP_HOME = tmp('side-home');
process.env.WISP_UPDATE_CHECK = '0';
installFakeBins();

const { startServer } = await import('../server/index.js');
const { sideAsk, sidePrompt } = await import('../server/side.js');
const page = await import('../web/js/slash-text.js');

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
async function api(p, body, method) {
  const { status, json } = await call(p, body, method);
  if (status >= 400) throw new Error(`${p}: ${json.error}`);
  return json;
}
const settled = (id, n) =>
  until(async () => {
    const x = await api(`/sessions/${id}`);
    return x.turns.length === n && x.state === 'review' && x;
  });
const runs = () => records(RECORD, 'claude').filter((r) => !r.stdin.startsWith('# wisp retro'));
const flag = (r, f) => r.argv[r.argv.indexOf(f) + 1];

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

test('sideAsk reads "/side …" on the server and in the page alike; the / menu offers it in a follow-up only', () => {
  for (const f of [sideAsk, page.sideAsk]) {
    assert.equal(f('/side why sqlite?'), 'why sqlite?');
    assert.equal(f('  /SIDE  review it\n'), 'review it');
    assert.equal(f('/side'), '');
    assert.equal(f('/sidebar'), null);
    assert.equal(f('a /side'), null);
  }
  assert.deepEqual(page.slashMatches('/si').map((c) => c.name), ['side']);
  assert.ok(!page.HOME_SLASH.some((c) => c.name === 'side'), 'the new-task box has no task to talk over');
});

test('sidePrompt: the main task as it stands now, then the message; a deleted one says so', () => {
  const main = { title: 'Fix login', agent: 'claude', turns: [{ id: 'a', prompt: 'fix the login bug', status: 'running', startedAt: Date.now(), activity: [{ kind: 'edit', label: 'Edited auth.js' }], changes: [{ file: 'auth.js' }] }] };
  const p = sidePrompt(main, 'why that way?', () => 'Claude');
  assert.match(p, /## The main task now: “Fix login”[\s\S]*still running[\s\S]*Edited auth\.js[\s\S]*`auth\.js`[\s\S]*## The user, in this side discussion\n\nwhy that way\?/);
  assert.match(sidePrompt(null, 'hi'), /main task was deleted/);
});

test('a side discussion reads the main task’s work read-only, hears its latest state every message, and is linked both ways', async () => {
  const repo = makeRepo();
  const s = await api('/sessions', { prompt: 'fix add() please', cwd: repo, agent: 'claude', mode: 'auto', worktree: true });
  const main = await settled(s.id, 1);

  const side = await api(`/sessions/${s.id}/side`, { text: '/side why did it do it that way?' });
  assert.deepEqual(side.sideOf, { id: s.id, title: main.title });
  assert.equal(side.mode, 'plan');
  let full = await settled(side.id, 1);
  assert.equal(full.worktree, undefined, 'no work of its own');
  assert.equal(full.turns[0].checkpoint, null);
  assert.equal(full.turns[0].prompt, 'why did it do it that way?');
  let r = runs().at(-1);
  assert.ok(same(r.cwd, main.worktree.path), 'it reads the main task’s folder');
  assert.equal(flag(r, '--permission-mode'), 'plan');
  assert.match(flag(r, '--append-system-prompt'), /# wisp side discussion[\s\S]*Change nothing/);
  assert.match(flag(r, '--mcp-config'), /"WISP_READONLY":"1"/, 'wisp’s tools that act are left out');
  assert.match(r.stdin, /## The main task now: “[^”]+”[\s\S]*fix add\(\) please[\s\S]*## The user, in this side discussion\n\nwhy did it do it that way\?/);
  assert.deepEqual((await api(`/sessions/${s.id}`)).sides, [side.id]);
  assert.deepEqual((await api('/sessions')).find((x) => x.id === s.id).sides, [side.id]);
  assert.ok(!(await api('/projects').catch(() => [])).some?.((p) => same(p.path, main.worktree.path)), 'the worktree isn’t made a project');

  // The main task moves on: the side discussion's next message hears it. A mode switch is ignored.
  await api(`/sessions/${s.id}/reply`, { text: 'now add tests too' });
  await settled(s.id, 2);
  await api(`/sessions/${side.id}/reply`, { text: 'and the tests?', mode: 'auto' });
  full = await settled(side.id, 2);
  assert.equal(full.mode, 'plan');
  r = runs().at(-1);
  assert.equal(flag(r, '--permission-mode'), 'plan');
  assert.match(r.stdin, /now add tests too[\s\S]*## The user, in this side discussion\n\nand the tests\?/);

  // /side in the main task's follow-up box starts another; in a side discussion it's refused.
  const again = await api(`/sessions/${s.id}/reply`, { text: '/side review the tests' });
  assert.equal(again.side.sideOf.id, s.id);
  await settled(again.side.id, 1);
  assert.equal((await call(`/sessions/${side.id}/side`, { text: 'deeper' })).status, 409);
  assert.equal((await call(`/sessions/${side.id}/fork`, { prompt: 'x' })).status, 409, 'no work of its own to fork');
  assert.equal((await call(`/sessions/${side.id}/reply`, { text: '/goal tests pass' })).status, 409, 'a goal belongs on the main task');
  assert.equal((await call(`/sessions/${s.id}/side`, { text: '/side' })).status, 400);
});

test('the tour, unknown harnesses and bare messages are refused', async () => {
  const repo = makeRepo();
  const s = await api('/sessions', { prompt: 'hi', cwd: repo, agent: 'claude' });
  await settled(s.id, 1);
  assert.equal((await call(`/sessions/${s.id}/side`, { text: '  ' })).status, 400);
  assert.equal((await call(`/sessions/${s.id}/side`, { text: 'x', agent: 'nope' })).status, 400);
  assert.equal((await call('/sessions/nope/side', { text: 'x' })).status, 404);
});

test('wisp’s MCP server in a side discussion offers only the tools that read, and refuses the rest', async () => {
  const { spawn } = await import('node:child_process');
  const ask = (env, lines) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, ['server/mcp-ask.js'], { env: { ...process.env, WISP_URL: 'http://127.0.0.1:9', WISP_TOKEN: 't', WISP_SESSION: 's', ...env } });
      let out = '';
      p.stdout.on('data', (d) => {
        out += d;
        if (out.trim().split('\n').length >= lines.length) (p.kill(), resolve(out.trim().split('\n').map((l) => JSON.parse(l))));
      });
      p.stdin.write(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    });
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const launch = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wisp_launch', arguments: { prompt: 'x' } } };
  const [ro, refused] = await ask({ WISP_READONLY: '1' }, [list, launch]);
  const names = ro.result.tools.map((t) => t.name);
  for (const n of ['ask_user', 'wisp_session', 'wisp_sessions', 'wisp_blocks']) assert.ok(names.includes(n), n);
  for (const n of ['wisp_launch', 'wisp_task', 'delegate', 'wisp_crew_edit', 'wisp_save', 'wisp_pr', 'wisp_connector_add']) assert.ok(!names.includes(n), n);
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /side discussion/);
  const [all] = await ask({}, [list]);
  assert.ok(all.result.tools.some((t) => t.name === 'wisp_launch'), 'other tasks keep every tool');
});

test('nothing on a side discussion’s page changes the main task’s folder; queued follow-ups stay in Plan', async () => {
  const repo = makeRepo();
  const s = await api('/sessions', { prompt: 'fix add() please', cwd: repo, agent: 'claude', mode: 'auto', worktree: true });
  await settled(s.id, 1);
  const side = await api(`/sessions/${s.id}/side`, { text: 'what changed?' });
  await settled(side.id, 1);
  for (const [p, body, method] of [
    [`/sessions/${side.id}/changes/revert`, { path: 'math.js' }],
    [`/sessions/${side.id}/changes/stage`, { path: 'math.js' }],
    [`/sessions/${side.id}/changes/commit`, { message: 'x' }],
    [`/sessions/${side.id}/source`, { path: 'math.js', text: 'x' }, 'PUT'],
    [`/sessions/${side.id}/ship`, {}],
    [`/sessions/${side.id}/merge`, {}],
    [`/sessions/${side.id}/exec`, { command: 'touch nope' }],
    [`/sessions/${side.id}/rollback`, { restore: false }],
    [`/sessions/${side.id}/takeover`, { inline: true }],
  ]) {
    const r = await call(p, body, method);
    assert.equal(r.status, 409, p);
    assert.match(r.json.error, /side discussion only reads/, p);
  }
  // A follow-up queued behind a running turn, with a mode, still runs in Plan.
  process.env.FAKE_DELAY = '600';
  await api(`/sessions/${side.id}/reply`, { text: 'first' });
  await api(`/sessions/${side.id}/reply`, { text: 'second', queue: true, mode: 'auto' });
  delete process.env.FAKE_DELAY;
  await settled(side.id, 3);
  assert.deepEqual(runs().slice(-2).map((r) => flag(r, '--permission-mode')), ['plan', 'plan']);
  assert.equal((await api(`/sessions/${side.id}`)).turns.at(-1).mode, 'plan');
});

test('deleting a side discussion takes it off its main task; deleting the main task leaves it to read what was said', async () => {
  const repo = makeRepo();
  const s = await api('/sessions', { prompt: 'fix add() please', cwd: repo, agent: 'claude', worktree: true });
  await settled(s.id, 1);
  const a = await api(`/sessions/${s.id}/side`, { text: 'one' });
  const b = await api(`/sessions/${s.id}/side`, { text: 'two' });
  await settled(a.id, 1);
  await settled(b.id, 1);
  await api(`/sessions/${a.id}`, {}, 'DELETE');
  assert.deepEqual((await api(`/sessions/${s.id}`)).sides, [b.id]);
  await api(`/sessions/${s.id}`, {}, 'DELETE');
  const left = await api(`/sessions/${b.id}`);
  assert.equal(left.sideOf.id, s.id);
  const r = await call(`/sessions/${b.id}/reply`, { text: 'still there?' });
  assert.equal(r.status, 409, 'its folder went with the main task');
  assert.match(r.json.error, /folder is gone/);
});
