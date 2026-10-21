// hostd: starts and stops each user's wisp. One API, pluggable drivers:
//
//   process      one `wisp` process per user on this box, with its own WISP_HOME and HOME. For
//                development and a single trusted team: the users share an OS user, so it is
//                NOT isolation between them.
//   container    one container per user (Docker, with gVisor's runsc runtime when it's there):
//                its own kernel boundary, filesystem, network namespace and limits; only its
//                home folder persists (data/users/<id>/home → /home/wisp). Image: grid/deploy/image
//   firecracker  (next) one microVM per user, on hosts with KVM; see grid/README.md
//
// A user's wisp runs in trusted-proxy mode (server/http/trust.js) behind the edge, with a clean
// environment: nothing from the operator's shell (keys, tokens) leaks into it.
//
// Idle: every checkMs, GET /api/status on each running wisp. No turn running, no side question,
// no page open and nothing for idleMs: stop it, and remember when its next scheduled task is due
// so it wakes for it.

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WISP_BIN = fileURLToPath(new URL('../bin/wisp.js', import.meta.url));
const WAKE_EARLY_MS = 30_000;
const KILL_AFTER_MS = 10_000;
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

// --- the container driver ------------------------------------------------------------------

export const CONTAINER = {
  image: 'wisp-grid-user',
  runtime: 'runsc', // gVisor: a user-space kernel between the agents and the host's. 'runc' without it
  network: 'wisp-users',
  memory: '1536m',
  memorySwap: '3g',
  cpus: 1.5,
  pids: 512,
  uid: 1000,
  // Docker's built-in resolver (127.0.0.11) isn't reachable from gVisor's network stack, and on a
  // network of its own Docker keeps pointing at it even with --dns: each container gets its own
  // resolv.conf with these instead.
  dns: ['1.1.1.1', '9.9.9.9'],
};
export const containerName = (user) => `wisp-u-${user.id}`;

// `docker run` for one user's wisp. Attached (no -d) with --rm: the docker process lives as long as
// the container, so hostd watches it like any child.
export function containerRun({ image, runtime, network, memory, memorySwap, cpus, pids, resolv = null, name, port, home, env }) {
  return {
    cmd: 'docker',
    args: [
      'run', '--rm', '--init', '--name', name,
      ...(runtime ? ['--runtime', runtime] : []),
      '--network', network,
      ...(resolv ? ['-v', `${resolv}:/etc/resolv.conf:ro`] : []),
      // Only this box's loopback reaches it, on the same port number inside, so Host headers match.
      '-p', `127.0.0.1:${port}:${port}`,
      '--memory', memory, '--memory-swap', memorySwap, '--cpus', String(cpus), '--pids-limit', String(pids),
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '-v', `${home}:/home/wisp`, '-w', '/home/wisp',
      '-e', 'HOME=/home/wisp', '-e', 'WISP_HOST=0.0.0.0',
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      image, 'node', '/opt/wisp/bin/wisp.js', '--no-open', '--port', String(port),
    ],
  };
}

// The users' network: containers can't talk to each other (no inter-container traffic).
function ensureNetwork({ network }) {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['network', 'inspect', network], { stdio: 'ignore' });
    p.on('error', () => reject(new Error('The container driver needs Docker (grid/deploy/install.sh sets it up).')));
    p.on('exit', (code) => {
      if (code === 0) return resolve();
      const c = spawn('docker', ['network', 'create', '--driver', 'bridge', '-o', 'com.docker.network.bridge.enable_icc=false', '-o', 'com.docker.network.bridge.name=br-wisp', network], { stdio: 'ignore' });
      c.on('exit', (x) => (x === 0 ? resolve() : reject(new Error(`docker network create ${network} failed`))));
    });
  });
}

export class Hostd extends EventEmitter {
  // user: { id, handle }. secretFor(user) → the trusted-proxy secret; urlFor(user) → its public URL.
  constructor({ dataDir, driver = 'process', idleMs, checkMs, startMs = 45_000, maxRunning = 50, env = {}, path: extraPath = '', container = {}, secretFor, urlFor, gridUrl = '', telemetry = false, wispBin = WISP_BIN, log = () => {} }) {
    super();
    if (driver !== 'process' && driver !== 'container') throw new Error(`hostd driver "${driver}" isn’t built yet: use "process" or "container" (see grid/README.md).`);
    Object.assign(this, { dataDir, driver, idleMs, checkMs, startMs, maxRunning, env, extraPath, secretFor, urlFor, gridUrl, telemetry, wispBin, log, container: { ...CONTAINER, ...container } });
    if (driver === 'container') this.network = ensureNetwork(this.container).catch((err) => log(`hostd: ${err.message}`));
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
    return { root, wisp: path.join(root, 'wisp'), home: path.join(root, 'home'), log: path.join(root, 'wisp.log') };
  }

