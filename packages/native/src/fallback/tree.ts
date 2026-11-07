// Killing a tree without wisp-native (ported from v1 server/proc.js killTree, made thorough).
// Unix: every child leads its own process group (spawned detached), so one kill(-pid) reaches the
// tree; a process that left the group is found by walking parent links in a `ps` snapshot taken
// before anything dies. Windows: taskkill /T, as v1 did.

import { execFile, spawnSync } from 'node:child_process';
import type { Signal } from '../protocol.ts';
import type { KillReport } from '../types.ts';

interface Row {
  pid: number;
  ppid: number;
  pgid: number;
  zombie: boolean;
}

const POLL_MS = 50;
const KILL_WAIT_MS = 2000;

/** The process table, or null where ps can't say (an odd platform, busybox without -o pgid). */
export function table(): Promise<Row[] | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat='], { maxBuffer: 16 << 20 }, (err, out) => {
      if (err) return resolve(null);
      resolve(parsePs(out));
    });
  });
}

export function parsePs(out: string): Row[] {
  const rows: Row[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), zombie: (m[4] ?? '').startsWith('Z') });
  }
  return rows;
}

/** The tree's live pids: its group, the root while it runs, and their descendants. */
export function members(root: number, rootAlive: boolean, rows: readonly Row[]): Set<number> {
  const live = rows.filter((r) => !r.zombie);
  // An exited root's pid may belong to a stranger by now; its group id can't (a pgid is not
  // reused while the group has members), so only the group seeds the walk then.
  const set = new Set(live.filter((r) => r.pgid === root || (rootAlive && r.pid === root)).map((r) => r.pid));
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of live) {
      if (!set.has(r.pid) && set.has(r.ppid)) {
        set.add(r.pid);
        grew = true;
      }
    }
  }
  set.delete(process.pid);
  for (const p of set) if (p <= 1) set.delete(p);
  return set;
}

function send(root: number, pids: Iterable<number>, sig: Signal): void {
  // ESRCH (already gone) is the expected outcome for most of these.
  try {
    if (root > 1) process.kill(-root, sig);
  } catch {}
  for (const pid of pids) {
    try {
      process.kill(pid, sig);
    } catch {}
  }
}

async function left(root: number, seen: ReadonlySet<number>): Promise<Set<number>> {
  const rows = await table();
  if (!rows) return groupAlive(root) ? new Set([root]) : new Set();
  const now = members(root, false, rows);
  for (const r of rows) if (!r.zombie && seen.has(r.pid)) now.add(r.pid);
  return now;
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(limitMs: number, count: () => Promise<number>): Promise<number> {
  const end = Date.now() + limitMs;
  for (;;) {
    const n = await count();
    if (n === 0 || Date.now() >= end) return n;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

export async function killTreeUnix(root: number, rootAlive: boolean, sig: Signal, graceMs: number): Promise<KillReport> {
  const rows = await table();
  const first = rows ? members(root, rootAlive, rows) : new Set(rootAlive ? [root] : []);
  const signalled = first.size;
  if (sig !== 'SIGKILL') {
    send(root, first, sig);
    send(root, first, 'SIGCONT'); // a stopped process can't act on SIGTERM
    await until(graceMs, async () => (await left(root, first)).size);
  }
  const seen = new Set(first);
  // Processes forked while the tree was dying are new members: walk again each round.
  const survivors = await until(KILL_WAIT_MS, async () => {
    const now = await left(root, seen);
    send(root, now, 'SIGKILL');
    for (const p of now) seen.add(p);
    return now.size;
  });
  return { signalled, survivors };
}

/** A signal to the tree without waiting (the group, plus anything that left it). */
export async function signalTreeUnix(root: number, rootAlive: boolean, sig: Signal): Promise<void> {
  const rows = await table();
  send(root, rows ? members(root, rootAlive, rows) : [], sig);
}

/** v1's taskkill /T; Windows has no process groups to fall back on. */
export function killTreeWindows(pid: number, rootAlive: boolean): KillReport {
  if (!rootAlive) return { signalled: 0, survivors: 0 };
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  return { signalled: 1, survivors: alive ? 1 : 0 };
}

/** On the way out (process 'exit', so synchronous): SIGKILL every tree, no waiting. */
export function killGroupsNow(pids: Iterable<number>): void {
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else process.kill(-pid, 'SIGKILL');
    } catch {}
  }
}
