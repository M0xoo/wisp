// A stand-in for `docker` in the grid tests: `run` starts the box's wisp as a plain process (no
// container) with the home, port and environment the run asked for, so hostd and boxd can be
// tested end to end without Docker. Its state and a log of every call (docker.jsonl: the args, and
// for a run the env file's mode and names, never its values) sit next to the launcher, because
// boxd runs docker with nothing but PATH in its environment.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const dir = path.dirname(process.argv[1]);
const state = path.join(dir, 'state');
fs.mkdirSync(state, { recursive: true });
const args = process.argv.slice(2);
const log = (o = {}) => fs.appendFileSync(path.join(dir, 'docker.jsonl'), `${JSON.stringify({ args, ...o })}\n`);
const pidFile = (name) => path.join(state, `${name}.pid`);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const running = () =>
  fs
    .readdirSync(state)
    .filter((f) => f.endsWith('.pid') && alive(Number(fs.readFileSync(path.join(state, f), 'utf8'))))
    .map((f) => f.slice(0, -4));

const [cmd, ...rest] = args;
if (cmd === 'network') {
  log();
  process.exit(0);
}
if (cmd === 'ps') {
  log();
  const want = /name=(\S+)/.exec(rest.join(' '))?.[1] || '';
  for (const n of running().filter((x) => x.startsWith(want))) console.log(n);
  process.exit(0);
}
if (cmd === 'rm' || cmd === 'kill') {
  log();
  const name = rest.filter((a) => !a.startsWith('-')).pop();
  const f = pidFile(name);
  if (fs.existsSync(f)) {
    try {
      process.kill(Number(fs.readFileSync(f, 'utf8')), 'SIGKILL');
    } catch {}
    fs.rmSync(f, { force: true });
  }
  process.exit(0);
}
if (cmd !== 'run') {
  log();
  console.error(`fake docker: ${cmd}?`);
  process.exit(1);
}

// docker run [options] image command…
const opt = { e: [], v: [] };
const FLAGS = new Set(['--rm', '--init']);
let i = 0;
for (; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith('-')) break;
  if (FLAGS.has(a)) continue;
  const v = rest[++i];
  if (a === '-e') opt.e.push(v);
  else if (a === '-v') opt.v.push(v);
  else opt[a] = v;
}
const command = rest.slice(i + 1);
const name = opt['--name'];
const home = opt.v.find((v) => v.endsWith(':/home/wisp'))?.slice(0, -':/home/wisp'.length);
const port = Number(String(opt['-p']).split(':').pop());
const env = {};
let envFileMode = null;
if (opt['--env-file']) {
  envFileMode = fs.statSync(opt['--env-file']).mode & 0o777;
  for (const line of fs.readFileSync(opt['--env-file'], 'utf8').split('\n')) {
    const j = line.indexOf('=');
    if (j > 0) env[line.slice(0, j)] = line.slice(j + 1);
  }
}
const fileKeys = Object.keys(env);
for (const kv of opt.e) env[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
log({ name, home, port, envFileMode, envKeys: fileKeys, network: opt['--network'], runtime: opt['--runtime'] || null });
if (fs.existsSync(pidFile(name)) && alive(Number(fs.readFileSync(pidFile(name), 'utf8')))) {
  console.error(`docker: Error response from daemon: Conflict. The container name "/${name}" is already in use.`);
  process.exit(125);
}
// node /opt/wisp/bin/wisp.js …: this checkout's wisp, on loopback, at home in the mounted folder.
const child = spawn(process.execPath, [path.join(REPO, 'bin', 'wisp.js'), ...command.slice(2)], {
  cwd: home,
  env: { PATH: process.env.PATH, ...env, HOME: home, WISP_HOST: '127.0.0.1' },
  stdio: 'inherit',
});
fs.writeFileSync(pidFile(name), String(child.pid));
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => child.kill(s));
child.on('exit', (code, signal) => {
  fs.rmSync(pidFile(name), { force: true });
  process.exit(code ?? (signal ? 137 : 1));
});
