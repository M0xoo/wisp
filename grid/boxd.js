// boxd: the one part of wisp Grid that runs as root (container driver). Whoever can run docker is
// root on the host, so the grid doesn't: it asks boxd, over a Unix socket only the grid's group can
// open, to run, stop or delete one user's box. boxd builds `docker run` from its own settings
// (image, runtime, network, the box's uid), so a grid that was broken into can't ask for more than
// a box. The boxes' homes, where the agents keep their logins, live in boxd's own folder
// (/var/lib/wisp-grid-boxes, root only), out of the grid user's reach.
//
//   node grid/boxd.js serve   [--socket /run/wisp-grid/box.sock] [--group wisp] [--data /var/lib/wisp-grid]
//                             [--boxes /var/lib/wisp-grid-boxes] [--image wisp-grid-user] [--runtime runsc]
//                             [--network wisp-users] [--uid 1000]
//   node grid/boxd.js migrate [--data …] [--boxes …]   move homes from <data>/users/<id>/home (grid stopped)
//
// The protocol: one JSON line per connection ({ op: 'run' | 'remove' | 'ping', … }), answers as
// JSON lines. A run's connection stays open while its box runs: { log } lines, then { exit }. The
// grid can send { signal: 'SIGTERM' | 'SIGKILL' } on it; closing it stops the box.
//
// Node built-ins only, nothing else from wisp: this is what runs as root. hostd.js uses the client
// half (boxdCall, boxdRun) and containerRun from here.

import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
export const BOXD = { socket: '/run/wisp-grid/box.sock', boxes: '/var/lib/wisp-grid-boxes', data: '/var/lib/wisp-grid', group: 'wisp' };
export const containerName = (user) => `wisp-u-${user.id}`;

const KILL_AFTER_MS = 10_000;
const MAX_LINE = 64 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SIZE = /^\d{1,12}[bkmg]?$/i;

// `docker run` for one user's wisp. Attached (no -d) with --rm: the docker process lives as long as
// the container, so whoever started it watches it like any child.
export function containerRun({ image, runtime, network, memory, memorySwap, cpus, pids, resolv = null, envFile = null, name, port, home }) {
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
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '-v', `${home}:/home/wisp`, '-w', '/home/wisp',
      // Its secrets come from a 0600 file, never the command line, which `ps` shows everyone.
      ...(envFile ? ['--env-file', envFile] : []),
      '-e', 'HOME=/home/wisp', '-e', 'WISP_HOST=0.0.0.0',
      image, 'node', '/opt/wisp/bin/wisp.js', '--no-open', '--port', String(port),
    ],
  };
}

