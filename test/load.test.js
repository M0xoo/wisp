// The RAM/CPU guard (server/load.js): each OS's reading, the hysteresis that keeps held work from
// flapping, maxRuns, and what it holds (work nobody started by hand) and what it never holds.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { installFakeBins, makeRepo, tmp, until } from './helpers.js';

// The server is set up before the first test (see test/budget.test.js for why).
process.env.WISP_HOME = tmp('load-wisp');
process.env.WISP_UPDATE_CHECK = '0';
process.env.CLAUDE_CONFIG_DIR = tmp('load-claude-home');
installFakeBins();
const { startServer } = await import('../server/index.js');
const { Load, readMemory, parseMemorystatus, parseVmStat, parseMeminfo, parsePressure, cpuBusy, limitsOf, autoRuns, CPU_HOLD_MS, RETRY_MS } = await import('../server/load.js');
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

const GB = 1024 ** 3;
const fakeOs = ({ total = 24 * GB, free = 20 * GB, load = 1, cores = 8, cpus } = {}) => ({
  totalmem: () => total,
  freemem: () => free,
  loadavg: () => [load, load, load],
  availableParallelism: () => cores,
  cpus: () => cpus?.() || Array.from({ length: cores }, () => ({ times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } })),
});
// A guard on a 24 GB, 8-core machine with a clock the test moves.
const guard = ({ defaults = {}, runs = 0, o = fakeOs(), ...rest } = {}) => {
  const clock = { t: 1_000_000 };
  const box = { runs };
  const l = new Load({ defaults: () => defaults, runs: () => box.runs, o, now: () => clock.t, ...rest });
  return { l, clock, box };
};

// --- parsing --------------------------------------------------------------------------------

test('macOS: kern.memorystatus_level is the free percent; anything else is no reading', () => {
  assert.equal(parseMemorystatus('42\n'), 42);
  assert.equal(parseMemorystatus(''), null);
  assert.equal(parseMemorystatus('sysctl: unknown oid'), null);
  assert.equal(parseMemorystatus('140'), null);
});

