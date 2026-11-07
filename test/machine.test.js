// This Mac (server/machine.js, design/machine.md): ps on each OS, attributing processes to tasks
// (trees, WISP_TASK on an orphan), what's left behind, Stop refusing what it doesn't own, Pause
// automations holding a check-in and expiring, the battery hold, res on a heavy task, the history
// ring and the reclaim groups. Plus GET /machine's shape on a real server.

import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeRepo, tmp, until } from './helpers.js';

process.env.WISP_HOME = tmp('machine-wisp');
process.env.WISP_UPDATE_CHECK = '0';
process.env.CLAUDE_CONFIG_DIR = tmp('machine-claude-home');
installFakeBins();
const { startServer } = await import('../server/index.js');
const { Machine, parsePs, parseWin, parseEtime, parseBatt, tagInEnviron, untilText, LEFT_MS, HISTORY_MS, POINT_MS, KILL_MS, RES_RSS } = await import('../server/machine.js');

let srv;
let base;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
async function api(p, body, method) {
  const r = await fetch(`${base}/api${p}`, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${p}: ${j.error}`), { status: r.status });
  return j;
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
  for (const timer of [srv.later, srv.triggers, srv.crew, srv.liveLimits]) timer.stop();
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

const MB = 1024 ** 2;
const HOME = '/u/.wisp';
// A ps line: pid ppid rss(kB) %cpu etime command.
const line = (pid, ppid, rssMb, cpu, etime, command) => `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${rssMb * 1024} ${cpu} ${etime} ${command}`;

// A Machine on stubs: tasks in a map, runs in runner.live, ps output the test sets.
function rig({ platform = 'darwin', tasks = {}, live = {}, files = {}, defaults = {}, home = HOME } = {}) {
  const clock = { t: 10_000_000_000 };
  const out = { ps: '', pmset: '', win: '' };
  const killed = [];
  const summaries = [];
  const sessions = new Map(Object.entries(tasks).map(([id, s]) => [id, { id, title: id, ...s }]));
  const config = { defaults };
  const store = { get: (id) => sessions.get(id), config, saveConfig: () => {} };
  const runner = { live: new Map(Object.entries(live)) };
  const exec = async (cmd) => (cmd === 'ps' ? out.ps : cmd === 'pmset' ? out.pmset : cmd === 'powershell' ? out.win : null);
  const m = new Machine({ home, runner, store, platform, exec, readFile: async (f) => files[f] ?? null, now: () => clock.t, pid: 50, kill: (pid, sig) => killed.push([pid, sig]), summary: (s) => summaries.push(s.id), o: { totalmem: () => 24 * 1024 ** 3, availableParallelism: () => 8, cpus: () => [] } });
  return { m, clock, out, killed, summaries, runner, store, sessions };
}

// --- parsing ------------------------------------------------------------------------------------

test('etime: [[dd-]hh:]mm:ss as ms', () => {
  assert.equal(parseEtime('00:05'), 5000);
  assert.equal(parseEtime('02:03'), 123_000);
  assert.equal(parseEtime('01:00:00'), 3_600_000);
  assert.equal(parseEtime('1-02:03:04'), 93_784_000);
  assert.equal(parseEtime('junk'), 0);
});

test('macOS ps -E: WISP_TASK read from the env, and the env never kept in the command', () => {
  const now = 1_000_000_000;
  const ps = [line(1, 0, 20, 0.1, '9-00:00:00', '/sbin/launchd'), line(700, 1, 300, 12.5, '05:00', 'node /u/.wisp/worktrees/a/bin/wisp.js --port 5000 HOME=/u WISP_TASK=task1 API_KEY=sk-secret PATH=/bin')].join('\n');
  const [a, b] = parsePs(ps, { now, env: true });
  assert.deepEqual(a, { pid: 1, ppid: 0, rss: 20 * MB, cpu: 0.1, since: now - 9 * 86_400_000, command: '/sbin/launchd' });
  assert.equal(b.task, 'task1');
  assert.equal(b.command, 'node /u/.wisp/worktrees/a/bin/wisp.js --port 5000');
  assert.equal(b.since, now - 300_000);
  assert.doesNotMatch(JSON.stringify(b), /sk-secret/);
});

test('Linux ps: the command as it is (no env to cut); /proc environ finds the tag', () => {
  const [p] = parsePs(line(9, 1, 1, 0, '10:00', 'env FOO=1 make test'), { env: false });
  assert.equal(p.command, 'env FOO=1 make test');
  assert.equal(p.task, undefined);
  assert.equal(tagInEnviron('HOME=/u\0WISP_TASK=abc\0PATH=/bin\0'), 'abc');
  assert.equal(tagInEnviron('HOME=/u\0'), null);
});

test('Windows: Win32_Process JSON, one object or a list; CPU from two ticks', async () => {
  const one = parseWin(JSON.stringify({ ProcessId: 4, ParentProcessId: 0, WorkingSetSize: 1000, T: 0, S: 5, CommandLine: null }));
  assert.deepEqual(one, [{ pid: 4, ppid: 0, rss: 1000, cpu: 0, time: 0, since: 5, command: '' }]);
  assert.deepEqual(parseWin('not json'), []);
  const { m, clock, out } = rig({ platform: 'win32', tasks: { t1: { state: 'running' } }, live: { t1: { pid: 100 } } });
  const procs = (t) => JSON.stringify([{ ProcessId: 50, ParentProcessId: 4, WorkingSetSize: 80 * MB, T: 0, S: 1, CommandLine: 'node wisp' }, { ProcessId: 100, ParentProcessId: 50, WorkingSetSize: 300 * MB, T: t, S: 2, CommandLine: 'claude -p' }]);
  out.win = procs(0);
  await m.tick({ force: true });
  clock.t += 10_000;
  out.win = procs(50_000_000); // 5 s of CPU in 10 s: half a core
  await m.tick({ force: true });
  assert.deepEqual(m.view().tasks.map(({ id, rss, cpu, procs: n }) => ({ id, rss, cpu, n })), [{ id: 't1', rss: 300 * MB, cpu: 50, n: 1 }]);
});

test('pmset: percent and whether it’s on the charger; no battery, null', () => {
  assert.deepEqual(parseBatt("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234)\t14%; discharging; 1:02 remaining present: true"), { pct: 14, charging: false });
  assert.deepEqual(parseBatt("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234)\t100%; charged; 0:00 remaining present: true"), { pct: 100, charging: true });
  assert.equal(parseBatt("Now drawing from 'AC Power'"), null);
});

// --- attribution and left behind ------------------------------------------------------------------

test('a run’s tree from the runner’s pid; wisp’s own and its parents are nobody’s', async () => {
  const { m, out } = rig({ tasks: { t1: { state: 'running', crew: { id: 'c1', job: 'checkin' } } }, live: { t1: { pid: 100 } } });
  m.crewName = () => 'Ada';
  out.ps = [
    line(1, 0, 20, 0, '9-00:00:00', '/sbin/launchd'),
    line(40, 1, 5, 0, '9-00:00:00', '/bin/zsh'), // what started wisp
    line(50, 40, 90, 3, '1-00:00:00', 'node bin/wisp.js'),
    line(51, 50, 200, 1, '1-00:00:00', 'npm run dev'), // the Preview's dev server: wisp's own
    line(100, 50, 300, 20, '03:00', 'claude -p'),
    line(101, 100, 1500, 80, '02:00', 'node --test'),
    line(102, 101, 200, 5, '01:00', 'node fixture.mjs'),
  ].join('\n');
  await m.tick({ force: true });
  const v = m.view();
  assert.deepEqual(v.tasks, [{ id: 't1', title: 't1', crew: 'c1', rss: 2000 * MB, cpu: 105, procs: 3, worktreeBytes: null }]);
  assert.deepEqual(v.crew, [{ id: 'c1', name: 'Ada', rss: 2000 * MB, cpu: 105, jobs: 1 }]);
  assert.deepEqual(v.wisp, { rss: 90 * MB, cpu: 3 });
  assert.deepEqual(v.leftovers, []);
});

test('an orphan is attributed by WISP_TASK and left behind once its task stopped, after 2 min', async () => {
  const { m, out, clock } = rig({ tasks: { done1: { state: 'review' } } });
  m.lastRead = clock.t;
  const ps = (age) => [line(1, 0, 20, 0, '9-00:00:00', '/sbin/launchd'), line(50, 1, 90, 1, '1-00:00:00', 'node wisp'), line(300, 1, 250, 2, age, 'node server.js WISP_TASK=done1 HOME=/u'), line(301, 300, 50, 0, age, 'esbuild --service')].join('\n');
  out.ps = ps('01:00');
  await m.tick({ force: true });
  assert.deepEqual(m.view().leftovers, [], 'younger than 2 min: not yet');
  out.ps = ps('02:30');
  await m.tick({ force: true });
  const left = m.view().leftovers;
  assert.deepEqual(left.map((l) => [l.pid, l.task, l.command]), [[300, 'done1', 'node server.js'], [301, null, 'esbuild --service']]);
  assert.equal(left[0].since, clock.t - 150_000);
});

test('Linux: the tag comes from /proc/<pid>/environ; a pid seen in a tree keeps its task after the run', async () => {
  const files = { '/proc/400/environ': 'HOME=/u\0WISP_TASK=t2\0' };
  const { m, out, clock, runner } = rig({ platform: 'linux', files, tasks: { t2: { state: 'running' }, t3: { state: 'running' } }, live: { t3: { pid: 500 } } });
  out.ps = [line(50, 1, 90, 1, '1-00:00:00', 'node wisp'), line(400, 1, 120, 0, '10:00', 'vite'), line(500, 50, 300, 1, '10:00', 'codex exec'), line(501, 500, 700, 1, '10:00', 'cargo build')].join('\n');
  await m.tick({ force: true });
  assert.deepEqual(m.view().leftovers.map((l) => [l.pid, l.task]), [[400, 't2']], 't2 isn’t running: its vite is left behind');
  // t3's run ends; cargo, reparented to 1, has no env tag but was seen in its tree.
  runner.live.clear();
  clock.t += 10_000;
  out.ps = [line(50, 1, 90, 1, '1-00:00:00', 'node wisp'), line(400, 1, 120, 0, '10:10', 'vite'), line(501, 1, 700, 1, '10:10', 'cargo build')].join('\n');
  await m.tick({ force: true });
  assert.deepEqual(m.view().leftovers.map((l) => [l.pid, l.task]), [[501, 't3'], [400, 't2']]);
});

test('an orphan with only its folder under <home>/worktrees is left behind with no task; the user’s own aren’t', async () => {
  const { m, out } = rig({ platform: 'linux' });
  out.ps = [line(50, 1, 90, 1, '1-00:00:00', 'node wisp'), line(600, 1, 300, 0, '40:00', `node ${HOME}/worktrees/wisp-x/bin/wisp.js --port 61000`), line(601, 77, 300, 0, '40:00', `node ${HOME}/worktrees/wisp-y/node_modules/.bin/tsserver`), line(77, 1, 30, 0, '40:00', 'code')].join('\n');
  await m.tick({ force: true });
  assert.deepEqual(m.view().leftovers.map((l) => [l.pid, l.task]), [[600, null]]);
});

// --- stop ---------------------------------------------------------------------------------------

test('stop: refuses wisp, its parents, what wisp started itself and anything not a task’s; SIGTERM then SIGKILL', async () => {
  const { m, out, killed } = rig({ tasks: { t1: { state: 'running' }, old: { state: 'review' } }, live: { t1: { pid: 100 } } });
  out.ps = [line(40, 1, 5, 0, '9-00:00:00', '/bin/zsh'), line(50, 40, 90, 3, '1-00:00:00', 'node wisp'), line(51, 50, 200, 1, '1-00:00:00', 'npm run dev'), line(100, 50, 300, 20, '03:00', 'claude -p'), line(101, 100, 300, 20, '03:00', 'node --test'), line(300, 1, 250, 2, '05:00', 'vite WISP_TASK=old'), line(999, 1, 10, 0, '05:00', 'Safari')].join('\n');
  for (const [pid, why] of [[50, /wisp itself/], [40, /wisp itself/], [51, /Not a process/], [999, /Not a process/], [12345, /Not a process/]]) {
    await assert.rejects(m.stopPid(pid), (err) => err.status === 403 && why.test(err.message), `pid ${pid}`);
  }
  await assert.rejects(m.stopPid('x'), (err) => err.status === 400);
  await assert.rejects(m.stopPid(1), (err) => err.status === 400);
  assert.deepEqual(killed, []);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    assert.equal((await m.stopPid(300)).stopped, 300);
    assert.equal((await m.stopPid(101)).stopped, 101, 'a process in a running task’s tree');
    assert.deepEqual(killed, [[300, 'SIGTERM'], [101, 'SIGTERM']]);
    mock.timers.tick(KILL_MS);
    assert.deepEqual(killed.slice(2), [[300, 0], [300, 'SIGKILL'], [101, 0], [101, 'SIGKILL']]);
  } finally {
    mock.timers.reset();
  }
});

// --- holds --------------------------------------------------------------------------------------

test('pause: holds until the time, says until when, and expires by itself; 0 resumes; bad times refused', () => {
  const { m, clock, store } = rig();
  assert.equal(m.hold(), null);
  const at = clock.t + 2 * 3_600_000;
  assert.deepEqual(m.pause(at), { pausedUntil: at });
  assert.equal(store.config.defaults.automationsPausedUntil, at);
  const h = m.hold();
  assert.equal(h.kind, 'paused');
  assert.equal(h.load, true);
  assert.equal(h.why, `Automations paused until ${untilText(at, clock.t)}`);
  assert.ok(h.until <= clock.t + 60_000, 'looks again within a minute, so Resume now is quick');
  clock.t = at + 1;
  assert.equal(m.hold(), null, 'expired');
  assert.equal(m.view().guard.pausedUntil, 0);
  m.pause(clock.t + 60_000);
  assert.deepEqual(m.pause(0), { pausedUntil: 0 });
  assert.equal(store.config.defaults.automationsPausedUntil, undefined);
  for (const bad of [-1, 'soon', clock.t - 1, clock.t + 31 * 86_400_000]) assert.throws(() => m.pause(bad), (err) => err.status === 400);
});

test('battery: on battery under batteryHold holds; the charger, off, or no battery don’t', async () => {
  const { m, out, store } = rig({ platform: 'darwin' });
  out.pmset = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t14%; discharging; present: true";
  await m.readBattery();
  assert.deepEqual(m.hold() && { kind: m.hold().kind, why: m.hold().why }, { kind: 'battery', why: 'Waiting for power: battery at 14%, needs 20% or the charger' });
  assert.deepEqual(m.view().guard.battery, { pct: 14, charging: false, hold: 20 });
  store.config.defaults.batteryHold = '40';
  out.pmset = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t30%; discharging; present: true";
  await m.readBattery();
  assert.equal(m.hold()?.kind, 'battery');
  out.pmset = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t30%; charging; present: true";
  await m.readBattery();
  assert.equal(m.hold(), null);
  store.config.defaults.batteryHold = 'off';
  await m.readBattery();
  assert.equal(m.battery, null);
  const linux = rig({ platform: 'linux' }).m;
  assert.equal(await linux.readBattery(), null);
});

test('pause on the server: a check-in, the crew and an unattended launch wait; POST /automations/pause 0 lets them go', async () => {
  const until = Date.now() + 3_600_000;
  assert.deepEqual(await api('/automations/pause', { until }), { pausedUntil: until });
  try {
    await assert.rejects(api('/automations/pause', { until: Date.now() - 1000 }), /in the future/);
    assert.equal(srv.reserve.check('claude')?.kind, 'paused');
    assert.equal(srv.reserve.plan('claude'), null, 'the plan check stays the plan’s');
    await assert.rejects(srv.launcher.launch({ prompt: 'check in', cwd: makeRepo(), agent: 'claude', worktree: false }, null, { unattended: true }), (err) => err.held?.load === true && /Automations paused until/.test(err.message));
    const ada = await api('/crew', { name: 'Pia', role: 'CI watcher', brief: 'Watch CI', cwd: makeRepo(), agent: 'claude', mode: 'edits', cron: '@hourly' });
    const view = (await api('/crew')).find((x) => x.id === ada.id);
    assert.match(view.held?.why || '', /^Automations paused until /);
    const g = (await api('/machine')).guard;
    assert.equal(g.held, 'paused');
    assert.equal(g.pausedUntil, until);
    assert.equal((await api('/config')).defaults.automationsPausedUntil, until);
  } finally {
    assert.deepEqual(await api('/automations/pause', { until: 0 }), { pausedUntil: 0 });
  }
  assert.equal(srv.reserve.check('claude'), null);
  await assert.rejects(api('/config', { defaults: { batteryHold: '30' } }, 'PATCH'), /batteryHold must be one of off, 20, 40/);
  await assert.rejects(api('/config', { defaults: { automationsPausedUntil: 'later' } }, 'PATCH'), /automationsPausedUntil/);
});

// --- res on the summary -------------------------------------------------------------------------

test('res: a heavy task’s summary gets { rss, cpu }, sent again only on a 20% move, and dropped under', async () => {
  const { m, out, summaries } = rig({ tasks: { t1: { state: 'running' } }, live: { t1: { pid: 100 } } });
  const ps = (rssMb, cpu) => [line(50, 1, 90, 1, '1-00:00:00', 'node wisp'), line(100, 50, rssMb, cpu, '03:00', 'claude -p')].join('\n');
  out.ps = ps(300, 10);
  await m.tick({ force: true });
  assert.deepEqual([summaries, m.res.size], [[], 0], 'light: nothing');
  out.ps = ps(600, 10);
  await m.tick({ force: true });
  assert.deepEqual(m.res.get('t1'), { rss: 600 * MB, cpu: 10 });
  assert.equal(summaries.length, 1);
  out.ps = ps(680, 11); // +13%: not sent
  await m.tick({ force: true });
  assert.equal(summaries.length, 1);
  assert.equal(m.res.get('t1').rss, 600 * MB);
  out.ps = ps(800, 11); // +33%
  await m.tick({ force: true });
  assert.equal(summaries.length, 2);
  out.ps = ps(200, 5); // under both: dropped
  await m.tick({ force: true });
  assert.equal(summaries.length, 3);
  assert.equal(m.res.has('t1'), false);
  assert.ok(RES_RSS === 500 * MB);
});

test('ticks: nothing runs and nobody looks, no ps', async () => {
  let calls = 0;
  const { m, clock } = rig();
  m.exec = async () => (calls++, '');
  await m.tick();
  assert.equal(calls, 0);
  m.lastRead = clock.t;
  await m.tick();
  assert.equal(calls, 1, 'someone read GET /machine');
  clock.t += 31_000;
  await m.tick();
  assert.equal(calls, 1);
});

// --- history and reclaim ------------------------------------------------------------------------

test('history: a point a minute, 24 h kept, saved to <home>/machine-history.json and read back', async () => {
  const home = tmp('machine-history');
  const { m, clock } = rig({ home });
  m.load = { reading: () => ({ memFreePct: 41.27, cpu: 88.88 }), hold: () => null };
  m.worktrees = () => ({ view: ({ look }) => (assert.equal(look, false, 'a point never starts a look'), { size: 5 * 1024 ** 3 }) });
  const n = HISTORY_MS / POINT_MS;
  for (let i = 0; i < n + 30; i++) {
    await m.point();
    clock.t += POINT_MS;
  }
  assert.equal(m.history.length, n, 'the oldest go after 24 h');
  assert.deepEqual(m.history.at(-1), { at: clock.t - POINT_MS, freePct: 41.3, cpu: 88.9, runs: 0, held: false, worktreeBytes: 5 * 1024 ** 3 });
  assert.ok(m.history[0].at > clock.t - HISTORY_MS - POINT_MS);
  m.stop();
  const file = path.join(home, 'machine-history.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, n);
  // Read back on the next start an hour on (the clock is already a minute past the last point),
  // minus what's over 24 h old by then.
  const again = new Machine({ home, runner: { live: new Map() }, store: { get: () => null, config: { defaults: {} } }, now: () => clock.t + 60 * POINT_MS });
  assert.equal(again.history.length, n - 61);
});

test('reclaim: merged or closed PRs, Done, finished crew jobs and clean leftovers; only idle folders count', () => {
  const tasks = {
    a: { state: 'review', pr: { state: 'MERGED' } },
    b: { state: 'done', also: [{ pr: { state: 'CLOSED' } }] },
    c: { state: 'done' },
    d: { state: 'review', crew: { id: 'c1' } },
    e: { state: 'done' }, // dirty
    f: { state: 'review' }, // just in review: not a group
  };
  const { m } = rig({ tasks });
  const wt = {
    items: [
      { id: 'a', status: 'idle', size: 100 },
      { id: 'b', status: 'idle', size: 50 },
      { id: 'c', status: 'idle', size: 10 },
      { id: 'd', status: 'idle', size: 7 },
      { id: 'e', status: 'dirty', size: 1000 },
      { id: 'f', status: 'idle', size: 1 },
    ],
    leftovers: [{ name: 'wisp-old', size: 30, only: 0 }, { name: 'wisp-dirty', size: 900, only: 3 }],
    size: 2098,
    disk: { free: 10, total: 100 },
  };
  assert.deepEqual(m.reclaim(wt), [
    { kind: 'merged', count: 2, bytes: 150, ids: ['a', 'b'] },
    { kind: 'done', count: 1, bytes: 10, ids: ['c'] },
    { kind: 'crew', count: 1, bytes: 7, ids: ['d'] },
    { kind: 'leftover', count: 1, bytes: 30, ids: ['wisp-old'] },
  ]);
  m.worktrees = () => ({ view: () => wt });
  assert.deepEqual(m.view().disk, { free: 10, total: 100, worktrees: 2098, reclaimable: 197 });
});

// --- the route ----------------------------------------------------------------------------------

test('GET /machine: the shape design/machine.md promises; WISP_TASK reaches the agent', async () => {
  const v = await api('/machine');
  assert.deepEqual(Object.keys(v), ['at', 'mem', 'cpu', 'disk', 'wisp', 'guard', 'tasks', 'crew', 'leftovers', 'history', 'reclaim']);
  assert.deepEqual(Object.keys(v.mem), ['total', 'freePct', 'pressure']);
  assert.deepEqual(Object.keys(v.cpu), ['pct', 'cores']);
  assert.deepEqual(Object.keys(v.disk), ['free', 'total', 'worktrees', 'reclaimable']);
  assert.deepEqual(Object.keys(v.wisp), ['rss', 'cpu']);
  assert.deepEqual(Object.keys(v.guard), ['held', 'why', 'floor', 'ceiling', 'maxRuns', 'runs', 'pausedUntil', 'battery']);
  assert.ok(v.mem.total > 0 && v.cpu.cores > 0 && v.wisp.rss > 0);
  for (const k of ['tasks', 'crew', 'leftovers', 'history', 'reclaim']) assert.ok(Array.isArray(v[k]), k);
  await assert.rejects(api('/machine/stop', { pid: process.pid }), (err) => err.status === 403);
  await assert.rejects(api('/machine/stop', { pid: 'x' }), (err) => err.status === 400);
  // Every harness's run carries WISP_TASK (the fake agent records it), and its handle the CLI's pid.
  const rec = tmp('machine-record');
  process.env.FAKE_RECORD = rec;
  const runs = [];
  const orig = srv.runner.live.set.bind(srv.runner.live);
  srv.runner.live.set = (id, h) => (runs.push([id, h.pid]), orig(id, h));
  try {
    for (const agent of ['claude', 'codex', 'opencode']) {
      const s = await api('/sessions', { prompt: 'hello', cwd: makeRepo(), agent, worktree: false });
      await until(() => fs.existsSync(path.join(rec, `${agent}.jsonl`)) && fs.readFileSync(path.join(rec, `${agent}.jsonl`), 'utf8').includes(s.id), { timeout: 20_000 });
      const got = fs.readFileSync(path.join(rec, `${agent}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).findLast((r) => r.task === s.id);
      assert.ok(got, `${agent} ran with WISP_TASK=${s.id}`);
      assert.ok(runs.some(([id, pid]) => id === s.id && pid === got.pid), `${agent}'s handle carries its CLI's pid`);
    }
  } finally {
    delete process.env.FAKE_RECORD;
    srv.runner.live.set = orig;
  }
});