// KEY=value lines for `docker run --env-file`, which takes values as they are: no quotes, so no
// line breaks either.
export function envFileText(env = {}) {
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
export function writeEnvFile(file, env) {
  const text = envFileText(env);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}

// The users' network: containers can't talk to each other (no inter-container traffic).
export function ensureNetwork({ network, docker = 'docker' }) {
  return new Promise((resolve, reject) => {
    const p = spawn(docker, ['network', 'inspect', network], { stdio: 'ignore' });
    p.on('error', () => reject(new Error('The container driver needs Docker (grid/deploy/install.sh sets it up).')));
    p.on('exit', (code) => {
      if (code === 0) return resolve();
      const c = spawn(docker, ['network', 'create', '--driver', 'bridge', '-o', 'com.docker.network.bridge.enable_icc=false', '-o', 'com.docker.network.bridge.name=br-wisp', network], { stdio: 'ignore' });
      c.on('error', reject);
      c.on('exit', (x) => (x === 0 ? resolve() : reject(new Error(`docker network create ${network} failed`))));
    });
  });
}

// What a run may ask for. Everything else (image, runtime, network, mounts, uid) is boxd's own.
export function checkRun(req, defaults = CONTAINER) {
  const id = String(req?.id ?? '');
  if (!ID.test(id)) throw new Error('run: a user id (letters, digits, - and _), please.');
  const port = Number(req.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('run: a port from 1024 to 65535.');
  const env = req.env && typeof req.env === 'object' && !Array.isArray(req.env) ? req.env : {};
  if (Object.keys(env).length > 200) throw new Error('run: too many env variables.');
  envFileText(env);
  const l = { memory: defaults.memory, memorySwap: defaults.memorySwap, cpus: defaults.cpus, pids: defaults.pids, ...(req.limits || {}) };
  for (const k of ['memory', 'memorySwap']) if (!SIZE.test(String(l[k])) && !(k === 'memorySwap' && String(l[k]) === '-1')) throw new Error(`run: ${k} "${l[k]}" isn’t a size like 1536m.`);
  const cpus = Number(l.cpus);
  if (!(cpus > 0 && cpus <= 256)) throw new Error(`run: cpus "${l.cpus}" isn’t a number of CPUs.`);
  const pids = Number(l.pids);
  if (!Number.isInteger(pids) || pids < 16 || pids > 1_000_000) throw new Error(`run: pids "${l.pids}" isn’t a process limit.`);
  const dns = req.dns ?? defaults.dns;
  if (!Array.isArray(dns) || !dns.length || dns.length > 4 || !dns.every((x) => net.isIP(String(x)))) throw new Error('run: dns is a list of 1 to 4 IP addresses.');
  return { id, port, env, limits: { memory: String(l.memory), memorySwap: String(l.memorySwap), cpus, pids }, dns: dns.map(String) };
}

const isRealDir = (p) => {
  try {
    return fs.lstatSync(p).isDirectory(); // lstat: a link to a folder isn't one
  } catch {
    return false;
  }
};

// boxd's folder, and every folder above it: root's, and nobody else can write to them, or someone
// could swap a box's home for a link to anywhere.
function rootOnlyDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const st = fs.lstatSync(d);
    if (st.isSymbolicLink() || st.uid !== 0 || st.mode & 0o022) throw new Error(`${d} must be root’s and writable by root only: boxd keeps the users’ homes under it.`);
    if (d === path.dirname(d)) break;
  }
  fs.chmodSync(dir, 0o700);
}

function groupId(name) {
  const line = fs.readFileSync('/etc/group', 'utf8').split('\n').find((l) => l.split(':')[0] === name);
  const gid = Number(line?.split(':')[2]);
  if (!line || !Number.isInteger(gid)) throw new Error(`There’s no group "${name}" (--group: the grid’s user’s group).`);
  return gid;
}

