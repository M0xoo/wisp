// Bringing in a project's Conductor worktrees (server/services/bring-in.js) through a real wisp, with
// real worktrees under a fake home: what's offered and refused, the task it makes, and every way
// wisp could have removed one (git.js isForeign): archive, discard, delete, merge, a delegate's
// clean-up, a crew job's, a task's other folders, a fork. A worktree stays through all of them.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeClone, makeRepo, records, same, sleep, taskRuns, tmp, until, win } from './helpers.js';

// Before any server code: os.homedir() is where Conductor's folders and Claude's transcripts are.
const HOME = tmp('bring-home');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.CLAUDE_CONFIG_DIR;
const RECORD = tmp('bring-record');
const GH_STATE = path.join(tmp('bring-gh'), 'state.json');
process.env.FAKE_RECORD = RECORD;
process.env.FAKE_GH_STATE = GH_STATE;
process.env.WISP_HOME = tmp('bring-wisp');
process.env.WISP_UPDATE_CHECK = '0';
installFakeBins();

const { startServer } = await import('../server/index.js');
const { foreignWorktrees } = await import('../server/services/bring-in.js');
const { ensureWorktree, gitBin, isForeign, removeWorktree } = await import('../server/git.js');
const { adapters } = await import('../server/adapters/index.js');
const { worthRetro } = await import('../server/preferences.js');
const { captureCheckpoint, rollbackToTurn } = await import('../server/checkpoint.js');
const { inConductor } = await import('../server/conductor.js');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

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

async function call(method, p, body) {
  const r = await fetch(`${base}/api${p}`, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  return { status: r.status, json: await r.json() };
}
async function api(method, p, body) {
  const { status, json } = await call(method, p, body);
  if (status >= 400) throw Object.assign(new Error(`${p}: ${json.error}`), { status });
  return json;
}
const session = (id) => api('GET', `/sessions/${id}`);
const settled = (id, turns) =>
  until(
    async () => {
      const s = await session(id);
      return s.turns.length >= turns && ['review', 'done'].includes(s.state) && s.turns.at(-1).status !== 'running' ? s : null;
    },
    { what: `task ${id} to finish turn ${turns}` },
  );
const reply = (id, text) => api('POST', `/sessions/${id}/reply`, { text });

const gitIn = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const has = (repo, branch) => !!gitIn(repo, 'branch', '--list', branch);

// Every git wisp runs while fn does: the args, one call a line. Off on Windows (a .cmd shim would
// change how git is spawned): the checks on it are extra, the folders are asserted anyway.
async function traced(fn) {
  if (win) return { out: await fn(), calls: null };
  const dir = tmp('bring-trace');
  const log = path.join(dir, 'log');
  const shim = path.join(dir, 'git');
  fs.writeFileSync(log, '');
  fs.writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${gitBin()}' "$@"\n`);
  fs.chmodSync(shim, 0o755);
  process.env.WISP_GIT_BIN = shim;
  try {
    const out = await fn();
    return { out, calls: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) };
  } finally {
    delete process.env.WISP_GIT_BIN;
  }
}
const noTidying = (calls) => {
  for (const line of calls || []) assert.doesNotMatch(line, /^worktree (remove|prune|add)|^branch -D|--delete/, line);
};

const snapshot = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'latin1');
    }
  };
  walk(dir);
  return out;
};

