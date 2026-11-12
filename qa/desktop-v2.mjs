// The v2 desktop app, on any OS (ADR-0013: the app ships the `wisp` binary Homebrew and npm ship): the Tauri shell
// starts `wisp serve` (desktop/src-tauri/src/server.rs), the window loads v2's page from it, and the server never
// outlives the shell, however the shell goes (WISP_EXIT_WITH_STDIN). Node built-ins only, so a bare runner runs it.
//
//   node qa/desktop-v2.mjs --app <the shell binary> [--wisp <the wisp binary>]   # a build from this checkout
//   node qa/desktop-v2.mjs --install dist/tauri/wisp-windows-x64-setup.exe        # Windows: the installer, then the app
//   node qa/desktop-v2.mjs --install <new setup.exe> --over <an older setup.exe>  # Windows: an update over an install
//
// Linux needs a display (xvfb-run). Each check prints PASS or FAIL; any FAIL exits 1. Writes qa/out/desktop-v2.md.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'qa/out');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const win = process.platform === 'win32';
const PORT = Number(process.env.QA_DESKTOP_PORT) || 4791;
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'npm/wisp-agents/package.json'), 'utf8')).version;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

async function check(id, title, fn) {
  const at = Date.now();
  try {
    await fn();
    results.push([id, title, 'PASS', '', Date.now() - at]);
    console.log(`  PASS ${id} ${title}`);
  } catch (e) {
    results.push([id, title, 'FAIL', String(e?.message ?? e).split('\n')[0], Date.now() - at]);
    console.log(`  FAIL ${id} ${title}: ${e?.message ?? e}`);
  }
}
const ok = (cond, why) => {
  if (!cond) throw new Error(why);
};
async function until(fn, { timeout = 20_000, what = 'it' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`waited ${timeout / 1000} s for ${what}`);
    await sleep(250);
  }
}
const get = (p) =>
  new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c)).on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', () => resolve(null)).on('timeout', () => (r.destroy(), resolve(null)));
  });
const listening = () =>
  new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const health = async () => {
  const r = await get('/api/health');
  if (r?.status !== 200) return null;
  try {
    return JSON.parse(r.body);
  } catch {
    return null;
  }
};

// Windows: the installer, silently, as the updater runs it; an older one first when asked (an update over it)
const installed = win ? path.join(process.env.LOCALAPPDATA ?? '', 'wisp/wisp.exe') : '';
const install = (setup) => execFileSync(setup, ['/S'], { stdio: 'inherit' });
let app = arg('--app');
const wisp = arg('--wisp');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-desktop-qa-'));

