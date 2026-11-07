// What agents cost this computer (design/machine.md): per running task its memory, CPU and process
// count, what finished runs left running, a day of 1-minute points, the worktree folders that can go,
// and two more holds on automations: Pause automations (defaults.automationsPausedUntil) and, on a
// Mac on battery, defaults.batteryHold. Both hold through server/load.js (Load's extra()), so they
// reach exactly what the RAM/CPU guard holds.
//
// Cheap by design: one `ps` per 10 s tick (Windows: one Get-CimInstance Win32_Process), and only
// while something runs, a run ended in the last 3 min, or someone read GET /machine in the last 30 s.
// Disk numbers are Settings → Worktrees' last look; nothing here runs `du`.
//
// Attribution: every run is spawned with WISP_TASK=<task id> (server/runner.js runEnv), and its tree
// is everything under the runner's child pid. A pid once seen in a tree keeps its task, so a process
// reparented to pid 1 is still known; Linux's /proc/<pid>/environ (and macOS's `ps -E`, where the
// system shows other processes' env) finds the tag on ones wisp never saw.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SETTINGS } from '../web/js/spell-schema.js';
import { limitsOf, RETRY_MS } from './load.js';
import { bad, writeJsonAtomic } from './util.js';

export const TICK_MS = 10_000;
export const READ_MS = 30_000; // a read of GET /machine keeps the ticks going this long
export const AFTER_MS = 180_000; // ...and so does a run that just ended: what it left behind shows
export const LEFT_MS = 120_000; // a finished run's process this old is left behind
export const POINT_MS = 60_000;
export const HISTORY_MS = 24 * 3_600_000;
export const KILL_MS = 5_000; // SIGTERM, then SIGKILL this long after
export const RES_RSS = 500 * 1024 ** 2; // a task's summary shows its res over these
export const RES_CPU = 50;
export const RES_MOVE = 0.2; // ...and is sent again only when it moved this much
export const BATTERY_HOLDS = SETTINGS.batteryHold;
export const BATTERY_DEFAULT = '20';
const SAVE_EVERY = 5; // history points between writes
const COMMAND_MAX = 200;

// --- parsing (pure) -----------------------------------------------------------------------------

// ps etime: [[dd-]hh:]mm:ss, as ms.
export function parseEtime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s).trim());
  if (!m) return 0;
  const [, d = 0, h = 0, min, sec] = m.map((x) => Number(x || 0));
  return (((Number(d) * 24 + Number(h)) * 60 + min) * 60 + sec) * 1000;
}

// The env macOS's `ps -E` puts after a command: from the first ` NAME=`. An argument shaped like that
// cuts the command early, never late, so no env value reaches the page.
const cutEnv = (s) => {
  const i = s.search(/\s[A-Za-z_][A-Za-z0-9_]*=/);
  return (i < 0 ? s : s.slice(0, i)).trim();
};
const tagIn = (s) => /(?:^|\s)WISP_TASK=([A-Za-z0-9_-]{1,64})(?=\s|$)/.exec(s)?.[1];

// `ps -o pid=,ppid=,rss=,%cpu=,etime=,command=` (macOS, Linux). env: the commands carry their env (-E).
export function parsePs(text, { now = Date.now(), env = false } = {}) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[6];
    const task = env ? tagIn(rest) : null;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]) * 1024, cpu: Number(m[4]), since: now - parseEtime(m[5]), command: (env ? cutEnv(rest) : rest.trim()).slice(0, COMMAND_MAX), ...(task && { task }) });
  }
  return out;
}

