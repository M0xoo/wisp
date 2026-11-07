// boxd: the one part of wisp Grid that runs as root (container driver). Whoever can run docker is
// root on the host, so the grid doesn't: it asks boxd, over a Unix socket only the grid's group can
// open, to run, stop or delete one user's box. boxd builds `docker run` from its own settings
// (image, runtime, network, the box's uid), so a grid that was broken into can't ask for more than
// a box. The boxes' homes, where the agents keep their logins, live in boxd's own folder
// (/var/lib/wisp-grid-boxes, root only), out of the grid user's reach.
//
//   node apps/grid/src/boxd.ts serve   [--socket /run/wisp-grid/box.sock] [--group wisp] [--data /var/lib/wisp-grid]
//                                      [--boxes /var/lib/wisp-grid-boxes] [--image wisp-grid-user] [--runtime runsc]
//                                      [--network wisp-users] [--uid 1000]
//   node apps/grid/src/boxd.ts migrate [--data …] [--boxes …]   move homes from <data>/users/<id>/home (grid stopped)
//
// The protocol: one JSON line per connection ({ op: 'run' | 'remove' | 'ping', … }), answers as
// JSON lines. A run's connection stays open while its box runs: { log } lines, then { exit }. The
// grid can send { signal: 'SIGTERM' | 'SIGKILL' } on it; closing it stops the box.
//
// Node built-ins only, nothing else from wisp, not even the grid's own modules: this is what runs as
// root, so everything it trusts is on this page (test/boxd.test.ts checks its imports). That is also
// why it is one file over the 400-line guide: splitting it would mean importing, and every import is
// code that runs as root. hostd.ts uses the client half (boxdCall, boxdRun) and containerRun from here.
//
// Sync fs calls are fine here: boxd serves a handful of starts a minute, one connection each, and the
// grid's request path never waits on them (it holds the run's socket, not a reply).

import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Container {
  image: string;
  /** gVisor's runsc: a user-space kernel between the agents and the host's. '' for runc */
  runtime: string;
  network: string;
  memory: string;
  memorySwap: string;
  cpus: number;
  pids: number;
  uid: number;
  dns: string[];
}