  // Running, or started and waited for. Several callers share one start.
  async ensure(user) {
    const i = this.#of(user);
    i.lastTouch = Date.now();
    if (i.state === 'running') return i;
    if (i.state === 'starting') return i.ready;
    if (i.state === 'stopping') await i.stopped;
    const running = [...this.inst.values()].filter((x) => x.state === 'running' || x.state === 'starting').length;
    if (running >= this.maxRunning) throw Object.assign(new Error('This grid is full right now. Try again in a few minutes.'), { status: 503 });
    i.state = 'starting';
    this.#changed(i);
    i.ready = this.#start(i).catch((err) => {
      i.state = 'stopped';
      i.error = err.message;
      this.#changed(i, 'failed');
      throw err;
    });
    return i.ready;
  }

  async #start(i) {
    const d = this.dirs(i.user);
    for (const x of [d.wisp, d.home]) fs.mkdirSync(x, { recursive: true });
    i.port = await freePort();
    const wisp = { WISP_TRUSTED_PROXY_SECRET: this.secretFor(i.user), WISP_PUBLIC_URL: this.urlFor(i.user), ...(this.gridUrl && { WISP_GRID_URL: this.gridUrl }), WISP_UPDATE_CHECK: '0', ...(!this.telemetry && { WISP_TELEMETRY: '0' }), WISP_FEEDBACK: '0', WISP_NO_OPEN: '1' };
    let cmd;
    let args;
    let env;
    if (this.driver === 'container') {
      await this.network;
      const resolv = path.join(d.root, 'resolv.conf');
      fs.writeFileSync(resolv, this.container.dns.map((x) => `nameserver ${x}\n`).join(''));
      ({ cmd, args } = containerRun({ ...this.container, resolv, name: containerName(i.user), port: i.port, home: d.home, env: { ...this.env, ...wisp } }));
      env = { PATH: process.env.PATH };
      // The image runs as uid 1000; its home is this folder.
      try {
        fs.chownSync(d.home, this.container.uid, this.container.uid);
      } catch {}
    } else {
      env = Object.fromEntries(BASE_ENV.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
      if (this.extraPath) env.PATH = `${this.extraPath}${path.delimiter}${env.PATH || ''}`;
      Object.assign(env, this.env, { HOME: d.home, USERPROFILE: d.home, WISP_HOME: d.wisp, ...wisp });
      [cmd, args] = [process.execPath, [this.wispBin, '--no-open', '--port', String(i.port)]];
    }
    const out = fs.openSync(d.log, 'a');
    const child = spawn(cmd, args, { cwd: d.home, env, stdio: ['ignore', out, out] });
    fs.closeSync(out);
    i.child = child;
    i.startedAt = Date.now();
    let exited = false;
    i.stopped = new Promise((resolve) =>
      child.on('exit', (code, signal) => {
        exited = true;
        const was = i.state;
        Object.assign(i, { state: 'stopped', child: null, port: null, stoppedAt: Date.now() });
        if (was === 'running' && !i.stopReason) i.stopReason = `exited (${signal || code})`;
        this.#changed(i, i.stopReason || 'exited');
        i.stopReason = null;
        this.#scheduleWake(i);
        resolve();
      }),
    );
    const until = Date.now() + this.startMs;
    while (Date.now() < until) {
      if (exited) throw new Error(`Its wisp quit while starting; see ${d.log}.`);
      try {
        await getJson(i.port, '/api/health', 2000);
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
      if (this.driver === 'container') spawn('docker', ['kill', containerName(i.user)], { stdio: 'ignore' });
      i.child?.kill('SIGKILL');
    }, KILL_AFTER_MS);
    await i.stopped;
    clearTimeout(kill);
    return true;
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
      i.nextWakeAt = s.nextWakeAt || null;
      i.lastActiveAt = Math.max(s.lastActivityAt || 0, i.lastTouch || 0);
      // Checked after the await: a request may have arrived meanwhile. stop() flips the state
      // before it yields, so a request after this point waits for a fresh start instead.
      const quiet = i.state === 'running' && !i.inflight && !s.live && !s.sides && !s.clients && Date.now() - Math.max(i.lastActiveAt, i.lastTouch || 0) > this.idleMs;
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
      if (i.state === 'stopped') this.ensure(i.user).catch((err) => this.log(`hostd: wake ${i.user.handle}: ${err.message}`));
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
    clearInterval(this.timer);
    for (const i of this.inst.values()) clearTimeout(i.wakeTimer);
    await Promise.all([...this.inst.keys()].map((id) => this.stop(id, 'grid stopped')));
  }
}
