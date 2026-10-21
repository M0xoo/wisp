// Machines: run agents on your other computers over SSH. wisp starts itself on the machine (or
// uses the one already running there), reaches it through an SSH tunnel and shows its sessions
// here, so worktrees, diffs, rollback, ask_user and Ship it work over there unchanged.
//
//   connect   one `ssh -L <free port>:127.0.0.1:<port> <host> sh -s` per machine. The script on
//             stdin finds Node, starts `npx -y wisp-agents@<this version>` detached if nothing
//             answers on <port>, reports each step as an `@@wisp …` line, then holds the session.
//   requests  go to the forwarded local port with the Host header the remote server insists on.
//   sessions  are <id>@<machine> here. Summaries, sessions and events are rewritten on the way.
//
// Nothing new listens on the network: the remote wisp stays on its own loopback, and it keeps
// running (agents too) when this computer sleeps. Auth is whatever your SSH setup does.
//
// Cloud computers (kind: 'grid') are wisps on a wisp Grid (grid/), reached over HTTPS at their own
// address with a device token (secrets.json, never config.json). The grid stops one that's idle:
// this computer's event stream doesn't keep it up (x-wisp-relay), so when it ends the machine is
// 'asleep', watched without waking it, and anything you do there wakes it again.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { target as gridTarget } from './grid-client.js';
import net from 'node:net';
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import { spawn, killTree } from './proc.js';
import { newer } from './update.js';
import { bootstrapScript, STEPS } from './machines/bootstrap.js';
import { letIn } from './machines/letin.js';
import { sshHint, sshHosts, knownHosts, tailscalePeers, discoverHosts, TARGET } from './machines/hosts.js';
import { HERE } from './store.js';
import { bad, DEFAULT_PORT, shq } from './util.js';

export { DEFAULT_PORT };
const READY_TIMEOUT_MS = 6 * 60_000; // the first `npx` download can take a while
const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
const LIST_TIMEOUT_MS = 5_000;
const GRID_STEPS = [
  ['wake', 'Wake it up'],
  ['agents', 'Find harnesses'],
];
const GRID_WAKE_MS = 90_000;
const GRID_WATCH_MS = 20_000; // how often an asleep cloud computer is checked (without waking it)
const isGrid = (m) => m?.kind === 'grid';
const MAX_LOG = 80;

const sshBin = () => process.env.WISP_SSH || 'ssh';
export { STEPS, shq, bootstrapScript, sshHint, sshHosts, knownHosts, tailscalePeers, discoverHosts };

// Session ids: <remote id>@<machine id> here. Local ids never contain '@'.
export const qualify = (id, mid) => (id ? `${id}@${mid}` : id);
export function splitId(id) {
  const i = String(id || '').lastIndexOf('@');
  return i > 0 ? { id: id.slice(0, i), machine: id.slice(i + 1) } : null;
}

// The version an older wisp on the machine would become on Restart wisp there: this one, unless a
// custom start command decides what runs there.
export const updateTo = (local, remote, command) => (!command && remote && newer(local, remote) ? local : null);

// What the UI needs of a machine's harness list.
const remoteAgent = ({ id, name, available, version, models, efforts, delegates }) => ({ id, name, available, version, models, efforts, delegates });

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer().once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const readAll = (res) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });


export class Machines extends EventEmitter {
  // onEvent(event, data): a session event from a machine, ids already rewritten.
  constructor({ store, version, apiVersion, secrets = null, onEvent = () => {}, onChange = () => {} }) {
    super();
    Object.assign(this, { store, version, apiVersion, secrets, onEvent, onChange });
    this.conns = new Map(); // machine id -> connection state
    this.cache = new Map(); // machine id -> Map(remote id -> remote summary): shown while it's offline
  }

  get list() {
    return (this.store.config.machines ||= []);
  }

  get defaultCommand() {
    return `npx -y wisp-agents@${this.version}`;
  }

  get(id) {
    const m = this.list.find((x) => x.id === id);
    if (!m) throw bad('No such machine.', 404);
    return m;
  }