export const CONTAINER: Readonly<Container> = {
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
export const BOXD = { socket: '/run/wisp-grid/box.sock', boxes: '/var/lib/wisp-grid-boxes', data: '/var/lib/wisp-grid', group: 'wisp' } as const;
export const containerName = (user: { id: string }): string => `wisp-u-${user.id}`;
/** The box's wisp inside the image: apps/server's bundle, copied to /opt/wisp (deploy/image/Dockerfile). */
export const BOX_ENTRY = '/opt/wisp/bin/wisp.js';

const KILL_AFTER_MS = 10_000;
const MAX_LINE = 64 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SANDBOX_ID = /-sb-[a-f0-9]{8}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SIZE = /^\d{1,12}[bkmg]?$/i;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const msgOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const codeOf = (err: unknown): string => (isObj(err) && typeof err['code'] === 'string' ? err['code'] : '');

export interface RunArgs {
  image: string;
  runtime: string;
  network: string;
  memory: string;
  memorySwap: string;
  cpus: number;
  pids: number;
  resolv?: string | null;
  envFile?: string | null;
  name: string;
  port: number;
  home: string;
  sandbox?: boolean;
}

// `docker run` for one user's wisp. Attached (no -d) with --rm: the docker process lives as long as
// the container, so whoever started it watches it like any child.
// sandbox (sandboxes.ts), under gVisor only: started as root with Docker's default capabilities
// by the image's wisp-sandbox-init, which keeps a root helper for the agent's sudo (apt-get) and runs
// wisp as the box's user. That root is gVisor's, not the host's. Under runc a sandbox is locked down
// like any box. A bigger /dev/shm for its browser either way.
export const sandboxRoot = (runtime: string): boolean => runtime === 'runsc';
export function containerRun({ image, runtime, network, memory, memorySwap, cpus, pids, resolv = null, envFile = null, name, port, home, sandbox = false }: RunArgs): { cmd: string; args: string[] } {
  const root = sandbox && sandboxRoot(runtime);
  return {
    cmd: 'docker',
    args: [
      'run', '--rm', '--init', '--name', name,
      ...(runtime ? ['--runtime', runtime] : []),
      '--network', network,
      ...(resolv ? ['-v', `${resolv}:/etc/resolv.conf:ro`] : []),
      // Only this box's loopback reaches it, on the same port number inside, so Host headers match.
      '-p', `127.0.0.1:${port}:${port}`,
      '--memory', String(memory), '--memory-swap', String(memorySwap), '--cpus', String(cpus), '--pids-limit', String(pids),
      // Root in a sandbox still goes without raw sockets, device nodes and the audit log.
      ...(root ? ['--cap-drop', 'NET_RAW', '--cap-drop', 'MKNOD', '--cap-drop', 'AUDIT_WRITE'] : ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']),
      ...(sandbox ? ['--shm-size', '512m'] : []),
      '-v', `${home}:/home/wisp`, '-w', '/home/wisp',
      // Its secrets come from a 0600 file, never the command line, which `ps` shows everyone.
      ...(envFile ? ['--env-file', envFile] : []),
      '-e', 'HOME=/home/wisp', '-e', 'WISP_HOST=0.0.0.0',
      ...(root ? ['--user', '0'] : []),
      image, ...(root ? ['/usr/local/sbin/wisp-sandbox-init'] : []), 'node', BOX_ENTRY, '--no-open', '--port', String(port),
    ],
  };
}

// KEY=value lines for `docker run --env-file`, which takes values as they are: no quotes, so no
// line breaks either.
export function envFileText(env: Readonly<Record<string, unknown>> = {}): string {
  return Object.entries(env)
    .map(([k, v]) => {
      if (!ENV_KEY.test(k)) throw new Error(`env: "${k}" isn’t a variable name.`);
      const s = String(v);
      if (/[\0\r\n]/.test(s)) throw new Error(`env: ${k} has a line break in it.`);
      return `${k}=${s}\n`;
    })
    .join('');
}

// 0600 from the moment it exists, and replaced whole (never written through a link).
export function writeEnvFile(file: string, env: Readonly<Record<string, unknown>>): void {
  const text = envFileText(env);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}

// The users' network: containers can't talk to each other (no inter-container traffic).
export function ensureNetwork({ network, docker = 'docker' }: { network: string; docker?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(docker, ['network', 'inspect', network], { stdio: 'ignore' });
    p.on('error', () => reject(new Error('The container driver needs Docker (apps/grid/deploy/install.sh sets it up).')));
    p.on('exit', (code) => {
      if (code === 0) return resolve();
      const c = spawn(docker, ['network', 'create', '--driver', 'bridge', '-o', 'com.docker.network.bridge.enable_icc=false', '-o', 'com.docker.network.bridge.name=br-wisp', network], { stdio: 'ignore' });
      c.on('error', reject);
      c.on('exit', (x) => (x === 0 ? resolve() : reject(new Error(`docker network create ${network} failed`))));
    });
  });
}

export interface Limits {
  memory: string;
  memorySwap: string;
  cpus: number;
  pids: number;
}
export interface CheckedRun {
  id: string;
  port: number;
  env: Record<string, unknown>;
  limits: Limits;
  dns: string[];
  sandbox: boolean;
}

function checkLimits(raw: unknown, defaults: Readonly<Container>): Limits {
  const l: Obj = { memory: defaults.memory, memorySwap: defaults.memorySwap, cpus: defaults.cpus, pids: defaults.pids, ...(isObj(raw) ? raw : {}) };
  for (const k of ['memory', 'memorySwap']) if (!SIZE.test(String(l[k])) && !(k === 'memorySwap' && String(l[k]) === '-1')) throw new Error(`run: ${k} "${String(l[k])}" isn’t a size like 1536m.`);
  const cpus = Number(l['cpus']);
  if (!(cpus > 0 && cpus <= 256)) throw new Error(`run: cpus "${String(l['cpus'])}" isn’t a number of CPUs.`);
  const pids = Number(l['pids']);
  if (!Number.isInteger(pids) || pids < 16 || pids > 1_000_000) throw new Error(`run: pids "${String(l['pids'])}" isn’t a process limit.`);
  return { memory: String(l['memory']), memorySwap: String(l['memorySwap']), cpus, pids };
}

// What a run may ask for. Everything else (image, runtime, network, mounts, uid) is boxd's own.
export function checkRun(raw: unknown, defaults: Readonly<Container> = CONTAINER): CheckedRun {
  const req: Obj = isObj(raw) ? raw : {};
  const id = String(req['id'] ?? '');
  if (!ID.test(id)) throw new Error('run: a user id (letters, digits, - and _), please.');
  const port = Number(req['port']);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('run: a port from 1024 to 65535.');
  const env = isObj(req['env']) ? req['env'] : {};
  if (Object.keys(env).length > 200) throw new Error('run: too many env variables.');
  envFileText(env);
  const limits = checkLimits(req['limits'], defaults);
  const dns: unknown = req['dns'] ?? defaults.dns;
  if (!Array.isArray(dns) || !dns.length || dns.length > 4 || !dns.every((x) => net.isIP(String(x)))) throw new Error('run: dns is a list of 1 to 4 IP addresses.');
  // A sandbox only by its id's shape (<user>-sb-<8 hex>, sandboxes.ts): a user's own box never.
  return { id, port, env, limits, dns: dns.map(String), sandbox: req['sandbox'] === true && SANDBOX_ID.test(id) };
}

const isRealDir = (p: string): boolean => {
  try {
    return fs.lstatSync(p).isDirectory(); // lstat: a link to a folder isn't one
  } catch {
    return false;
  }
};

// boxd's folder, and every folder above it: root's, and nobody else can write to them, or someone
// could swap a box's home for a link to anywhere.
function rootOnlyDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const st = fs.lstatSync(d);
    if (st.isSymbolicLink() || st.uid !== 0 || st.mode & 0o022) throw new Error(`${d} must be root’s and writable by root only: boxd keeps the users’ homes under it.`);
    if (d === path.dirname(d)) break;
  }
  fs.chmodSync(dir, 0o700);
}