// Windows: Get-CimInstance Win32_Process as JSON (one object when there's one process). T is kernel +
// user time in 100 ns units: the CPU share comes from two ticks (Machine). S: start, ms.
export const WIN_PS = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,@{n='T';e={[int64]$_.KernelModeTime+[int64]$_.UserModeTime}},@{n='S';e={if($_.CreationDate){([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}else{0}}},CommandLine | ConvertTo-Json -Compress";
export function parseWin(text, { now = Date.now() } = {}) {
  let j;
  try {
    j = JSON.parse(String(text));
  } catch {
    return [];
  }
  return (Array.isArray(j) ? j : [j]).filter((p) => p && Number.isInteger(p.ProcessId)).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId || 0, rss: Number(p.WorkingSetSize) || 0, cpu: 0, time: Number(p.T) || 0, since: Number(p.S) || now, command: String(p.CommandLine || '').slice(0, COMMAND_MAX) }));
}

// /proc/<pid>/environ: NUL-separated.
export const tagInEnviron = (text) => String(text).split('\0').find((x) => x.startsWith('WISP_TASK='))?.slice(10) || null;

// `pmset -g batt`: { pct, charging } (charging: on the charger), or null on a Mac without a battery.
export function parseBatt(text) {
  const s = String(text);
  const m = /InternalBattery[^\n]*?(\d{1,3})%/.exec(s);
  if (!m) return null;
  return { pct: Number(m[1]), charging: !/'Battery Power'/.test(s) };
}

export const batteryLimit = (defaults = {}) => {
  const v = BATTERY_HOLDS.includes(defaults.batteryHold) ? defaults.batteryHold : BATTERY_DEFAULT;
  return v === 'off' ? null : Number(v);
};