export function createBoxd({ boxes = BOXD.boxes, data = BOXD.data, image = CONTAINER.image, runtime = CONTAINER.runtime, network = CONTAINER.network, uid = CONTAINER.uid, docker = 'docker', log = () => {} } = {}) {
  const runs = new Map(); // user id -> { child, hard(), done }
  const root = process.getuid?.() === 0;
  const env = { PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' };
  const dockerDo = (args) =>
    new Promise((resolve) => {
      const p = spawn(docker, args, { stdio: 'ignore', env });
      p.on('error', () => resolve(127));
      p.on('exit', (code) => resolve(code));
    });

  // <boxes>/<id> (root, 0700) holds the box's env file and resolv.conf, and its home (the box's uid).
  function prepare(id) {
    const dir = path.join(boxes, id);
    const home = path.join(dir, 'home');
    if (!fs.existsSync(home)) {
      const old = path.join(data, 'users', id, 'home');
      if (isRealDir(old)) throw new Error(`Its files are still at ${old}: stop the grid and run \`node grid/boxd.js migrate\` (grid/README.md).`);
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(home)) {
      fs.mkdirSync(home, { mode: 0o755 });
      if (root) fs.chownSync(home, uid, uid);
    }
    return { dir, home };
  }

  async function stopRun(id) {
    const r = runs.get(id);
    if (!r) return;
    r.hard();
    await r.done;
  }

  async function run(conn, req, send) {
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
    const { args } = containerRun({ image, runtime, network, ...r.limits, resolv, envFile, name, port: r.port, home });
    const child = spawn(docker, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let exited = false;
    const entry = {
      child,
      hard() {
        if (exited) return;
        dockerDo(['kill', name]);
        child.kill('SIGKILL');
      },
    };
    entry.done = new Promise((resolve) => {
      const finish = (code, signal) => {
        if (exited) return;
        exited = true;
        fs.rmSync(envFile, { force: true });
        if (runs.get(r.id) === entry) runs.delete(r.id);
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
    runs.set(r.id, entry);
    for (const s of [child.stdout, child.stderr]) s.on('data', (d) => send({ log: d.toString('utf8') }));
    // The grid went away (it stopped or restarted): stop the box, as when the grid stops it.
    conn.on('close', () => {
      if (exited) return;
      child.kill('SIGTERM');
      setTimeout(() => entry.hard(), KILL_AFTER_MS).unref();
    });
    log(`boxd: ${name} on port ${r.port}`);
    return (m) => {
      if (m.signal === 'SIGTERM') child.kill('SIGTERM'); // `docker run` passes it on to the container
      else if (m.signal === 'SIGKILL') entry.hard();
    };
  }

  // Delete a box for good: the container, then its folder (home, logins and all).
  async function remove(req) {
    const id = String(req?.id ?? '');
    if (!ID.test(id)) throw new Error('remove: a user id, please.');
    await stopRun(id);
    await dockerDo(['rm', '-f', containerName({ id })]);
    fs.rmSync(path.join(boxes, id), { recursive: true, force: true });
    log(`boxd: removed ${containerName({ id })}`);
  }

  function handle(conn) {
    let buf = '';
    let first = true;
    let control = null;
    const early = []; // control lines that came before the box started
    const send = (m) => {
      if (!conn.destroyed && conn.writable) conn.write(`${JSON.stringify(m)}\n`);
    };
    conn.setEncoding('utf8');
    conn.on('error', () => {});
    conn.on('data', (d) => {
      buf += d;
      if (buf.length > MAX_LINE) return conn.destroy();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          send({ error: 'Not JSON.' });
          return conn.end();
        }
        if (first) {
          first = false;
          dispatch(m);
        } else if (control) control(m);
        else early.push(m);
      }
    });
    async function dispatch(m) {
      try {
        if (m?.op === 'ping') {
          send({ ok: true, boxes, image, runtime, network, running: runs.size });
          return conn.end();
        }
        if (m?.op === 'remove') {
          await remove(m);
          send({ ok: true });
          return conn.end();
        }
        if (m?.op === 'run') {
          control = await run(conn, m, send);
          if (control) for (const x of early.splice(0)) control(x);
          return;
        }
        throw new Error(`Unknown op "${m?.op}".`);
      } catch (err) {
        log(`boxd: ${m?.op} ${m?.id || ''}: ${err.message}`);
        send({ error: err.message });
        conn.end();
      }
    }
  }

  // boxd is stopping: every box stops the way the grid stops them, then hard after a while.
  async function stopAll() {
    const all = [...runs.values()];
    for (const r of all) r.child.kill('SIGTERM');
    const late = setTimeout(() => all.forEach((r) => r.hard()), KILL_AFTER_MS);
    await Promise.all(all.map((r) => r.done));
    clearTimeout(late);
  }

  return { handle, runs, stopAll };
}

export async function serveBoxd(opts = {}) {
  const o = { ...BOXD, ...CONTAINER, log: (m) => console.log(m), ...opts };
  const root = process.getuid?.() === 0;
  if (root) rootOnlyDir(o.boxes);
  else fs.mkdirSync(o.boxes, { recursive: true, mode: 0o700 });
  const gid = root && o.group ? groupId(o.group) : null;
  await ensureNetwork({ network: o.network, docker: o.docker }).catch((err) => o.log(`boxd: ${err.message}`));
  const boxd = createBoxd(o);
  try {
    if (fs.lstatSync(o.socket).isSocket()) fs.unlinkSync(o.socket);
  } catch {}
  fs.mkdirSync(path.dirname(o.socket), { recursive: true });
  const server = net.createServer(boxd.handle);
  const umask = process.umask(0o117); // the socket is 0660 from the start
  try {
    await new Promise((resolve, reject) => {
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
    async close() {
      const closed = new Promise((r) => server.close(r));
      await boxd.stopAll();
      await closed;
    },
  };
}

// Homes kept at the old place (<data>/users/<id>/home, in the grid's own folder) move into boxd's.
// With the grid stopped: its user can write there, so nothing may change the folders meanwhile.
export function migrate({ data = BOXD.data, boxes = BOXD.boxes, docker = 'docker', log = console.log } = {}) {
  const ps = spawnSync(docker, ['ps', '-q', '--filter', 'name=wisp-u-'], { encoding: 'utf8' });
  if (ps.status === 0 && ps.stdout.trim()) throw new Error('Boxes are running: stop the grid first (systemctl stop wisp-grid).');
  if (process.getuid?.() === 0) rootOnlyDir(boxes);
  else fs.mkdirSync(boxes, { recursive: true, mode: 0o700 });
  const users = path.join(data, 'users');
  const out = { moved: [], skipped: [] };
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
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.renameSync(from, to);
    out.moved.push(id);
    log(`  ✓ ${id}: ${from} → ${to}`);
  }
  return out;
}

// --- the grid's side -----------------------------------------------------------------------------

const unreachable = (socket, err) => `boxd didn’t answer at ${socket}${err ? ` (${err.code || err.message})` : ''}: is wisp-grid-boxd running?`;

function connect(socket, req, onMsg, onEnd) {
  const c = net.connect(socket);
  let buf = '';
  let ended = false;
  const end = (err) => {
    if (ended) return;
    ended = true;
    onEnd(err);
  };
  c.setEncoding('utf8');
  c.on('connect', () => c.write(`${JSON.stringify(req)}\n`));
  c.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      onMsg(m);
    }
  });
  c.on('error', (err) => end(err));
  c.on('close', () => end(null));
  return c;
}

// One request and its answer; boxd's error becomes an Error.
export function boxdCall(socket, req, { timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    let answer = null;
    const c = connect(
      socket,
      req,
      (m) => (answer = m),
      (err) => {
        clearTimeout(t);
        if (answer?.error) reject(new Error(answer.error));
        else if (answer) resolve(answer);
        else reject(new Error(unreachable(socket, err)));
      },
    );
    const t = setTimeout(() => c.destroy(new Error('no answer in time')), timeout);
  });
}