test('macOS vm_stat: free + inactive + speculative + purgeable pages of the machine', () => {
  const out = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               65536.
Pages active:                            500000.
Pages inactive:                           65536.
Pages speculative:                        32768.
Pages throttled:                              0.
Pages wired down:                        200000.
Pages purgeable:                          32768.
`;
  // 196608 pages × 16 KB = 3 GB of 24 GB.
  assert.equal(parseVmStat(out, 24 * GB), 12.5);
  assert.equal(parseVmStat('nothing here', 24 * GB), null);
});

test('Linux: MemAvailable of MemTotal, and PSI some avg10', () => {
  assert.equal(parseMeminfo('MemTotal:       16000000 kB\nMemFree:  100000 kB\nMemAvailable:    4000000 kB\n'), 25);
  assert.equal(parseMeminfo('MemTotal: 16000000 kB\n'), null, 'an old kernel without MemAvailable reads nothing');
  assert.equal(parsePressure('some avg10=12.50 avg60=3.00 avg300=1.00 total=123\nfull avg10=2.00 avg60=0.00 avg300=0.00 total=9\n'), 12.5);
  assert.equal(parsePressure(''), null);
});

test('Windows: CPU busy from two os.cpus() samples', () => {
  const a = [{ times: { user: 100, nice: 0, sys: 0, idle: 900, irq: 0 } }, { times: { user: 0, nice: 0, sys: 0, idle: 1000, irq: 0 } }];
  const b = [{ times: { user: 600, nice: 0, sys: 100, idle: 1300, irq: 0 } }, { times: { user: 0, nice: 0, sys: 0, idle: 2000, irq: 0 } }];
  // core 0: 600 busy of 1000; core 1: 0 of 1000.
  assert.equal(cpuBusy(a, b), 30);
  assert.equal(cpuBusy(null, b), null);
});

test('readMemory: macOS asks sysctl, then vm_stat, and never os.freemem', async () => {
  const o = { ...fakeOs(), freemem: () => assert.fail('os.freemem on macOS') };
  const calls = [];
  const exec = async (cmd) => (calls.push(cmd), cmd === 'sysctl' ? '37\n' : null);
  assert.deepEqual(await readMemory({ platform: 'darwin', exec, o }), { memFreePct: 37 });
  assert.deepEqual(calls, ['sysctl']);
  const vm = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 196608.\n';
  const fallback = async (cmd) => (cmd === 'vm_stat' ? vm : null);
  assert.deepEqual(await readMemory({ platform: 'darwin', exec: fallback, o }), { memFreePct: 12.5 });
  assert.deepEqual(await readMemory({ platform: 'darwin', exec: async () => null, o }), { memFreePct: null }, 'no reading holds nothing');
});

test('readMemory: Linux reads /proc, PSI when it’s there; Windows os.freemem', async () => {
  const files = { '/proc/meminfo': 'MemTotal: 1000 kB\nMemAvailable: 300 kB\n', '/proc/pressure/memory': 'some avg10=4.00 avg60=0 avg300=0 total=0\n' };
  assert.deepEqual(await readMemory({ platform: 'linux', readFile: async (f) => files[f] ?? null }), { memFreePct: 30, pressure: 4 });
  assert.deepEqual(await readMemory({ platform: 'linux', readFile: async (f) => (f === '/proc/meminfo' ? files[f] : null) }), { memFreePct: 30 });
  assert.deepEqual(await readMemory({ platform: 'win32', o: fakeOs({ total: 16 * GB, free: 2 * GB }) }), { memFreePct: 12.5 });
});

test('sample: CPU is the 1-minute load over the cores; on Windows the busy share between samples', async () => {
  const { l } = guard({ platform: 'linux', o: fakeOs({ load: 12, cores: 8 }), readFile: async () => null });
  await l.sample();
  assert.equal(l.reading().cpu, 150);
  let n = 0;
  const cpus = () => [{ times: { user: n * 50, nice: 0, sys: 0, idle: n++ * 50, irq: 0 } }];
  const w = guard({ platform: 'win32', o: fakeOs({ cores: 1, cpus }) }).l;
  await w.sample();
  assert.equal(w.reading().cpu, null, 'one sample is no reading yet');
  await w.sample();
  assert.equal(w.reading().cpu, 50);
});

// --- the knobs ------------------------------------------------------------------------------

test('limits: defaults 15% / 200% / auto; auto is one run per 3 GB, at least 2', () => {
  assert.deepEqual(limitsOf({}, 24 * GB), { floor: 15, ceiling: 200, maxRuns: 8 });
  assert.deepEqual(limitsOf({ memoryFloor: 'off', cpuCeiling: 'off', maxRuns: 'off' }, 24 * GB), { floor: null, ceiling: null, maxRuns: null });
  assert.deepEqual(limitsOf({ memoryFloor: '25', cpuCeiling: '200', maxRuns: '12' }), { floor: 25, ceiling: 200, maxRuns: 12 });
  assert.deepEqual(limitsOf({ memoryFloor: '7', maxRuns: '3' }, 24 * GB), { floor: 15, ceiling: 200, maxRuns: 8 }, 'a value off the list is the default');
  assert.equal(autoRuns(4 * GB), 2);
  assert.equal(autoRuns(64 * GB), 21);
});

// --- the hysteresis -------------------------------------------------------------------------

test('memory: holds under the floor, goes on only 5 points above it', () => {
  const { l } = guard();
  l.feed({ memFreePct: 16 });
  assert.equal(l.hold(), null);
  l.feed({ memFreePct: 11 });
  const h = l.hold();
  assert.equal(h.load, true);
  assert.equal(h.kind, 'memory');
  assert.equal(h.why, 'Waiting for memory: 11% free, needs 20%');
  assert.equal(h.until, 1_000_000 + RETRY_MS, 'it looks again in a minute');
  l.feed({ memFreePct: 18 });
  assert.equal(l.hold()?.why, 'Waiting for memory: 18% free, needs 20%', 'above the floor but under floor + 5: still held');
  l.feed({ memFreePct: 20 });
  assert.equal(l.hold(), null);
  l.feed({ memFreePct: 17 });
  assert.equal(l.hold(), null, 'back above the floor it takes going under again to hold');
});

test('memory: Linux PSI holds past 25% stalled and clears under 10%; floor off holds nothing', () => {
  const { l } = guard();
  l.feed({ memFreePct: 60, pressure: 30 });
  assert.match(l.hold().why, /stalling on it \(30% of the last 10 s\)/);
  l.feed({ memFreePct: 60, pressure: 15 });
  assert.ok(l.hold());
  l.feed({ memFreePct: 60, pressure: 5 });
  assert.equal(l.hold(), null);
  const off = guard({ defaults: { memoryFloor: 'off' } }).l;
  off.feed({ memFreePct: 2, pressure: 90 });
  assert.equal(off.hold(), null);
});

test('CPU: over the ceiling (200% by default) for 60 s holds; back under goes on at once', () => {
  const { l, clock } = guard();
  l.feed({ memFreePct: 80, cpu: 180 });
  clock.t += CPU_HOLD_MS;
  l.feed({ memFreePct: 80, cpu: 190 });
  assert.equal(l.hold(), null, 'under 200% holds nothing, however long');
  l.feed({ memFreePct: 80, cpu: 240 });
  assert.equal(l.hold(), null, 'a spike holds nothing');
  clock.t += CPU_HOLD_MS - 1;
  l.feed({ memFreePct: 80, cpu: 250 });
  assert.equal(l.hold(), null, 'a minute less a millisecond holds nothing');
  clock.t += 1;
  l.feed({ memFreePct: 80, cpu: 230 });
  assert.equal(l.hold().why, 'Waiting for the CPU: load at 230% of its cores, needs under 200%');
  l.feed({ memFreePct: 80, cpu: 150 });
  assert.equal(l.hold(), null);
  l.feed({ memFreePct: 80, cpu: 240 });
  assert.equal(l.hold(), null, 'the minute starts over');
  assert.equal(CPU_HOLD_MS, 60_000);
});

test('maxRuns: a full house holds until a slot is free; off never', () => {
  const { l, box } = guard({ runs: 8 });
  l.feed({ memFreePct: 80, cpu: 10 });
  assert.equal(l.hold().why, 'Waiting for a run slot: 8 runs going, at most 8');
  assert.equal(l.busy(), false, 'full run slots don’t stop the worktree sweep');
  box.runs = 7;
  assert.equal(l.hold(), null);
  const off = guard({ runs: 40, defaults: { maxRuns: 'off' } }).l;
  off.feed({ memFreePct: 80 });
  assert.equal(off.hold(), null);
});

test('onChange once held work may go; busy() for the worktree sweep; short() for a run of yours', () => {
  const seen = [];
  const { l, box } = guard({ onChange: (r) => seen.push(r), runs: 3, platform: 'darwin' });
  l.feed({ memFreePct: 12 });
  assert.equal(l.busy(), true);
  assert.deepEqual(l.short(), { why: 'Your Mac is short on memory: 12% free, 3 runs going' });
  l.feed({ memFreePct: 13 });
  assert.equal(seen.length, 0);
  l.feed({ memFreePct: 30 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].held, null);
  assert.equal(l.busy(), false);
  assert.equal(l.short(), null);
  box.runs = 1;
  l.feed({ memFreePct: 9 });
  assert.equal(l.short().why, 'Your Mac is short on memory: 9% free, 1 run going');
  assert.equal(guard({ platform: 'linux' }).l.short(), null, 'no reading, nothing to say');
});

test('off (the suite’s servers): never samples, never holds', () => {
  const { l } = guard({ off: true });
  l.start();
  assert.equal(l.timer, null);
  l.feed({ memFreePct: 1 });
  assert.equal(l.hold(), null);
  assert.equal(l.short(), null);
});

// --- in wisp --------------------------------------------------------------------------------

// The server's guard on, with a reading the test sets. maxRuns off unless a test wants it: other
// tests' runs may still be ending.
const short = (memFreePct) => {
  srv.load.off = false;
  srv.load.feed({ memFreePct, cpu: 10 });
};
const calm = () => {
  srv.load.feed({ memFreePct: 90, cpu: 10 });
  srv.load.off = true;
};

test('settings: three fixed lists, refused otherwise; GET /load says what it reads and holds', async () => {
  await assert.rejects(api('/config', { defaults: { memoryFloor: '12' } }, 'PATCH'), /memoryFloor must be one of off, 10, 15, 20, 25/);
  await assert.rejects(api('/config', { defaults: { cpuCeiling: '120' } }, 'PATCH'), /cpuCeiling must be one of off, 100, 150, 200/);
  await assert.rejects(api('/config', { defaults: { maxRuns: '5' } }, 'PATCH'), /maxRuns must be one of off, 4, 6, 8, 12, 16, auto/);
  await api('/config', { defaults: { memoryFloor: '20', maxRuns: 'off' } }, 'PATCH');
  try {
    short(11);
    const r = await api('/load');
    assert.equal(r.memFreePct, 11);
    assert.deepEqual(r.limits, { floor: 20, ceiling: 200, maxRuns: null });
    assert.deepEqual(r.held, { kind: 'memory', why: 'Waiting for memory: 11% free, needs 25%' });
  } finally {
    calm();
    await api('/config', { defaults: { memoryFloor: '15', maxRuns: 'auto' } }, 'PATCH');
  }
});

test('short on memory: yours runs (and the page hears so), an agent’s follow-up and an unattended launch wait', async () => {
  await api('/config', { defaults: { maxRuns: 'off' } }, 'PATCH');
  const ac = new AbortController();
  const events = await fetch(`${base}/api/events`, { signal: ac.signal });
  let seen = '';
  (async () => {
    try {
      for await (const chunk of events.body) seen += Buffer.from(chunk).toString('utf8');
    } catch {}
  })();
  const sent = () => [...seen.matchAll(/event: load\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]));
  try {
    short(9);
    const s = await api('/sessions', { prompt: 'fix the add bug please', cwd: makeRepo(), agent: 'claude', worktree: false });
    await until(async () => (await api(`/sessions/${s.id}`)).state === 'review', { timeout: 30_000 });
    await until(() => sent().length === 1);
    assert.match(sent()[0].why, /short on memory: 9% free, \d+ runs? going/);
    // An unattended launch (a check-in's, a trigger's) is refused with the hold.
    await assert.rejects(srv.launcher.launch({ prompt: 'check in', cwd: makeRepo(), agent: 'claude', worktree: false }, null, { unattended: true }), (err) => err.held?.load === true && /Waiting for memory: 9% free, needs 20%/.test(err.message));
    // The crew's own hold says so too, for a member on Auto.
    assert.equal(srv.reserve.check('claude')?.kind, 'memory');
    // A follow-up an agent scheduled waits a minute; yours goes.
    const live = srv.store.get(s.id);
    await until(() => !srv.runner.live.has(s.id));
    srv.later.add(live, { text: 'look at CI again', by: 'agent', in: 2 });
    srv.later.add(live, { text: 'and mine', by: 'user', in: 3 });
    for (const l of live.later) l.at = Date.now() - 1000;
    await srv.later.tick();
    const x = await until(async () => {
      const y = await api(`/sessions/${s.id}`);
      return y.turns.length === 2 && y.turns[1].status !== 'running' && y;
    }, { timeout: 30_000 });
    assert.equal(x.turns[1].prompt, 'and mine');
    assert.equal(x.later.length, 1);
    assert.equal(x.later[0].held.load, true);
    assert.equal(x.later[0].held.why, 'Waiting for memory: 9% free, needs 20%');
    assert.ok(x.later[0].at > Date.now() + 30_000, 'it looks again in about a minute');
    // Memory back above floor + 5: the next tick sends it, once turn 2's CLI has let go (Later
    // never sends over a live run, and a slow runner still holds the handle after the turn ends).
    calm();
    await until(() => !srv.runner.live.has(s.id) && srv.store.get(s.id).state !== 'running');
    srv.store.get(s.id).later[0].at = Date.now() - 1000;
    await srv.later.tick();
    assert.equal(srv.store.get(s.id).later, undefined, 'the tick sent it');
    await until(async () => (await api(`/sessions/${s.id}`)).turns.length === 3, { timeout: 30_000 });
  } finally {
    ac.abort();
    calm();
    await api('/config', { defaults: { maxRuns: 'auto' } }, 'PATCH');
  }
});

test('the plan check stays the plan’s alone: an early reset isn’t blocked by the machine', () => {
  short(5);
  try {
    assert.equal(srv.reserve.plan('claude'), null);
    assert.equal(srv.reserve.check('claude')?.load, true);
  } finally {
    calm();
  }
});

test('the worktree sweep skips while memory is under the floor or the CPU over its ceiling, not for full run slots', async () => {
  const now = srv.load.now;
  try {
    short(9);
    assert.deepEqual(await srv.worktrees.sweep(), { skipped: 'busy' }, 'short on memory');
    calm();
    assert.equal((await srv.worktrees.sweep()).skipped, undefined, 'room again: it sweeps');
    // The CPU over 200% for a minute.
    const t0 = Date.now();
    srv.load.off = false;
    srv.load.now = () => t0;
    srv.load.feed({ memFreePct: 90, cpu: 300 });
    srv.load.now = () => t0 + 60_000;
    assert.equal(srv.load.hold()?.kind, 'cpu');
    assert.deepEqual(await srv.worktrees.sweep(), { skipped: 'busy' }, 'CPU over the ceiling');
    // Every run slot taken holds automations, but a sweep costs disk, not a run.
    srv.load.now = now;
    srv.load.feed({ memFreePct: 90, cpu: 10 });
    const runs = srv.load.runs;
    srv.load.runs = () => 99;
    try {
      assert.equal(srv.load.hold()?.kind, 'runs');
      assert.equal((await srv.worktrees.sweep()).skipped, undefined);
    } finally {
      srv.load.runs = runs;
    }
  } finally {
    srv.load.now = now;
    calm();
  }
});
