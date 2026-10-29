// Agents driving wisp through the injected MCP server (server/routes/control.js): reading what
// there is, making their own subagents on any harness or machine, starting tasks and acting on
// them, and the limits on all of it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { installFakeBins, makeRepo, tmp, until } from './helpers.js';

process.env.FAKE_RECORD = tmp('control-record');
process.env.WISP_HOME = tmp('control-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.WISP_NO_OPEN = '1';
installFakeBins();

const { startServer } = await import('../server/index.js');
const { MAX_DEPTH } = await import('../server/routes/control.js');

let srv;
let base;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function api(p, body, method = body ? 'POST' : 'GET', headers = {}) {
  const r = await fetch(`${base}/api${p}`, { method, headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${p}: ${j.error}`), { status: r.status });
  return j;
}
const internal = (p, body) => api(`/internal${p}`, body, body ? 'POST' : 'GET', { 'x-wisp-token': srv.token });
const settled = (id, turns = 1) =>
  until(async () => {
    const x = await api(`/sessions/${id}`);
    return x.turns.length === turns && x.state === 'review' && !srv.runner.live.has(id) && x;
  });
const said = (x, i = 0) => x.turns[i].presentation.blocks[0].summary;
const launch = (prompt, extra = {}) => api('/sessions', { prompt, cwd: makeRepo(), agent: 'claude', worktree: false, ...extra });

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

test('wisp_available lists harnesses, machines, projects, presets and the task itself', async () => {
  srv.store.config.machines.push({ id: 'm-avail', name: 'devbox', target: 'dev@devbox', autoConnect: false });
  srv.store.config.teams.push({ id: 'pair-x1', name: 'Pair', members: [{ name: 'codex', agent: 'codex', model: '', effort: '', use: '', count: 1 }] });
  try {
    const s = await launch('AVAILABLE');
    const text = said(await settled(s.id));
    assert.match(text, /## Harnesses on this computer - \*\*claude\*\*/);
    assert.match(text, /\*\*auto\*\*: wisp picks/);
    assert.match(text, /`m-avail` \*\*devbox\*\*: off/);
    assert.match(text, /`pair-x1` \*\*Pair\*\*: codex \(codex\)/);
    assert.match(text, new RegExp(`Task \`${s.id}\` on claude`));
    assert.match(text, /No subagents yet: delegate creates them on the fly/);
  } finally {
    srv.store.config.machines = srv.store.config.machines.filter((m) => m.id !== 'm-avail');
    srv.store.config.teams = srv.store.config.teams.filter((t) => t.id !== 'pair-x1');
  }
});