// A box boxd runs, shaped like the child process hostd watches: 'exit' (code, signal), kill(), and
// error: what boxd said when it couldn't start it. Its output goes to logFile.
export function boxdRun(socket, req, logFile) {
  const ev = new EventEmitter();
  ev.error = '';
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  out.on('error', () => {});
  let done = false;
  const finish = (code, signal) => {
    if (done) return;
    done = true;
    out.end();
    ev.emit('exit', code, signal);
  };
  const c = connect(
    socket,
    { ...req, op: 'run' },
    (m) => {
      if (typeof m.log === 'string') out.write(m.log);
      else if (m.error) {
        ev.error = m.error;
        out.write(`boxd: ${m.error}\n`);
      } else if ('exit' in m) finish(m.exit, m.signal || null);
    },
    (err) => {
      if (!done && !ev.error) {
        ev.error = unreachable(socket, err);
        out.write(`${ev.error}\n`);
      }
      finish(1, null);
    },
  );
  ev.kill = (signal = 'SIGTERM') => {
    if (done || c.destroyed) return false;
    c.write(`${JSON.stringify({ signal })}\n`);
    return true;
  };
  return ev;
}

// --- `node grid/boxd.js …` -------------------------------------------------------------------------

async function main(argv) {
  const [cmd, ...rest] = argv;
  const o = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) throw new Error(`What is "${rest[i]}"?`);
    o[rest[i].slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = rest[++i];
  }
  if (o.uid !== undefined) o.uid = Number(o.uid);
  if (cmd === 'serve') {
    const b = await serveBoxd(o);
    const at = { ...BOXD, ...CONTAINER, ...o };
    console.log(`boxd: listening at ${at.socket} (group ${at.group}); boxes in ${at.boxes}, image ${at.image}, runtime ${at.runtime || 'runc'}, network ${at.network}`);
    const stop = async () => {
      console.log('boxd: stopping every box…');
      await b.close();
      process.exit(0);
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    return;
  }
  if (cmd === 'migrate') {
    const r = migrate(o);
    console.log(`boxd: moved ${r.moved.length} home${r.moved.length === 1 ? '' : 's'}${r.skipped.length ? `, skipped ${r.skipped.length}` : ''}.`);
    if (r.skipped.length) process.exitCode = 1;
    return;
  }
  console.log('usage: node grid/boxd.js serve|migrate [--socket S] [--group G] [--data DIR] [--boxes DIR] [--image I] [--runtime R] [--network N] [--uid U]');
  process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`boxd: ${err.message}`);
    process.exit(1);
  });
}
