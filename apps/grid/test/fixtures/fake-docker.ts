// A stand-in for `docker` in the grid tests: `run` starts the box as a plain process (no container),
// the stand-in box (fake-box.ts) with the home, port and environment the run asked for, so hostd and
// boxd can be tested end to end without Docker. Its state and a log of every call (docker.jsonl: the
// args, and for a run the env file's mode and names, never its values) sit next to the launcher,
// because boxd runs docker with nothing but PATH in its environment.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOX = fileURLToPath(new URL('./fake-box.ts', import.meta.url));
const dir = path.dirname(process.argv[1] ?? '.');
const state = path.join(dir, 'state');
fs.mkdirSync(state, { recursive: true });
const args = process.argv.slice(2);
const log = (o: Record<string, unknown> = {}): void => fs.appendFileSync(path.join(dir, 'docker.jsonl'), `${JSON.stringify({ args, ...o })}\n`);
const pidFile = (name: string): string => path.join(state, `${name}.pid`);
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const running = (): string[] =>
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
  const name = rest.filter((a) => !a.startsWith('-')).pop() ?? '';
  const f = pidFile(name);
  if (fs.existsSync(f)) {
    try {
      process.kill(Number(fs.readFileSync(f, 'utf8')), 'SIGKILL');
    } catch {
      // gone already
    }
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
const opt: Record<string, string> = {};
const e: string[] = [];
const v: string[] = [];
const FLAGS = new Set(['--rm', '--init']);
let i = 0;
for (; i < rest.length; i++) {
  const a = rest[i] ?? '';
  if (!a.startsWith('-')) break;
  if (FLAGS.has(a)) continue;
  const val = rest[++i] ?? '';
  if (a === '-e') e.push(val);
  else if (a === '-v') v.push(val);
  else opt[a] = val;
}
// image, then: [wisp-sandbox-init] node /opt/wisp/bin/wisp.js …
const command = rest.slice(i + 1);
const flags = command.slice(command.indexOf('node') + 2);
const name = opt['--name'] ?? '';
const home = v.find((x) => x.endsWith(':/home/wisp'))?.slice(0, -':/home/wisp'.length) ?? '.';
const port = Number(String(opt['-p']).split(':').pop());
const env: Record<string, string> = {};
let envFileMode: number | null = null;
const envFile = opt['--env-file'];
if (envFile) {
  envFileMode = fs.statSync(envFile).mode & 0o777;
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const j = line.indexOf('=');
    if (j > 0) env[line.slice(0, j)] = line.slice(j + 1);
  }
}
const fileKeys = Object.keys(env);
for (const kv of e) env[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
log({ name, home, port, envFileMode, envKeys: fileKeys, network: opt['--network'], runtime: opt['--runtime'] || null });
const known = pidFile(name);
if (fs.existsSync(known) && alive(Number(fs.readFileSync(known, 'utf8')))) {
  console.error(`docker: Error response from daemon: Conflict. The container name "/${name}" is already in use.`);
  process.exit(125);
}
const child = spawn(process.execPath, [BOX, ...flags], { cwd: home, env: { PATH: process.env['PATH'] ?? '', ...env, HOME: home, WISP_HOST: '127.0.0.1' }, stdio: 'inherit' });
fs.writeFileSync(pidFile(name), String(child.pid));
for (const s of ['SIGTERM', 'SIGINT'] as const) process.on(s, () => child.kill(s));
child.on('exit', (code, signal) => {
  fs.rmSync(pidFile(name), { force: true });
  process.exit(code ?? (signal ? 137 : 1));
});
