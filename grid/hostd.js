// hostd: starts and stops each user's wisp. One API, pluggable drivers:
//
//   process      one `wisp` process per user on this box, with its own WISP_HOME and HOME. For
//                development and a single trusted team: the users share an OS user, so it is
//                NOT isolation between them.
//   container    one container per user (Docker, with gVisor's runsc runtime when it's there):
//                its own kernel boundary, filesystem, network namespace and limits; only its
//                home folder persists (→ /home/wisp). Image: grid/deploy/image. With
//                container.boxd set, boxd (grid/boxd.js, root) runs them and keeps the homes
//                (/var/lib/wisp-grid-boxes): the grid needs no Docker. Without, hostd runs docker
//                itself and the homes are data/users/<id>/home
//   firecracker  (next) one microVM per user, on hosts with KVM; see grid/README.md
//
// A user's wisp runs in trusted-proxy mode (server/http/trust.js) behind the edge, with a clean
// environment: nothing from the operator's shell (keys, tokens) leaks into it.
//
// Idle: every checkMs, GET /api/status on each running wisp. No turn running, no side question,
// no page open and nothing for idleMs: stop it, and remember when its next scheduled task is due
// so it wakes for it.
//
// Room: a box starts while fewer than maxRunning run and (with `admit`, on by default for
// containers) the host has the memory for one more. When it doesn't, the box that has been quiet
// longest (nothing running, no page open, for evictAfterMs) is stopped the way idle stops it, so
// its home and tasks are kept. With nothing to stop, the start waits in line (state 'queued') for
// up to queueMs; people opening their wisp go before scheduled wakes, which never evict anyone.

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTAINER, boxdCall, boxdRun, containerName, containerRun, ensureNetwork, writeEnvFile } from './boxd.js';

export { CONTAINER, containerName, containerRun };

const WISP_BIN = fileURLToPath(new URL('../bin/wisp.js', import.meta.url));
const WAKE_EARLY_MS = 30_000;
const KILL_AFTER_MS = 10_000;
const WAKE_QUEUE_MS = 30 * 60_000; // a scheduled wake waits this long for room
const WAKE_SOON_MS = 5 * 60_000; // a box whose schedule is this close isn't evicted
// The memory one more box needs, on top of what the host keeps for itself (the grid, Caddy, boxd).
export const ADMIT = { boxMb: 1024, reserveMb: 1024 };
const full = () => Object.assign(new Error('This grid is full right now. Try again in a few minutes.'), { status: 503 });

// MiB the host can still hand out: MemAvailable on Linux (counts reclaimable cache), else free.
export function availableMb() {
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) return Math.floor(Number(m[1]) / 1024);
  } catch {}
  return Math.floor(os.freemem() / 1048576);
}
const BASE_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR'];

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer().once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

