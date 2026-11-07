// hostd's types and the helpers it shares with the CLI: what it knows of a box, how much memory the
// host has, and deleting a box for good (`wisp grid users --delete` calls deleteBox too).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTAINER, boxdCall, containerName, type Container } from './boxd.ts';
import { getJson, type BoxChild, type BoxStatus } from './hostd-run.ts';
import type { BoxUser } from './rows.ts';

// How long to wait between /api/health tries while a box boots: short at first, because a box that
// is up in 40 ms shouldn't wait 150 (v1 did, on every wake), then no busier than v1's 150 ms
// (bench/wake.ts has the numbers).
export const HEALTH_BACKOFF: readonly number[] = [5, 10, 20, 40, 80, 150];
// The memory one more box needs, on top of what the host keeps for itself (the grid, Caddy, boxd).
export const ADMIT = { boxMb: 1024, reserveMb: 1024 } as const;
export type Admit = { boxMb: number; reserveMb: number };

// "2560m" / "3g" / bytes → MiB.
export const mib = (size: unknown): number => {
  const m = /^(\d+)([bkmg]?)$/i.exec(String(size || '0'));
  const n = Number(m?.[1] || 0);
  const per: Record<string, number> = { b: n / 1048576, k: n / 1024, m: n, g: n * 1024, '': n / 1048576 };
  return Math.ceil(per[(m?.[2] || '').toLowerCase()] ?? 0);
};
type Status = Error & { status: number };
export const failure = (message: string, status: number): Status => Object.assign(new Error(message), { status });
export const full = (): Status => failure('This grid is full right now. Try again in a few minutes.', 503);
export const closing = (): Status => failure('The grid is shutting down.', 503);
export const deleting = (): Status => failure('This account is being deleted.', 410);

// MiB the host can still hand out: MemAvailable on Linux (counts reclaimable cache), else free.
// A procfs read: no disk, so it stays sync on the admission path.
export function availableMb(): number {
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) return Math.floor(Number(m[1]) / 1024);
  } catch {
    // not Linux
  }
  return Math.floor(os.freemem() / 1048576);
}

export interface ContainerSettings extends Container {
  boxd?: string;
  sandbox?: { memory?: string; memorySwap?: string; cpus?: number; pids?: number };
}

export const docker = (args: string[]): Promise<number | null> =>
  new Promise((resolve) => {
    const p = spawn('docker', args, { stdio: 'ignore' });
    p.on('error', () => resolve(127));
    p.on('exit', resolve);
  });

// A user's box and files, gone for good (their account is being deleted): the container, its home
// (with boxd, in boxd's folder), and data/users/<id>. Also what `wisp grid users --delete` runs.
export async function deleteBox({ dataDir, driver, container = {}, user }: { dataDir: string; driver: string; container?: Partial<ContainerSettings>; user: { id: string } }): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(String(user.id))) throw new Error(`"${user.id}" isn’t a user id.`);
  const c = { ...CONTAINER, ...container };
  if (driver === 'container') {
    if (c.boxd) await boxdCall(c.boxd, { op: 'remove', id: user.id });
    else await docker(['rm', '-f', containerName(user)]);
  }
  const root = path.join(dataDir, 'users', user.id);
  try {
    // Retried: on Windows a wisp that just exited can hold its files open for a moment (EBUSY, EPERM).
    // The async rm retries the whole removal with a growing delay; rmSync gave up within a second.
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(`Couldn’t delete ${root} (${code || (err as Error).message}): its files may belong to the box’s user; remove it as root.`);
  }
}

// What a wisp's /api/status says is going on: any of it keeps a box up, whatever the idle clock says.
export const atRest = (s: BoxStatus): boolean => !s.live && !s.sides && !s.terms && !s.clients && !s.channels;

export type BoxState = 'stopped' | 'queued' | 'starting' | 'running' | 'stopping';