let names = 0;
// A repo with Conductor's three kinds of worktree, with real uncommitted work in the first.
function layout({ clone = false, setup } = {}) {
  const made = clone ? makeClone() : null;
  const repo = made?.dir || makeRepo();
  if (setup) setup(repo);
  const name = `demo-${++names}`;
  const add = (dir, branch) => {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    gitIn(repo, 'worktree', 'add', '-q', '-b', branch, dir);
    return dir;
  };
  const tokyo = add(path.join(HOME, 'conductor', 'workspaces', name, 'tokyo'), `dev/fix-login_page-${names}`);
  const lima = add(path.join(HOME, 'conductor', 'cloud-workspaces', name, 'lima'), `cloud-${names}`);
  const old = add(path.join(repo, '.conductor', 'old'), `old-${names}`);
  fs.appendFileSync(path.join(tokyo, 'math.js'), '// work in progress\n');
  fs.writeFileSync(path.join(tokyo, 'staged.txt'), 'staged by hand\n');
  gitIn(tokyo, 'add', 'staged.txt');
  fs.writeFileSync(path.join(tokyo, 'scratch.txt'), 'not added yet\n');
  return { repo, name, tokyo, lima, old, add, made };
}
// The folder as git names it, which is what wisp looks up: on Windows TMP can be the 8.3 RUNNER~1.
const claudeFolder = (dir) => path.join(HOME, '.claude', 'projects', fs.realpathSync.native(dir).replace(/[^a-zA-Z0-9]/g, '-'));
// Windows won't move a folder while a git is running in it, and wisp's check of the new task may be.
async function moveAway(from, to) {
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(from, to);
    } catch (err) {
      if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err;
      if (i >= 40) throw err;
      await sleep(250);
    }
  }
}
function chatIn(dir, id, { bytes = 'x', at } = {}) {
  const folder = claudeFolder(dir);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${id}.jsonl`);
  fs.writeFileSync(file, bytes);
  if (at) fs.utimesSync(file, at, at);
  return file;
}
const CHAT = '11111111-2222-4333-8444-555555555555';
const addProject = (repo) => api('POST', '/projects', { path: repo });
const offered = (p) => api('GET', `/projects/${p.id}/foreign-worktrees`);
// One worktree in as a task: { l: the layout, p: its project, s: the full task }. clean: lima, with
// nothing uncommitted: the one archiving would remove, were it wisp's.
async function brought({ clean = false, ...opts } = {}) {
  const l = layout(opts);
  const p = await addProject(l.repo);
  const { tasks, missed } = await api('POST', `/projects/${p.id}/foreign-worktrees`, { paths: [clean ? l.lima : l.tokyo] });
  assert.deepEqual(missed, []);
  return { l, p, s: await session(tasks[0].id) };
}
const kept = (l) => {
  assert.ok(fs.existsSync(l.tokyo), 'the folder stays');
  assert.equal(fs.readFileSync(path.join(l.tokyo, 'scratch.txt'), 'utf8'), 'not added yet\n', 'its uncommitted files too');
};

test('offers Conductor’s worktrees of this repo, and nothing else that looks like one', async () => {
  const l = layout();
  chatIn(l.tokyo, CHAT);
  // Never listed: a plain folder there, a worktree of another repo there.
  fs.mkdirSync(path.join(HOME, 'conductor', 'workspaces', l.name, 'plain'), { recursive: true });
  const other = makeRepo();
  gitIn(other, 'worktree', 'add', '-q', '-b', 'theirs', path.join(HOME, 'conductor', 'workspaces', l.name, 'theirs'));
  // This repo's, but not Conductor's.
  const outside = l.add(path.join(tmp('bring-out'), 'mine'), `mine-${names}`);
  // A detached one: counted, not offered.
  gitIn(l.repo, 'worktree', 'add', '-q', '--detach', path.join(HOME, 'conductor', 'workspaces', l.name, 'loose'));
  // Prunable: its folder went.
  const gone = l.add(path.join(HOME, 'conductor', 'workspaces', l.name, 'gone'), `gone-${names}`);
  fs.rmSync(gone, { recursive: true, force: true });
  // git still lists this one, but what's there now is another repo: its own common dir says so.
  const swapped = l.add(path.join(HOME, 'conductor', 'workspaces', l.name, 'swapped'), `swapped-${names}`);
  fs.rmSync(swapped, { recursive: true, force: true });
  gitIn(other, 'worktree', 'add', '-q', '-b', 'swapped', swapped);

  const { items, detached, from } = await foreignWorktrees(l.repo);
  assert.equal(from, 'Conductor');
  assert.equal(detached, 1);
  assert.deepEqual(items.map((x) => x.name).sort(), ['lima', 'old', 'tokyo']);
  const tokyo = items.find((x) => x.name === 'tokyo');
  assert.ok(same(tokyo.path, l.tokyo));
  assert.deepEqual({ ...tokyo, path: 0 }, { path: 0, branch: `dev/fix-login_page-${names}`, name: 'tokyo', dirty: 3, chat: true, from: 'conductor' });
  assert.equal(items.find((x) => x.name === 'lima').chat, false);
  assert.equal(items.find((x) => x.name === 'lima').dirty, 0);
  assert.ok(!items.some((x) => same(x.path, outside) || same(x.path, l.repo)));

  // Spoken for, by real path whatever the spelling; and a project that is one of them.
  const left = await foreignWorktrees(l.repo, { known: [tokyo.path, path.join(l.lima, '..', 'lima')] });
  assert.deepEqual(left.items.map((x) => x.name), ['old']);
  const fromInside = await foreignWorktrees(l.tokyo);
  assert.deepEqual(fromInside.items.map((x) => x.name).sort(), ['lima', 'old']);
});

test('GET only reads: no fetch, no write, and a project with nothing here is simply empty', async () => {
  const l = layout({ clone: true });
  const p = await addProject(l.repo);
  const before = snapshot(l.tokyo);
  const { out, calls } = await traced(() => offered(p));
  assert.deepEqual(Object.keys(out).sort(), ['detached', 'from', 'items']);
  assert.equal(out.items.length, 3);
  assert.deepEqual(snapshot(l.tokyo), before);
  if (calls) for (const line of calls) assert.match(line, /^(worktree list|rev-parse|status --porcelain)/, line);

  const empty = { from: 'Conductor', items: [], detached: 0 };
  const plain = tmp('bring-plain');
  const projects = srv.store.config.projects;
  projects.push({ id: 'bi-noway', name: 'away', path: '/nope/there', machine: 'box' }, { id: 'bi-plain', name: 'plain', path: plain }, { id: 'bi-gone', name: 'gone', path: path.join(plain, 'nope') }, { id: 'bi-scratch', name: 'scratch', path: path.join(process.env.WISP_HOME, 'scratch', 'x') });
  for (const id of ['bi-noway', 'bi-plain', 'bi-gone', 'bi-scratch']) assert.deepEqual(await api('GET', `/projects/${id}/foreign-worktrees`), empty, id);
  srv.store.config.projects = projects.filter((x) => !x.id.startsWith('bi-'));
  assert.equal((await call('GET', '/projects/nope/foreign-worktrees')).status, 404);
  assert.equal((await call('POST', '/projects/nope/foreign-worktrees')).status, 404);
  assert.equal((await call('POST', '/projects/nope/foreign-worktrees/dismiss')).status, 404);
  assert.equal((await call('POST', `/projects/${p.id}/foreign-worktrees`, { paths: 'all' })).status, 400);
  assert.equal((await call('POST', `/projects/${p.id}/foreign-worktrees`, { paths: [1] })).status, 400);
});

test('latestSession: the newest conversation in that one folder, by name and size alone', { skip: win }, () => {
  const l = layout();
  const latest = (dir, env) => adapters.claude.latestSession(dir, env);
  assert.equal(latest(l.tokyo), null);
  const now = Date.now() / 1000;
  chatIn(l.tokyo, 'aaaaaaaa-0000-4000-8000-000000000001', { at: now - 100 });
  const newest = chatIn(l.tokyo, 'aaaaaaaa-0000-4000-8000-000000000002', { at: now - 50 });
  chatIn(l.tokyo, 'aaaaaaaa-0000-4000-8000-000000000003', { bytes: '', at: now }); // started, never saved
  chatIn(l.tokyo, 'agent-1234567', { at: now + 10 }); // a subagent's
  chatIn(l.lima, 'bbbbbbbb-0000-4000-8000-000000000001', { at: now + 20 }); // another folder's
  assert.equal(latest(l.tokyo), 'aaaaaaaa-0000-4000-8000-000000000002');
  fs.chmodSync(newest, 0o000); // it can't be read, and it's still found: nothing opens it
  fs.chmodSync(path.dirname(newest), 0o500);
  try {
    assert.equal(latest(l.tokyo), 'aaaaaaaa-0000-4000-8000-000000000002');
  } finally {
    fs.chmodSync(path.dirname(newest), 0o700);
    fs.chmodSync(newest, 0o600);
  }
  const config = tmp('bring-config');
  assert.equal(latest(l.tokyo, { CLAUDE_CONFIG_DIR: config }), null);
  fs.mkdirSync(path.join(config, 'projects', path.basename(claudeFolder(l.tokyo))), { recursive: true });
  fs.writeFileSync(path.join(config, 'projects', path.basename(claudeFolder(l.tokyo)), `${CHAT}.jsonl`), 'x');
  assert.equal(latest(l.tokyo, { CLAUDE_CONFIG_DIR: config }), CHAT);
});

test('taking the offer makes a finished, waiting task in place, and writes nothing there', async () => {
  const l = layout();
  chatIn(l.tokyo, CHAT);
  gitIn(l.tokyo, 'branch', '-m', `dev/fix-login_page-${names}`, `dev/renamed_on-first-chat-${names}`); // Conductor does this: read from git, now
  const p = await addProject(l.repo);
  const before = { tokyo: snapshot(l.tokyo), lima: snapshot(l.lima), old: snapshot(l.old) };
  const seen = [];
  const track = srv.telemetry.track;
  srv.telemetry.track = (event, props) => seen.push({ event, props });
  const r = await traced(() => api('POST', `/projects/${p.id}/foreign-worktrees`));
  srv.telemetry.track = track;
  noTidying(r.calls);
  const { tasks, missed } = r.out;
  assert.deepEqual(missed, []);
  assert.equal(tasks.length, 3);
  assert.deepEqual({ tokyo: snapshot(l.tokyo), lima: snapshot(l.lima), old: snapshot(l.old) }, before, 'nothing written in the folders');
  assert.deepEqual(seen.filter((x) => x.event === 'worktrees_brought_in').map((x) => x.props), [{ n: 3, resumed: 1 }]);

  const sum = tasks.find((x) => same(x.cwd, l.repo) && x.title === `first chat ${names}`.replace('first chat', 'renamed on first chat'));
  assert.ok(sum, tasks.map((x) => x.title).join());
  assert.equal(sum.foreign, 'conductor');
  assert.equal(sum.branch, `dev/renamed_on-first-chat-${names}`);
  assert.equal(sum.state, 'review');
  assert.equal(sum.unread, false);
  assert.equal(sum.followups, 0);
  assert.equal(sum.agent, 'claude');
  const s = await session(sum.id);
  assert.equal(s.titleAuto, false);
  assert.equal(s.agentSessionId, CHAT);
  assert.ok(same(s.cwd, l.repo), 'it groups under the project');
  assert.equal(s.mode, srv.store.config.defaults.mode || 'auto');
  const wt = s.worktree;
  assert.ok(same(wt.path, l.tokyo));
  assert.ok(same(wt.cwd, l.tokyo));
  assert.ok(same(wt.root, l.repo));
  assert.equal(wt.head, null);
  assert.equal(wt.foreign, 'conductor');
  assert.equal(wt.remote, null);
  assert.equal(wt.baseRef, gitIn(l.repo, 'rev-parse', 'HEAD'));
  assert.ok(!wt.prepared, 'no setup');
  assert.equal(s.turns.length, 1);
  const [t] = s.turns;
  assert.equal(t.by, 'wisp');
  assert.equal(t.status, 'done');
  assert.equal(t.stats, null);
  assert.equal(t.prompt, 'Brought in from Conductor');
  assert.equal(t.presentation.blocks.length, 1, 'one report, so nothing is said twice');
  assert.equal(t.presentation.blocks[0].type, 'markdown');
  const facts = t.presentation.blocks[0].text;
  assert.ok(facts.includes(`\`${wt.path}\``), facts);
  assert.ok(facts.includes(`\`${wt.branch}\``), facts);
  assert.match(facts, /3 uncommitted files, as they were/);
  assert.match(facts, /The Claude chat resumes on your next message/);
  assert.equal(sum.preview, '', 'no hero: the card has no long path to cut');
  assert.equal(sum.status, 'info');

  const none = tasks.find((x) => x.title !== sum.title);
  const noChat = await session(none.id);
  assert.equal(noChat.agentSessionId, null);
  assert.match(noChat.turns[0].presentation.blocks[0].text, /No Claude chat was found, so your next message starts a new one/);
  assert.match(noChat.turns[0].presentation.blocks[0].text, /No uncommitted files/);

  assert.equal(worthRetro(srv.store.get(s.id)), false, 'nothing for wisp’s memory to spend a run on');
  assert.deepEqual((await api('GET', `/sessions/${s.id}/workspace`)).worktree.foreign, 'conductor');
  assert.equal((await offered(p)).items.length, 0, 'now they’re tasks');
  await until(async () => (await api('GET', '/sessions')).find((x) => x.id === s.id).toShip?.dirty === 3, { what: 'the card to count the work' });
});

