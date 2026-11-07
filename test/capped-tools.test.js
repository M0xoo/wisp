// A task started from a channel at a mode cap can't escape it through wisp's own tools. Enforced at
// the /internal routes, by the session the call authenticates as (server/capped.js): the sessions
// here are started the way a channel starts them (phone.startParsed), and each call carries the
// token that session's agent was really given, read from the harness's argv.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeBins, isolateAgentConfigs, makeRepo, taskRuns, tmp, until } from './helpers.js';

const FAKE = tmp('capped-record');
process.env.FAKE_RECORD = FAKE;
process.env.WISP_HOME = tmp('capped-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.WISP_NO_OPEN = '1';
installFakeBins();
isolateAgentConfigs();

const { startServer } = await import('../server/index.js');

let srv;
let base;
let repo;
let other;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function api(p, body, method = body ? 'POST' : 'GET') {
  const r = await fetch(`${base}/api${p}`, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${p}: ${j.error}`), { status: r.status });
  return j;
}

// The harness's own copy of what wisp injected: the only way an agent learns who it is.
const wispEnvOf = (record) => {
  const at = record.argv.indexOf('--mcp-config');
  return at < 0 ? null : JSON.parse(record.argv[at + 1]).mcpServers?.wisp?.env || null;
};
const envOf = (id) => {
  const r = taskRuns(FAKE, 'claude').map(wispEnvOf).findLast((e) => e?.WISP_SESSION === id);
  assert.ok(r, `session ${id} never reached the harness`);
  return r;
};
// A call as the agent of `who` makes it.
async function as(who, p, body, method = body ? 'POST' : 'GET') {
  const r = await fetch(`${base}/api/internal${p}`, { method, headers: { 'x-wisp-token': envOf(who).WISP_TOKEN, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const words = (r) => String(r.error ?? r.text ?? '');

const settled = (id, turns = 1) =>
  until(async () => {
    const x = await api(`/sessions/${id}`);
    return x.turns.length >= turns && x.state === 'review' && !srv.runner.live.has(id) && x;
  });

// A task as a channel starts one, here at Edits.
async function capped(prompt = 'look at math.js', { cap = 'edits', fallback = 'edits', mode, agent = 'claude', cwd = repo, wait = true } = {}) {
  const project = srv.store.projectFor(cwd) || srv.store.addProject(cwd);
  const { session } = await srv.remote.phone.startParsed({ prompt, project, agent, model: '', tagged: [], notes: [], ...(mode && { mode }) }, { channel: 'slack', name: 'Slack', sender: 'U1', cap, fallback });
  return wait ? settled(session.id) : session;
}
const person = (prompt = 'look at math.js', extra = {}) => api('/sessions', { prompt, cwd: repo, agent: 'claude', worktree: false, mode: 'edits', ...extra });

const withMachine = async (fn) => {
  srv.store.config.machines.push({ id: 'm-box', name: 'devbox', target: 'dev@devbox', autoConnect: false });
  try {
    return await fn();
  } finally {
    srv.store.config.machines = srv.store.config.machines.filter((m) => m.id !== 'm-box');
  }
};

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
  srv.store.config.defaults.worktree = 'off';
  repo = makeRepo();
  other = makeRepo();
  srv.store.addProject(repo);
  srv.store.addProject(other);
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

test('a channel with a cap below Full auto marks the task; Full auto, or a task of yours, marks nothing', async () => {
  const s = await capped();
  assert.deepEqual(s.capped, { mode: 'edits' });
  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.WISP_HOME, 'sessions', `${s.id}.json`), 'utf8'));
  assert.deepEqual(onDisk.capped, { mode: 'edits' }, 'it outlives a restart');
  assert.equal((await capped('look', { cap: 'auto', fallback: 'auto' })).capped, undefined);
  assert.equal((await settled((await person()).id)).capped, undefined);
});

test('launch: above the cap is refused, whatever the harness; within it, the new task carries the cap', async () => {
  const s = await capped();
  const before = srv.store.all().length;
  for (const body of [{ mode: 'auto' }, { mode: 'auto', agent: 'auto' }, { mode: 'auto', agent: 'codex' }]) {
    const r = await as(s.id, `/launch/${s.id}`, { prompt: 'rm the world', worktree: false, ...body });
    assert.match(r.error || '', /Full auto/, JSON.stringify(body));
    assert.match(r.error, /channel/);
    assert.equal(r.ids, undefined);
  }
  assert.equal(srv.store.all().length, before, 'nothing started');

  // The user's default is Full auto: no mode asked for must not mean that.
  srv.store.config.defaults.mode = 'auto';
  const r = await as(s.id, `/launch/${s.id}`, { prompt: 'look at math.js', agent: 'claude', worktree: false });
  assert.ok(r.ids?.length, words(r));
  const child = await settled(r.ids[0]);
  assert.equal(child.mode, 'edits');
  assert.deepEqual(child.capped, { mode: 'edits' });
});

test('launch: no machine, sandbox or /sandbox; no folder or project of another; no team that gets round it', async () => {
  await withMachine(async () => {
    const s = await capped();
    const away = path.join(repo, 'door');
    fs.symlinkSync(other, away);
    srv.store.config.projects.push({ id: 'p-away', name: 'away', path: '/srv/away', machine: 'm-box' });
    srv.store.config.teams.push({ id: 'p-box', name: 'Box', members: [{ name: 'x', agent: 'codex', machine: 'm-box' }] });
    const refused = [
      [{ machine: 'devbox' }, /machine/],
      [{ machine: 'm-box' }, /machine/],
      [{ machine: 'sandbox' }, /machine|sandbox/i],
      [{ project: 'away' }, /machine/],
      [{ subagents: [{ agent: 'codex', machine: 'devbox' }] }, /machine/],
      [{ preset: 'p-box' }, /machine/],
      [{ cwd: other }, /project/],
      [{ cwd: `${repo}/../${path.basename(other)}` }, /project/],
      [{ cwd: away }, /project/],
      [{ also: [other] }, /project/],
    ];
    try {
      for (const [body, why] of refused) {
        const r = await as(s.id, `/launch/${s.id}`, { prompt: 'look', mode: 'edits', worktree: false, ...body });
        assert.match(r.error || '', why, JSON.stringify(body));
      }
      assert.match((await as(s.id, `/launch/${s.id}`, { prompt: '/sandbox try it', mode: 'edits' })).error || '', /sandbox/i);
      const here = await as(s.id, `/launch/${s.id}`, { prompt: 'look', mode: 'edits', machine: 'here', worktree: false });
      assert.ok(here.ids?.length, `this computer is fine: ${words(here)}`);
    } finally {
      srv.store.config.projects = srv.store.config.projects.filter((p) => p.id !== 'p-away');
      srv.store.config.teams = srv.store.config.teams.filter((t) => t.id !== 'p-box');
      fs.rmSync(away);
    }
  });
});

test('delegate: a subagent on a machine is refused, and nothing is sent there', async () => {
  await withMachine(async () => {
    const s = await capped('ADHOC@devbox on the box');
    const text = s.turns[0].presentation.blocks[0].summary;
    assert.match(text, /machine/);
    assert.ok(!(s.subagents || []).some((m) => m.machine), 'no member on the machine');
    assert.ok(!Object.values(s.children || {}).length, 'no child');
  });
});

test('delegate: the child gets the cap, and runs at it', async () => {
  const s = await capped('ADHOC please review');
  const child = await api(`/sessions/${s.children.reviewer}`);
  assert.deepEqual(child.capped, { mode: 'edits' });
  assert.equal(child.mode, 'edits');
});

test('delegate: a member of the crew runs the job at the cap, however it is set', async () => {
  const m = srv.crew.create({ name: 'Wren', cwd: repo, agent: 'claude', mode: 'auto', parallel: 2 });
  try {
    const lead = await capped();
    const job = await srv.runner.crewDelegate(lead, { crew: m.id, name: 'wren' }, 'look at math.js');
    assert.equal(job.mode, 'edits');
    assert.deepEqual(job.capped, { mode: 'edits' });
    await until(() => !srv.runner.live.has(job.id) && srv.store.get(job.id).state === 'done');
  } finally {
    srv.crew.remove(m);
  }
});

test('a crew job from a capped channel carries the cap, waiting in the queue too, and leaves the crew as it was', async () => {
  const m = srv.crew.create({ name: 'Ibis', cwd: repo, agent: 'claude', mode: 'auto', parallel: 1, notebook: 'as it was' });
  try {
    const p = (prompt) => ({ prompt, crew: m, tagged: [], notes: [] });
    const first = await srv.remote.phone.startParsed(p('CREWNOTE look'), { channel: 'slack', name: 'Slack', cap: 'edits', fallback: 'edits' });
    assert.deepEqual(srv.store.get(first.session.id).capped, { mode: 'edits' });
    const next = await srv.remote.phone.startParsed(p('look again'), { channel: 'slack', name: 'Slack', cap: 'edits', fallback: 'edits' });
    assert.ok(next.queued !== undefined, 'waits for a free slot');
    assert.deepEqual(m.queue.at(-1).capped, { mode: 'edits' }, 'the wait keeps it');
    await settled(first.session.id);
    assert.equal(m.notebook, 'as it was', 'a capped job writes nothing to the member');
    const after = await until(() => srv.store.all().find((x) => x.crew?.id === m.id && x.id !== first.session.id));
    assert.deepEqual(after.capped, { mode: 'edits' });
    await settled(after.id);
  } finally {
    srv.crew.remove(m);
  }
});

test('wisp_task: another task can’t be raised, or touched at all, unless this task started it', async () => {
  const theirs = await settled((await person()).id);
  const s = await capped();
  for (const body of [{ action: 'reply', text: 'do it', mode: 'auto' }, { action: 'reply', text: 'do it' }, { action: 'stop' }, { action: 'done' }, { action: 'archive' }, { action: 'rename', title: 'x' }]) {
    const r = await as(s.id, `/task/${s.id}`, { task: theirs.id, ...body });
    assert.match(r.error || '', /channel/, JSON.stringify(body));
  }
  const after = await api(`/sessions/${theirs.id}`);
  assert.equal(after.mode, 'edits');
  assert.equal(after.turns.length, 1);
  assert.equal(after.title, theirs.title);

  const started = await as(s.id, `/launch/${s.id}`, { prompt: 'look', mode: 'plan', agent: 'claude', worktree: false });
  await settled(started.ids[0]);
  assert.match((await as(s.id, `/task/${s.id}`, { task: started.ids[0], action: 'reply', text: 'again', mode: 'auto' })).error || '', /Full auto/);
  assert.match((await as(s.id, `/task/${s.id}`, { task: started.ids[0], action: 'reply', text: 'again', mode: 'edits' })).error || '', /mode/, 'nor switched within it');
  assert.equal((await api(`/sessions/${started.ids[0]}`)).mode, 'plan');
  const r = await as(s.id, `/task/${s.id}`, { task: started.ids[0], action: 'reply', text: 'look again' });
  assert.match(words(r), /Sent/, 'a follow-up to its own task still goes');
  await settled(started.ids[0], 2);
});

test('reading: wisp_session, wisp_sessions, wisp_task wait, stats and stuff keep to its project', async () => {
  const elsewhere = await settled((await person('secret plans', { cwd: other })).id);
  const neighbour = await settled((await person('look at math.js')).id);
  const s = await capped();
  const session = await as(s.id, `/session/${s.id}?of=${elsewhere.id}`);
  assert.doesNotMatch(words(session), /secret plans/);
  assert.match(words(session), /channel/);
  assert.match(words(await as(s.id, `/session/${s.id}?of=${neighbour.id}`)), new RegExp(neighbour.id), 'its own project reads as before');
  assert.doesNotMatch(words(await as(s.id, `/task/${s.id}?of=${elsewhere.id}`)), /secret plans/);

  const list = await as(s.id, `/sessions/${s.id}?limit=100`);
  assert.doesNotMatch(words(list), new RegExp(elsewhere.id));
  assert.match(words(list), new RegExp(neighbour.id));
  assert.doesNotMatch(words(await as(s.id, `/sessions/${s.id}?project=${srv.store.projectFor(other).id}`)), new RegExp(elsewhere.id));

  const mine = srv.stuff.addText('ours', { name: 'ours.md', title: 'ours', from: { session: neighbour.id, title: 'x' }, by: 'agent' });
  const theirs = srv.stuff.addText('theirs', { name: 'theirs.md', title: 'theirs', from: { session: elsewhere.id, title: 'x' }, by: 'agent' });
  const yours = srv.stuff.addText('yours', { name: 'yours.md', title: 'yours', by: 'you' });
  const stuff = words(await as(s.id, `/stuff/${s.id}`));
  assert.match(stuff, new RegExp(mine.id));
  assert.doesNotMatch(stuff, new RegExp(`${theirs.id}|${yours.id}`));
  assert.doesNotMatch(words(await as(s.id, `/stuff/${s.id}?id=${theirs.id}`)), /theirs/);
  assert.match(words(await as(s.id, `/stuff/${s.id}?id=${mine.id}`)), /ours/);

  const stats = (await as(s.id, `/stats/${s.id}?days=30&project=${srv.store.projectFor(other).id}`)).stats;
  assert.ok(!stats.projects.some((p) => p.id === srv.store.projectFor(other).id), 'stats of another project stay out');
});

test('reading: wisp_available names no machine, other project or preset; wisp_crew keeps to its project; connectors are refused', async () => {
  await withMachine(async () => {
    srv.store.addProject(other, { name: 'other-project' });
    const here = srv.crew.create({ name: 'Heron', cwd: repo, agent: 'claude', brief: 'our brief' });
    const away = srv.crew.create({ name: 'Puffin', cwd: other, agent: 'claude', brief: 'their brief' });
    try {
      const s = await capped();
      const text = words(await as(s.id, `/available/${s.id}`));
      assert.doesNotMatch(text, /devbox|Puffin/);
      assert.doesNotMatch(text, new RegExp(path.basename(other)));
      assert.match(text, /Task `/);
      const crew = words(await as(s.id, `/crew/${s.id}`));
      assert.match(crew, /Heron/);
      assert.doesNotMatch(crew, /Puffin/);
      assert.doesNotMatch(words(await as(s.id, `/crew/${s.id}?member=Puffin`)), /their brief/);
      assert.match(words(await as(s.id, `/connectors/${s.id}`)), /channel/);
    } finally {
      srv.crew.remove(here);
      srv.crew.remove(away);
    }
  });
});