test('a lead without a team makes its own subagent with delegate; a bad harness is refused', async () => {
  const s = await launch('ADHOC please review');
  const done = await settled(s.id);
  assert.match(said(done), /### reviewer \(Codex · default model · high thinking\) — done/);
  assert.match(said(done), /- nope: Unknown harness “nope”/);
  assert.deepEqual(done.subagents.map((m) => [m.name, m.agent, m.effort]), [['reviewer', 'codex', 'high']], 'it joined the task\'s team');
  const child = await api(`/sessions/${done.children.reviewer}`);
  assert.equal(child.agent, 'codex');
  assert.equal(child.parentId, s.id);

  // Next turn: the team note names it, and delegating to the same name continues it.
  await api(`/sessions/${s.id}/reply`, { text: 'ADHOC again' });
  const again = await settled(s.id, 2);
  assert.equal(again.subagents.length, 1, 'no second reviewer');
  assert.equal(Object.keys(again.children).length, 1);
  assert.equal((await api(`/sessions/${done.children.reviewer}`)).turns.length, 2, 'the same subagent session, resumed');
});

test('a subagent named on a machine runs there (relayed); an unknown machine is refused', async () => {
  srv.store.config.machines.push({ id: 'm-box', name: 'devbox', target: 'dev@devbox', autoConnect: false });
  try {
    const s = await launch('ADHOC@devbox on the box');
    const done = await settled(s.id);
    assert.match(said(done), /Delegated: reviewer \(id/);
    const m = done.subagents[0];
    assert.deepEqual([m.agent, m.machine, m.place], ['codex', 'm-box', 'devbox']);
    const child = srv.store.get(done.children[m.name]);
    assert.equal(child.relay.machine, 'm-box', 'carried to the machine by the relay');
    srv.runner.stop(child);

    const bad = await launch('ADHOC@nowhere');
    assert.match(said(await settled(bad.id)), /- Reviewer: No machine “nowhere”/);
  } finally {
    srv.store.config.machines = srv.store.config.machines.filter((m) => m.id !== 'm-box');
  }
});

test('wisp_launch starts a task the user sees, marked as started by the asking task', async () => {
  const s = await launch('LAUNCHTASK WAIT');
  const done = await settled(s.id);
  const id = said(done).match(/`([a-z0-9]{12})` “/)?.[1];
  assert.ok(id, said(done));
  assert.match(said(done), /Started a task the user sees in wisp/);
  assert.match(said(done), /# Fake codex finished/, 'wait=true returned its report');
  const t = await api(`/sessions/${id}`);
  assert.deepEqual([t.agent, t.mode, t.cwd, t.origin.kind, t.origin.id], ['codex', 'plan', done.cwd, 'task', s.id]);
  assert.deepEqual(srv.store.get(s.id).turns[0].launched, [id]);
  assert.ok((await api('/sessions')).some((x) => x.id === id), 'listed like any task');
});

test('wisp_task follows up, renames, finishes and archives another task; never itself', async () => {
  const other = await launch('look at math.js');
  await settled(other.id);
  const s = await launch(`TASKCTL ${other.id} reply look again`);
  assert.match(said(await settled(s.id)), /task: Sent; it is working on it/);
  await settled(other.id, 2);
  assert.equal((await api(`/sessions/${other.id}`)).turns[1].prompt, 'look again');

  const run = async (text, n) => {
    await api(`/sessions/${s.id}/reply`, { text });
    return said(await settled(s.id, n), n - 1);
  };
  assert.match(await run(`TASKCTL ${other.id} rename Math review`, 2), /Renamed it “Math review”/);
  assert.equal((await api(`/sessions/${other.id}`)).title, 'Math review');
  assert.match(await run(`TASKCTL ${other.id} done`, 3), /Marked “Math review”/);
  assert.equal((await api(`/sessions/${other.id}`)).state, 'done');
  assert.match(await run(`TASKCTL ${other.id} archive`, 4), /Archived/);
  assert.equal((await api(`/sessions/${other.id}`)).archived, true);
  assert.match(await run(`TASKCTL ${other.id} wait`, 5), /task: # Math review/);
  assert.match(await run(`TASKCTL ${s.id} stop`, 6), /That is this task/);
  assert.match(await run('TASKCTL nope00000000 stop', 7), /No task `nope00000000`/);
});

test('subagents can\'t drive wisp, a chain of launches stops, and the token is required', async () => {
  const s = await launch('look at math.js', { subagents: [{ agent: 'codex' }] });
  await settled(s.id);
  const child = srv.runner.create({ prompt: 'x', cwd: s.cwd, agent: 'codex', parentId: s.id, member: 'codex' });
  await until(() => !srv.runner.live.has(child.id) && srv.store.get(child.id).state !== 'running');
  assert.match((await internal(`/launch/${child.id}`, { prompt: 'more' })).error, /A subagent can't start tasks/);
  assert.match((await internal(`/task/${child.id}`, { task: s.id, action: 'stop' })).error, /A subagent can't act on other tasks/);

  // A task started by a task started by a task…
  let x = srv.store.get(s.id);
  const made = [];
  for (let i = 0; i < MAX_DEPTH; i++) {
    const y = srv.runner.create({ prompt: 'x', cwd: s.cwd, agent: 'claude', origin: { kind: 'task', id: x.id, name: x.title } });
    made.push(y);
    x = y;
  }
  await until(() => made.every((y) => !srv.runner.live.has(y.id)));
  assert.match((await internal(`/launch/${x.id}`, { prompt: 'deeper' })).error, /levels deep/);
  assert.match((await internal(`/launch/${s.id}`, { prompt: 'x', mode: 'yolo' })).error, /mode must be/);
  assert.match((await internal(`/launch/${s.id}`, { prompt: 'x', project: 'nope' })).error, /No project “nope”/);
  assert.match((await internal(`/launch/${s.id}`, { prompt: 'x', agent: 'nope' })).error, /Unknown harness/);

  const r = await fetch(`${base}/api/internal/launch/${s.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"prompt":"x"}' });
  assert.equal(r.status, 403);
});

test('the protocol tells a lead it can drive wisp', async () => {
  const { systemPrompt } = await import('../server/protocol.js');
  assert.match(systemPrompt({ askTool: 'mcp__wisp__ask_user' }), /tasks or subagents on any harness or machine, use wisp's tools[^]*`wisp_launch`, `wisp_task`, `delegate`/);
  assert.doesNotMatch(systemPrompt({ askTool: null }), /wisp_launch/);
});