function groupId(name: string): number {
  const line = fs.readFileSync('/etc/group', 'utf8').split('\n').find((l) => l.split(':')[0] === name);
  const gid = Number(line?.split(':')[2]);
  if (!line || !Number.isInteger(gid)) throw new Error(`There’s no group "${name}" (--group: the grid’s user’s group).`);
  return gid;
}

export interface BoxdOptions {
  boxes?: string;
  data?: string;
  image?: string;
  runtime?: string;
  network?: string;
  uid?: number;
  docker?: string;
  log?: (m: string) => void;
}

type Send = (m: Obj) => void;
type Control = (m: Obj) => void;
interface Running {
  child: ReturnType<typeof spawn>;
  hard(): void;
  done: Promise<void>;
}

export function createBoxd({ boxes = BOXD.boxes, data = BOXD.data, image = CONTAINER.image, runtime = CONTAINER.runtime, network = CONTAINER.network, uid = CONTAINER.uid, docker = 'docker', log = () => {} }: BoxdOptions = {}) {
  const runs = new Map<string, Running>(); // user id -> the box boxd runs for it
  const root = process.getuid?.() === 0;
  const env = { PATH: process.env['PATH'] || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' };
  const dockerDo = (args: string[]): Promise<number | null> =>
    new Promise((resolve) => {
      const p = spawn(docker, args, { stdio: 'ignore', env });
      p.on('error', () => resolve(127));
      p.on('exit', (code) => resolve(code));
    });

  // <boxes>/<id> (root, 0700) holds the box's env file and resolv.conf, and its home (the box's uid).
  function prepare(id: string): { dir: string; home: string } {
    const dir = path.join(boxes, id);
    const home = path.join(dir, 'home');
    if (!fs.existsSync(home)) {
      const old = path.join(data, 'users', id, 'home');
      if (isRealDir(old)) throw new Error(`Its files are still at ${old}: stop the grid and run \`node apps/grid/src/boxd.ts migrate\` (apps/grid/README.md).`);
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(home)) {
      fs.mkdirSync(home, { mode: 0o755 });
      if (root) fs.chownSync(home, uid, uid);
    }
    return { dir, home };
  }

  async function stopRun(id: string): Promise<void> {
    const r = runs.get(id);
    if (!r) return;
    r.hard();
    await r.done;
  }

  // Watches the docker child until it exits: tells the grid, ends the connection, forgets the box.
  function watch(conn: net.Socket, id: string, name: string, child: Running['child'], envFile: string, send: Send): Running {
    let exited = false;
    const entry: Running = {
      child,
      hard() {
        if (exited) return;
        void dockerDo(['kill', name]);
        child.kill('SIGKILL');
      },
      done: Promise.resolve(),
    };
    entry.done = new Promise((resolve) => {
      const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (exited) return;
        exited = true;
        fs.rmSync(envFile, { force: true });
        if (runs.get(id) === entry) runs.delete(id);
        send({ exit: code, signal });
        conn.end();
        resolve();
      };
      child.on('error', (err) => {
        send({ log: `boxd: ${docker}: ${err.message}\n` });
        finish(127, null);
      });
      child.on('close', finish);
    });
    for (const s of [child.stdout, child.stderr]) s?.on('data', (d: Buffer) => send({ log: d.toString('utf8') }));
    // The grid went away (it stopped or restarted): stop the box, as when the grid stops it.
    conn.on('close', () => {
      if (exited) return;
      child.kill('SIGTERM');
      setTimeout(() => entry.hard(), KILL_AFTER_MS).unref();
    });
    return entry;
  }

  async function run(conn: net.Socket, req: unknown, send: Send): Promise<Control | null> {
    const r = checkRun(req);
    const name = containerName({ id: r.id });
    await stopRun(r.id); // one the grid lost track of (it restarted)
    await dockerDo(['rm', '-f', name]); // and any box left from before boxd restarted
    const { dir, home } = prepare(r.id);
    const resolv = path.join(dir, 'resolv.conf');
    fs.writeFileSync(resolv, r.dns.map((x) => `nameserver ${x}\n`).join(''), { mode: 0o644 });
    const envFile = path.join(dir, 'env');
    writeEnvFile(envFile, r.env);
    if (conn.destroyed) return null; // the grid gave up while this got ready
    const { args } = containerRun({ image, runtime, network, ...r.limits, resolv, envFile, name, port: r.port, home, sandbox: r.sandbox });
    const child = spawn(docker, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const entry = watch(conn, r.id, name, child, envFile, send);
    runs.set(r.id, entry);
    log(`boxd: ${name} on port ${r.port}`);
    return (m) => {
      if (m['signal'] === 'SIGTERM') child.kill('SIGTERM'); // `docker run` passes it on to the container
      else if (m['signal'] === 'SIGKILL') entry.hard();
    };
  }

  // Delete a box for good: the container, then its folder (home, logins and all).
  async function remove(req: Obj): Promise<void> {
    const id = String(req['id'] ?? '');
    if (!ID.test(id)) throw new Error('remove: a user id, please.');
    await stopRun(id);
    await dockerDo(['rm', '-f', containerName({ id })]);
    fs.rmSync(path.join(boxes, id), { recursive: true, force: true });
    log(`boxd: removed ${containerName({ id })}`);
  }

  async function dispatch(conn: net.Socket, m: Obj, send: Send): Promise<Control | null> {
    try {
      if (m['op'] === 'ping') {
        send({ ok: true, boxes, image, runtime, network, running: runs.size });
        conn.end();
        return null;
      }
      if (m['op'] === 'remove') {
        await remove(m);
        send({ ok: true });
        conn.end();
        return null;
      }
      if (m['op'] === 'run') return await run(conn, m, send);
      throw new Error(`Unknown op "${String(m['op'])}".`);
    } catch (err) {
      log(`boxd: ${String(m['op'])} ${String(m['id'] || '')}: ${msgOf(err)}`);
      send({ error: msgOf(err) });
      conn.end();
      return null;
    }
  }

  function handle(conn: net.Socket): void {
    let buf = '';
    let first = true;
    let control: Control | null = null;
    const early: Obj[] = []; // control lines that came before the box started
    const send: Send = (m) => {
      if (!conn.destroyed && conn.writable) conn.write(`${JSON.stringify(m)}\n`);
    };
    conn.setEncoding('utf8');
    conn.on('error', () => {});
    conn.on('data', (d: string) => {
      buf += d;
      if (buf.length > MAX_LINE) return void conn.destroy();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m: unknown;
        try {
          m = JSON.parse(line);
        } catch {
          send({ error: 'Not JSON.' });
          return void conn.end();
        }
        const msg = isObj(m) ? m : {};
        if (first) {
          first = false;
          void dispatch(conn, msg, send).then((c) => {
            control = c;
            if (c) for (const x of early.splice(0)) c(x);
          });
        } else if (control) (control as Control)(msg);
        else early.push(msg);
      }
    });
  }

  // boxd is stopping: every box stops the way the grid stops them, then hard after a while.
  async function stopAll(): Promise<void> {
    const all = [...runs.values()];
    for (const r of all) r.child.kill('SIGTERM');
    const late = setTimeout(() => all.forEach((r) => r.hard()), KILL_AFTER_MS);
    await Promise.all(all.map((r) => r.done));
    clearTimeout(late);
  }

  return { handle, runs, stopAll };
}