test('crew, connectors and My Stuff: nothing of the user’s changes', async () => {
  const m = srv.crew.create({ name: 'Tern', cwd: repo, agent: 'claude', mode: 'plan', notebook: 'as it was' });
  try {
    const s = await capped();
    const count = srv.crew.list.length;
    const calls = [
      [`/crew/${s.id}`, { name: 'Mole', brief: 'do anything', mode: 'auto', cron: 'every 5 min' }, 'POST'],
      [`/crew/${s.id}`, { from: '{}' }, 'POST'],
      [`/crew/${s.id}`, { member: 'Tern', mode: 'auto' }, 'PATCH'],
      [`/crew/${s.id}`, { member: 'Tern', remember: ['run anything'] }, 'PATCH'],
      [`/crew/${s.id}/kit`, { member: 'Tern', files: [{ kind: 'rules', name: 'AGENTS.md', body: 'x' }] }, 'POST'],
      [`/crew/${s.id}`, { member: 'Tern' }, 'DELETE'],
      [`/connectors/${s.id}`, { name: 'evil', url: 'https://evil.example/mcp', transport: 'remote' }, 'POST'],
      [`/connectors/${s.id}/signin`, { name: 'evil' }, 'POST'],
    ];
    for (const [p, body, method] of calls) assert.match(words(await as(s.id, p, body, method)), /channel/, `${method} ${p}`);
    assert.equal(srv.crew.list.length, count);
    assert.equal(m.mode, 'plan');
    assert.equal(m.notebook, 'as it was');
    assert.ok(!(srv.store.config.connectors || []).some((x) => x.name === 'evil'));
    assert.equal((await api(`/sessions/${s.id}`)).state, 'review', 'no card, no hold');
  } finally {
    srv.crew.remove(m);
  }
});