test('with no chat the default harness takes it; Auto or nothing falls back to Claude', async () => {
  const d = srv.store.config.defaults;
  const was = { agent: d.agent, mode: d.mode };
  try {
    d.agent = 'codex';
    d.mode = 'plan';
    const a = await brought();
    assert.equal(a.s.agent, 'codex');
    assert.equal(a.s.agentSessionId, null);
    assert.equal(a.s.mode, 'plan');
    d.agent = 'auto';
    d.mode = 'nonsense';
    const b = await brought();
    assert.equal(b.s.agent, 'claude');
    assert.equal(b.s.mode, 'auto');
    d.agent = 'codex'; // a chat wins: it's Claude's
    const l = layout();
    chatIn(l.tokyo, CHAT);
    const p = await addProject(l.repo);
    const { tasks } = await api('POST', `/projects/${p.id}/foreign-worktrees`, { paths: [l.tokyo] });
    assert.equal(tasks[0].agent, 'claude');
  } finally {
    Object.assign(d, was);
  }
});

test('the next message resumes the Claude chat in the worktree, told what kind of folder it’s in', async () => {
  const l = layout();
  chatIn(l.tokyo, CHAT);
  const p = await addProject(l.repo);
  const { tasks } = await api('POST', `/projects/${p.id}/foreign-worktrees`, { paths: [l.tokyo] });
  const id = tasks[0].id;
  await reply(id, 'carry on');
  await settled(id, 2);
  const run = taskRuns(RECORD, 'claude').at(-1);
  assert.equal(run.stdin.includes('Brought in from Conductor'), false, 'Claude has its chat: wisp’s note isn’t repeated to it');
  assert.equal(run.argv[run.argv.indexOf('--resume') + 1], CHAT);
  assert.ok(same(run.cwd, l.tokyo));
  const said = `${run.stdin}\n${run.argv.join(' ')}`;
  assert.match(said, /existing git worktree/);
  assert.match(said, /brought in from Conductor/);
  assert.match(said, /may hold uncommitted work/);
  assert.match(said, /Don't remove this worktree or its folder/);
  assert.doesNotMatch(said, /isolated git worktree|for this task only|install them/);
  assert.doesNotMatch(run.stdin, /Earlier in this task/, 'Claude was there: no hand-over');
  const s = await session(id);
  assert.equal(s.turns[1].checkpoint.dirty, true, 'a true checkpoint of the work as it stood');
});

test('the first turn on a resumed chat is the baseline, not the whole conversation; the next is exact', async () => {
  const l = layout();
  chatIn(l.tokyo, CHAT);
  const p = await addProject(l.repo);
  const { tasks } = await api('POST', `/projects/${p.id}/foreign-worktrees`, { paths: [l.tokyo] });
  const id = tasks[0].id;
  try {
    process.env.FAKE_SUBAGENTS = '3'; // the fake reports modelUsage only then
    process.env.FAKE_RESTORED = '300'; // $3 of Conductor's in the counters
    await reply(id, 'carry on');
    let s = await settled(id, 2);
    const first = s.turns[1].stats;
    assert.equal(first.costUsd, 0);
    assert.equal(first.baseline, true);
    assert.equal(first.models, undefined, 'no model deltas');
    assert.ok(Math.abs(first.totals.costUsd - 3.01) < 1e-9, 'the next turn counts from here');
    assert.equal(first.totals.models[0].output, 301 * 41000);
    assert.equal(first.inputTokens, 10, 'this run’s tokens stay');
    assert.ok(first.outputTokens > 0);

    process.env.FAKE_RESTORED = '301';
    await reply(id, 'and again');
    s = await settled(id, 3);
    const second = s.turns[2].stats;
    assert.equal(second.costUsd, 0.01);
    assert.equal(second.baseline, undefined);
    assert.equal(second.models[0].output, 41000);
    assert.ok(Math.abs(second.totals.costUsd - 3.02) < 1e-9);
  } finally {
    delete process.env.FAKE_SUBAGENTS;
    delete process.env.FAKE_RESTORED;
  }

  // No chat to resume: nothing unknown, so the first run counts as any first run.
  const { s: fresh } = await brought();
  await reply(fresh.id, 'start');
  const done = await settled(fresh.id, 2);
  assert.equal(done.turns[1].stats.costUsd, 0.01);
  assert.equal(done.turns[1].stats.baseline, undefined);
});

test('a harness that wasn’t there hears the facts from the report', async () => {
  const { l, s } = await brought();
  await api('POST', `/sessions/${s.id}/reply`, { text: 'pick it up', agent: 'codex' });
  await settled(s.id, 2);
  const run = taskRuns(RECORD, 'codex').at(-1);
  assert.ok(same(run.cwd, l.tokyo));
  assert.ok(run.stdin.includes(s.worktree.path), 'the folder');
  assert.match(run.stdin, /3 uncommitted files/);
});

test('no setup runs, wisp’s or Conductor’s, at bring-in or on the first turn', async () => {
  const marker = 'setup-ran.txt';
  const { l, s } = await brought({
    setup: (repo) => {
      fs.mkdirSync(path.join(repo, '.wisp'));
      fs.mkdirSync(path.join(repo, '.conductor'));
      fs.writeFileSync(path.join(repo, '.wisp', 'worktree.json'), JSON.stringify({ setup: [`node -e "require('fs').writeFileSync('${marker}','x')"`] }));
      fs.writeFileSync(path.join(repo, '.conductor', 'settings.toml'), `[scripts]\nsetup = "node -e \\"require('fs').writeFileSync('${marker}','x')\\""\n`);
      gitIn(repo, 'add', '.wisp', '.conductor/settings.toml');
      gitIn(repo, 'commit', '-qm', 'setup');
    },
  });
  await reply(s.id, 'go on');
  await settled(s.id, 2);
  assert.ok(!fs.existsSync(path.join(l.tokyo, marker)));
  assert.ok(!fs.existsSync(path.join(l.repo, marker)));
});

test('two clicks make one task each; a path that isn’t offered is refused, never trusted', async () => {
  const l = layout();
  const p = await addProject(l.repo);
  const [a, b] = await Promise.all([api('POST', `/projects/${p.id}/foreign-worktrees`), api('POST', `/projects/${p.id}/foreign-worktrees`)]);
  assert.equal(a.tasks.length + b.tasks.length, 3);
  assert.equal(srv.store.all().filter((s) => s.worktree?.path && same(s.worktree.path, l.tokyo)).length, 1);
  const again = await api('POST', `/projects/${p.id}/foreign-worktrees`, { paths: [l.tokyo] });
  assert.deepEqual(again.tasks, []);
  assert.equal(again.missed[0].path, l.tokyo);
  assert.match(again.missed[0].why, /Not offered/);

  const m = layout();
  const q = await addProject(m.repo);
  const outside = m.add(path.join(tmp('bring-out'), 'mine'), `mine-${names}`);
  const planted = path.join(HOME, 'conductor', 'workspaces', 'nothing', 'here');
  const r = await api('POST', `/projects/${q.id}/foreign-worktrees`, { paths: [outside, planted, m.repo, m.tokyo, m.tokyo] });
  assert.deepEqual(r.tasks.map((x) => x.branch), [`dev/fix-login_page-${names}`], 'the one offered, once');
  assert.deepEqual(r.missed.map((x) => x.path), [outside, planted, m.repo]);
});

test('Not now keeps those folders out, and a worktree made later is still offered', async () => {
  const l = layout();
  const p = await addProject(l.repo);
  assert.equal(p.skipWorktrees, undefined, 'an older project has no field, and works');
  const all = (await offered(p)).items.map((x) => x.path).sort();
  const dismissed = await api('POST', `/projects/${p.id}/foreign-worktrees/dismiss`);
  assert.deepEqual({ ...dismissed, paths: dismissed.paths.sort() }, { ok: true, skipped: 3, paths: all });
  assert.deepEqual((await offered(p)).items, []);
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.WISP_HOME, 'config.json'), 'utf8')).projects.find((x) => x.id === p.id);
  assert.equal(saved.skipWorktrees.length, 3);
  assert.deepEqual((await api('POST', `/projects/${p.id}/foreign-worktrees`, { paths: [l.tokyo] })).tasks, []);
  const later = l.add(path.join(HOME, 'conductor', 'workspaces', l.name, 'osaka'), `osaka-${names}`);
  const { items } = await offered(p);
  assert.deepEqual(items.map((x) => x.name), ['osaka']);
  assert.ok(same(items[0].path, later));
  await api('POST', `/projects/${p.id}/foreign-worktrees/dismiss`);
  assert.equal(srv.store.config.projects.find((x) => x.id === p.id).skipWorktrees.length, 4);
});