export interface ServeOptions extends BoxdOptions {
  socket?: string;
  group?: string | null;
}

export async function serveBoxd(opts: ServeOptions = {}) {
  const o = { ...BOXD, ...CONTAINER, log: (m: string) => console.log(m), ...opts };
  const root = process.getuid?.() === 0;
  if (root) rootOnlyDir(o.boxes);
  else fs.mkdirSync(o.boxes, { recursive: true, mode: 0o700 });
  const gid = root && o.group ? groupId(o.group) : null;
  await ensureNetwork({ network: o.network, ...(o.docker !== undefined && { docker: o.docker }) }).catch((err: unknown) => o.log(`boxd: ${msgOf(err)}`));
  const boxd = createBoxd(o);
  try {
    if (fs.lstatSync(o.socket).isSocket()) fs.unlinkSync(o.socket);
  } catch {
    // nothing there yet
  }
  fs.mkdirSync(path.dirname(o.socket), { recursive: true });
  const server = net.createServer(boxd.handle);
  const umask = process.umask(0o117); // the socket is 0660 from the start
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(o.socket, resolve);
    });
  } finally {
    process.umask(umask);
  }
  if (gid != null) fs.chownSync(o.socket, 0, gid);
  fs.chmodSync(o.socket, 0o660);
  return {
    server,
    boxd,
    async close(): Promise<void> {
      const closed = new Promise((r) => server.close(r));
      await boxd.stopAll();
      await closed;
    },
  };
}