// "20:00" today, "tomorrow 08:00", else "Mon 08:00".
export function untilText(at, now = Date.now()) {
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = (x) => new Date(x).toDateString();
  if (day(at) === day(now)) return hm;
  if (day(at) === day(now + 86_400_000)) return `tomorrow ${hm}`;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm}`;
}

// --- the readers ----------------------------------------------------------------------------------

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, out) => resolve(err && !out ? null : String(out || '')));
  });
const readText = (file) => fs.promises.readFile(file, 'utf8').catch(() => null);
const sum = (list, k) => list.reduce((n, x) => n + (x[k] || 0), 0);
const round = (n, d = 1) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

export class Machine {
  // runner: live handles (each with the pid of its CLI). store: tasks and config. worktrees():
  // services/worktrees. load: server/load.js. crewName(id): a member's name. summary(s): send the
  // task's summary again (its res moved). onChange(): config changed (pause). off: no ticks (tests).
  constructor({ home, runner, store, worktrees = () => null, load = null, crewName = () => '', summary = () => {}, onChange = () => {}, res = new Map(), platform = process.platform, exec = run, readFile = readText, now = () => Date.now(), pid = process.pid, kill = (p, sig) => process.kill(p, sig), o = os, off = false } = {}) {
    Object.assign(this, { home, runner, store, worktrees, load, crewName, summary, onChange, res, platform, exec, readFile, now, pid, kill, o, off });
    // The folder a left-behind command line names, matched as the platform writes paths: on Windows
    // a command line may use / or \\ and any case for the same folder (C:/Users vs c:\\users).
    const p = platform === 'win32' ? path.win32 : path.posix;
    this.wtDir = this.#pathKey(p.join(home || '', 'worktrees') + p.sep);
    this.file = path.join(home || '', 'machine-history.json');
    this.procs = [];
    this.byPid = new Map();
    this.at = 0; // the last snapshot
    this.tags = new Map(); // pid -> { task, since }: whose it is, kept past a reparent
    this.environ = new Map(); // Linux: pid -> { since, task } read from /proc, once per process
    this.trees = new Map(); // task id -> Set of pids, for the runs going now
    this.ancestors = new Set();
    this.leftovers = [];
    this.lastRead = 0;
    this.lastLive = 0;
    this.battery = null;
    this.winPrev = new Map(); // Windows: pid -> { time, at } of the previous tick
    this.history = this.#loadHistory();
    this.unsaved = 0;
    this.ticking = null;
    this.timers = [];
  }

  #pathKey(s) {
    return this.platform === 'win32' ? String(s).replace(/\\/g, '/').toLowerCase() : String(s);
  }

  start() {
    if (this.off || this.timers.length) return this;
    const safe = (fn) => () => fn().catch((err) => console.warn(`wisp: machine: ${err.message}`));
    this.timers = [setInterval(safe(() => this.tick()), TICK_MS), setInterval(safe(() => this.point()), POINT_MS)];
    for (const t of this.timers) t.unref?.();
    safe(() => this.readBattery())();
    return this;
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.#saveHistory();
  }

  // --- holds (Load's extra()) ---

  pausedUntil() {
    const u = Number(this.store?.config?.defaults?.automationsPausedUntil) || 0;
    return u > this.now() ? u : 0;
  }

  // Pause automations, or on battery under batteryHold: { load, kind, why, until }, or null. until is
  // a minute off at most, so Resume now (or the charger) lets held work go within one.
  hold() {
    const now = this.now();
    const paused = this.pausedUntil();
    if (paused) return { load: true, kind: 'paused', why: `Automations paused until ${untilText(paused, now)}`, until: Math.min(paused, now + RETRY_MS) };
    const at = batteryLimit(this.store?.config?.defaults);
    const b = this.battery;
    if (at != null && b && !b.charging && b.pct < at) return { load: true, kind: 'battery', why: `Waiting for power: battery at ${b.pct}%, needs ${at}% or the charger`, until: now + RETRY_MS };
    return null;
  }

  async readBattery() {
    if (this.platform !== 'darwin' || batteryLimit(this.store?.config?.defaults) == null) return (this.battery = null);
    const out = await this.exec('pmset', ['-g', 'batt']);
    this.battery = out == null ? null : parseBatt(out);
    return this.battery;
  }

  // POST /automations/pause { until }: ms, or 0 to resume.
  pause(until) {
    const u = Number(until);
    if (!Number.isFinite(u) || u < 0) throw bad('until must be a time in ms, or 0 to resume', 400);
    if (u && u <= this.now()) throw bad('until must be in the future (0 resumes)', 400);
    if (u > this.now() + 30 * 86_400_000) throw bad('until is at most 30 days away', 400);
    const d = this.store.config.defaults;
    if (u) d.automationsPausedUntil = Math.round(u);
    else delete d.automationsPausedUntil;
    this.store.saveConfig();
    this.onChange();
    return { pausedUntil: this.pausedUntil() };
  }

  // --- the snapshot ---

  async #snapshot() {
    const now = this.now();
    if (this.platform === 'win32') {
      const list = parseWin((await this.exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN_PS])) ?? '', { now });
      const seen = new Map();
      for (const p of list) {
        const prev = this.winPrev.get(p.pid);
        // 100 ns units over the ms between ticks, as a percent of one core (ps's %cpu).
        if (prev && now > prev.at && p.time >= prev.time) p.cpu = round(((p.time - prev.time) / ((now - prev.at) * 10_000)) * 100);
        seen.set(p.pid, { time: p.time, at: now });
      }
      this.winPrev = seen;
      return list;
    }
    const darwin = this.platform === 'darwin';
    const args = darwin ? ['-axwwE', '-o', 'pid=,ppid=,rss=,%cpu=,etime=,command='] : ['-eww', '-o', 'pid=,ppid=,rss=,%cpu=,etime=,args='];
    const out = await this.exec('ps', args);
    return out == null ? [] : parsePs(out, { now, env: darwin });
  }

  // One tick: a snapshot when something runs or someone looks. force: GET /machine, a stop.
  async tick({ force = false } = {}) {
    if (this.off && !force) return;
    const now = this.now();
    if (this.runner.live.size) this.lastLive = now;
    if (!force && !this.runner.live.size && now - this.lastRead > READ_MS && now - this.lastLive > AFTER_MS) return;
    return (this.ticking ||= (async () => {
      const list = await this.#snapshot();
      await this.#attribute(list);
      this.#settleRes();
    })().finally(() => (this.ticking = null)));
  }

  #descendants(root, kids) {
    const out = new Set();
    const stack = [root];
    while (stack.length) {
      const pid = stack.pop();
      if (out.has(pid)) continue;
      out.add(pid);
      for (const k of kids.get(pid) || []) stack.push(k);
    }
    return out;
  }

  async #attribute(list) {
    const now = this.now();
    const byPid = new Map(list.map((p) => [p.pid, p]));
    const kids = new Map();
    for (const p of list) if (p.pid !== p.ppid) kids.set(p.ppid, [...(kids.get(p.ppid) || []), p.pid]);
    const same = (p, t) => Math.abs(p.since - t.since) < 5000; // a pid the OS gave to another process doesn't keep the tag
    for (const [pid, t] of this.tags) if (!byPid.has(pid) || !same(byPid.get(pid), t)) this.tags.delete(pid);
    for (const [pid, t] of this.environ) if (!byPid.has(pid) || !same(byPid.get(pid), t)) this.environ.delete(pid);
    const known = (id) => !!id && !!this.store.get(id);
    // The runs' trees, from the runner's child pids.
    const trees = new Map();
    for (const [id, h] of this.runner.live) {
      if (!h?.pid || !byPid.has(h.pid)) continue;
      const set = this.#descendants(h.pid, kids);
      trees.set(id, set);
      for (const pid of set) this.tags.set(pid, { task: id, since: byPid.get(pid).since });
    }
    // wisp itself, what it started outside a run (Preview, the panel's shells and terminals), and
    // what started it: never a task's, never left behind, never stopped.
    const inRuns = new Set([...trees.values()].flatMap((s) => [...s]));
    const own = new Set([...this.#descendants(this.pid, kids)].filter((pid) => !inRuns.has(pid)));
    const ancestors = new Set();
    for (let p = byPid.get(this.pid)?.ppid, n = 0; p > 0 && n < 64; p = byPid.get(p)?.ppid, n++) ancestors.add(p);
    const ours = (pid) => own.has(pid) || ancestors.has(pid) || pid <= 1;
    // Tags from the processes' own env: ps -E's, or Linux's /proc (read once per process).
    for (const p of list) {
      if (inRuns.has(p.pid) || ours(p.pid) || this.tags.has(p.pid)) continue;
      let task = p.task;
      if (!task && this.platform === 'linux' && p.rss > 0) {
        if (!this.environ.has(p.pid)) this.environ.set(p.pid, { since: p.since, task: tagInEnviron((await this.readFile(`/proc/${p.pid}/environ`)) ?? '') });
        task = this.environ.get(p.pid).task;
      }
      if (known(task)) this.tags.set(p.pid, { task, since: p.since });
    }
    // A tagged process reparented away while its task still runs is still the task's.
    for (const [pid, t] of this.tags) if (trees.has(t.task) && !ours(pid)) trees.get(t.task).add(pid);
    const inTree = new Set([...trees.values()].flatMap((s) => [...s]));
    // Left behind: tagged with a task that isn't running, or orphaned with a command under
    // <home>/worktrees, and what those started.
    const orphan = (p) => p.ppid <= 1 || !byPid.has(p.ppid) || /(^|\/)(launchd|systemd|init)\b/.test(byPid.get(p.ppid).command);
    const left = new Set();
    for (const p of list) {
      if (inTree.has(p.pid) || ours(p.pid)) continue;
      const t = this.tags.get(p.pid)?.task;
      if (t || (orphan(p) && this.#pathKey(p.command).includes(this.wtDir))) for (const pid of this.#descendants(p.pid, kids)) if (!inTree.has(pid) && !ours(pid)) left.add(pid);
    }
    this.leftovers = [...left]
      .map((pid) => byPid.get(pid))
      .filter((p) => now - p.since >= LEFT_MS)
      .map((p) => {
        const t = this.tags.get(p.pid)?.task;
        return { pid: p.pid, command: p.command, rss: p.rss, cpu: round(p.cpu), task: known(t) ? t : null, since: p.since };
      })
      .sort((a, b) => b.rss - a.rss);
    Object.assign(this, { procs: list, byPid, trees, ancestors, at: now });
  }

  // Per running task: { rss, cpu, procs } summed over its tree.
  #rows() {
    const out = new Map();
    for (const [id, set] of this.trees) {
      const ps = [...set].map((pid) => this.byPid.get(pid)).filter(Boolean);
      out.set(id, { rss: sum(ps, 'rss'), cpu: round(sum(ps, 'cpu')), procs: ps.length });
    }
    return out;
  }

  // A heavy run's summary carries res; sent again only when it moved by RES_MOVE (or went light).
  #settleRes() {
    const rows = this.#rows();
    const moved = (a, b) => Math.abs(a - b) > Math.max(a, 1) * RES_MOVE;
    for (const [id, r] of rows) {
      const prev = this.res.get(id);
      const heavy = r.rss > RES_RSS || r.cpu > RES_CPU;
      if (heavy && (!prev || moved(prev.rss, r.rss) || moved(prev.cpu, r.cpu))) this.res.set(id, { rss: r.rss, cpu: r.cpu });
      else if (!heavy && prev) this.res.delete(id);
      else continue;
      const s = this.store.get(id);
      if (s) this.summary(s);
    }
    for (const id of [...this.res.keys()]) {
      if (rows.has(id)) continue;
      this.res.delete(id);
      const s = this.store.get(id);
      if (s) this.summary(s);
    }
  }

  // --- stop ---

  // POST /machine/stop { pid }: a left-behind process, or one in a running task's tree.
  async stopPid(pid) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 1) throw bad('pid must be a process id', 400);
    await this.tick({ force: true });
    if (n === this.pid || this.ancestors.has(n)) throw bad('That is wisp itself: it isn’t stopped from here.', 403);
    const mine = this.leftovers.some((l) => l.pid === n) || [...this.trees.values()].some((s) => s.has(n));
    if (!mine) throw bad('Not a process a task of wisp’s started, or it already ended.', 403);
    const since = this.byPid.get(n)?.since;
    try {
      this.kill(n, 'SIGTERM');
    } catch (err) {
      if (err.code !== 'ESRCH') throw bad(`Couldn’t stop ${n}: ${err.message}`, 500);
    }
    const t = setTimeout(() => {
      try {
        this.kill(n, 0); // still there after 5 s
        this.kill(n, 'SIGKILL');
      } catch {}
    }, KILL_MS);
    t.unref?.();
    this.leftovers = this.leftovers.filter((l) => l.pid !== n);
    return { stopped: n, since };
  }

  // --- history ---

  #loadHistory() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const from = this.now() - HISTORY_MS;
      return (Array.isArray(j) ? j : []).filter((p) => p && p.at > from).slice(-Math.ceil(HISTORY_MS / POINT_MS));
    } catch {
      return [];
    }
  }

  #saveHistory() {
    if (!this.home || !this.unsaved) return;
    try {
      writeJsonAtomic(this.file, this.history);
      this.unsaved = 0;
    } catch (err) {
      console.warn(`wisp: machine history: ${err.message}`);
    }
  }

  // One 1-minute point; the ring keeps 24 h. Also when the battery is read again.
  async point() {
    const r = this.load?.reading?.() || {};
    let wt = null;
    try {
      wt = this.worktrees()?.view({ look: false });
    } catch {}
    this.history.push({ at: this.now(), freePct: round(r.memFreePct), cpu: round(r.cpu), runs: this.runner.live.size, held: !!this.load?.hold?.(), worktreeBytes: wt?.size ?? null });
    const from = this.now() - HISTORY_MS;
    while (this.history.length && this.history[0].at <= from) this.history.shift();
    if (++this.unsaved >= SAVE_EVERY) this.#saveHistory();
    await this.readBattery().catch(() => {});
  }

  // --- the view ---

  // Groups of folders Clean up can take, each a list for POST /worktrees/clean.
  reclaim(wt) {
    const groups = { merged: { ids: [], bytes: 0 }, done: { ids: [], bytes: 0 }, crew: { ids: [], bytes: 0 }, leftover: { ids: [], bytes: 0 } };
    for (const it of wt?.items || []) {
      const s = this.store.get(it.id);
      if (!s || it.status !== 'idle') continue;
      const kind = [s, ...(s.also || [])].some((x) => ['MERGED', 'CLOSED'].includes(x.pr?.state)) ? 'merged' : s.crew && ['done', 'review'].includes(s.state) ? 'crew' : s.state === 'done' ? 'done' : null;
      if (!kind) continue;
      groups[kind].ids.push(it.id);
      groups[kind].bytes += it.size || 0;
    }
    for (const l of wt?.leftovers || []) {
      if (l.only !== 0) continue; // holds work of its own, or unread: Settings → Worktrees, by hand
      groups.leftover.ids.push(l.name);
      groups.leftover.bytes += l.size || 0;
    }
    return Object.entries(groups).filter(([, g]) => g.ids.length).map(([kind, g]) => ({ kind, count: g.ids.length, bytes: g.bytes, ids: g.ids }));
  }

  // GET /machine. A read keeps the ticks going for READ_MS; a stale snapshot is taken first.
  async read() {
    this.lastRead = this.now();
    if (this.now() - this.at > TICK_MS * 1.5) await this.tick({ force: true });
    return this.view();
  }

  view() {
    const now = this.now();
    let wt = null;
    try {
      wt = this.worktrees()?.view();
    } catch {}
    const r = this.load?.reading?.() || {};
    const limits = r.limits || limitsOf(this.store?.config?.defaults, this.o.totalmem());
    const h = this.load?.hold?.() || this.hold();
    const sizes = new Map((wt?.items || []).map((x) => [x.id, x.size]));
    const rows = this.#rows();
    const tasks = [...rows]
      .map(([id, x]) => {
        const s = this.store.get(id);
        return { id, title: s?.title || '', crew: s?.crew?.id || null, rss: x.rss, cpu: x.cpu, procs: x.procs, worktreeBytes: sizes.get(id) ?? null };
      })
      .sort((a, b) => b.rss - a.rss);
    const crew = new Map();
    for (const t of tasks) {
      if (!t.crew) continue;
      const c = crew.get(t.crew) || { id: t.crew, name: this.crewName(t.crew) || '', rss: 0, cpu: 0, jobs: 0 };
      Object.assign(c, { rss: c.rss + t.rss, cpu: round(c.cpu + (t.cpu || 0)), jobs: c.jobs + 1 });
      crew.set(t.crew, c);
    }
    const reclaim = this.reclaim(wt);
    const self = this.byPid.get(this.pid);
    const at = batteryLimit(this.store?.config?.defaults);
    return {
      at: now,
      mem: { total: this.o.totalmem(), freePct: round(r.memFreePct), pressure: r.pressure ?? null },
      cpu: { pct: round(r.cpu), cores: this.o.availableParallelism?.() || this.o.cpus().length || 1 },
      disk: { free: wt?.disk?.free ?? null, total: wt?.disk?.total ?? null, worktrees: wt?.size ?? null, reclaimable: sum(reclaim, 'bytes') },
      wisp: { rss: self?.rss ?? process.memoryUsage().rss, cpu: self ? round(self.cpu) : null },
      guard: { held: h?.kind || null, why: h?.why || null, floor: limits.floor, ceiling: limits.ceiling, maxRuns: limits.maxRuns, runs: this.runner.live.size, pausedUntil: this.pausedUntil(), battery: this.battery ? { pct: this.battery.pct, charging: this.battery.charging, hold: at } : null },
      tasks,
      crew: [...crew.values()].sort((a, b) => b.rss - a.rss),
      leftovers: this.leftovers,
      history: this.history,
      reclaim,
    };
  }
}