test('isForeign: the mark, or where it is if the mark is lost; never one of wisp’s own', () => {
  const home = process.env.HOME;
  assert.equal(isForeign(null), false);
  assert.equal(isForeign({ path: path.join(process.env.WISP_HOME, 'worktrees', 'repo-abc') }), false);
  assert.equal(isForeign({ path: path.join(tmp('bring-any'), 'x'), foreign: 'conductor' }), true);
  assert.equal(isForeign({ path: path.join(home, 'conductor', 'workspaces', 'r', 'gone-now') }), true);
  assert.equal(isForeign({ path: path.join(home, 'conductor', 'archived', 'r', 'x') }), true);
  assert.equal(isForeign({ path: path.join(tmp('bring-any'), '.conductor', 'x') }), true);
  assert.equal(isForeign({ path: path.join(home, 'my-conductor-notes') }), false);
  assert.equal(isForeign({ path: path.join(home, 'conductor') }), false, 'the folder itself isn’t a worktree in it');
  assert.equal(inConductor(path.join(tmp('bring-any'), 'x.conductor', 'y')), false);
});

test('Not now’s Undo offers exactly those folders again; an unknown path changes nothing', async () => {
  const l = layout();
  const p = await addProject(l.repo);
  const { paths } = await api('POST', `/projects/${p.id}/foreign-worktrees/dismiss`);
  const skipped = () => srv.store.config.projects.find((x) => x.id === p.id).skipWorktrees;

  const unknown = path.join(HOME, 'conductor', 'workspaces', 'nothing', 'here');
  assert.deepEqual(await api('POST', `/projects/${p.id}/foreign-worktrees/dismiss`, { undo: [unknown] }), { ok: true, skipped: 0, paths: [] });
  assert.equal(skipped().length, 3);
  assert.deepEqual((await offered(p)).items, []);

  // Another spelling of the same folder, and only that one.
  const one = paths.find((x) => same(x, l.lima));
  await api('POST', `/projects/${p.id}/foreign-worktrees/dismiss`, { undo: [path.join(path.dirname(one), '.', 'x', '..', 'lima')] });
  assert.deepEqual((await offered(p)).items.map((x) => x.name), ['lima']);
  assert.equal(skipped().length, 2);

  assert.deepEqual(await api('POST', `/projects/${p.id}/foreign-worktrees/dismiss`, { undo: paths }), { ok: true, skipped: 0, paths: [] });
  assert.deepEqual((await offered(p)).items.map((x) => x.name).sort(), ['lima', 'old', 'tokyo']);
  assert.deepEqual(skipped(), []);

  for (const undo of ['all', [1], { a: 1 }, null]) assert.equal((await call('POST', `/projects/${p.id}/foreign-worktrees/dismiss`, { undo })).status, 400, JSON.stringify(undo));
  assert.equal((await offered(p)).items.length, 3, 'a refused undo dismisses nothing');
});