function launch() {
  const env = { ...process.env, WISP_PORT: String(PORT), WISP_HOME: home, WISP_UPDATE_CHECK: '0', ...(wisp && { WISP_BIN: path.resolve(wisp) }) };
  for (const k of ['WISP_DESKTOP', 'CI']) delete env[k];
  const proc = spawn(app, [], { env, stdio: 'ignore' });
  const exited = new Promise((r) => proc.once('exit', (c, s) => r(c ?? s)));
  return { proc, exited };
}
// a process that's already gone is done: taskkill says "not found" (exit 128), process.kill throws ESRCH; anything
// else, with the process still there, is a real failure
const signal = (pid, f) => {
  try {
    f();
  } catch (e) {
    if (alive(pid)) throw e;
  }
};
const hardKill = (pid) => signal(pid, () => (win ? execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' }) : process.kill(pid, 'SIGKILL')));
// asks the shell to quit: its window's close on Windows, a TERM elsewhere
const askQuit = (pid) => signal(pid, () => (win ? execFileSync('taskkill', ['/PID', String(pid)], { stdio: 'ignore' }) : process.kill(pid, 'SIGTERM')));

console.log(`\n  desktop v2 · ${process.platform} · port ${PORT}\n`);
ok(!(await listening()), `port ${PORT} is taken: set QA_DESKTOP_PORT`);

if (arg('--over')) await check('DESK2-00', 'an older install is there first (the update case)', async () => install(arg('--over')));
// over an older install, ~/.wisp holds the user's data: a file put there now must outlive the update (DESK2-01)
const keep = arg('--over') ? path.join(os.homedir(), '.wisp', `qa-keep-${process.pid}`) : '';
if (keep) (fs.mkdirSync(path.dirname(keep), { recursive: true }), fs.writeFileSync(keep, 'kept'));
if (arg('--install')) {
  await check('DESK2-01', 'setup.exe /S installs the app', async () => {
    install(arg('--install'));
    ok(fs.existsSync(installed), `no ${installed}`);
    ok(fs.existsSync(path.join(path.dirname(installed), 'resources/app/wisp.exe')), 'no wisp.exe in resources/app: the app would have no server');
    ok(fs.existsSync(path.join(path.dirname(installed), 'resources/app/web/index.html')), 'no web build beside it');
    ok(!fs.existsSync(path.join(path.dirname(installed), 'node')), 'a bundled Node is still there: v1 packaging');
    // v1's Node app beside it (an update over v1 must clear it: installer-hooks.nsh NSIS_HOOK_PREINSTALL)
    for (const left of ['server', 'bin', 'grid', 'skills', 'desktop', 'CHANGELOG.md'])
      ok(!fs.existsSync(path.join(path.dirname(installed), 'resources/app', left)), `v1's resources/app/${left} is still there`);
    // the update keeps the user's data: a file in ~/.wisp from before the install is still there
    if (keep) {
      ok(fs.existsSync(keep), `the update removed ${keep}: ~/.wisp must stay`);
      fs.rmSync(keep, { force: true });
    }
  });
  app = installed;
}
ok(app && fs.existsSync(app), `no app at ${app}: --app <shell binary> or --install <setup.exe>`);

let run = launch();
let server = 0;
await check('DESK2-02', 'the shell starts wisp serve, which answers as v2 on the port', async () => {
  const h = await until(health, { timeout: 90_000, what: 'GET /api/health' });
  ok(h.name === 'wisp' && h.ok === true, `health: ${JSON.stringify(h)}`);
  ok(typeof h.apiVersion === 'number' || typeof h.apiVersion === 'string', `no apiVersion: ${JSON.stringify(h)}`);
  if (arg('--install')) ok(h.version === version, `version ${h.version}, this build is ${version}`);
  server = h.pid;
  ok(server && server !== run.proc.pid, 'the server is its own process');
});
await check('DESK2-03', 'the page is v2’s web build, from the server beside the binary', async () => {
  const r = await get('/');
  ok(r?.status === 200, `GET / ${r?.status}`);
  ok(r.body.includes('<div id="app"></div>') && r.body.includes('PREPAINT_THEME'), 'not v2’s index.html');
});
await check('DESK2-04', 'killed hard, the shell takes the server with it (its stdin pipe)', async () => {
  hardKill(run.proc.pid);
  await run.exited;
  await until(async () => !alive(server) && !(await listening()), { timeout: 15_000, what: 'the server to stop' });
});
run = launch();
await check('DESK2-05', 'quit, it stops the server and the port closes', async () => {
  const h = await until(health, { timeout: 90_000, what: 'the second start' });
  server = h.pid;
  askQuit(run.proc.pid);
  await Promise.race([run.exited, sleep(15_000)]);
  await until(async () => !alive(server) && !(await listening()), { timeout: 15_000, what: 'the server to stop' });
});
// nothing left behind for the next job on this runner
for (const pid of [run.proc.pid, server]) if (pid && alive(pid)) hardKill(pid);

fs.mkdirSync(OUT, { recursive: true });
const md = [`# Desktop v2 (${process.platform})`, '', '| Check | What | Result | Note | ms |', '|---|---|---|---|---:|', ...results.map((r) => `| ${r.join(' | ')} |`)].join('\n');
fs.writeFileSync(path.join(OUT, 'desktop-v2.md'), `${md}\n`);
const failed = results.filter((r) => r[2] === 'FAIL').length;
console.log(`\n  ${results.length - failed}/${results.length} passed · qa/out/desktop-v2.md\n`);
process.exit(failed ? 1 : 0);
