// How hostd starts one box, per driver: a plain `wisp` process (process), `docker run` (container,
// hostd running docker itself), or a run through boxd (container with boxd). And the one HTTP call
// hostd makes to a box: GET /api/health while it boots, /api/status on every tick.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { boxdRun, containerRun, writeEnvFile, type Container } from './boxd.ts';
import type { BoxUser } from './rows.ts';

/** What a box's wisp says to /api/status. Anything else it sends is kept but not read. */
export interface BoxStatus {
  live?: number;
  sides?: number;
  terms?: number;
  clients?: number;
  channels?: number;
  nextWakeAt?: number | null;
  lastActivityAt?: number;
  [k: string]: unknown;
}

/** A box's process as hostd watches it: a child process, or boxd's stand-in for one. */
export interface BoxChild {
  /** what boxd said when it couldn't start it ('' or absent for a plain process) */
  error?: string;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

const BASE_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR'];

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer().once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });

export function getJson(port: number, p: string, timeout = 5000): Promise<BoxStatus> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` }, timeout }, (res) => {
      let t = '';
      res.on('data', (d: Buffer) => (t += d));
      res.on('end', () => {
        if ((res.statusCode ?? 500) >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          const v: unknown = JSON.parse(t || '{}');
          resolve(typeof v === 'object' && v !== null ? (v as BoxStatus) : {});
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

export interface SpawnSpec {
  driver: 'process' | 'container';
  boxd: string | null;
  container: Container & { boxd?: string };
  limits: { memory: string; memorySwap: string; cpus: number; pids: number };
  user: BoxUser;
  dirs: { root: string; wisp: string; home: string; log: string; env: string };
  env: Record<string, string>;
  extraPath: string;
  wispBin: string;
  name: string;
}

export interface Spawned {
  child: BoxChild;
  /** The env file only has to last until docker has read it: by the time the box answers. */
  dropEnv(): Promise<void>;
}

// The log file as the child's stdout and stderr: opened here, handed over, closed once spawned.
async function withLog(file: string, fn: (fd: number) => BoxChild): Promise<BoxChild> {
  const out = await fs.promises.open(file, 'a');
  try {
    return fn(out.fd);
  } finally {
    await out.close();
  }
}

async function runContainer(s: SpawnSpec, port: number): Promise<Spawned> {
  const c = s.container;
  const resolv = path.join(s.dirs.root, 'resolv.conf');
  await fs.promises.writeFile(resolv, c.dns.map((x) => `nameserver ${x}\n`).join(''));
  // The secrets go in a 0600 file, never on docker's command line (boxd.ts writeEnvFile).
  writeEnvFile(s.dirs.env, s.env);
  const { cmd, args } = containerRun({ ...c, ...s.limits, resolv, envFile: s.dirs.env, name: s.name, port, home: s.dirs.home, sandbox: !!s.user.sandbox });
  // The image runs as uid 1000; its home is this folder.
  await fs.promises.chown(s.dirs.home, c.uid, c.uid).catch(() => {});
  const child = await withLog(s.dirs.log, (fd) => spawn(cmd, args, { cwd: s.dirs.home, env: { PATH: process.env['PATH'] ?? '' }, stdio: ['ignore', fd, fd] }));
  return { child, dropEnv: () => fs.promises.rm(s.dirs.env, { force: true }) };
}

async function runProcess(s: SpawnSpec, port: number): Promise<Spawned> {
  const env: Record<string, string> = {};
  for (const k of BASE_ENV) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  if (s.extraPath) env['PATH'] = `${s.extraPath}${path.delimiter}${env['PATH'] || ''}`;
  Object.assign(env, s.env, { HOME: s.dirs.home, USERPROFILE: s.dirs.home, WISP_HOME: s.dirs.wisp });
  const args = [s.wispBin, '--no-open', '--port', String(port)];
  const child = await withLog(s.dirs.log, (fd) => spawn(process.execPath, args, { cwd: s.dirs.home, env, stdio: ['ignore', fd, fd] }));
  return { child, dropEnv: async () => {} };
}

/** Starts the box on a free port (told to `onPort` before it is spawned, so hostd knows it at once). */
export async function spawnBox(s: SpawnSpec, onPort: (port: number) => void): Promise<Spawned> {
  // With boxd, the home is boxd's to make, in its own folder: only the log lives here.
  const dirs = s.boxd ? [s.dirs.root] : s.driver === 'container' ? [s.dirs.home] : [s.dirs.wisp, s.dirs.home];
  await Promise.all(dirs.map((x) => fs.promises.mkdir(x, { recursive: true })));
  const port = await freePort();
  onPort(port);
  if (s.boxd) {
    const child = boxdRun(s.boxd, { id: s.user.id, port, env: s.env, limits: s.limits, dns: s.container.dns, ...(s.user.sandbox && { sandbox: true }) }, s.dirs.log);
    return { child, dropEnv: async () => {} };
  }
  return s.driver === 'container' ? runContainer(s, port) : runProcess(s, port);
}

export interface EnvParts {
  /** the last run was killed for memory: its limit (containers) or '1'; '' for a plain start */
  oom: string;
  secret: string;
  url: string;
  preview: string;
  gridUrl: string;
  telemetry: boolean;
  /** a sandbox's env vars (its owner's) */
  extra: Record<string, string>;
  /** the admin's hostd.env */
  admin: Record<string, string>;
}

// The box's environment from hostd: a sandbox's env vars first, the admin's hostd.env and wisp's
// own win over them.
export function boxEnv(p: EnvParts): Record<string, string> {
  const wisp: Record<string, string> = {
    WISP_TRUSTED_PROXY_SECRET: p.secret,
    WISP_PUBLIC_URL: p.url,
    ...(p.preview && { WISP_PREVIEW_URL: p.preview }),
    ...(p.gridUrl && { WISP_GRID_URL: p.gridUrl }),
    // WISP_OUT_OF_MEMORY: the last run was killed for memory, so the task that was running says why.
    ...(p.oom && { WISP_OUT_OF_MEMORY: p.oom }),
    WISP_GROUP: 'box', // apps/server runs the BoxPlugins group (plan §6.3)
    WISP_UPDATE_CHECK: '0',
    ...(!p.telemetry && { WISP_TELEMETRY: '0' }),
    WISP_FEEDBACK: '0',
    WISP_NO_OPEN: '1',
  };
  return { ...p.extra, ...p.admin, ...wisp };
}

export interface HealthWait {
  port: () => number | null;
  exited: () => boolean;
  child: Spawned;
  startMs: number;
  /** ms between tries, the last repeated (hostd-box.ts HEALTH_BACKOFF) */
  backoff: readonly number[];
  /** the box's log, named when it quits while starting */
  log: string;
}

// Asks /api/health until the box answers; a box that quits, or never answers in startMs, fails.
export async function untilHealthy(w: HealthWait): Promise<void> {
  const until = Date.now() + w.startMs;
  for (let n = 0; Date.now() < until; n++) {
    if (w.exited()) throw new Error(w.child.child.error || `Its wisp quit while starting; see ${w.log}.`);
    try {
      const port = w.port();
      if (port === null) throw new Error('no port');
      await getJson(port, '/api/health', 2000);
      await w.child.dropEnv(); // the env file only has to last until docker has read it
      return;
    } catch {
      await new Promise((r) => setTimeout(r, w.backoff[Math.min(n, w.backoff.length - 1)] ?? 150));
    }
  }
  w.child.child.kill('SIGKILL');
  throw new Error('Its wisp didn’t answer in time.');
}
