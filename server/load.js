// The RAM/CPU guard (design/budget.md → Machine load): like Automations stop at, but for this
// computer. Work nobody started by hand (check-ins, the crew queue, triggers, goal rounds, agents'
// own follow-ups and wake-ups) waits while free memory is under defaults.memoryFloor, the load is
// over defaults.cpuCeiling for 30 s, or wisp's own runs fill defaults.maxRuns. It goes on once memory
// is back 5 points above the floor, the load is under the ceiling and a run slot is free.
//
// Readings are sampled every 10 s off the event loop and read synchronously (reading(), hold(),
// busy()): Crew.view asks on every render. Never os.freemem() on macOS: it counts only free pages,
// so a Mac that caches files (all of them) always reads nearly full.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { SETTINGS } from '../web/js/spell-schema.js';

export const MEMORY_FLOORS = SETTINGS.memoryFloor;
export const CPU_CEILINGS = SETTINGS.cpuCeiling;
export const MAX_RUNS = SETTINGS.maxRuns;
export const LOAD_DEFAULTS = { memoryFloor: '15', cpuCeiling: '150', maxRuns: 'auto' };
export const SAMPLE_MS = 10_000;
export const CPU_HOLD_MS = 30_000; // the load stays over the ceiling this long before work waits
export const MARGIN = 5; // points above the floor before held work goes on (no flapping)
export const RETRY_MS = 60_000; // held work looks again this soon (it has no reset to wait for)
// Linux PSI: the share of the last 10 s some task stalled on memory. Over this the machine is short
// whatever MemAvailable says; under PSI_CLEAR it can go on.
export const PSI_HOLD = 25;
export const PSI_CLEAR = 10;
const GB = 1024 ** 3;

// --- parsing (pure, one per source) -----------------------------------------------------------

// `sysctl -n kern.memorystatus_level`: the free percentage memory_pressure prints (macOS, no root).
export function parseMemorystatus(text) {
  const t = String(text).trim();
  const n = Number(t);
  return /^\d+$/.test(t) && n <= 100 ? n : null;
}

// `vm_stat`: pages free + inactive + speculative + purgeable, of the machine's memory.
export function parseVmStat(text, total) {
  const s = String(text);
  const size = Number(/page size of (\d+) bytes/.exec(s)?.[1]) || 4096;
  const pages = (name) => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, 'm').exec(s)?.[1]);
  const got = ['free', 'inactive', 'speculative', 'purgeable'].map(pages);
  if (!Number.isFinite(got[0]) || !(total > 0)) return null;
  const free = got.filter(Number.isFinite).reduce((a, b) => a + b, 0) * size;
  return Math.max(0, Math.min(100, (free / total) * 100));
}

// /proc/meminfo: MemAvailable of MemTotal (both in kB).
export function parseMeminfo(text) {
  const kb = (name) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(String(text))?.[1]);
  const total = kb('MemTotal');
  const avail = kb('MemAvailable');
  return total > 0 && Number.isFinite(avail) ? Math.max(0, Math.min(100, (avail / total) * 100)) : null;
}

// /proc/pressure/memory: `some avg10=…`.
export function parsePressure(text) {
  const n = Number(/^some\b.*?\bavg10=([\d.]+)/m.exec(String(text))?.[1]);
  return Number.isFinite(n) ? n : null;
}

// Two os.cpus() samples: the busy share of every core, as a percent of one (0–100 on Windows).
export function cpuBusy(a, b) {
  if (!a?.length || a.length !== b?.length) return null;
  let busy = 0;
  let all = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Object.fromEntries(Object.keys(b[i].times).map((k) => [k, b[i].times[k] - (a[i].times[k] || 0)]));
    const total = Object.values(d).reduce((x, y) => x + y, 0);
    all += total;
    busy += total - d.idle;
  }
  return all > 0 ? (busy / all) * 100 : null;
}

// --- settings -------------------------------------------------------------------------------

const pick = (v, list, dflt) => (list.includes(v) ? v : dflt);
// maxRuns 'auto': a run (a CLI plus the tests and builds it starts) can reach 3 GB.
export const autoRuns = (totalBytes) => Math.max(2, Math.floor(totalBytes / GB / 3));

// The three knobs as numbers (null = off).
export function limitsOf(defaults = {}, totalBytes = os.totalmem()) {
  const floor = pick(defaults.memoryFloor, MEMORY_FLOORS, LOAD_DEFAULTS.memoryFloor);
  const ceiling = pick(defaults.cpuCeiling, CPU_CEILINGS, LOAD_DEFAULTS.cpuCeiling);
  const runs = pick(defaults.maxRuns, MAX_RUNS, LOAD_DEFAULTS.maxRuns);
  return {
    floor: floor === 'off' ? null : Number(floor),
    ceiling: ceiling === 'off' ? null : Number(ceiling),
    maxRuns: runs === 'off' ? null : runs === 'auto' ? autoRuns(totalBytes) : Number(runs),
  };
}

// --- readers ---------------------------------------------------------------------------------

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000, windowsHide: true }, (err, out) => resolve(err ? null : String(out)));
  });
const readText = (file) => fs.promises.readFile(file, 'utf8').catch(() => null);