function getJson(port, p, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` }, timeout }, (res) => {
      let t = '';
      res.on('data', (d) => (t += d));
      res.on('end', () => (res.statusCode < 400 ? resolve(JSON.parse(t || '{}')) : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const docker = (args) =>
  new Promise((resolve) => {
    const p = spawn('docker', args, { stdio: 'ignore' });
    p.on('error', () => resolve(127));
    p.on('exit', resolve);
  });

// A user's box and files, gone for good (their account is being deleted): the container, its home
// (with boxd, in boxd's folder), and data/users/<id>. Also what `wisp grid users --delete` runs.
export async function deleteBox({ dataDir, driver, container = {}, user }) {
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
    throw new Error(`Couldn’t delete ${root} (${err.code || err.message}): its files may belong to the box’s user; remove it as root.`);
  }
}

export class Hostd extends EventEmitter {
  // user: { id, handle }. secretFor(user) → the trusted-proxy secret; urlFor(user) → its public URL;
  // exists(user): still has an account (a scheduled wake doesn't start a deleted user's box).
  // admit: { boxMb, reserveMb } (false: count boxes only); memory() → MiB available (tests).
  constructor({ dataDir, driver = 'process', idleMs, checkMs, startMs = 45_000, maxRunning = 50, admit, evictAfterMs = 120_000, queueMs = 120_000, memory = availableMb, env = {}, path: extraPath = '', container = {}, secretFor, urlFor, exists = () => true, gridUrl = '', telemetry = false, wispBin = WISP_BIN, log = () => {} }) {
    super();
    if (driver !== 'process' && driver !== 'container') throw new Error(`hostd driver "${driver}" isn’t built yet: use "process" or "container" (see grid/README.md).`);
    // By default only where MemAvailable says what's really free (Linux): elsewhere free memory
    // leaves out the cache the system would hand back, and would keep boxes from starting.
    admit = admit === undefined ? driver === 'container' && fs.existsSync('/proc/meminfo') && ADMIT : admit && { ...ADMIT, ...admit };
    Object.assign(this, { dataDir, driver, idleMs, checkMs, startMs, maxRunning, admit, evictAfterMs, queueMs, memory, env, extraPath, secretFor, urlFor, exists, gridUrl, telemetry, wispBin, log, container: { ...CONTAINER, ...container } });
    this.setMaxListeners(0); // every start waiting in line listens for 'room'
    this.gate = Promise.resolve(); // one admission at a time
    this.peak = 0; // most boxes up at once since takePeak()
    this.waits = 0; // starts that had to queue since takePeak()
    this.boxd = driver === 'container' ? this.container.boxd || null : null;
    if (driver === 'container' && !this.boxd) this.network = ensureNetwork(this.container).catch((err) => log(`hostd: ${err.message}`));
    this.inst = new Map(); // user id -> { user, state, port, child, ready, lastTouch, nextWakeAt, wakeTimer }
    this.timer = setInterval(() => this.tick().catch((err) => log(`hostd: ${err.message}`)), checkMs);
    this.timer.unref?.();
  }

  #of(user) {
    if (!this.inst.has(user.id)) this.inst.set(user.id, { user, state: 'stopped', port: null, child: null, ready: null, lastTouch: 0, nextWakeAt: null });
    const i = this.inst.get(user.id);
    i.user = user;
    return i;
  }

  state(userId) {
    return this.inst.get(userId)?.state || 'stopped';
  }

  // Where its wisp listens, once running.
  port(userId) {
    const i = this.inst.get(userId);
    return i?.state === 'running' ? i.port : null;
  }

  touch(userId) {
    const i = this.inst.get(userId);
    if (i) i.lastTouch = Date.now();
  }

  // A request on its way to its wisp: never stopped for idleness while one is open.
  begin(userId) {
    const i = this.inst.get(userId);
    if (!i) return () => {};
    i.inflight = (i.inflight || 0) + 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      i.inflight -= 1;
      i.lastTouch = Date.now();
    };
  }

  dirs(user) {
    const root = path.join(this.dataDir, 'users', user.id);
    return { root, wisp: path.join(root, 'wisp'), home: path.join(root, 'home'), log: path.join(root, 'wisp.log'), env: path.join(root, 'box.env') };
  }

  // Running, or started and waited for. Several callers share one start. wake: a scheduled
  // task's, which waits behind people and never evicts anyone.
  async ensure(user, { wake = false } = {}) {
    if (this.closed) throw Object.assign(new Error('The grid is shutting down.'), { status: 503 });
    const i = this.#of(user);
    if (i.gone) throw Object.assign(new Error('This account is being deleted.'), { status: 410 });
    if (!wake) i.lastTouch = Date.now();
    if (i.state === 'running') return i;
    if (i.state === 'queued') {
      if (!wake) i.wake = false; // someone is waiting for it now
      return i.ready;
    }
    if (i.state === 'starting') return i.ready;
    if (i.state === 'stopping') await i.stopped;
    if (i.gone) throw Object.assign(new Error('This account is being deleted.'), { status: 410 });
    if (i.state !== 'stopped') return i.ready; // another caller got here first while it stopped
    i.state = 'queued'; // until admitted; nothing is shown for it unless it really has to wait
    Object.assign(i, { wake, queuedAt: Date.now(), error: '' });
    i.ready = this.#admit(i)
      .then(() => this.#start(i))
      .catch((err) => {
        i.state = 'stopped';
        i.error = err.message;
        this.#changed(i, 'failed');
        this.emit('room'); // its place, or its turn, goes to the next in line
        throw err;
      });
    return i.ready;
  }

  // Boxes taking memory or a place: running, starting or stopping.
  #up() {
    return [...this.inst.values()].filter((x) => x.state === 'running' || x.state === 'starting' || x.state === 'stopping').length;
  }

  #room() {
    if (this.#up() >= this.maxRunning) return false;
    return !this.admit || this.memory() >= this.admit.reserveMb + this.admit.boxMb;
  }

  // How many boxes this host could have up now: those up, plus what the free memory fits.
  capacity() {
    const up = this.#up();
    if (!this.admit) return this.maxRunning;
    return Math.min(this.maxRunning, up + Math.max(0, Math.floor((this.memory() - this.admit.reserveMb) / this.admit.boxMb)));
  }

  // The most boxes up at once, and how many starts had to wait, since the last call.
  takePeak() {
    const out = { peak: Math.max(this.peak, this.#up()), waits: this.waits };
    this.peak = this.#up();
    this.waits = 0;
    return out;
  }

  // Next in line: people first, then scheduled wakes, each oldest first.
  #first(i) {
    return [...this.inst.values()].filter((x) => x.state === 'queued').sort((a, b) => a.wake - b.wake || a.queuedAt - b.queuedAt)[0] === i;
  }

  #serial(fn) {
    const run = this.gate.then(fn);
    this.gate = run.catch(() => {});
    return run;
  }

  // Wait for room: make some by stopping a quiet box, or queue until one stops.
  async #admit(i) {
    const until = Date.now() + (i.wake ? WAKE_QUEUE_MS : this.queueMs);
    let told = false;
    for (;;) {
      const ok = await this.#serial(async () => {
        if (i.gone) throw Object.assign(new Error('This account is being deleted.'), { status: 410 });
        if (this.closed) throw Object.assign(new Error('The grid is shutting down.'), { status: 503 });
        if (!this.#first(i)) return false;
        // A few at most: memory comes back as each box exits.
        for (let n = 0; !this.#room() && !i.wake && n < 3; n++) {
          const v = await this.#victim(i);
          if (!v) break;
          this.log(`hostd: ${v.user.handle} quiet, stopping to make room for ${i.user.handle}`);
          await this.stop(v.user.id, 'evicted');
        }
        if (!this.#room()) return false;
        i.state = 'starting'; // counted from here on, before the next admission looks
        this.peak = Math.max(this.peak, this.#up());
        this.#changed(i);
        return true;
      });
      if (ok) return;
      if (!told) {
        told = true;
        this.waits += 1;
        this.log(`hostd: ${i.user.handle} waiting for room${i.wake ? ' (scheduled wake)' : ''}`);
        this.#changed(i);
      }
      if (Date.now() >= until) throw full();
      // Until a box stops, or a little while (memory also frees up by itself).
      await new Promise((r) => {
        const done = () => {
          clearTimeout(t);
          this.off('room', done);
          r();
        };
        const t = setTimeout(done, Math.min(this.checkMs, 2000));
        this.on('room', done);
      });
    }
  }

  // The box quiet for longest that can go: nothing running or open (rechecked now, not just at
  // the last tick), quiet for evictAfterMs, not just started, no schedule due soon.
  async #victim(i) {
    const now = Date.now();
    const quietSince = (x) => Math.max(x.lastActiveAt || 0, x.lastTouch || 0, x.startedAt || 0);
    const quiet = (s) => !s.live && !s.sides && !s.terms && !s.clients;
    const list = [...this.inst.values()]
      .filter((x) => x !== i && x.state === 'running' && !x.inflight && x.status && quiet(x.status) && now - quietSince(x) >= this.evictAfterMs && !(x.nextWakeAt && x.nextWakeAt - now < WAKE_SOON_MS))
      .sort((a, b) => quietSince(a) - quietSince(b));
    for (const x of list) {
      let s;
      try {
        s = await getJson(x.port, '/api/status', 2000);
      } catch {
        continue;
      }
      x.status = s;
      x.lastActiveAt = Math.max(s.lastActivityAt || 0, x.lastTouch || 0);
      if (x.state === 'running' && !x.inflight && quiet(s) && Date.now() - quietSince(x) >= this.evictAfterMs) return x;
    }
    return null;
  }

  async #start(i) {
    const d = this.dirs(i.user);
    const c = this.container;
    // With boxd, the home is boxd's to make, in its own folder: only the log lives here.
    const dirs = this.boxd ? [d.root] : this.driver === 'container' ? [d.home] : [d.wisp, d.home];
    for (const x of dirs) fs.mkdirSync(x, { recursive: true });
    i.port = await freePort();
    // WISP_OUT_OF_MEMORY: the last run was killed for memory (its limit, with containers).
    const oom = i.oom && { WISP_OUT_OF_MEMORY: this.driver === 'container' ? String(c.memory) : '1' };
    i.oom = false;
    const wisp = { WISP_TRUSTED_PROXY_SECRET: this.secretFor(i.user), WISP_PUBLIC_URL: this.urlFor(i.user), ...(this.gridUrl && { WISP_GRID_URL: this.gridUrl }), ...oom, WISP_UPDATE_CHECK: '0', ...(!this.telemetry && { WISP_TELEMETRY: '0' }), WISP_FEEDBACK: '0', WISP_NO_OPEN: '1' };
    let child;
    if (this.boxd) {
      child = boxdRun(this.boxd, { id: i.user.id, port: i.port, env: { ...this.env, ...wisp }, limits: { memory: c.memory, memorySwap: c.memorySwap, cpus: c.cpus, pids: c.pids }, dns: c.dns }, d.log);
    } else {
      let cmd;
      let args;
      let env;
      if (this.driver === 'container') {
        await this.network;
        const resolv = path.join(d.root, 'resolv.conf');
        fs.writeFileSync(resolv, c.dns.map((x) => `nameserver ${x}\n`).join(''));
        writeEnvFile(d.env, { ...this.env, ...wisp });
        ({ cmd, args } = containerRun({ ...c, resolv, envFile: d.env, name: containerName(i.user), port: i.port, home: d.home }));
        env = { PATH: process.env.PATH };
        // The image runs as uid 1000; its home is this folder.
        try {
          fs.chownSync(d.home, c.uid, c.uid);
        } catch {}
      } else {
        env = Object.fromEntries(BASE_ENV.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
        if (this.extraPath) env.PATH = `${this.extraPath}${path.delimiter}${env.PATH || ''}`;
        Object.assign(env, this.env, { HOME: d.home, USERPROFILE: d.home, WISP_HOME: d.wisp, ...wisp });
        [cmd, args] = [process.execPath, [this.wispBin, '--no-open', '--port', String(i.port)]];
      }
      const out = fs.openSync(d.log, 'a');
      child = spawn(cmd, args, { cwd: d.home, env, stdio: ['ignore', out, out] });
      fs.closeSync(out);
    }
    // The env file only has to last until docker has read it: by the time the box answers.
    const dropEnv = () => this.driver === 'container' && !this.boxd && fs.rmSync(d.env, { force: true });
    i.child = child;
    i.startedAt = Date.now();
    let exited = false;
    i.stopped = new Promise((resolve) =>
      child.on('exit', (code, signal) => {
        exited = true;
        dropEnv();
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
        resolve();
        this.emit('room');
      }),
    );
    const until = Date.now() + this.startMs;
    while (Date.now() < until) {
      if (exited) throw new Error(child.error || `Its wisp quit while starting; see ${d.log}.`);
      try {
        await getJson(i.port, '/api/health', 2000);
        dropEnv();
        i.state = 'running';
        i.error = '';
        this.#changed(i, 'started');
        return i;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    child.kill('SIGKILL');
    throw new Error('Its wisp didn’t answer in time.');
  }

  async stop(userId, reason = 'stopped') {
    const i = this.inst.get(userId);
    if (!i || (i.state !== 'running' && i.state !== 'starting')) return false;
    if (i.state === 'starting') await i.ready.catch(() => {});
    if (!i.child) return false;
    i.state = 'stopping';
    i.stopReason = reason;
    this.#changed(i);
    i.child.kill('SIGTERM'); // `docker run` passes it on to the container
    const kill = setTimeout(() => {
      if (this.driver === 'container' && !this.boxd) docker(['kill', containerName(i.user)]);
      i.child?.kill('SIGKILL'); // with boxd: it kills the container
    }, KILL_AFTER_MS);
    await i.stopped;
    clearTimeout(kill);
    return true;
  }

  // The account is being deleted: no more starts, then the box and its files go (deleteBox).
  async remove(user) {
    const i = this.#of(user);
    i.gone = true;
    clearTimeout(i.wakeTimer);
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

  async tick() {
    const now = Date.now();
    for (const i of this.inst.values()) {
      if (i.state !== 'running') continue;
      let s;
      try {
        s = await getJson(i.port, '/api/status');
      } catch {
        continue; // busy or going away; the next tick sees
      }
      i.status = s;
      i.nextWakeAt = s.nextWakeAt || null;
      i.lastActiveAt = Math.max(s.lastActivityAt || 0, i.lastTouch || 0);
      // Checked after the await: a request may have arrived meanwhile. stop() flips the state
      // before it yields, so a request after this point waits for a fresh start instead.
      const quiet = i.state === 'running' && !i.inflight && !s.live && !s.sides && !s.terms && !s.clients && Date.now() - Math.max(i.lastActiveAt, i.lastTouch || 0) > this.idleMs;
      if (quiet) {
        this.log(`hostd: ${i.user.handle} idle, stopping${i.nextWakeAt ? ` (wakes ${new Date(i.nextWakeAt).toISOString()})` : ''}`);
        await this.stop(i.user.id, 'idle');
      }
    }
  }

  // Wake for its next scheduled task (a trigger), a little early.
  #scheduleWake(i) {
    clearTimeout(i.wakeTimer);
    if (!i.nextWakeAt) return;
    const wait = Math.max(0, i.nextWakeAt - Date.now() - WAKE_EARLY_MS);
    i.wakeTimer = setTimeout(() => {
      if (i.state === 'stopped' && !i.gone && this.exists(i.user)) this.ensure(i.user, { wake: true }).catch((err) => this.log(`hostd: wake ${i.user.handle}: ${err.message}`));
    }, wait);
    i.wakeTimer.unref?.();
  }

  // After a restart of the grid: wake times kept in the database.
  restore(user, nextWakeAt) {
    const i = this.#of(user);
    i.nextWakeAt = nextWakeAt;
    this.#scheduleWake(i);
  }

  #changed(i, event = i.state) {
    this.emit('change', { user: i.user, state: i.state, event, startedAt: i.startedAt || null, stoppedAt: i.stoppedAt || null, nextWakeAt: i.nextWakeAt || null, lastActiveAt: i.lastActiveAt || null, error: i.error || '' });
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const i of this.inst.values()) clearTimeout(i.wakeTimer);
    // Starts still waiting for room give up now, not after the grid (and its database) is gone.
    const queued = [...this.inst.values()].filter((i) => i.state === 'queued').map((i) => i.ready.catch(() => {}));
    this.emit('room');
    await Promise.all(queued);
    await Promise.all([...this.inst.keys()].map((id) => this.stop(id, 'grid stopped')));
  }
}