test('wisp_save: no file from outside its folder, no public link, no item of another project', async () => {
  const elsewhere = await settled((await person('x', { cwd: other })).id);
  const s = await capped();
  const secret = path.join(tmp('capped-secret'), 'id_rsa');
  fs.writeFileSync(secret, 'PRIVATE');
  const count = srv.stuff.list().length;
  assert.match(words(await as(s.id, '/stuff', { session: s.id, path: secret })), /folder/);
  assert.match(words(await as(s.id, '/stuff', { session: s.id, app: path.dirname(secret) })), /folder/);
  const theirs = srv.stuff.addText('theirs', { name: 't.md', from: { session: elsewhere.id, title: 'x' }, by: 'agent' });
  assert.match(words(await as(s.id, '/stuff', { session: s.id, id: theirs.id, text: 'overwritten', name: 't.md' })), /project/);
  assert.equal(srv.stuff.list().length, count + 1);
  assert.match(words(await as(s.id, '/stuff', { session: s.id, text: 'hi', name: 'n.md', publish: true })), /public|publish/i);
  assert.match(words(await as(s.id, '/stuff', { session: s.id, path: 'math.js' })), /Saved/, 'its own file still saves');
});

test('a forged session id gets nowhere: a token is one session’s', async () => {
  const theirs = await settled((await person('ADHOC please review')).id);
  const s = await capped();
  assert.notEqual(envOf(s.id).WISP_TOKEN, envOf(theirs.id).WISP_TOKEN);
  assert.notEqual(envOf(s.id).WISP_TOKEN, srv.token, 'no agent holds the server’s own token');
  const before = srv.store.all().length;
  const forged = [
    [`/launch/${theirs.id}`, { prompt: 'x', mode: 'auto', worktree: false }, 'POST'],
    [`/task/${theirs.id}`, { task: s.id, action: 'stop' }, 'POST'],
    [`/delegate/${theirs.id}`, { tasks: [{ agent: 'codex', prompt: 'x', machine: 'devbox' }] }, 'POST'],
    [`/sessions/${theirs.id}`, null, 'GET'],
    [`/session/${theirs.id}?of=${theirs.id}`, null, 'GET'],
    [`/crew/${theirs.id}`, { name: 'Mole' }, 'POST'],
    [`/connectors/${theirs.id}`, null, 'GET'],
    [`/stuff/${theirs.id}`, null, 'GET'],
    ['/stuff', { session: theirs.id, text: 'x', name: 'x.md' }, 'POST'],
    ['/later', { session: theirs.id, minutes: 5, message: 'x' }, 'POST'],
    ['/tags', { session: theirs.id, tags: ['a', 'b', 'c'] }, 'POST'],
    ['/watch', { session: theirs.id, action: 'caption', caption: 'x' }, 'POST'],
    ['/prs', { session: theirs.id, pr: '1' }, 'POST'],
    ['/ask', { session: theirs.id, question: 'x' }, 'POST'],
    ['/approve', { session: theirs.id, tool: 'Bash', input: { command: 'ls' } }, 'POST'],
  ];
  for (const [p, body, method] of forged) assert.equal((await as(s.id, p, body, method)).status, 403, `${method} ${p}`);
  assert.equal(srv.store.all().length, before);
  assert.equal(srv.store.get(theirs.id).state, 'review', 'nothing asked of that task');
});