// What the machine's memory reads now: { memFreePct, pressure? }. Each source is injectable.
export async function readMemory({ platform = process.platform, exec = run, readFile = readText, o = os } = {}) {
  if (platform === 'darwin') {
    const level = parseMemorystatus((await exec('sysctl', ['-n', 'kern.memorystatus_level'])) ?? '');
    if (level != null) return { memFreePct: level };
    const vm = await exec('vm_stat', []);
    return { memFreePct: vm == null ? null : parseVmStat(vm, o.totalmem()) };
  }
  if (platform === 'linux') {
    const [info, psi] = await Promise.all([readFile('/proc/meminfo'), readFile('/proc/pressure/memory')]);
    const pressure = psi == null ? null : parsePressure(psi);
    return { memFreePct: info == null ? null : parseMeminfo(info), ...(pressure != null && { pressure }) };
  }
  const total = o.totalmem();
  return { memFreePct: total > 0 ? (o.freemem() / total) * 100 : null };
}

// --- the guard ---------------------------------------------------------------------------------

const pct = (n) => `${Math.round(n)}%`;

export class Load {
  // runs(): wisp's own runs going now (its subagents and delegates count, other machines' don't).
  // defaults(): config.defaults. off: no sampling and nothing held (the test suite's servers).
  constructor({ runs = () => 0, defaults = () => ({}), platform = process.platform, exec, readFile, o = os, now = () => Date.now(), off = false, onChange = () => {} } = {}) {
    Object.assign(this, { runs, defaults, platform, exec, readFile, o, now, off, onChange });
    this.last = { memFreePct: null, cpu: null, at: 0 };
    this.memHeld = false;
    this.cpuOver = null; // since when the load has been over the ceiling
    this.cpus = null; // Windows: the previous os.cpus() sample
    this.timer = null;
    this.was = null;
  }

  start() {
    if (this.off || this.timer) return this;
    this.sample().catch(() => {});
    this.timer = setInterval(() => this.sample().catch(() => {}), SAMPLE_MS);
    this.timer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // One reading, from the injectable sources.
  async sample() {
    const mem = await readMemory({ platform: this.platform, exec: this.exec, readFile: this.readFile, o: this.o });
    let cpu = null;
    if (this.platform === 'win32') {
      const now = this.o.cpus();
      cpu = this.cpus ? cpuBusy(this.cpus, now) : null;
      this.cpus = now;
    } else {
      const cores = this.o.availableParallelism?.() || this.o.cpus().length || 1;
      cpu = (this.o.loadavg()[0] / cores) * 100;
    }
    this.feed({ ...mem, cpu });
  }

  // A reading in (sample(), or a test): updates the hysteresis, and says when held work may go.
  feed({ memFreePct = null, cpu = null, pressure = null } = {}) {
    this.last = { memFreePct, cpu, ...(pressure != null && { pressure }), at: this.now() };
    this.#settle();
    const free = !this.hold();
    if (this.was === false && free) this.onChange(this.reading());
    this.was = free;
  }

  // Hysteresis on the last reading against the knobs as they are now (a changed knob counts at once).
  #settle() {
    const { floor, ceiling } = limitsOf(this.defaults(), this.o.totalmem());
    const { memFreePct: m, pressure: p, cpu, at } = this.last;
    if (floor == null) this.memHeld = false;
    else if (!this.memHeld) this.memHeld = (m != null && m < floor) || (p != null && p >= PSI_HOLD);
    else this.memHeld = !((m == null || m >= floor + MARGIN) && (p == null || p < PSI_CLEAR));
    if (ceiling == null || cpu == null || cpu <= ceiling) this.cpuOver = null;
    else this.cpuOver ??= at;
  }

  // What the page and the API see: { memFreePct, cpu, runs, pressure?, at, limits, held }.
  reading() {
    const r = { ...this.last, runs: this.runs(), limits: limitsOf(this.defaults(), this.o.totalmem()) };
    const h = this.hold();
    return { ...r, held: h ? { kind: h.kind, why: h.why } : null };
  }

  // What holds back work nobody started by hand, or null. { load: true, kind, why, until }; until is
  // when it looks again (no reset to wait for), like Automations stop at's hold for its consumers.
  hold() {
    if (this.off) return null;
    this.#settle();
    const { floor, ceiling, maxRuns } = limitsOf(this.defaults(), this.o.totalmem());
    const { memFreePct: m, pressure: p, cpu } = this.last;
    const until = this.now() + RETRY_MS;
    if (this.memHeld && floor != null) {
      const why = m != null && m < floor + MARGIN ? `Waiting for memory: ${pct(m)} free, needs ${pct(floor + MARGIN)}` : `Waiting for memory: the system is stalling on it (${pct(p)} of the last 10 s)`;
      return { load: true, kind: 'memory', why, until };
    }
    if (ceiling != null && this.cpuOver != null && this.now() - this.cpuOver >= CPU_HOLD_MS) return { load: true, kind: 'cpu', why: `Waiting for the CPU: load at ${pct(cpu)} of its cores, needs under ${pct(ceiling)}`, until };
    const n = this.runs();
    if (maxRuns != null && n >= maxRuns) return { load: true, kind: 'runs', why: `Waiting for a run slot: ${n} run${n === 1 ? '' : 's'} going, at most ${maxRuns}`, until };
    return null;
  }

  // The machine is busy (the guard holds work): the worktree sweep and its `du` wait for the next hour.
  busy() {
    return !!this.hold();
  }

  // A run you start by hand goes anyway; when memory is under the floor the page says so (a toast).
  short() {
    if (this.off) return null;
    const { floor } = limitsOf(this.defaults(), this.o.totalmem());
    const m = this.last.memFreePct;
    if (floor == null || m == null || m >= floor) return null;
    const n = this.runs();
    const machine = this.platform === 'darwin' ? 'Your Mac' : 'This computer';
    return { why: `${machine} is short on memory: ${pct(m)} free, ${n} run${n === 1 ? '' : 's'} going` };
  }
}
