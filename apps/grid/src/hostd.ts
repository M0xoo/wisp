// hostd: starts and stops each user's wisp. One API, pluggable drivers:
//
//   process      one `wisp` process per user on this box, with its own WISP_HOME and HOME. For
//                development and a single trusted team: the users share an OS user, so it is
//                NOT isolation between them.
//   container    one container per user (Docker, with gVisor's runsc runtime when it's there):
//                its own kernel boundary, filesystem, network namespace and limits; only its
//                home folder persists (→ /home/wisp). Image: deploy/image. With container.boxd
//                set, boxd (boxd.ts, root) runs them and keeps the homes (/var/lib/wisp-grid-boxes):
//                the grid needs no Docker. Without, hostd runs docker itself and the homes are
//                data/users/<id>/home
//   firecracker  (next) one microVM per user, on hosts with KVM; see apps/grid/README.md
//
// A user's wisp runs the BoxPlugins group in trusted-proxy mode (trust.ts boxTrust) behind the
// edge, with a clean environment: nothing from the operator's shell (keys, tokens) leaks into it.
//
// Idle: every checkMs, GET /api/status on each running wisp. No turn running, no side question,
// no page open, no channel answering and nothing for idleMs: stop it, and remember when its next
// scheduled task is due so it wakes for it.
//
// Room: a box starts while fewer than maxRunning run and (with `admit`, on by default for
// containers) the host has the memory for one more. When it doesn't, the box that has been quiet
// longest (nothing running, no page open, for evictAfterMs) is stopped the way idle stops it, so
// its home and tasks are kept. With nothing to stop, the start waits in line (state 'queued') for
// up to queueMs; people opening their wisp go before scheduled wakes, which never evict anyone.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTAINER, containerName, containerRun, ensureNetwork } from './boxd.ts';
import { ADMIT, HEALTH_BACKOFF, atRest, limitsFor, victim, availableMb, closing, deleteBox, deleting, docker, full, mib, type Admit, type BoxChange, type BoxState, type ContainerSettings, type HostdOptions, type Inst } from './hostd-box.ts';
import { boxEnv, getJson, spawnBox, untilHealthy, type BoxChild, type BoxStatus } from './hostd-run.ts';
import type { BoxUser } from './rows.ts';

export { ADMIT, CONTAINER, HEALTH_BACKOFF, availableMb, containerName, containerRun, deleteBox };
export type { Admit, BoxChange, BoxChild, BoxState, BoxStatus, ContainerSettings, HostdOptions, Inst };

const WISP_BIN = fileURLToPath(new URL('../../server/bin/wisp.ts', import.meta.url));
const WAKE_EARLY_MS = 30_000;
const KILL_AFTER_MS = 10_000;
const WAKE_QUEUE_MS = 30 * 60_000; // a scheduled wake waits this long for room
export class Hostd extends EventEmitter {
  readonly dataDir: string;
  readonly driver: 'process' | 'container';
  readonly idleMs: number;
  readonly checkMs: number;
  readonly startMs: number;
  readonly maxRunning: number;
  readonly admit: Admit | false;
  readonly evictAfterMs: number;
  readonly queueMs: number;
  readonly container: ContainerSettings;
  readonly boxd: string | null;
  readonly inst = new Map<string, Inst>();
  readonly #o: Required<Pick<HostdOptions, 'memory' | 'env' | 'secretFor' | 'urlFor' | 'previewFor' | 'envFor' | 'exists' | 'gridUrl' | 'telemetry' | 'wispBin' | 'healthBackoff' | 'log'>> & { extraPath: string };
  #gate: Promise<unknown> = Promise.resolve(); // one admission at a time
  #network: Promise<void> | null = null;
  #timer: NodeJS.Timeout;
  #closed = false;
  peak = 0; // most boxes up at once since takePeak()
  waits = 0; // starts that had to queue since takePeak()