// G1, G9: what relay.js removeSession and Delete ask for, in full force, with and without the mark.
test('removeWorktree leaves one alone whatever it’s told: no status, no remove, no prune, no branch -D', async () => {
  const { l, s } = await brought();
  const before = snapshot(l.tokyo);
  for (const wt of [s.worktree, { ...s.worktree, foreign: undefined }]) {
    for (const opts of [{}, { force: true }, { branch: true }, { force: true, branch: 'force' }]) {
      const { out, calls } = await traced(() => removeWorktree(wt, opts));
      assert.deepEqual(out, { removed: false, foreign: true });
      if (calls) assert.deepEqual(calls, []);
    }
  }
  assert.deepEqual(snapshot(l.tokyo), before);
  assert.ok(has(l.repo, s.worktree.branch));
});

// G2
test('a gone folder is a readable refusal: never recreated, never pruned, and the panel still loads', async () => {
  const { l, s } = await brought();
  const held = path.join(tmp('bring-hold'), 'tokyo');
  await moveAway(l.tokyo, held);
  const tried = await traced(() => call('POST', `/sessions/${s.id}/reply`, { text: 'carry on' }));
  noTidying(tried.calls);
  assert.equal(tried.out.status, 409);
  assert.match(tried.out.json.error, /This worktree's folder is gone/);
  assert.ok(tried.out.json.error.includes(s.worktree.path));
  assert.equal((await session(s.id)).turns.length, 1, 'no turn started');
  assert.ok(!fs.existsSync(l.tokyo), 'nothing made at its path');
  await assert.rejects(ensureWorktree({ ...s.worktree, foreign: undefined }), (e) => e.status === 409 && /folder is gone/.test(e.message));

  const panel = await traced(async () => ({
    workspace: await api('GET', `/sessions/${s.id}/workspace`),
    changes: await api('GET', `/sessions/${s.id}/changes`),
    run: await call('POST', `/sessions/${s.id}/changes/stage`, { path: 'math.js' }),
    revert: await call('POST', `/sessions/${s.id}/changes/revert`, { path: 'math.js' }),
    ship: await call('POST', `/sessions/${s.id}/ship`, { title: 'x' }),
    rollback: await call('POST', `/sessions/${s.id}/rollback`, { turnId: s.turns[0].id }),
    fork: await call('POST', `/sessions/${s.id}/fork`, { prompt: 'try' }),
  }));
  noTidying(panel.calls);
  const { workspace, changes, run, revert, ship, rollback, fork } = panel.out;
  assert.equal(workspace.gone, true);
  assert.ok(same(workspace.dir, l.repo), 'the project folder stands in');
  assert.equal(workspace.worktree.foreign, 'conductor');
  assert.equal(changes.files, null);
  assert.equal(run.status, 409);
  assert.equal(revert.status, 409);
  for (const r of [ship, rollback, fork]) {
    assert.equal(r.status, 409);
    assert.match(r.json.error, /folder is gone/);
  }
  assert.ok(!fs.existsSync(l.tokyo));

  // Back in place: it works again, and git never forgot it.
  await moveAway(held, l.tokyo);
  assert.ok(gitIn(l.repo, 'worktree', 'list', '--porcelain').includes(`worktree ${fs.realpathSync(l.tokyo)}`));
  await reply(s.id, 'carry on');
  await settled(s.id, 2);
  kept(l);
});

// G3
test('merge syncs the base and leaves the worktree, its branch and the remote branch', async () => {
  const { l, s } = await brought({ clone: true });
  fs.writeFileSync(GH_STATE, '{}');
  await api('POST', `/sessions/${s.id}/ship`, { title: 'fix: the login page', body: 'Carried over.' });
  const { out, calls } = await traced(() => api('POST', `/sessions/${s.id}/merge`));
  noTidying(calls);
  assert.equal(out.pr.state, 'MERGED');
  assert.equal(out.sync.ok, true, out.sync.text);
  assert.ok(records(RECORD, 'gh').some((x) => x.argv[1] === 'merge'));
  assert.ok(fs.existsSync(l.tokyo), 'the folder stays');
  assert.ok(has(l.repo, s.worktree.branch));
  assert.ok(gitIn(l.repo, 'ls-remote', 'origin', `refs/heads/${s.worktree.branch}`), 'the remote branch stays');
  const after = await session(s.id);
  assert.equal(after.state, 'done');
  assert.equal(after.worktree.path, s.worktree.path, 'it still says where it is');
  const w = await api('GET', `/sessions/${s.id}/workspace`);
  assert.equal(w.gone, false);
  assert.equal(w.worktree.branch, s.worktree.branch);
  await reply(s.id, 'one more thing');
  await settled(s.id, 2);
  assert.ok(same(taskRuns(RECORD, 'claude').at(-1).cwd, l.tokyo));
});

// G4
test('rolling back the first real turn keeps the work that was there, byte for byte', async () => {
  const { l, s } = await brought();
  const math = path.join(l.tokyo, 'math.js');
  const files = ['math.js', 'staged.txt', 'scratch.txt'];
  const read = () => Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(l.tokyo, f))]));
  const before = read();
  const status = gitIn(l.tokyo, 'status', '--porcelain');
  assert.match(status, /M math\.js[\s\S]*A {2}staged\.txt[\s\S]*\?\? scratch\.txt/);

  await reply(s.id, 'change something');
  const done = await settled(s.id, 2);
  assert.match(fs.readFileSync(math, 'utf8'), /a \+ b/, 'the agent edited it');
  assert.match(fs.readFileSync(math, 'utf8'), /work in progress/);
  const t = done.turns[1];
  assert.equal(t.checkpoint.dirty, true);
  assert.deepEqual(t.checkpoint.untracked, ['scratch.txt']);
  fs.writeFileSync(path.join(l.tokyo, 'made-by-the-turn.txt'), 'new\n');

  await api('POST', `/sessions/${s.id}/rollback`, { turnId: t.id });
  assert.deepEqual(read(), before);
  assert.ok(!fs.existsSync(path.join(l.tokyo, 'made-by-the-turn.txt')), 'what the turn made goes');

  // The turn it was brought in on has nothing to undo, and undoing it undoes nothing of yours.
  await api('POST', `/sessions/${s.id}/rollback`, { turnId: done.turns[0].id });
  assert.deepEqual(read(), before);
});