/** What hostd knows of one box. Public for the grid's tests and the edge's /_grid/state. */
export interface Inst {
  user: BoxUser;
  state: BoxState;
  port: number | null;
  child: BoxChild | null;
  ready: Promise<Inst> | null;
  stopped: Promise<void> | null;
  lastTouch: number;
  nextWakeAt: number | null;
  wakeTimer: NodeJS.Timeout | null;
  inflight: number;
  ended: number;
  status: BoxStatus | null;
  lastActiveAt: number;
  startedAt: number;
  stoppedAt: number;
  queuedAt: number;
  stopReason: string | null;
  error: string;
  wake: boolean;
  oom: boolean;
  gone: boolean;
}

export interface BoxChange {
  user: BoxUser;
  state: BoxState;
  event: string;
  startedAt: number | null;
  stoppedAt: number | null;
  nextWakeAt: number | null;
  lastActiveAt: number | null;
  error: string;
}

export interface HostdOptions {
  dataDir: string;
  driver?: 'process' | 'container';
  idleMs: number;
  checkMs: number;
  startMs?: number;
  maxRunning?: number;
  /** false: count boxes only; undefined: on for containers where MemAvailable is real (Linux) */
  admit?: false | Partial<Admit> | undefined;
  evictAfterMs?: number;
  queueMs?: number;
  /** MiB available (tests) */
  memory?: () => number;
  env?: Record<string, string>;
  path?: string;
  container?: Partial<ContainerSettings> & Record<string, unknown>;
  /** the trusted-proxy secret */
  secretFor?: (u: BoxUser) => string;
  /** its public URL */
  urlFor?: (u: BoxUser) => string;
  /** where its box's pages show ("…p{port}--handle…", '' for none) */
  previewFor?: (u: BoxUser) => string;
  /** more environment for that box (a sandbox's sign-ins, sandboxes.ts) */
  envFor?: (u: BoxUser) => Record<string, string>;
  /** still has an account: a scheduled wake doesn't start a deleted user's box */
  exists?: (u: BoxUser) => boolean;
  gridUrl?: string;
  telemetry?: boolean;
  wispBin?: string;
  healthBackoff?: readonly number[];
  log?: (m: string) => void;
  [k: string]: unknown;
}


const WAKE_SOON_MS = 5 * 60_000; // a box whose schedule is this close isn't evicted

// The box quiet for longest that can go to make room for i: nothing running or open (rechecked now,
// not just at the last tick), quiet for evictAfterMs, not just started, no schedule due soon.
export async function victim(all: Iterable<Inst>, i: Inst, evictAfterMs: number): Promise<Inst | null> {
  const now = Date.now();
  const quietSince = (x: Inst): number => Math.max(x.lastActiveAt, x.lastTouch, x.startedAt);
  const list = [...all]
    .filter((x) => x !== i && x.state === 'running' && !x.inflight && x.status && atRest(x.status) && now - quietSince(x) >= evictAfterMs && !(x.nextWakeAt && x.nextWakeAt - now < WAKE_SOON_MS))
    .sort((a, b) => quietSince(a) - quietSince(b));
  for (const x of list) {
    const ended = x.ended;
    if (x.port === null) continue;
    let s: BoxStatus;
    try {
      s = await getJson(x.port, '/api/status', 2000);
    } catch {
      continue;
    }
    x.status = s;
    x.lastActiveAt = Math.max(s.lastActivityAt || 0, x.lastTouch);
    if (x.state === 'running' && !x.inflight && x.ended === ended && atRest(s) && Date.now() - quietSince(x) >= evictAfterMs) return x;
  }
  return null;
}

// A box's limits: the container's, or for a sandbox (room for its browser) container.sandbox's over them.
export function limitsFor(c: ContainerSettings, user: BoxUser): { memory: string; memorySwap: string; cpus: number; pids: number } {
  const sb: NonNullable<ContainerSettings['sandbox']> = user.sandbox ? { memory: '2560m', memorySwap: '4g', ...(c.sandbox || {}) } : {};
  return { memory: sb.memory ?? c.memory, memorySwap: sb.memorySwap ?? c.memorySwap, cpus: sb.cpus ?? c.cpus, pids: sb.pids ?? c.pids };
}