  constructor(o: HostdOptions) {
    super();
    const driver = o.driver ?? 'process';
    if (driver !== 'process' && driver !== 'container') throw new Error(`hostd driver "${String(driver)}" isn’t built yet: use "process" or "container" (see apps/grid/README.md).`);
    this.dataDir = o.dataDir;
    this.driver = driver;
    this.idleMs = o.idleMs;
    this.checkMs = o.checkMs;
    this.startMs = o.startMs ?? 45_000;
    this.maxRunning = o.maxRunning ?? 50;
    this.evictAfterMs = o.evictAfterMs ?? 120_000;
    this.queueMs = o.queueMs ?? 120_000;
    // By default only where MemAvailable says what's really free (Linux): elsewhere free memory
    // leaves out the cache the system would hand back, and would keep boxes from starting.
    this.admit = o.admit === undefined ? (driver === 'container' && fs.existsSync('/proc/meminfo') ? { ...ADMIT } : false) : o.admit && { ...ADMIT, ...o.admit };
    this.container = { ...CONTAINER, dns: [...CONTAINER.dns], ...(o.container as Partial<ContainerSettings> | undefined) };
    this.#o = {
      memory: o.memory ?? availableMb,
      env: o.env ?? {},
      extraPath: o.path ?? '',
      secretFor: o.secretFor ?? (() => ''),
      urlFor: o.urlFor ?? (() => ''),
      previewFor: o.previewFor ?? (() => ''),
      envFor: o.envFor ?? (() => ({})),
      exists: o.exists ?? (() => true),
      gridUrl: o.gridUrl ?? '',
      telemetry: o.telemetry ?? false,
      wispBin: o.wispBin ?? WISP_BIN,
      healthBackoff: o.healthBackoff ?? HEALTH_BACKOFF,
      log: o.log ?? (() => {}),
    };
    this.setMaxListeners(0); // every start waiting in line listens for 'room'
    this.boxd = driver === 'container' ? this.container.boxd || null : null;
    if (driver === 'container' && !this.boxd) this.#network = ensureNetwork(this.container).catch((err: Error) => this.#o.log(`hostd: ${err.message}`));
    this.#timer = setInterval(() => this.tick().catch((err: Error) => this.#o.log(`hostd: ${err.message}`)), o.checkMs);
    this.#timer.unref();
  }

  #of(user: BoxUser): Inst {
    let i = this.inst.get(user.id);
    if (!i) {
      i = { user, state: 'stopped', port: null, child: null, ready: null, stopped: null, lastTouch: 0, nextWakeAt: null, wakeTimer: null, inflight: 0, ended: 0, status: null, lastActiveAt: 0, startedAt: 0, stoppedAt: 0, queuedAt: 0, stopReason: null, error: '', wake: false, oom: false, gone: false };
      this.inst.set(user.id, i);
    }
    i.user = user;
    return i;
  }

  state(userId: string): BoxState {
    return this.inst.get(userId)?.state || 'stopped';
  }

  /** Where its wisp listens, once running. */
  port(userId: string): number | null {
    const i = this.inst.get(userId);
    return i?.state === 'running' ? i.port : null;
  }

  touch(userId: string): void {
    const i = this.inst.get(userId);
    if (i) i.lastTouch = Date.now();
  }

  // A request on its way to its wisp: never stopped for idleness while one is open. touch: false
  // for one that mustn't count as use once it's over (a channel's message: inbox.ts).
  begin(userId: string, { touch = true }: { touch?: boolean } = {}): () => void {
    const i = this.inst.get(userId);
    if (!i) return () => {};
    i.inflight += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      i.inflight -= 1;
      i.ended += 1;
      if (touch) i.lastTouch = Date.now();
    };
  }

  dirs(user: { id: string }): { root: string; wisp: string; home: string; log: string; env: string } {
    const root = path.join(this.dataDir, 'users', user.id);
    return { root, wisp: path.join(root, 'wisp'), home: path.join(root, 'home'), log: path.join(root, 'wisp.log'), env: path.join(root, 'box.env') };
  }

  // Running, or started and waited for. Several callers share one start. wake: a scheduled
  // task's, which waits behind people and never evicts anyone.
  async ensure(user: BoxUser, { wake = false }: { wake?: boolean } = {}): Promise<Inst> {
    if (this.#closed) throw closing();
    const i = this.#of(user);
    if (i.gone) throw deleting();
    if (!wake) i.lastTouch = Date.now();
    if (i.state === 'running') return i;
    if (i.state === 'queued') {
      if (!wake) i.wake = false; // someone is waiting for it now
      return (i.ready ?? Promise.resolve(i));
    }
    if (i.state === 'starting') return (i.ready ?? Promise.resolve(i));
    if (i.state === 'stopping') await i.stopped;
    if (i.gone) throw deleting();
    if (i.state !== 'stopped') return (i.ready ?? Promise.resolve(i)); // another caller got here first while it stopped
    i.state = 'queued'; // until admitted; nothing is shown for it unless it really has to wait
    Object.assign(i, { wake, queuedAt: Date.now(), error: '' });
    i.ready = this.#admit(i)
      .then(() => this.#start(i))
      .catch((err: Error) => {
        i.state = 'stopped';
        i.error = err.message;
        this.#changed(i, 'failed');
        this.emit('room'); // its place, or its turn, goes to the next in line
        throw err;
      });
    return i.ready;
  }

  // Boxes taking memory or a place: running, starting or stopping.
  #up(): number {
    let n = 0;
    for (const x of this.inst.values()) if (x.state === 'running' || x.state === 'starting' || x.state === 'stopping') n++;
    return n;
  }

  // i: the box asking. A sandbox needs its own memory limit's worth (room for its browser).
  #room(i: Inst | null = null): boolean {
    if (this.#up() >= this.maxRunning) return false;
    if (!this.admit) return true;
    const need = i?.user.sandbox ? Math.max(this.admit.boxMb, mib(limitsFor(this.container, i.user).memory)) : this.admit.boxMb;
    return this.#o.memory() >= this.admit.reserveMb + need;
  }

  /** How many boxes this host could have up now: those up, plus what the free memory fits. */
  capacity(): number {
    const up = this.#up();
    if (!this.admit) return this.maxRunning;
    return Math.min(this.maxRunning, up + Math.max(0, Math.floor((this.#o.memory() - this.admit.reserveMb) / this.admit.boxMb)));
  }

  /** The most boxes up at once, and how many starts had to wait, since the last call. */
  takePeak(): { peak: number; waits: number } {
    const out = { peak: Math.max(this.peak, this.#up()), waits: this.waits };
    this.peak = this.#up();
    this.waits = 0;
    return out;
  }

  // Next in line: people first, then scheduled wakes, each oldest first.
  #first(i: Inst): boolean {
    const queued = [...this.inst.values()].filter((x) => x.state === 'queued');
    queued.sort((a, b) => Number(a.wake) - Number(b.wake) || a.queuedAt - b.queuedAt);
    return queued[0] === i;
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#gate.then(fn);
    this.#gate = run.catch(() => {});
    return run;
  }

  // One look at whether i may start now, making room by stopping quiet boxes if it may evict.
  async #tryAdmit(i: Inst): Promise<boolean> {
    if (i.gone) throw deleting();
    if (this.#closed) throw closing();
    if (!this.#first(i)) return false;
    // A few at most: memory comes back as each box exits.
    for (let n = 0; !this.#room(i) && !i.wake && n < 3; n++) {
      const v = await victim(this.inst.values(), i, this.evictAfterMs);
      if (!v) break;
      this.#o.log(`hostd: ${v.user.handle} quiet, stopping to make room for ${i.user.handle}`);
      await this.stop(v.user.id, 'evicted');
    }
    if (!this.#room(i)) return false;
    i.state = 'starting'; // counted from here on, before the next admission looks
    this.peak = Math.max(this.peak, this.#up());
    this.#changed(i);
    return true;
  }

  // Wait for room: make some by stopping a quiet box, or queue until one stops.
  async #admit(i: Inst): Promise<void> {
    const until = Date.now() + (i.wake ? WAKE_QUEUE_MS : this.queueMs);
    let told = false;
    for (;;) {
      if (await this.#serial(() => this.#tryAdmit(i))) return;
      if (!told) {
        told = true;
        this.waits += 1;
        this.#o.log(`hostd: ${i.user.handle} waiting for room${i.wake ? ' (scheduled wake)' : ''}`);
        this.#changed(i);
      }
      if (Date.now() >= until) throw full();
      // Until a box stops, or a little while (memory also frees up by itself).
      await new Promise<void>((r) => {
        const done = (): void => {
          clearTimeout(t);
          this.off('room', done);
          r();
        };
        const t = setTimeout(done, Math.min(this.checkMs, 2000));
        this.on('room', done);
      });
    }
  }

  async #start(i: Inst): Promise<Inst> {
    const d = this.dirs(i.user);
    const u = i.user;
    const env = boxEnv({ oom: i.oom ? (this.driver === 'container' ? String(limitsFor(this.container, u).memory) : '1') : '', secret: this.#o.secretFor(u), url: this.#o.urlFor(u), preview: this.#o.previewFor(u), gridUrl: this.#o.gridUrl, telemetry: this.#o.telemetry, extra: this.#o.envFor(u) || {}, admin: this.#o.env });
    i.oom = false;
    if (this.driver === 'container' && !this.boxd) await this.#network;
    const child = await spawnBox({ driver: this.driver, boxd: this.boxd, container: this.container, limits: limitsFor(this.container, i.user), user: i.user, dirs: d, env, extraPath: this.#o.extraPath, wispBin: this.#o.wispBin, name: containerName(i.user) }, (port) => (i.port = port));
    i.child = child.child;
    i.startedAt = Date.now();
    let exited = false;
    i.stopped = new Promise((resolve) =>
      child.child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        exited = true;
        void child.dropEnv();
        this.#exited(i, code, signal);
        resolve();
        this.emit('room');
      }),
    );
    await untilHealthy({ port: () => i.port, exited: () => exited, child, startMs: this.startMs, backoff: this.#o.healthBackoff, log: this.dirs(i.user).log });
    i.state = 'running';
    i.error = '';
    this.#changed(i, 'started');
    return i;
  }

  #exited(i: Inst, code: number | null, signal: NodeJS.Signals | null): void {
    const was = i.state;
    Object.assign(i, { state: 'stopped', child: null, port: null, stoppedAt: Date.now() });
    // Killed when nobody asked: the kernel's OOM killer (docker says 137 for a box over its
    // --memory). Its next start tells its wisp, so the task that was running says why.
    i.oom = was === 'running' && !i.stopReason && (code === 137 || signal === 'SIGKILL');
    if (i.oom) i.stopReason = 'out of memory';
    if (was === 'running' && !i.stopReason) i.stopReason = `exited (${signal || code})`;
    this.#changed(i, i.stopReason || 'exited');
    i.stopReason = null;
    this.#scheduleWake(i);
  }

  async stop(userId: string, reason = 'stopped'): Promise<boolean> {
    const i = this.inst.get(userId);
    if (!i || (i.state !== 'running' && i.state !== 'starting')) return false;
    if (i.state === 'starting') await i.ready?.catch(() => {});
    const child = i.child;
    if (!child) return false;
    i.state = 'stopping';
    i.stopReason = reason;
    this.#changed(i);
    child.kill('SIGTERM'); // `docker run` passes it on to the container
    const kill = setTimeout(() => {
      if (this.driver === 'container' && !this.boxd) void docker(['kill', containerName(i.user)]);
      i.child?.kill('SIGKILL'); // with boxd: it kills the container
    }, KILL_AFTER_MS);
    await i.stopped;
    clearTimeout(kill);
    return true;
  }

  // The account is being deleted: no more starts, then the box and its files go (deleteBox).
  async remove(user: BoxUser): Promise<void> {
    const i = this.#of(user);
    i.gone = true;
    if (i.wakeTimer) clearTimeout(i.wakeTimer);
    i.nextWakeAt = null;
    try {
      await this.stop(user.id, 'deleted');
      await deleteBox({ dataDir: this.dataDir, driver: this.driver, container: this.container, user });
    } catch (err) {
      i.gone = false;
      throw err;
    }
    this.inst.delete(user.id);
  }

  async tick(): Promise<void> {
    for (const i of this.inst.values()) {
      if (i.state !== 'running' || i.port === null) continue;
      let s: BoxStatus;
      const ended = i.ended;
      try {
        s = await getJson(i.port, '/api/status');
      } catch {
        continue; // busy or going away; the next tick sees
      }
      i.status = s;
      i.nextWakeAt = s.nextWakeAt || null;
      i.lastActiveAt = Math.max(s.lastActivityAt || 0, i.lastTouch);
      // Checked after the await: a request may have arrived meanwhile, or ended, and then this status
      // may be from before what it set going. stop() flips the state before it yields, so a request
      // after this point waits for a fresh start instead.
      const quiet = i.state === 'running' && !i.inflight && i.ended === ended && atRest(s) && Date.now() - Math.max(i.lastActiveAt, i.lastTouch) > this.idleMs;
      if (quiet) {
        this.#o.log(`hostd: ${i.user.handle} idle, stopping${i.nextWakeAt ? ` (wakes ${new Date(i.nextWakeAt).toISOString()})` : ''}`);
        await this.stop(i.user.id, 'idle');
      }
    }
  }

  // Wake for its next scheduled task (a trigger), a little early.
  #scheduleWake(i: Inst): void {
    if (i.wakeTimer) clearTimeout(i.wakeTimer);
    i.wakeTimer = null;
    if (!i.nextWakeAt) return;
    const wait = Math.max(0, i.nextWakeAt - Date.now() - WAKE_EARLY_MS);
    i.wakeTimer = setTimeout(() => {
      if (i.state === 'stopped' && !i.gone && this.#o.exists(i.user)) this.ensure(i.user, { wake: true }).catch((err: Error) => this.#o.log(`hostd: wake ${i.user.handle}: ${err.message}`));
    }, wait);
    i.wakeTimer.unref();
  }

  /** After a restart of the grid: wake times kept in the database. */
  restore(user: BoxUser, nextWakeAt: number | null): void {
    const i = this.#of(user);
    i.nextWakeAt = nextWakeAt;
    this.#scheduleWake(i);
  }

  #changed(i: Inst, event: string = i.state): void {
    const e: BoxChange = { user: i.user, state: i.state, event, startedAt: i.startedAt || null, stoppedAt: i.stoppedAt || null, nextWakeAt: i.nextWakeAt || null, lastActiveAt: i.lastActiveAt || null, error: i.error || '' };
    this.emit('change', e);
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    for (const i of this.inst.values()) if (i.wakeTimer) clearTimeout(i.wakeTimer);
    // Starts still waiting for room give up now, not after the grid (and its database) is gone.
    const queued = [...this.inst.values()].filter((i) => i.state === 'queued').map((i) => i.ready?.catch(() => {}));
    this.emit('room');
    await Promise.all(queued);
    await Promise.all([...this.inst.keys()].map((id) => this.stop(id, 'grid stopped')));
  }
}