test('a rollback that can’t see every untracked file only removes what the turn says it made', () => {
  const dir = makeRepo();
  gitIn(dir, 'checkout', '-q', '--', 'math.js');
  const name = (i) => path.join(dir, `old-${String(i).padStart(4, '0')}.txt`);
  for (let i = 0; i < 510; i++) fs.writeFileSync(name(i), 'mine\n');
  const checkpoint = captureCheckpoint(dir, 'sess', 'turn');
  assert.equal(checkpoint.untrackedCut, true);
  assert.equal(checkpoint.untracked.length, 500);
  // The agent removes files, so ones past the checkpoint's list move up into the first 500.
  for (let i = 0; i < 20; i++) fs.rmSync(name(i));
  const turn = { id: 'turn', checkpoint, changes: [{ file: 'new.txt', op: 'create', edits: [] }], activity: [] };
  fs.writeFileSync(path.join(dir, 'new.txt'), 'the agent’s\n');
  rollbackToTurn({ id: 'sess', cwd: dir, turns: [turn] }, turn);
  for (let i = 20; i < 510; i++) assert.ok(fs.existsSync(name(i)), name(i));
  assert.ok(!fs.existsSync(path.join(dir, 'new.txt')));
});

// G6, G7, G8
test('archive keeps the folder, even a clean one, and a follow-up carries on in it', async () => {
  const { l, s } = await brought({ clean: true });
  const before = snapshot(l.lima);
  const { out, calls } = await traced(() => api('PATCH', `/sessions/${s.id}`, { archived: true }));
  noTidying(calls);
  assert.equal(out.archived, true);
  assert.deepEqual(snapshot(l.lima), before);
  await reply(s.id, 'one more');
  await settled(s.id, 2);
  assert.ok(same(taskRuns(RECORD, 'claude').at(-1).cwd, l.lima));
  assert.ok(has(l.repo, s.worktree.branch));
});