  // The harnesses the machine reported when it came online (Auto routes with these), or null.
  agentsOf(id) {
    return this.conns.get(id)?.remote?.agents || null;
  }

  isOnline(id) {
    return this.conns.get(id)?.state === 'online';
  }

  // Takes requests: online, or a cloud computer asleep (a request wakes it).
  usable(id) {
    const st = this.conns.get(id)?.state;
    return st === 'online' || (st === 'asleep' && isGrid(this.list.find((m) => m.id === id)));
  }

  start() {
    for (const m of this.list) {
      if (m.autoConnect === false) continue;
      // Opening wisp here shouldn't wake a cloud computer: follow it if it's up, else wait.
      if (isGrid(m)) this.#asleep(m, { id: m.id, grid: true, state: 'asleep', steps: [], log: [], attempt: 0 }, 0);
      else this.connect(m.id).catch(() => {});
    }
  }

  stop() {
    for (const c of this.conns.values()) this.#hangUp(c);
  }

  // --- config ------------------------------------------------------------------------------

  #clean(body, prev = {}) {
    const v = (k, d) => (body[k] !== undefined ? body[k] : prev[k] !== undefined ? prev[k] : d);
    // A cloud computer's address comes from the grid; only its name and auto-connect change here.
    if (isGrid(prev)) return { name: String(v('name', '') || '').trim().slice(0, 40) || prev.name, autoConnect: v('autoConnect', true) !== false };
    const target = String(v('target', '')).trim();
    if (!TARGET.test(target)) throw bad('SSH host: user@host, a host name, or a Host from ~/.ssh/config.');
    const port = Number(v('port', DEFAULT_PORT));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad('Port: a number from 1 to 65535.');
    const command = String(v('command', '') || '').trim();
    const name = String(v('name', '') || '').trim().slice(0, 40) || target.replace(/^.*@/, '');
    return { name, target, port, command, autoConnect: v('autoConnect', true) !== false };
  }

  // A cloud computer, after signing in to its grid (services/cloud.js). The token goes to secrets.json.
  addGrid({ url, grid, handle, name, token, user = null }) {
    const u = new URL(url);
    let m = this.list.find((x) => isGrid(x) && x.url === u.origin);
    if (m) Object.assign(m, { grid, handle, user });
    else {
      m = { id: randomBytes(3).toString('hex'), kind: 'grid', name: String(name || handle || u.hostname).slice(0, 40), url: u.origin, grid, handle, user, target: u.host, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80), command: '', autoConnect: true, addedAt: Date.now() };
      this.list.push(m);
    }
    this.secrets?.set('machines', m.id, token);
    this.store.saveConfig();
    this.onChange();
    return m;
  }

  add(body = {}) {
    const m = { id: randomBytes(3).toString('hex'), ...this.#clean(body), addedAt: Date.now() };
    if (this.list.some((x) => x.target === m.target && x.port === m.port)) throw bad(`${m.target} is already added.`, 409);
    this.list.push(m);
    this.store.saveConfig();
    this.onChange();
    return m;
  }

  async update(id, body = {}) {
    const m = this.get(id);
    const next = this.#clean(body, m);
    const reconnect = ['target', 'port', 'command'].some((k) => next[k] !== m[k]) && this.conns.get(id)?.state !== 'off';
    Object.assign(m, next);
    this.store.saveConfig();
    if (reconnect && this.conns.has(id)) {
      this.disconnect(id);
      this.connect(id).catch(() => {});
    }
    this.onChange();
    return m;
  }

  remove(id) {
    this.get(id);
    this.disconnect(id);
    this.conns.delete(id);
    this.cache.delete(id);
    this.secrets?.delete('machines', id);
    this.store.config.machines = this.list.filter((x) => x.id !== id);
    // Its checkouts go. A project added there lives on in a copy elsewhere, if it has one.
    this.store.config.projects = this.store.config.projects.filter((p) => {
      delete p.copies?.[id];
      if (p.machine !== id) return true;
      const [k, dir] = Object.entries(p.copies || {})[0] || [];
      if (!k) return false;
      delete p.copies[k];
      delete p.machine;
      Object.assign(p, { path: dir }, k !== HERE && { machine: k });
      return true;
    });
    this.store.saveConfig();
    this.onChange();
  }

  view() {
    return this.list.map((m) => {
      const c = this.conns.get(m.id);
      const cached = [...(this.cache.get(m.id)?.values() || [])];
      return {
        ...m,
        defaultCommand: this.defaultCommand,
        state: c?.state || 'off',
        steps: c?.steps || [],
        error: c?.error || '',
        hint: c?.hint || null,
        stale: !!c?.stalePid,
        attempt: c?.attempt || 0,
        since: c?.since || null,
        remote: c?.remote || null,
        outdated: updateTo(this.version, c?.remote?.version, m.command),
        log: c?.log.slice(-30) || [],
        projects: this.store.config.projects.filter((p) => this.store.pathAt(p, m.id)).length,
        working: cached.filter((s) => s.state === 'running').length,
      };
    });
  }

  // --- the connection ----------------------------------------------------------------------

  #step(c, id, status, detail) {
    const i = c.steps.findIndex((s) => s.id === id);
    if (i < 0) return;
    Object.assign(c.steps[i], { status, ...(detail !== undefined && { detail }) });
    if (status === 'done' && c.steps[i + 1]?.status === 'pending') c.steps[i + 1].status = 'run';
    this.onChange();
  }

  #log(c, line) {
    c.log.push(line);
    if (c.log.length > MAX_LOG) c.log.splice(0, c.log.length - MAX_LOG);
  }

  async connect(id, { retry = false } = {}) {
    const m = this.get(id);
    if (isGrid(m)) return this.#connectGrid(m, { retry });
    const prev = this.conns.get(id);
    if (prev?.child || prev?.state === 'online') return this.view().find((x) => x.id === id);
    clearTimeout(prev?.retryTimer);
    const c = {
      id,
      state: retry ? 'reconnecting' : 'connecting',
      steps: STEPS.map(([sid, label], i) => ({ id: sid, label, status: i ? 'pending' : 'run', detail: '' })),
      error: '',
      hint: null,
      log: [],
      stderr: '',
      attempt: retry ? prev?.attempt || 0 : 0,
      wasOnline: retry ? prev?.wasOnline : false,
      remote: prev?.remote || null,
    };
    this.conns.set(id, c);
    this.onChange();
    c.localPort = await freePort();
    const args = [
      ...['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15'],
      ...['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ExitOnForwardFailure=yes'],
      ...['-L', `${c.localPort}:127.0.0.1:${m.port}`, m.target, 'sh -s'],
    ];
    const child = spawn(sshBin(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    c.child = child;
    child.stdin.on('error', () => {});
    child.stdin.write(bootstrapScript({ port: m.port, command: m.command || this.defaultCommand, apiVersion: this.apiVersion, installNode: true }));
    child.stderr.on('data', (d) => {
      c.stderr = (c.stderr + d).slice(-4000);
      for (const l of String(d).split(/\r?\n/)) if (l.trim()) this.#log(c, l);
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.#line(m, c, line));
    c.readyTimer = setTimeout(() => this.#fail(c, 'It took too long to start wisp there.'), READY_TIMEOUT_MS);
    child.on('error', (err) => this.#fail(c, `Could not run ssh: ${err.message}`, { text: 'wisp needs the OpenSSH client (`ssh`) on this computer.' }));
    child.on('close', (code) => this.#closed(m, c, code));
    return this.view().find((x) => x.id === id);
  }

  #line(m, c, line) {
    const hit = /^@@wisp (\w+)\s*(.*)$/.exec(line);
    if (!hit) return line.trim() && this.#log(c, line);
    const [, kind, rest] = hit;
    if (kind === 'step') {
      const [, sid, status, detail = ''] = /^(\w+) (\w+)\s*(.*)$/.exec(rest) || [];
      this.#log(c, `${sid}: ${detail || status}`);
      return this.#step(c, sid, status, detail);
    }
    if (kind === 'stale') return (c.stalePid = Number(rest) || null);
    if (kind === 'fail') {
      const [, sid, msg = ''] = /^(\w+)\s*(.*)$/.exec(rest) || [];
      this.#step(c, sid, 'fail', msg);
      const hint = sid === 'node' ? { title: 'Node.js is missing there', text: 'wisp couldn’t install Node.js there by itself (see above). Install the LTS version from nodejs.org on that computer, then Try again.', url: 'https://nodejs.org/en/download' } : null;
      c.giveUp = true; // retrying won't change the answer
      return this.#fail(c, msg, hint, { keep: true });
    }
    if (kind === 'ready') {
      const [version, pid] = rest.split(' ');
      c.remote = { ...c.remote, version, pid: Number(pid) || null };
      this.#ready(m, c).catch((err) => this.#fail(c, err.message));
    }
  }

  // A cloud computer: no ssh, no script. Asking for /health wakes it (the grid starts it on any
  // request); a 503 means it's still waking.
  async #connectGrid(m, { retry = false } = {}) {
    const prev = this.conns.get(m.id);
    if (prev?.state === 'online' || prev?.waking) return this.view().find((x) => x.id === m.id);
    clearTimeout(prev?.retryTimer);
    clearTimeout(prev?.watchTimer);
    const token = this.secrets?.get('machines', m.id);
    const c = {
      id: m.id,
      grid: true,
      waking: true,
      token,
      state: retry ? 'reconnecting' : 'connecting',
      steps: GRID_STEPS.map(([sid, label], i) => ({ id: sid, label, status: i ? 'pending' : 'run', detail: '' })),
      error: '',
      hint: null,
      log: [],
      attempt: retry ? prev?.attempt || 0 : 0,
      wasOnline: retry ? prev?.wasOnline : false,
      remote: prev?.remote || null,
    };
    this.conns.set(m.id, c);
    this.onChange();
    if (!token) {
      c.waking = false;
      this.#fail(c, 'Signed out of this cloud computer.', { title: 'Sign in again', text: 'Settings → Cloud → Sign in, with the same grid.' });
      return this.view().find((x) => x.id === m.id);
    }
    (async () => {
      const until = Date.now() + GRID_WAKE_MS;
      let health = null;
      while (!health && Date.now() < until && this.conns.get(m.id) === c) {
        try {
          health = await this.#raw(m, c, 'GET', '/health', undefined, { timeout: 30_000 });
        } catch (err) {
          if (err.status === 401 || err.status === 403) {
            c.giveUp = true;
            throw Object.assign(new Error('The grid didn’t accept this computer’s sign-in.'), { hint: { title: 'Signed out', text: 'The device was revoked or expired. Settings → Cloud → Sign in again.' } });
          }
          this.#step(c, 'wake', 'run', err.status === 503 ? 'Starting…' : err.message);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (!health) throw new Error('It didn’t wake up in time.');
      if (this.conns.get(m.id) !== c) return;
      this.#step(c, 'wake', 'done', new URL(m.url).host);
      await this.#ready(m, c);
    })()
      .catch((err) => {
        c.waking = false;
        this.#fail(c, err.message, err.hint);
      })
      .finally(() => {
        c.waking = false;
      });
    return this.view().find((x) => x.id === m.id);
  }

  // The script says wisp answers over there; check it through the tunnel, then go live.
  async #ready(m, c) {
    this.#step(c, 'tunnel', 'run');
    let health;
    for (let i = 0; i < 40 && !health; i++) {
      health = await this.#raw(m, c, 'GET', '/health').catch(() => null);
      if (!health) await new Promise((r) => setTimeout(r, 250));
    }
    if (!health) throw new Error('The tunnel opened, but wisp doesn’t answer through it.');
    if (this.conns.get(m.id) !== c) return;
    this.#step(c, 'tunnel', 'done', `localhost:${c.localPort} → ${m.port}`);
    const [agents, config] = await Promise.all([this.#raw(m, c, 'GET', '/agents').catch(() => []), this.#raw(m, c, 'GET', '/config').catch(() => ({}))]);
    const ready = agents.filter((a) => a.available);
    c.remote = { ...c.remote, version: health.version, pid: health.pid, home: config.home || '', agents: agents.map(remoteAgent) };
    this.#step(c, 'agents', ready.length ? 'done' : 'warn', ready.length ? ready.map((a) => a.name).join(', ') : 'No coding agent installed there yet. Install Claude Code, Codex or opencode on that computer and sign in once.');
    clearTimeout(c.readyTimer);
    Object.assign(c, { state: 'online', error: '', hint: null, attempt: 0, wasOnline: true, since: Date.now() });
    this.#listen(m, c);
    await this.sessions({}, { only: m.id }).catch(() => {});
    this.onChange();
    this.emit('online', m);
  }

  // Detect harnesses and models again on every online machine (after installing or signing in
  // to something there). A machine that doesn't answer keeps what it had.
  async recheckAgents() {
    const online = this.list.map((m) => [m, this.conns.get(m.id)]).filter(([, c]) => c?.state === 'online');
    await Promise.all(
      online.map(async ([m, c]) => {
        const agents = await this.#raw(m, c, 'GET', '/agents?fresh=1').catch(() => null);
        if (!Array.isArray(agents) || this.conns.get(m.id) !== c) return;
        c.remote = { ...c.remote, agents: agents.map(remoteAgent) };
      }),
    );
    if (online.length) this.onChange();
  }

  #fail(c, msg, hint, { keep = false } = {}) {
    if (this.conns.get(c.id) !== c) return;
    if (c.error && !keep) return;
    c.error = msg;
    c.hint = hint || c.hint;
    const running = c.steps.find((s) => s.status === 'run');
    if (running) Object.assign(running, { status: 'fail', detail: running.detail || msg });
    if (c.grid) c.state = 'error'; // no ssh child whose exit would say so
    this.onChange();
    this.#hangUp(c);
  }

  #closed(m, c, code) {
    clearTimeout(c.readyTimer);
    c.child = null;
    c.events?.destroy();
    if (this.conns.get(m.id) !== c) return;
    if (c.stopped) {
      c.state = 'off';
      return this.onChange();
    }
    const lost = c.state === 'online' || c.wasOnline;
    if (!c.error) {
      c.error = lost ? 'Connection lost.' : String(c.stderr).trim().split('\n').filter(Boolean).at(-1) || `ssh exited (${code}).`;
      c.hint = sshHint(c.stderr, m.target);
      // The step says it in words (the raw ssh line stays under Details).
      const running = c.steps.find((s) => s.status === 'run');
      if (running) Object.assign(running, { status: 'fail', detail: c.hint?.title || c.error });
    }
    // Once it has worked, keep trying (laptop lid, Wi-Fi, VPN). A first connect that fails stops.
    if (lost && !c.giveUp) {
      c.state = 'reconnecting';
      const wait = RETRY_MS[Math.min(c.attempt, RETRY_MS.length - 1)];
      c.attempt += 1;
      c.retryTimer = setTimeout(() => this.connect(m.id, { retry: true }).catch(() => {}), wait);
      c.retryTimer.unref?.();
    } else c.state = 'error';
    this.onChange();
    this.emit('offline', m);
  }

  #hangUp(c) {
    clearTimeout(c.retryTimer);
    clearTimeout(c.readyTimer);
    clearTimeout(c.watchTimer);
    c.events?.destroy();
    if (c.child) {
      c.child.stdin.end();
      killTree(c.child);
    }
  }

  disconnect(id) {
    const c = this.conns.get(id);
    if (!c) return;
    c.stopped = true;
    c.giveUp = true;
    this.#hangUp(c);
    if (!c.child) c.state = 'off';
    if (c.grid) this.cache.delete(id);
    this.onChange();
  }

  // Run one command on the machine (stop / restart its wisp). Resolves { code, out }.
  #ssh(m, command) {
    return new Promise((resolve) => {
      const child = spawn(sshBin(), ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', m.target, command], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('error', (err) => resolve({ code: -1, out: err.message }));
      child.on('close', (code) => resolve({ code, out }));
    });
  }

  // The machine refused this computer's key: sign in with the password once to add it, then connect.
  async letIn(id, password) {
    const m = this.get(id);
    if (isGrid(m)) throw bad('A cloud computer signs in through its grid: Settings → Cloud.', 400);
    const r = await letIn({ target: m.target, password, ssh: sshBin() });
    return { ...r, machine: await this.connect(id) };
  }

  // Stop wisp on the machine: its agents stop too. restart: connect again right after, which
  // starts this version there.
  async stopRemote(id, { restart = false } = {}) {
    const m = this.get(id);
    const c = this.conns.get(id);
    if (isGrid(m)) {
      // The grid stops it (and starts it again on the next request).
      const res = await this.#gridEdge(m, 'POST', '/_grid/stop');
      if (res.status >= 400) throw bad(res.body.error || `The grid said ${res.status}.`, res.status);
      if (c) this.#asleep(m, c);
      if (restart) await this.connect(id);
      return { ok: true };
    }
    const pid = c?.remote?.pid || c?.stalePid;
    if (!pid) throw bad('wisp isn’t known to be running there.', 409);
    this.disconnect(id);
    const r = await this.#ssh(m, `kill ${Number(pid)} 2>&1 || true`);
    if (r.code) throw bad(`Couldn’t stop it: ${r.out.trim() || `ssh exited ${r.code}`}`, 502);
    this.cache.delete(id);
    if (c) Object.assign(c, { remote: null, stalePid: null });
    if (restart) {
      await new Promise((res) => setTimeout(res, 1500));
      await this.connect(id);
    }
    this.onChange();
    return { ok: true };
  }

  // --- requests through the tunnel ---------------------------------------------------------

  #online(id) {
    const m = this.get(id);
    const c = this.conns.get(id);
    // Asleep: the request itself wakes it; the event stream follows.
    if (isGrid(m) && c?.state === 'asleep') {
      this.connect(id, { retry: true }).catch(() => {});
      return { m, c: this.conns.get(id) };
    }
    if (c?.state !== 'online') throw bad(`${m.name} is offline. Connect it from Machines.`, 503);
    return { m, c };
  }

  // A request to the grid's edge itself (/_grid/…), which never wakes the computer.
  #gridEdge(m, method, p) {
    return import('./grid-client.js').then(({ gridJson }) => gridJson(`${m.url}${p}`, { method, token: this.secrets?.get('machines', m.id), body: method === 'GET' ? undefined : {} }));
  }

  // The grid stopped it (idle): keep the last sessions, check now and then without waking it.
  #asleep(m, c, first = GRID_WATCH_MS) {
    this.conns.set(m.id, c);
    c.events?.destroy();
    Object.assign(c, { state: 'asleep', error: '' });
    this.onChange();
    clearTimeout(c.watchTimer);
    const watch = async () => {
      if (this.conns.get(m.id) !== c || c.state !== 'asleep') return;
      const r = await this.#gridEdge(m, 'GET', '/_grid/state').catch(() => null);
      if (this.conns.get(m.id) !== c || c.state !== 'asleep') return;
      // Woken elsewhere (the phone, a schedule): follow it again.
      if (r?.body?.state === 'running') return this.connect(m.id, { retry: true }).catch(() => {});
      c.watchTimer = setTimeout(watch, GRID_WATCH_MS);
      c.watchTimer.unref?.();
    };
    c.watchTimer = setTimeout(watch, first);
    c.watchTimer.unref?.();
  }

  // Where a request goes: the tunnel's local port, or a cloud computer's own address.
  #to(m, c, p, headers) {
    if (!isGrid(m)) return { lib: http, opts: { host: '127.0.0.1', port: c.localPort, path: p, headers: { ...headers, host: `127.0.0.1:${m.port}` } } };
    const { lib, opts } = gridTarget(m.url);
    const token = c?.token || this.secrets?.get('machines', m.id);
    return { lib, opts: { ...opts, path: p, headers: { ...headers, authorization: `Bearer ${token}` } } };
  }

  #request(m, c, method, p, { body, headers = {}, timeout = 120_000 } = {}) {
    return new Promise((resolve, reject) => {
      const { lib, opts } = this.#to(m, c, `/api${p}`, headers);
      const req = lib.request({ ...opts, method, timeout }, resolve);
      req.on('timeout', () => req.destroy(bad(`${m.name} didn’t answer in time.`, 504)));
      req.on('error', (err) => reject(Object.assign(err, { status: err.status || 502 })));
      if (body && typeof body.pipe === 'function') body.pipe(req);
      else req.end(body);
    });
  }

  async #raw(m, c, method, p, body, opts = {}) {
    const json = method !== 'GET';
    const res = await this.#request(m, c, method, p, { body: json ? JSON.stringify(body ?? {}) : undefined, headers: json ? { 'content-type': 'application/json' } : {}, ...opts });
    const text = await readAll(res);
    let j;
    try {
      j = text ? JSON.parse(text) : {};
    } catch {
      j = { error: text.slice(0, 200) };
    }
    if (res.statusCode >= 400) throw bad(j.error || `${m.name}: HTTP ${res.statusCode}`, res.statusCode);
    return j;
  }

  // JSON call to the machine's API: p is the path under /api.
  json(id, method, p, body, opts) {
    const { m, c } = this.#online(id);
    return this.#raw(m, c, method, p, body, opts);
  }

  // A raw request (files, uploads): resolves with the http.IncomingMessage.
  stream(id, method, p, opts) {
    const { m, c } = this.#online(id);
    return this.#request(m, c, method, p, opts);
  }

  // --- the machine's event stream, relayed with ids rewritten ------------------------------

  #listen(m, c) {
    // x-wisp-relay: this stream alone doesn't keep a cloud computer awake.
    const { lib, opts } = this.#to(m, c, '/api/events', { accept: 'text/event-stream', 'x-wisp-relay': '1' });
    const req = lib.get(opts, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (!event || !data) continue;
          try {
            this.#relay(m, event, JSON.parse(data));
          } catch {}
        }
      });
      res.on('end', () => this.#streamLost(m, c));
      res.on('close', () => this.#streamLost(m, c)); // cut off without an end (the far side went away)
    });
    req.on('error', () => this.#streamLost(m, c));
    c.events = req;
  }

  // The stream only ends when wisp over there stopped or the tunnel broke: start over.
  #streamLost(m, c) {
    if (this.conns.get(m.id) !== c || c.state !== 'online' || c.stopped) return;
    if (c.grid) return this.#asleep(m, c);
    c.error = 'wisp stopped answering there.';
    this.#hangUp(c);
  }

  #relay(m, event, d) {
    const q = (id) => qualify(id, m.id);
    const cache = this.#cacheOf(m.id);
    if (event === 'summary') {
      if (d.agent === 'wisp') return; // its own welcome tour
      cache.set(d.id, d);
      return this.onEvent('summary', this.summary(m.id, d));
    }
    if (event === 'activity' || event === 'turn') return this.onEvent(event, { ...d, sessionId: q(d.sessionId) });
    if (event === 'finished') {
      if (d.session?.agent === 'wisp') return;
      cache.set(d.session.id, d.session);
      return this.onEvent('finished', { ...d, session: this.summary(m.id, d.session) });
    }
    if (event === 'removed') {
      cache.delete(d.id);
      return this.onEvent('removed', { id: q(d.id) });
    }
  }

  #cacheOf(mid) {
    if (!this.cache.has(mid)) this.cache.set(mid, new Map());
    return this.cache.get(mid);
  }

  // --- rewriting: remote shapes → local ones -----------------------------------------------

  #tag(m) {
    return { id: m.id, name: m.name, target: m.target };
  }

  summary(mid, s) {
    const m = this.get(mid);
    const q = (id) => qualify(id, mid);
    const p = s.scratch ? null : this.store.projectFor(s.cwd || '', mid);
    return {
      ...s,
      id: q(s.id),
      groupId: s.groupId || null, // random, and shared across machines when one launch fans out
      ...(s.parentId && { parentId: q(s.parentId) }),
      ...(s.group && { group: s.group.map((x) => this.summary(mid, x)) }),
      projectId: p?.id || null,
      project: p?.name || s.project,
      color: p?.color || s.color,
      machine: this.#tag(m),
    };
  }

  session(mid, s) {
    const m = this.get(mid);
    const q = (id) => qualify(id, mid);
    return {
      ...s,
      id: q(s.id),
      groupId: s.groupId || null, // random, and shared across machines when one launch fans out
      ...(s.parentId && { parentId: q(s.parentId) }),
      ...(s.children && { children: Object.fromEntries(Object.entries(s.children).map(([k, v]) => [k, q(v)])) }),
      ...(s.childSessions && { childSessions: Object.fromEntries(Object.entries(s.childSessions).map(([k, v]) => [q(k), this.session(mid, v)])) }),
      turns: (s.turns || []).map((t) => ({
        ...t,
        ...(t.delegations && { delegations: t.delegations.map((d) => ({ ...d, sessionId: q(d.sessionId) })) }),
        ...(t.attachments && { attachments: t.attachments.map((a) => ({ ...a, id: q(a.id) })) }),
      })),
      machine: this.#tag(m),
    };
  }

  // Every machine's sessions (fresh when online, the last seen ones when not), for GET /sessions.
  async sessions(q = {}, { only } = {}) {
    const qs = new URLSearchParams(Object.entries(q).filter(([k]) => k === 'children' || k === 'archived')).toString();
    const lists = await Promise.all(
      this.list
        .filter((m) => !only || m.id === only)
        .map(async (m) => {
          const cache = this.#cacheOf(m.id);
          if (this.isOnline(m.id)) {
            try {
              const list = await this.json(m.id, 'GET', `/sessions${qs ? `?${qs}` : ''}`, undefined, { timeout: LIST_TIMEOUT_MS });
              cache.clear();
              for (const s of list) if (s.agent !== 'wisp') cache.set(s.id, s);
            } catch {}
          }
          return [...cache.values()].map((s) => this.summary(m.id, s));
        }),
    );
    return lists.flat();
  }

  // --- launching and projects ----------------------------------------------------------------

  // Resolves with the machine's own summary (ids not rewritten yet): the caller may add the project first.
  async launch(mid, body) {
    const { machine, ...rest } = body;
    const out = await this.json(mid, 'POST', '/sessions', rest);
    for (const x of out.group || [out]) this.#cacheOf(mid).set(x.id, x);
    return out;
  }

  // Copy one of this computer's uploads to the machine; resolves with its upload record there.
  async upload(mid, u) {
    const res = await this.stream(mid, 'POST', `/uploads?name=${encodeURIComponent(u.name)}&type=${encodeURIComponent(u.mime)}`, {
      body: fs.createReadStream(u.path),
      headers: { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(u.path).size },
      timeout: 10 * 60_000,
    });
    const text = await readAll(res);
    const j = JSON.parse(text || '{}');
    if (res.statusCode >= 400) throw bad(j.error || `Upload failed (${res.statusCode})`, res.statusCode);
    return j;
  }

  // A folder there that's a checkout of a repo already added elsewhere joins that project.
  async addProject(mid, dir, name) {
    const p = await this.json(mid, 'POST', '/projects', { path: dir }, { timeout: 10 * 60_000 }); // dir may be a repo URL to clone
    return this.store.addProject(p.path, { name: name || p.name, machine: mid, repo: p.origin || p.cloned?.url || undefined });
  }

  // A terminal on the machine running `command` (Take over), in the user's own interactive login
  // shell so its PATH has the harness. Wrapped in sh, so a fish or nu login shell parses it too.
  terminalArgv(mid, command) {
    const m = this.get(mid);
    if (isGrid(m)) throw bad('Take over needs a terminal on that computer; a cloud computer doesn’t offer one yet.', 400);
    return [sshBin(), '-t', m.target, `sh -c ${shq('exec "${SHELL:-/bin/sh}" -lic "$0"')} ${shq(command)}`];
  }
}