function moveHome(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    // Another disk: mv copies it across (owners, modes and links kept) and removes the old one.
    const mv = codeOf(err) === 'EXDEV' ? spawnSync('mv', [from, to], { stdio: 'inherit' }) : null;
    if (mv?.status !== 0) {
      fs.rmSync(path.dirname(to), { recursive: true, force: true });
      throw mv ? new Error(`mv ${from} ${to} failed`) : err;
    }
  }
}

// Homes kept at the old place (<data>/users/<id>/home, in the grid's own folder) move into boxd's.
// With the grid stopped: its user can write there, so nothing may change the folders meanwhile.
export function migrate({ data = BOXD.data, boxes = BOXD.boxes, docker = 'docker', log = (m: string) => console.log(m) }: { data?: string; boxes?: string; docker?: string; log?: (m: string) => void } = {}): { moved: string[]; skipped: string[] } {
  const ps = spawnSync(docker, ['ps', '-q', '--filter', 'name=wisp-u-'], { encoding: 'utf8' });
  if (ps.status === 0 && ps.stdout.trim()) throw new Error('Boxes are running: stop the grid first (systemctl stop wisp-grid).');
  if (process.getuid?.() === 0) rootOnlyDir(boxes);
  else fs.mkdirSync(boxes, { recursive: true, mode: 0o700 });
  const users = path.join(data, 'users');
  const out = { moved: [] as string[], skipped: [] as string[] };
  for (const id of fs.existsSync(users) ? fs.readdirSync(users).sort() : []) {
    const from = path.join(users, id, 'home');
    if (!ID.test(id) || !fs.existsSync(from)) continue;
    const to = path.join(boxes, id, 'home');
    const why = !isRealDir(path.join(users, id)) || !isRealDir(from) ? `${from} isn’t a folder` : fs.existsSync(to) ? `${to} is already there` : '';
    if (why) {
      out.skipped.push(id);
      log(`  ! ${id}: skipped, ${why}`);
      continue;
    }
    moveHome(from, to);
    out.moved.push(id);
    log(`  ✓ ${id}: ${from} → ${to}`);
  }
  return out;
}

// --- the grid's side -----------------------------------------------------------------------------

const unreachable = (socket: string, err: unknown): string => `boxd didn’t answer at ${socket}${err ? ` (${codeOf(err) || msgOf(err)})` : ''}: is wisp-grid-boxd running?`;