test('discardWorktree keeps the folder and the branch', async () => {
  const { l, s } = await brought();
  const before = snapshot(l.tokyo);
  const { calls } = await traced(() => api('PATCH', `/sessions/${s.id}`, { archived: true, discardWorktree: true }));
  noTidying(calls);
  assert.deepEqual(snapshot(l.tokyo), before);
  assert.ok(has(l.repo, s.worktree.branch));
});

test('deleting the task keeps the folder, branch and changes, and offers it again', async () => {
  const { l, p, s } = await brought();
  await reply(s.id, 'a turn, so it has a checkpoint');
  await settled(s.id, 2);
  const before = snapshot(l.tokyo);
  const dirty = gitIn(l.tokyo, 'status', '--porcelain');
  const { calls } = await traced(() => api('DELETE', `/sessions/${s.id}`));
  noTidying(calls);
  assert.deepEqual(snapshot(l.tokyo), before);
  assert.equal(gitIn(l.tokyo, 'status', '--porcelain'), dirty);
  assert.ok(has(l.repo, s.worktree.branch));
  assert.ok((await offered(p)).items.some((x) => same(x.path, l.tokyo)));
});

// G10
test('a crew job archived as it ends keeps it', async () => {
  const { l, s } = await brought({ clean: true });
  const live = srv.store.get(s.id);
  live.crew = { id: 'nobody', job: 'check-in' };
  // A quiet check-in: archived as it ends, with nothing left to ship, so nothing but the guard stops it.
  srv.runner.prependOnceListener('ended', ({ session }) => {
    gitIn(l.lima, 'checkout', '--', '.');
    gitIn(l.lima, 'clean', '-fdq');
    session.archived = true;
  });
  const { calls } = await traced(async () => {
    await reply(s.id, 'check in');
    await settled(s.id, 2);
    await new Promise((r) => setTimeout(r, 300)); // nothing waits on the listener's removal
  });
  noTidying(calls);
  assert.ok(fs.existsSync(path.join(l.lima, 'math.js')));
  assert.ok(has(l.repo, s.worktree.branch));
});