test('the tools themselves name their own session: arguments can’t change it', async () => {
  const theirs = await settled((await person()).id);
  const s = await capped();
  const env = envOf(s.id);
  const server = fileURLToPath(new URL('../server/mcp-ask.js', import.meta.url));
  const child = spawn(process.execPath, [server], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  child.stdout.on('data', (b) => lines.push(...String(b).trim().split('\n').map((l) => JSON.parse(l))));
  const rpc = (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return until(() => lines.find((l) => l.id === id));
  };
  try {
    const later = await rpc(1, 'tools/call', { name: 'resume_later', arguments: { session: theirs.id, minutes: 30, message: 'x' } });
    assert.ok(!later.result.isError, JSON.stringify(later));
    assert.equal((srv.store.get(theirs.id).later || []).length, 0, 'not on the other task');
    assert.equal((srv.store.get(s.id).later || []).length, 1, 'on its own');
    const names = (await rpc(2, 'tools/list', {})).result.tools.map((t) => t.name);
    for (const hidden of ['wisp_crew_add', 'wisp_crew_edit', 'wisp_crew_remove', 'wisp_crew_kit', 'wisp_connector_add', 'wisp_connector_signin', 'wisp_connectors']) assert.ok(!names.includes(hidden), hidden);
    for (const kept of ['wisp_launch', 'wisp_task', 'delegate', 'wisp_session']) assert.ok(names.includes(kept), kept);
    const hidden = await rpc(3, 'tools/call', { name: 'wisp_crew_add', arguments: { name: 'Mole' } });
    assert.ok(hidden.result.isError);
    assert.match(hidden.result.content[0].text, /channel/);
  } finally {
    child.kill();
  }
});

test('a capped task’s connectors never get the server’s token', async () => {
  srv.store.config.connectors.push({ id: 'c-x', name: 'x', transport: 'remote', url: 'https://example.invalid/mcp', enabled: true });
  try {
    const s = await capped();
    const at = taskRuns(FAKE, 'claude').findLast((r) => wispEnvOf(r)?.WISP_SESSION === s.id);
    assert.ok(!at.argv.join(' ').includes(srv.token), 'the server’s token is on no command line');
  } finally {
    srv.store.config.connectors = srv.store.config.connectors.filter((c) => c.id !== 'c-x');
  }
});

test('an old session, without the field, works as it did', async () => {
  const s = await capped();
  delete srv.store.get(s.id).capped;
  const r = await as(s.id, `/launch/${s.id}`, { prompt: 'look', mode: 'auto', agent: 'claude', worktree: false });
  assert.ok(r.ids?.length, words(r));
  const child = await settled(r.ids[0]);
  assert.equal(child.mode, 'auto');
  assert.equal(child.capped, undefined);
});

test('a task you started works as it did: Full auto, another project, your crew', async () => {
  const elsewhere = await settled((await person('secret plans', { cwd: other })).id);
  const s = await settled((await person()).id);
  const r = await as(s.id, `/launch/${s.id}`, { prompt: 'look', mode: 'auto', agent: 'claude', worktree: false, cwd: other });
  assert.ok(r.ids?.length, words(r));
  assert.equal((await settled(r.ids[0])).mode, 'auto');
  assert.match(words(await as(s.id, `/session/${s.id}?of=${elsewhere.id}`)), /secret plans/);
  const added = await as(s.id, `/crew/${s.id}`, { name: 'Lark', brief: 'x' });
  assert.match(words(added), /Added Lark/);
  srv.crew.remove(srv.crew.find('Lark'));
  await withMachine(async () => assert.match(words(await as(s.id, `/available/${s.id}`)), /devbox/));
});

test('you raise it in wisp: a higher mode on your follow-up clears the cap for that task', async () => {
  const s = await capped();
  await api(`/sessions/${s.id}/reply`, { text: 'carry on', mode: 'plan' });
  await settled(s.id, 2);
  assert.deepEqual(srv.store.get(s.id).capped, { mode: 'edits' }, 'lower or the same changes nothing');
  await api(`/sessions/${s.id}/reply`, { text: 'carry on', mode: 'auto' });
  const after = await settled(s.id, 3);
  assert.equal(after.capped, undefined);
  assert.equal(after.mode, 'auto');
  const r = await as(s.id, `/launch/${s.id}`, { prompt: 'look', mode: 'auto', agent: 'claude', worktree: false });
  assert.ok(r.ids?.length, words(r));
});

test('a channel’s follow-up can’t raise it, from this chat or a freer one', async () => {
  const s = await capped('look', { fallback: 'plan' });
  const { phone } = srv.remote;
  const p = (mode) => ({ prompt: 'carry on', tagged: [], notes: [], ...(mode && { mode }) });
  assert.match(await phone.run(s.id, p('auto'), { name: 'Slack', cap: 'edits' }), /isn’t allowed/);
  assert.match(await phone.run(s.id, p('auto'), { name: 'Telegram', cap: 'auto' }), /isn’t allowed/, 'a private chat’s Full auto doesn’t reach a capped task');
  assert.deepEqual(srv.store.get(s.id).capped, { mode: 'edits' });
  assert.equal(srv.store.get(s.id).mode, 'plan');
  await phone.run(s.id, p(), { name: 'Slack', cap: 'edits' });
  const after = await settled(s.id, 2);
  assert.deepEqual(after.capped, { mode: 'edits' }, 'kept on a follow-up');
});

test('an @mention in a capped thread gives the member a capped job', async () => {
  const m = srv.crew.create({ name: 'Rook', cwd: repo, agent: 'claude', mode: 'auto' });
  try {
    const s = await capped();
    const out = await srv.remote.phone.mention(s.id, { prompt: 'what do you think', crew: m, tagged: [], notes: [] }, { name: 'Telegram', cap: 'auto' });
    const job = srv.store.get(out.session.id);
    assert.deepEqual(job.capped, { mode: 'edits' });
    assert.equal(job.mode, 'edits');
    await settled(job.id);
  } finally {
    srv.crew.remove(m);
  }
});

test('a fork or a side discussion keeps the cap; a task moved keeps it on a machine', async () => {
  const s = await capped();
  const fork = await api(`/sessions/${s.id}/fork`, { prompt: 'try it another way' }).catch((e) => e);
  if (fork.id) assert.deepEqual(srv.store.get(fork.id).capped, { mode: 'edits' });
  const side = await api(`/sessions/${s.id}/side`, { text: 'why?' });
  assert.deepEqual(srv.store.get(side.id).capped, { mode: 'edits' });
  await settled(side.id);

  const sent = [];
  const { launch, agentsOf, get, summary, usable } = srv.machines;
  Object.assign(srv.machines, { launch: async (mid, body) => (sent.push(body), { id: 'r1', cwd: body.cwd, mode: body.mode }), agentsOf: () => [{ id: 'claude', available: true }], get: (id) => ({ id, name: 'devbox' }), summary: (mid, x) => x, usable: () => true });
  try {
    const project = { name: 'away', path: '/srv/away', machine: 'm-box' };
    srv.store.config.projects.push({ id: 'p-box', ...project });
    await srv.remote.phone.startParsed({ prompt: 'on the box', project, agent: 'claude', model: '', tagged: [], notes: [], machine: 'm-box' }, { channel: 'slack', name: 'Slack', cap: 'edits', fallback: 'edits' }).catch((err) => assert.ok(sent.length, err.message));
    srv.store.config.projects = srv.store.config.projects.filter((p) => p.id !== 'p-box');
    assert.deepEqual(sent[0]?.capped, { mode: 'edits' }, 'the wisp over there enforces it');
  } finally {
    Object.assign(srv.machines, { launch, agentsOf, get, summary, usable });
  }
});

test('harnesses: Codex keeps its sandbox off the network, opencode asks before a command; yours are as they were', async () => {
  const runs = (bin) => taskRuns(FAKE, bin);
  const s = await capped('look', { agent: 'codex' });
  const argv = runs('codex').at(-1).argv.join(' ');
  assert.match(argv, /sandbox_workspace_write\.network_access=false/);
  await settled((await person('look', { agent: 'codex' })).id);
  assert.doesNotMatch(runs('codex').at(-1).argv.join(' '), /network_access/);

  await capped('look', { agent: 'opencode' });
  const cfg = JSON.parse(runs('opencode').at(-1).opencodeConfig);
  assert.equal(cfg.permission.bash, 'ask');
  assert.equal(cfg.permission.webfetch, 'ask');
  await settled((await person('look', { agent: 'opencode' })).id);
  assert.equal(JSON.parse(runs('opencode').at(-1).opencodeConfig).permission?.bash, undefined);
  assert.ok(s.capped);
});