function connect(socket: string, req: Obj, onMsg: (m: Obj) => void, onEnd: (err: Error | null) => void): net.Socket {
  const c = net.connect(socket);
  let buf = '';
  let ended = false;
  const end = (err: Error | null): void => {
    if (ended) return;
    ended = true;
    onEnd(err);
  };
  c.setEncoding('utf8');
  c.on('connect', () => c.write(`${JSON.stringify(req)}\n`));
  c.on('data', (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m: unknown;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (isObj(m)) onMsg(m);
    }
  });
  c.on('error', (err) => end(err));
  c.on('close', () => end(null));
  return c;
}

// One request and its answer; boxd's error becomes an Error.
export function boxdCall(socket: string, req: Obj, { timeout = 60_000 }: { timeout?: number } = {}): Promise<Obj> {
  return new Promise((resolve, reject) => {
    let answer: Obj | null = null;
    const c = connect(
      socket,
      req,
      (m) => (answer = m),
      (err) => {
        clearTimeout(t);
        const a: Obj | null = answer;
        if (a && a['error']) reject(new Error(String(a['error'])));
        else if (a) resolve(a);
        else reject(new Error(unreachable(socket, err)));
      },
    );
    const t = setTimeout(() => c.destroy(new Error('no answer in time')), timeout);
  });
}

/** A box boxd runs, shaped like the child process hostd watches. */
export interface BoxdChild extends EventEmitter {
  /** what boxd said when it couldn't start it */
  error: string;
  kill(signal?: NodeJS.Signals): boolean;
}

// A box boxd runs, shaped like the child process hostd watches: 'exit' (code, signal), kill(), and
// error: what boxd said when it couldn't start it. Its output goes to logFile.
export function boxdRun(socket: string, req: Obj, logFile: string): BoxdChild {
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  out.on('error', () => {});
  let done = false;
  let c: net.Socket | null = null;
  const ev: BoxdChild = Object.assign(new EventEmitter(), {
    error: '',
    kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
      if (done || !c || c.destroyed) return false;
      c.write(`${JSON.stringify({ signal })}\n`);
      return true;
    },
  });
  const finish = (code: unknown, signal: unknown): void => {
    if (done) return;
    done = true;
    out.end();
    ev.emit('exit', code, signal);
  };
  c = connect(
    socket,
    { ...req, op: 'run' },
    (m) => {
      if (typeof m['log'] === 'string') out.write(m['log']);
      else if (m['error']) {
        ev.error = String(m['error']);
        out.write(`boxd: ${ev.error}\n`);
      } else if ('exit' in m) finish(m['exit'], m['signal'] || null);
    },
    (err) => {
      if (!done && !ev.error) {
        ev.error = unreachable(socket, err);
        out.write(`${ev.error}\n`);
      }
      finish(1, null);
    },
  );
  return ev;
}

// --- `node apps/grid/src/boxd.ts …` ----------------------------------------------------------------

function parseFlags(rest: string[]): ServeOptions & { uid?: number } {
  const o: Record<string, string | undefined> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (!a.startsWith('--')) throw new Error(`What is "${a}"?`);
    o[a.slice(2).replace(/-(\w)/g, (_, ch: string) => ch.toUpperCase())] = rest[++i];
  }
  const { uid, ...strings } = o;
  return { ...(strings as Record<string, string>), ...(uid !== undefined && { uid: Number(uid) }) };
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const o = parseFlags(rest);
  if (cmd === 'serve') {
    const b = await serveBoxd(o);
    const at = { ...BOXD, ...CONTAINER, ...o };
    console.log(`boxd: listening at ${at.socket} (group ${at.group}); boxes in ${at.boxes}, image ${at.image}, runtime ${at.runtime || 'runc'}, network ${at.network}`);
    const stop = async (): Promise<void> => {
      console.log('boxd: stopping every box…');
      await b.close();
      process.exit(0);
    };
    process.once('SIGTERM', () => void stop());
    process.once('SIGINT', () => void stop());
    return;
  }
  if (cmd === 'migrate') {
    const r = migrate(o);
    console.log(`boxd: moved ${r.moved.length} home${r.moved.length === 1 ? '' : 's'}${r.skipped.length ? `, skipped ${r.skipped.length}` : ''}.`);
    if (r.skipped.length) process.exitCode = 1;
    return;
  }
  console.log('usage: node apps/grid/src/boxd.ts serve|migrate [--socket S] [--group G] [--data DIR] [--boxes DIR] [--image I] [--runtime R] [--network N] [--uid U]');
  process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`boxd: ${msgOf(err)}`);
    process.exit(1);
  });
}