// G12
test('in a task’s other folders it stays, while the task’s own worktree goes', async () => {
  const { l, s } = await brought();
  const own = await api('POST', '/sessions', { prompt: 'fix add() please', cwd: makeRepo(), agent: 'claude', mode: 'auto', worktree: true });
  const task = await settled(own.id, 1);
  srv.store.get(s.id).worktree = null; // the one task holding it: only `also` does now
  srv.store.get(own.id).also = [{ cwd: l.repo, worktree: s.worktree }];
  await api('PATCH', `/sessions/${own.id}`, { archived: true });
  kept(l);
  const { calls } = await traced(() => api('DELETE', `/sessions/${own.id}`));
  noTidying(calls?.filter((x) => x.includes(s.worktree.path)));
  kept(l);
  assert.ok(has(l.repo, s.worktree.branch));
  assert.ok(!fs.existsSync(task.worktree.path), 'wisp’s own goes as ever');
});

// G13
test('a fork gets a worktree of wisp’s own, removable as ever, and leaves the source alone', async () => {
  const { l, s } = await brought();
  await reply(s.id, 'a turn to fork from');
  await settled(s.id, 2);
  const before = snapshot(l.tokyo);
  const f = await api('POST', `/sessions/${s.id}/fork`, { prompt: 'try it another way', agent: 'claude' });
  const fork = await settled(f.id, 3);
  assert.deepEqual(snapshot(l.tokyo), before);
  const wt = fork.worktree;
  assert.equal(wt.foreign, undefined);
  assert.equal(f.foreign, '');
  assert.equal(isForeign(wt), false);
  assert.ok(wt.path.startsWith(path.join(process.env.WISP_HOME, 'worktrees')), wt.path);
  assert.equal(fs.readFileSync(path.join(wt.path, 'scratch.txt'), 'utf8'), 'not added yet\n', 'the work came along');
  assert.notEqual(wt.branch, s.worktree.branch);
  await api('DELETE', `/sessions/${f.id}`);
  assert.ok(!fs.existsSync(wt.path), 'the fork’s own folder goes');
  assert.deepEqual(snapshot(l.tokyo), before);
  assert.ok(has(l.repo, s.worktree.branch));
});
