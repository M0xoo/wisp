// Install gate: every way into wisp, on real artefacts. Scenarios: qa/scenarios/install.md.
//
//   node qa/install.mjs [--artefacts dist/tauri] [--only npm,script,brew,app,shell,links] [--old-electron <wisp-mac-<arch>.zip>]
//   node qa/install.mjs --only migrate   # Windows, CI only: a real v0.57.0, then this build
//
// Nothing is published and nothing of yours is touched: npm installs go to temp prefixes from `npm
// pack`'s tarball, install.sh reads a registry and a release folder served from this process, HOME
// is a temp folder. The `app` rows need desktop/scripts/package.mjs's output; without it they say
// so, they don't pass. What can't run here is listed as Manual or CI: never marked as passed.

import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { until, makeRepo } from '../test/helpers.js';
import { OUT, ROOT, ok, qaEnv, runner, win32 } from './lib.mjs';
import { Updater } from '../server/update.js';
import { artefacts, shellArtefact } from '../desktop/scripts/package.mjs';
import { NODE_VERSION, hostTarget } from '../desktop/scripts/fetch-node.mjs';

const { check, done, results } = runner('install');
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const ARTEFACTS = path.resolve(argOf('--artefacts', path.join(ROOT, 'dist/tauri')));
const OLD_ELECTRON = argOf('--old-electron');
const ONLY = argOf('--only', 'npm,script,brew,app,shell,links').split(',');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const [MAC, WIN] = [process.platform === 'darwin', process.platform === 'win32'];
const SYSTEM = WIN ? process.env.PATH : '/usr/bin:/bin:/usr/sbin:/sbin';
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-install-')));
const dirIn = (name) => fs.mkdtempSync(path.join(TMP, `${name}-`));
// One download of each per run, whichever prefix or HOME asks.
const CACHE = { npm_config_cache: process.env.QA_NPM_CACHE || path.join(TMP, 'npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', electron_config_cache: process.env.QA_ELECTRON_CACHE || path.join(TMP, 'electron-cache') };
let nextPort = Number(process.env.QA_INSTALL_PORT) || 4771;
const live = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const manual = [];
const notRun = [];
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: WIN && /\.(cmd|bat)$|^np[mx]$/.test(cmd), ...opts });
// For what talks to a server in this process: execFileSync would stop it from answering.
const shA = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 1 << 24, ...opts }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve(stdout)));
  });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Records what `open`, `xdg-open` would have opened. A real browser tab per row is no use to anyone.
const STUBS = dirIn('stubs');
const OPENED = path.join(STUBS, 'opened.log');
for (const name of ['open', 'xdg-open']) {
  fs.writeFileSync(path.join(STUBS, name), `#!/bin/sh\necho "$@" >> "${OPENED}"\ncase "$1" in *.app) nohup "$1/Contents/MacOS/wisp" >/dev/null 2>&1 & ;; esac\n`, { mode: 0o755 });
}
const opened = () => (fs.existsSync(OPENED) ? fs.readFileSync(OPENED, 'utf8') : '');
const clearOpened = () => fs.rmSync(OPENED, { force: true });

// A clean machine, as near as a folder gets: its own HOME, only the system's tools, this Node and
// the fake agents. No shell rc, so no nvm and no node but the one named here.
function machine(extra = {}, { withNode = true } = {}) {
  const home = dirIn('home');
  const { env, bins } = qaEnv({ HOME: home, USERPROFILE: home, SHELL: '/bin/sh', WISP_UPDATE_CHECK: '0', ...CACHE });
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CI; // Updater turns itself off on CI, which GET /update shouldn't hide
  env.PATH = [STUBS, bins, ...(withNode ? [path.dirname(process.execPath)] : []), SYSTEM].join(path.delimiter);
  return { ...env, ...extra };
}

const health = async (port) => (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
const up = (port, what = 'wisp') => until(() => health(port), { timeout: 60_000, every: 200, what });
const down = (port) => until(() => health(port).then(() => false, () => true), { timeout: 20_000, every: 100, what: `port ${port} to free up` });
const getUpdate = async (port) => (await fetch(`http://127.0.0.1:${port}/api/update`)).json();
const stopPort = async (port) => {
  const h = await health(port).catch(() => null);
  if (h && alive(h.pid)) process.kill(h.pid);
  await down(port);
};

function start(cmd, args, env, opts = {}) {
  const child = spawn(cmd, args, { env, stdio: 'ignore', shell: WIN && /\.cmd$|^npx$/.test(cmd), ...opts });
  child.on('error', () => {}); // the row that waits for it says so
  live.add(child);
  child.once('exit', () => live.delete(child));
  return child;
}

// What every copy from npm has to do, whichever way it got here.
async function driveCli(id, label, wisp, env, { method, cwd = makeRepo() }) {
  const port = nextPort++;
  await check(`${id}a`, `${label}: --version`, async () => {
    const got = sh(wisp[0], [...wisp.slice(1), '--version'], { env, cwd }).trim();
    ok(got.endsWith(PKG.version), `--version said ${got}`);
  });
  await check(`${id}b`, `${label}: --no-open serves, opens nothing, knows how it was installed`, async () => {
    clearOpened();
    const child = start(wisp[0], [...wisp.slice(1), '--no-open', '--port', String(port)], env, { cwd });
    const h = await up(port);
    ok(h.version === PKG.version, `health says ${h.version}`);
    const update = await getUpdate(port);
    ok(update.method === method, `update method ${update.method}, wanted ${method}`);
    ok(!opened(), `opened ${opened()}`);
    ok(child.exitCode === null, 'the server left');
  });
  await check(`${id}c`, `${label}: words on the command line go to the wisp already running`, async () => {
    const said = sh(wisp[0], [...wisp.slice(1), 'write a haiku', '--no-open', '--port', String(port)], { env, cwd });
    ok(/launched/.test(said), `said: ${said}`);
    const list = sh(wisp[0], [...wisp.slice(1), 'ls', '--port', String(port)], { env, cwd });
    ok(/^[0-9a-f]{12}\s/m.test(list), `ls: ${list}`); // its title is the agent's by now
  });
  await check(`${id}d`, `${label}: --browser on a running wisp opens a tab and leaves it running`, async () => {
    clearOpened();
    sh(wisp[0], [...wisp.slice(1), '--browser', '--port', String(port)], { env, cwd });
    if (!WIN) ok(opened().includes(`localhost:${port}`), `opened: ${opened()}`);
    await health(port);
  });
  await stopPort(port).catch(() => {});
  await check(`${id}e`, `${label}: --browser starts the server and a tab`, async () => {
    clearOpened();
    const p = nextPort++;
    start(wisp[0], [...wisp.slice(1), '--browser', '--port', String(p)], env, { cwd });
    await up(p);
    if (!WIN) await until(() => opened().includes(`localhost:${p}`), { what: 'the tab' });
    await stopPort(p);
  });
}

// `wisp` alone with no Electron: a browser tab.
async function driveDefault(id, label, wisp, env, { cwd = makeRepo() } = {}) {
  const port = nextPort++;
  await check(`${id}f`, `${label}: \`wisp\` alone opens a browser tab`, async () => {
    clearOpened();
    start(wisp[0], [...wisp.slice(1), '--port', String(port)], env, { cwd });
    await up(port);
    if (!WIN) await until(() => opened().includes(`localhost:${port}`), { what: 'the tab' });
  });
  await stopPort(port).catch(() => {});
}

// With Electron: the binary bin/wisp.js's electronBinary() finds, started as it starts it, with its
// own --user-data-dir. Electron keeps that folder under the real home whatever HOME says, so bare
// `wisp` here would hit the lock of any wisp.app open on this Mac, quit and focus that one.
async function driveElectron(id, label, root, env) {
  if (!MAC && !WIN && !process.env.DISPLAY) return manual.push([`${label}: Electron's window`, 'no display on this machine']);
  const port = nextPort++;
  await check(`${id}f`, `${label}: the Electron wisp would start opens and runs the server`, async () => {
    const find = `import { createRequire } from 'node:module'; import { wispAppBinary } from ${JSON.stringify(pathToFileURL(path.join(root, 'bin/mac-app.js')).href)};
const bin = createRequire(${JSON.stringify(path.join(root, 'bin/wisp.js'))})('electron'); process.stdout.write('\\n@@' + (process.platform === 'darwin' ? wispAppBinary(bin) : bin));`;
    const said = await shA(process.execPath, ['--input-type=module', '-e', find], { env }); // first use downloads Electron
    const bin = said.split('\n@@').pop();
    ok(fs.existsSync(bin), `no Electron at ${bin}`);
    start(bin, [root, `--user-data-dir=${dirIn('electron-data')}`], { ...env, WISP_PORT: String(port) });
    const h = await up(port);
    ok(h.version === PKG.version, `health says ${h.version}`);
    if (!WIN) {
      const cmd = sh('ps', ['-o', 'command=', '-p', String(h.pid)]);
      ok(/electron|wisp\.app/i.test(cmd), `the server is in: ${cmd}`);
    }
  });
  await stopPort(port).catch(() => {});
}

// wisp.js from a global prefix, the same on all three (npm puts it elsewhere on Windows).
const binIn = (prefix) => (WIN ? path.join(prefix, 'wisp.cmd') : path.join(prefix, 'bin/wisp'));
const pkgIn = (prefix) => (WIN ? path.join(prefix, 'node_modules/wisp-agents') : path.join(prefix, 'lib/node_modules/wisp-agents'));

function packVersion(version, dest) {
  const copy = dirIn('pack');
  for (const f of [...PKG.files.map((f) => f.replace(/\/$/, '')), 'README.md']) if (fs.existsSync(path.join(ROOT, f))) fs.cpSync(path.join(ROOT, f), path.join(copy, f), { recursive: true });
  fs.writeFileSync(path.join(copy, 'package.json'), JSON.stringify({ ...PKG, version }, null, 2));
  return path.join(dest, sh('npm', ['pack', '--silent', '--pack-destination', dest], { cwd: copy, env: { ...process.env, ...CACHE } }).trim().split('\n').pop());
}

// --- npm ---
let tarball = null;
async function npmRows() {
  const dest = dirIn('tar');
  await check('INST-01', 'npm pack: wisp, and of the Tauri shell only the entry.mjs it runs', async () => {
    tarball = path.join(dest, sh('npm', ['pack', '--silent', '--pack-destination', dest], { cwd: ROOT, env: { ...process.env, ...CACHE } }).trim().split('\n').pop());
    // System32's: Git Bash's GNU tar takes C:\ for a host name.
    const tar = WIN ? path.join(process.env.SystemRoot, 'System32/tar.exe') : 'tar';
    const files = sh(tar, ['-tzf', tarball]).split(/\r?\n/);
    for (const f of ['package/bin/wisp.js', 'package/server/index.js', 'package/electron/main.js', 'package/web/index.html']) ok(files.includes(f), `${f} isn't in it`);
    ok(files.filter((f) => f.startsWith('package/desktop/')).join() === 'package/desktop/entry.mjs', 'desktop/ beyond entry.mjs is on npm');
    ok(files.includes('package/bin/desktop-shell.js'), 'no bin/desktop-shell.js');
    ok(!files.some((f) => f.includes('node_modules/')), 'node_modules in the tarball');
  });
  if (!tarball) return;
  for (const electron of [false, true]) {
    const tag = electron ? 'with Electron' : 'no Electron';
    const n = electron ? '03' : '02';
    const prefix = dirIn('prefix');
    const env = machine();
    await check(`INST-${n}`, `npm i -g, ${tag}`, async () => {
      sh('npm', ['install', '-g', tarball, '--prefix', prefix], { env });
      const dep = path.join(pkgIn(prefix), 'node_modules/electron');
      // npm ignores --omit=optional with -g (the Homebrew formula's comment): what a machine where
      // Electron couldn't install ends up with.
      if (!electron) fs.rmSync(dep, { recursive: true });
      ok(fs.existsSync(dep) === electron, 'node_modules/electron');
    });
    await driveCli(`INST-${n}`, `npm -g, ${tag}`, [binIn(prefix)], env, { method: 'global' });
    if (electron) await driveElectron(`INST-${n}`, `npm -g, ${tag}`, pkgIn(prefix), env);
    else await driveDefault(`INST-${n}`, `npm -g, ${tag}`, [binIn(prefix)], env);
  }
  for (const electron of [false, true]) {
    const tag = electron ? 'with Electron' : 'no Electron';
    const n = electron ? '05' : '04';
    // Each its own cache: npx reuses an install by what was asked, and omit isn't part of that.
    const cache = dirIn('npx-cache');
    const env = machine({ npm_config_cache: cache, ...(electron ? {} : { npm_config_omit: 'optional' }) });
    const npx = ['npx', '--yes', `--package=${tarball}`, '--', 'wisp'];
    await driveCli(`INST-${n}`, `npx, ${tag}`, npx, env, { method: 'npx' });
    const root = path.join(cache, '_npx', fs.readdirSync(path.join(cache, '_npx'))[0], 'node_modules/wisp-agents');
    const dep = path.join(root, '../electron');
    await check(`INST-${n}g`, `npx, ${tag}: Electron ${electron ? 'came with it' : 'stayed out'}`, () => ok(fs.existsSync(dep) === electron, 'node_modules/electron'));
    if (electron) await driveElectron(`INST-${n}`, `npx, ${tag}`, root, env);
    else await driveDefault(`INST-${n}`, `npx, ${tag}`, npx, env);
  }
}

// --- install.sh, against a registry served from here ---
function registry(tarballs) {
  const versions = Object.fromEntries(
    Object.entries(tarballs).map(([tag, { version }]) => [version, { name: PKG.name, version, bin: PKG.bin, engines: PKG.engines, optionalDependencies: PKG.optionalDependencies, dist: { tarball: `@@/t/${tag}.tgz` } }]),
  );
  const server = http.createServer((req, res) => {
    const t = req.url.match(/^\/t\/(\w+)\.tgz$/)?.[1];
    if (t) return res.end(fs.readFileSync(tarballs[t].file));
    if (req.url !== `/${PKG.name}`) return (res.statusCode = 404), res.end('{}');
    const base = `http://127.0.0.1:${server.address().port}`;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ name: PKG.name, 'dist-tags': Object.fromEntries(Object.entries(tarballs).map(([tag, { version }]) => [tag, version])), versions }).replaceAll('@@', base));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function scriptRows() {
  if (WIN) return manual.push(['install.sh', 'macOS and Linux only: it says so on Windows']);
  const dest = dirIn('tags');
  const tags = { latest: PKG.version, next: `${PKG.version}-beta.1`, nightly: `${PKG.version}-nightly.20261107.317` };
  const tarballs = Object.fromEntries(Object.entries(tags).map(([tag, version]) => [tag, { version, file: packVersion(version, dest) }]));
  const server = await registry(tarballs);
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const [tag, version] of Object.entries(tags)) {
    await check(`INST-06-${tag}`, `install.sh ${tag === 'latest' ? '' : `WISP_VERSION=${tag} `}ends with a working wisp`, async () => {
      const prefix = dirIn('prefix');
      const env = machine({ npm_config_registry: url, npm_config_prefix: prefix, ...(tag === 'latest' ? {} : { WISP_VERSION: tag }) });
      env.PATH = `${path.join(prefix, 'bin')}${path.delimiter}${env.PATH}`;
      const said = await shA('bash', [path.join(ROOT, 'docs/install.sh')], { env });
      ok(said.includes(`Installed wisp ${version}`), `said: ${said.slice(-300)}`);
      ok(sh('wisp', ['--version'], { env }).trim() === version, 'wisp --version');
    });
  }
  await check('INST-07', 'install.sh with no Node says so', () => {
    const env = machine({}, { withNode: false });
    let said = '';
    try {
      sh('/bin/bash', [path.join(ROOT, 'docs/install.sh')], { env: { ...env, PATH: '/usr/bin:/bin' } });
    } catch (err) {
      said = String(err.stderr);
    }
    ok(/Node\.js 20\+ is required/.test(said), `said: ${said}`);
  });
  server.close();
}

// --- Homebrew: the formula read through, its install steps run in a temp Cellar. Not brew itself. ---
async function brewRows() {
  const formula = fs.readFileSync(path.join(ROOT, 'packaging/homebrew/wisp-agents.rb'), 'utf8');
  await check('INST-08', 'formula: still names what it removes, release.yml can still stamp it', () => {
    if (!WIN) sh('ruby', ['-c', path.join(ROOT, 'packaging/homebrew/wisp-agents.rb')]);
    ok(/depends_on "node"/.test(formula), 'node');
    ok(/libexec\/"lib\/node_modules\/wisp-agents\/node_modules\/electron"/.test(formula), 'the electron path');
    ok(/rm_r electron if electron\.exist\?/.test(formula), 'rm_r');
    ok(/^ {2}url "/m.test(formula) && /^ {2}sha256 "/m.test(formula), 'release.yml seds these two lines');
    const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
    ok(/homebrew:\r?\n\s+needs: \[plan, publish\]/.test(wf), 'the tap follows npm and the release');
  });
  if (!tarball || WIN) return;
  const cellar = path.join(dirIn('brew'), 'Cellar/wisp-agents', PKG.version);
  const libexec = path.join(cellar, 'libexec');
  const env = machine();
  await check('INST-09', 'formula steps in a temp Cellar: npm install, drop electron', () => {
    sh('npm', ['install', '-g', tarball, '--prefix', libexec], { env });
    const electron = path.join(pkgIn(libexec), 'node_modules/electron');
    if (fs.existsSync(electron)) fs.rmSync(electron, { recursive: true });
    fs.mkdirSync(path.join(cellar, 'bin'));
    fs.symlinkSync(path.join(libexec, 'bin/wisp'), path.join(cellar, 'bin/wisp'));
  });
  await driveCli('INST-09', 'brew steps', [path.join(cellar, 'bin/wisp')], env, { method: 'brew' });
  await driveDefault('INST-09', 'brew steps', [path.join(cellar, 'bin/wisp')], env);
}

// --- the desktop artefacts ---
const serveDir = (dir) =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = path.join(dir, path.basename(req.url));
      if (!fs.existsSync(file)) return (res.statusCode = 404), res.end();
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

function releaseDir(names) {
  const dir = dirIn('release');
  for (const n of names) fs.copyFileSync(path.join(ARTEFACTS, n), path.join(dir, n));
  // release.yml: (cd out && sha256sum wisp-* > SHA256SUMS.txt). shasum prints the same lines.
  const lines = names.map((n) => `${sha256(path.join(dir, n))}  ${n}`);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
  return dir;
}

const shellOf = (pid) => Number(sh('ps', ['-o', 'ppid=', '-p', String(pid)]).trim());

async function launchChecks(id, label, port, how) {
  let pid = null;
  await check(`${id}a`, `${label}: its server is up on the bundled Node, with no node on PATH`, async () => {
    await how();
    const h = await up(port, 'the app');
    pid = h.pid;
    ok(h.version, 'no version');
    const comm = sh('ps', ['-o', 'comm=', '-p', String(pid)]).trim();
    ok(/\/Contents\/Resources\/node\/bin\/node$/.test(comm), `the server runs on ${comm}`);
    const update = await getUpdate(port);
    ok(update.method === 'app', `update method ${update.method}`);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    ok(page.ok, `the page: ${page.status}`);
  });
  await check(`${id}b`, `${label}: killing the shell leaves no server behind`, async () => {
    ok(pid, 'never started');
    const shell = shellOf(pid);
    ok(/wisp$/.test(sh('ps', ['-o', 'comm=', '-p', String(shell)]).trim()), 'the server is the shell’s child');
    process.kill(shell, 'SIGKILL');
    await until(() => !alive(pid), { timeout: 20_000, what: 'Node to go' });
    await down(port);
  });
}

async function macRows() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const [dmg, zip] = [`wisp-mac-${arch}.dmg`, `wisp-mac-${arch}.zip`];
  const all = fs.existsSync(ARTEFACTS) ? fs.readdirSync(ARTEFACTS).filter((f) => /^wisp-/.test(f)) : [];
  if (!all.includes(zip) || !all.includes(dmg)) return notRun.push(['Mac dmg, zip, --app, self-update', `no ${zip} and ${dmg} in ${ARTEFACTS}`]);
  const dir = releaseDir(all);
  const server = await serveDir(dir);
  const url = `http://127.0.0.1:${server.address().port}`;

  await check('INST-10', 'SHA256SUMS.txt covers every artefact and install.sh can read it', () => {
    const lines = fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8').trim().split('\n').map((l) => l.split(/\s+/));
    ok(lines.length === all.length, `${lines.length} lines, ${all.length} files`);
    for (const [hash, name] of lines) ok(sha256(path.join(dir, name)) === hash, name);
    for (const a of artefacts(hostTarget())) ok(lines.some(([, n]) => n === a), `${a} isn't listed`);
    const awk = sh('awk', ['-v', `f=${zip}`, '$2 == f { print $1 }', path.join(dir, 'SHA256SUMS.txt')]).trim();
    ok(awk === sha256(path.join(dir, zip)), 'awk');
  });

  const installed = dirIn('apps');
  const app = path.join(installed, 'wisp.app');
  const script = (env) => shA('/bin/bash', [path.join(ROOT, 'docs/install.sh'), '--app'], { env });
  await check('INST-11', 'install.sh --app: no Node needed, wisp.app in place, Node still executable', async () => {
    const said = await script(machine({ WISP_DOWNLOADS: url, WISP_APP_DIR: installed, WISP_NO_OPEN: '1' }, { withNode: false }));
    ok(said.includes(`Installed ${app}`), said);
    const node = path.join(app, 'Contents/Resources/node/bin/node');
    ok(fs.statSync(node).mode & 0o100, 'the zip lost Node’s executable bit');
    ok(sh(node, ['--version']).trim() === `v${NODE_VERSION}`, 'node --version');
    sh('codesign', ['--verify', '--strict', app]);
  });
  await check('INST-12', 'install.sh --app refuses a zip that doesn’t match its sum', async () => {
    const bad = dirIn('bad');
    fs.copyFileSync(path.join(dir, zip), path.join(bad, zip));
    fs.writeFileSync(path.join(bad, 'SHA256SUMS.txt'), `${'0'.repeat(64)}  ${zip}\n`);
    const s = await serveDir(bad);
    const target = dirIn('apps');
    const refused = await script(machine({ WISP_DOWNLOADS: `http://127.0.0.1:${s.address().port}`, WISP_APP_DIR: target, WISP_NO_OPEN: '1' }, { withNode: false })).then(() => '', (err) => String(err.stderr));
    s.close();
    ok(/doesn't match/.test(refused), `said: ${refused}`);
    ok(!fs.existsSync(path.join(target, 'wisp.app')), 'it installed anyway');
  });
  await check('INST-13', 'the dmg holds wisp.app and Applications, Node executable', () => {
    const mount = dirIn('mnt');
    sh('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, path.join(dir, dmg)]);
    try {
      ok(fs.lstatSync(path.join(mount, 'Applications')).isSymbolicLink(), 'no Applications link');
      sh('codesign', ['--verify', '--strict', path.join(mount, 'wisp.app')]);
      ok(sh(path.join(mount, 'wisp.app/Contents/Resources/node/bin/node'), ['--version']).trim() === `v${NODE_VERSION}`, 'node --version');
    } finally {
      sh('hdiutil', ['detach', mount, '-quiet']);
    }
  });

  // Direct: this process names the environment. LaunchServices: a Finder start, PATH and all.
  const noNode = '/usr/bin:/bin:/usr/sbin:/sbin';
  const clean = (port) => {
    const env = machine({ WISP_PORT: String(port) }, { withNode: false });
    return { ...env, PATH: noNode };
  };
  const a = nextPort++;
  await launchChecks('INST-14', 'the .app run directly', a, () => {
    const env = clean(a);
    ok(sh('sh', ['-c', 'command -v node || echo none'], { env }).trim() === 'none', 'a node is on PATH');
    start(path.join(app, 'Contents/MacOS/wisp'), [], env);
  });
  const b = nextPort++;
  await launchChecks('INST-15', 'the .app through LaunchServices (open -n)', b, () => {
    const env = clean(b);
    const pass = ['WISP_PORT', 'WISP_HOME', 'HOME', 'SHELL', 'PATH', 'WISP_TELEMETRY', 'WISP_FEEDBACK', 'WISP_UPDATE_CHECK', 'CLAUDE_CONFIG_DIR'].flatMap((k) => ['--env', `${k}=${env[k]}`]);
    sh('/usr/bin/open', ['-n', ...pass, app]);
  });

  // Finder hands an app launchd's environment. `open` passes on its own, so it starts from nothing:
  // agents can only come from the login shell, and HOME is a temp one or they'd be found in ~/.local.
  const e = nextPort++;
  await check('INST-15c', 'as Finder starts it: launchd’s PATH, no node, agents from the login shell', async () => {
    const { env, bins, home } = qaEnv({});
    const user = dirIn('finder-home');
    // A login shell of our own: a hosted Mac's zsh doesn't read a temp HOME's .zshrc.
    const login = path.join(user, 'login-shell');
    fs.writeFileSync(login, `#!/bin/sh\nprintf '__WISP__%s__WISP__' "${bins}:$PATH"\n`, { mode: 0o755 });
    const pass = [`SHELL=${login}`, `HOME=${user}`, `WISP_HOME=${home}`, `WISP_PORT=${e}`, 'WISP_TELEMETRY=0', 'WISP_FEEDBACK=0', 'WISP_UPDATE_CHECK=0', `CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR}`];
    sh('/usr/bin/env', ['-i', `HOME=${user}`, '/usr/bin/open', '-n', ...pass.flatMap((p) => ['--env', p]), app]);
    const h = await up(e, 'the app');
    const shell = shellOf(h.pid);
    try {
      const path0 = sh('ps', ['eww', '-o', 'command=', '-p', String(shell)]).match(/ PATH=(\S+)/)?.[1] || '';
      ok(!path0.includes(bins) && !/nvm|homebrew/.test(path0), `the shell's PATH is ${path0}`);
      ok(/\/Contents\/Resources\/node\/bin\/node$/.test(sh('ps', ['-o', 'comm=', '-p', String(h.pid)]).trim()), 'not on the bundled Node');
      ok((await getUpdate(e)).method === 'app', 'update method');
      const saved = path.join(user, 'Library/Application Support/dev.wisp.app/shell-path');
      const look = async () => (await (await fetch(`http://127.0.0.1:${e}/api/agents`)).json()).find((x) => x.id === 'claude');
      await until(async () => (await look())?.available, { timeout: 20_000, what: 'claude, from the login shell' }).catch(async (err) => {
        throw new Error(`${err.message}. Saved PATH: ${fs.existsSync(saved) ? fs.readFileSync(saved, 'utf8') : '(none)'}. Agent: ${JSON.stringify(await look())}`);
      });
    } finally {
      process.kill(shell, 'SIGKILL');
    }
    await down(e);
  });

  await check('INST-19', 'run as Electron’s helper, the shell is Node', () => {
    const said = sh(path.join(app, 'Contents/MacOS/wisp'), ['-p', 'process.version'], { env: { ...clean(0), ELECTRON_RUN_AS_NODE: '1' } }).trim();
    ok(said === `v${NODE_VERSION}`, said);
  });

  // Tauri won't say where its resources are when the path holds a symlink.
  const d = nextPort++;
  const linked = path.join(dirIn('linked'), 'Apps');
  fs.symlinkSync(installed, linked);
  await launchChecks('INST-17', 'the .app reached through a symlinked folder', d, () => start(path.join(linked, 'wisp.app/Contents/MacOS/wisp'), [], clean(d)));

  // This build under a newer version, as a zip a release could hold.
  const [ma, mi, pa] = PKG.version.split('-')[0].split('.').map(Number);
  const version = `${ma}.${mi}.${pa + 1}`;
  const up2 = dirIn('newer');
  const bump = dirIn('bump');
  sh('ditto', [app, path.join(bump, 'wisp.app')]);
  const pkg = path.join(bump, 'wisp.app/Contents/Resources/app/package.json');
  fs.writeFileSync(pkg, JSON.stringify({ ...JSON.parse(fs.readFileSync(pkg, 'utf8')), version }, null, 2));
  sh('codesign', ['--force', '--sign', '-', path.join(bump, 'wisp.app')]);
  sh('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', path.join(bump, 'wisp.app'), path.join(up2, zip)]);

  // The app's own update, end to end: POST /api/update inside the running app, its own hand-off, the
  // real `open`. One line differs from a user's copy: RELEASES, patched in the installed app so the
  // release list comes from here. The Electron build is the rule that matters: its update.js is out
  // there and can't change, and after the swap its process.execPath is the Tauri binary.
  const updateInApp = (id, title, unpacked, args = []) =>
    check(id, title, async () => {
      const port = nextPort++;
      const [apps, home, tmp, stubs, data] = ['apps', 'home', 'tmp', 'stubs', 'data'].map(dirIn);
      sh('ditto', [unpacked, path.join(apps, 'wisp.app')]);
      const copy = path.join(apps, 'wisp.app');
      const code = path.join(copy, 'Contents/Resources/app/server/update.js');
      const was = fs.readFileSync(code, 'utf8');
      const patched = was.replace(/const RELEASES = '[^']+';/, 'const RELEASES = process.env.QA_RELEASES;');
      ok(patched !== was, 'RELEASES has moved');
      fs.writeFileSync(code, patched);
      sh('codesign', ['--force', '--deep', '--sign', '-', copy]);

      const body = fs.readFileSync(path.join(up2, zip));
      const digest = `sha256:${sha256(path.join(up2, zip))}`;
      const releases = http.createServer((req, res) => res.end(req.url === `/${zip}` ? body : JSON.stringify({ tag_name: `v${version}`, assets: [{ name: zip, browser_download_url: `http://127.0.0.1:${releases.address().port}/${zip}`, digest }] })));
      await new Promise((r) => releases.listen(0, '127.0.0.1', r));
      const wanted = { QA_RELEASES: `http://127.0.0.1:${releases.address().port}`, WISP_PORT: String(port), WISP_HOME: data, WISP_TELEMETRY: '0', WISP_FEEDBACK: '0', DO_NOT_TRACK: '1' };
      // `open` is the real one and hands on this test's port and home, or the new app would take 4477.
      // .zshrc, not .zshenv: path_helper reorders PATH after that, and Electron takes the login shell's.
      const log = path.join(stubs, 'opened');
      fs.writeFileSync(path.join(stubs, 'open'), `#!/bin/sh\necho "$@" >> "${log}"\nexec /usr/bin/open ${Object.entries(wanted).map(([k, v]) => `--env ${k}=${v}`).join(' ')} "$@"\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(home, '.zshrc'), `export PATH="${stubs}:$PATH"\n`);
      const first = start(path.join(copy, 'Contents/MacOS/wisp'), args.map((a) => a.replace('%DATA%', data)), { ...wanted, HOME: home, SHELL: '/bin/zsh', TMPDIR: tmp, PATH: `${stubs}:${noNode}` });
      await up(port, 'the old app');
      await sleep(1500); // the login shell's PATH lands behind the server's start
      const offer = await until(async () => {
        const u = await (await fetch(`http://127.0.0.1:${port}/api/update?check=1`)).json();
        return u.available && u;
      }, { timeout: 20_000, what: 'the update on offer' });
      ok(offer.method === 'app', `method ${offer.method}`);
      const r = await fetch(`http://127.0.0.1:${port}/api/update`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      ok(r.status === 202, `POST /api/update: ${r.status} ${await r.text()}`);
      const fresh = await until(() => health(port).then((x) => x.version === version && x, () => null), { timeout: 60_000, every: 200, what: `wisp ${version} on ${port}` }).catch((err) => {
        const procs = sh('ps', ['-axo', 'pid,ppid,command']).split('\n').filter((l) => l.includes(apps)).map((l) => l.slice(0, 120));
        throw new Error(`${err.message}. Opened: ${fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '(never)'}. Running: ${procs.join(' | ') || 'nothing'}`);
      });
      const shell = shellOf(fresh.pid);
      try {
        ok(fs.existsSync(log) && fs.readFileSync(log, 'utf8').trim() === copy, 'the hand-off never reached open');
        ok(sh('ps', ['-o', 'comm=', '-p', String(fresh.pid)]).trim() === path.join(copy, 'Contents/Resources/node/bin/node'), 'not on the new bundle’s Node');
        ok(!/ELECTRON_RUN_AS_NODE/.test(sh('ps', ['eww', '-o', 'command=', '-p', String(fresh.pid)])), 'ELECTRON_RUN_AS_NODE reached the new app');
        ok(!fs.readdirSync(tmp).some((d) => fs.existsSync(path.join(tmp, d, 'old.app'))), 'the old bundle stayed');
        await until(() => !alive(first.pid), { timeout: 15_000, what: 'the old app to go' }); // a sync call may have held its exit back
        ok((await getUpdate(port)).method === 'app', 'the new app isn’t the app');
      } finally {
        process.kill(shell, 'SIGKILL');
        releases.close();
      }
      await down(port);
    });

  await updateInApp('INST-16b', 'self-update from inside the running app, through POST /api/update and the real open', app);
  if (OLD_ELECTRON) {
    const old = dirIn('electron');
    sh('ditto', ['-xk', OLD_ELECTRON, old]);
    await updateInApp('INST-18', `Electron→Tauri: a real Electron wisp.app (${path.basename(OLD_ELECTRON)}) updates onto this zip`, path.join(old, 'wisp.app'), ['--user-data-dir=%DATA%/electron']);
  } else notRun.push(['Electron→Tauri self-update', 'no --old-electron <zip>: a Mac build of Electron, any version older than this one']);

  // The real swap, on the real app, from a real newer zip. Only the release list is stood in for.
  const c = nextPort++;
  await check('INST-16', 'self-update: the running app swaps itself for a newer build and reopens', async () => {
    const s = await serveDir(up2);
    const body = `http://127.0.0.1:${s.address().port}/${zip}`;
    const digest = `sha256:${sha256(path.join(up2, zip))}`;
    const env = clean(c);
    start(path.join(app, 'Contents/MacOS/wisp'), [], env);
    const h = await up(c, 'the app');
    const shell = shellOf(h.pid);
    const u = new Updater({ port: c, env: {}, platform: 'darwin', arch, root: path.join(app, 'Contents/Resources/app'), fetch: (href, o) => (String(href).includes('api.github.com') ? Promise.resolve({ ok: true, json: async () => ({ tag_name: `v${version}`, assets: [{ name: zip, browser_download_url: body, digest }] }) }) : fetch(href, o)) });
    await u.check();
    ok(u.state.available, 'no update on offer');
    // The hand-off helper inherits this: the stub `open` starts the app with the same temp home and port.
    const saved = { ...process.env };
    Object.assign(process.env, env, { PATH: `${STUBS}:${noNode}` });
    try {
      await u.install();
    } finally {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    process.kill(shell, 'SIGTERM');
    const fresh = await until(() => health(c).then((x) => x.version === version && x), { timeout: 60_000, every: 200, what: `wisp ${version} on ${c}` });
    ok(/\/Contents\/Resources\/node\/bin\/node$/.test(sh('ps', ['-o', 'comm=', '-p', String(fresh.pid)]).trim()), 'on the bundled Node');
    ok(!fs.existsSync(u.swap.remove), 'the old bundle stayed');
    s.close();
    process.kill(shellOf(fresh.pid), 'SIGKILL');
    await down(c);
  });
  server.close();
}

async function windowsRows() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const name = `wisp-windows-${arch}-setup.exe`;
  const setup = path.join(ARTEFACTS, name);
  if (!fs.existsSync(setup)) return notRun.push(['Windows installer', `no ${name} in ${ARTEFACTS}`]);
  const dir = path.join(process.env.LOCALAPPDATA, 'wisp');
  const exe = path.join(dir, 'wisp.exe');
  const port = nextPort++;
  const run = (args) => new Promise((resolve, reject) => spawn(setup, args, { stdio: 'ignore' }).once('exit', resolve).once('error', reject));
  await check('INST-20', 'setup.exe /S installs per user, with wisp and Node where the shell looks', async () => {
    ok((await run(['/S'])) === 0, 'the installer failed');
    await until(() => fs.existsSync(exe), { timeout: 120_000, every: 500, what: 'wisp.exe' });
    ok(fs.existsSync(path.join(dir, 'resources/app/package.json')), 'no resources\\app');
    ok(fs.existsSync(path.join(dir, 'resources/app/desktop/entry.mjs')), 'no entry.mjs');
    ok(fs.existsSync(path.join(dir, 'node/node.exe')), 'no node\\node.exe');
  });
  await check('INST-21', 'the installed app: server on the bundled Node, the updater calls it the app', async () => {
    const env = machine({ WISP_PORT: String(port) }, { withNode: false });
    start(exe, [], env);
    // If it doesn't come up: what the shell kept, what's running, and its Node by hand, watched from inside.
    const h = await up(port, 'the app').catch(async (err) => {
      const log = path.join(process.env.APPDATA, 'dev.wisp.app/server.log');
      const kept = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').slice(-1500) : '(no server.log)';
      const running = sh('tasklist').split('\n').filter((l) => /^(wisp|node)\.exe/i.test(l)).map((l) => l.split(/\s+/).slice(0, 2).join(' ')).join(', ');
      sh('taskkill', ['/F', '/T', '/IM', 'wisp.exe']);
      const node = path.join(dir, 'node/node.exe');
      const probe = `data:text/javascript,setInterval(()=>process.stderr.write('tick '+Math.round(process.uptime())+' '+process.report.getReport().libuv.filter((h)=>h.is_active).map((h)=>h.type+(h.localEndpoint?':'+h.localEndpoint.port:'')).join(' ')+'\\n'),4000).unref()`;
      const said = [];
      const child = spawn(node, ['--import', probe, path.join(dir, 'resources/app/desktop/entry.mjs')], { cwd: path.join(dir, 'resources/app'), env: { ...env, WISP_DESKTOP: 'tauri', WISP_DESKTOP_DATA: path.join(dir, 'data') }, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.on('data', (d) => said.push(String(d)));
      child.stderr.on('data', (d) => said.push(String(d)));
      const code = await Promise.race([new Promise((r) => child.once('exit', r)), sleep(30_000).then(() => 'still running')]);
      const answers = await health(port).then(() => true, () => false);
      child.kill();
      throw new Error(`${err.message}. Running: ${running}. server.log: ${kept}. By hand ${sh(node, ['--version']).trim()}: ${code}, answers ${answers}: ${said.join('').slice(-2500)}`);
    });
    const update = await getUpdate(port);
    ok(update.method === 'app', `update method ${update.method}`);
    const comm = sh('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${h.pid}).Path`]).trim();
    ok(comm.toLowerCase() === path.join(dir, 'node/node.exe').toLowerCase(), `the server runs on ${comm}`);
    sh('taskkill', ['/F', '/T', '/IM', 'wisp.exe']);
    await down(port);
  });
  // One row per caller: the Tauri app's own update, and a build already out updating onto Tauri.
  for (const [id, label, env, want] of [
    ['INST-22', 'a Tauri app', { WISP_DESKTOP: 'tauri' }, '/R'],
    ['INST-24', 'an Electron build', {}, '--force-run'],
  ]) {
    await check(id, `${label}'s update command, /S ${want}, reinstalls and starts the app again`, async () => {
      const u = new Updater({ port, env, platform: 'win32', arch, root: path.join(dir, 'resources/app') });
      u.swap = { installer: setup };
      const flags = u.relaunchCommand().split(`"${setup}" `)[1].split(' ');
      ok(flags.join(' ') === `/S ${want}`, flags.join(' '));
      ok((await run(flags)) === 0, 'the installer failed');
      // Started as the desktop user, not as this process's child: it has none of this env, so its port is the default.
      await up(4477, 'the app the installer started');
      sh('taskkill', ['/F', '/T', '/IM', 'wisp.exe']);
      await down(4477);
    });
  }
}

// --- from Electron to Tauri on Windows: the real last release, then this build ---
const ELECTRON = '0.57.0';
// electron-builder's install and Apps keys, by its GUID for dev.wisp.app (UUID v5 in its namespace).
const ELECTRON_KEYS = ['Software', 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'].map((k) => `HKCU\\${k}\\1d165acf-c1c9-5f90-b510-185d627d379f`);
const hasKey = (key) => new Promise((r) => execFile('reg', ['query', key], (err) => r(!err)));
const ELECTRON_DIR = () => path.join(process.env.LOCALAPPDATA, 'Programs/wisp-agents'); // the npm name, not wisp
const TAURI_DIR = () => path.join(process.env.LOCALAPPDATA, 'wisp');
const PIN = () => path.join(process.env.APPDATA, 'Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar/wisp.lnk');

async function migrateRows() {
  // It uninstalls and installs the real thing, in the real profile: a person's own wisp otherwise.
  if (!process.env.CI) return notRun.push(['Electron→Tauri on Windows', 'CI only: it replaces the wisp on this machine']);
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const name = `wisp-windows-${arch}-setup.exe`;
  const setup = path.join(ARTEFACTS, name);
  if (!fs.existsSync(setup)) return notRun.push(['Electron→Tauri on Windows', `no ${name} in ${ARTEFACTS}`]);
  const old = path.join(dirIn('electron-setup'), name);
  fs.writeFileSync(old, Buffer.from(await (await fetch(`https://github.com/M0xoo/wisp/releases/download/v${ELECTRON}/${name}`)).arrayBuffer()));
  const run = (file, args) => new Promise((resolve, reject) => spawn(file, args, { stdio: 'ignore' }).once('exit', resolve).once('error', reject));
  const installElectron = async () => {
    ok((await run(old, ['/S'])) === 0, 'v0.57.0’s installer failed');
    await until(() => fs.existsSync(path.join(ELECTRON_DIR(), 'wisp.exe')) && fs.existsSync(path.join(ELECTRON_DIR(), 'Uninstall wisp.exe')), { timeout: 120_000, every: 500, what: 'v0.57.0' });
    await sleep(2000);
  };
  // This machine's own home and profile, as a person's: no WISP_HOME, no HOME.
  const real = (port) => {
    const { env } = qaEnv({ WISP_PORT: String(port), WISP_UPDATE_CHECK: '0' });
    for (const k of ['WISP_HOME', 'ELECTRON_RUN_AS_NODE', 'CI']) delete env[k];
    return env;
  };
  const mainWindow = (pid) => win32('windows', pid).find((w) => w.title === 'wisp');
  const closeApp = async (child, port) => {
    win32('close', mainWindow(child.pid).hwnd);
    await new Promise((r) => (child.exitCode === null ? child.once('exit', r) : r()));
    await down(port);
  };
  const entries = () => win32('uninstall');
  const links = () => win32('links');
  const toTauri = (l) => l.every((x) => x.target.toLowerCase() === path.join(TAURI_DIR(), 'wisp.exe').toLowerCase());
  const home = path.join(os.homedir(), '.wisp');
  const profile = path.join(process.env.APPDATA, 'wisp-agents');
  const opened = {};

  await check('INST-40', `a real v${ELECTRON}: where it goes, what it writes`, async () => {
    await installElectron();
    const e = entries();
    ok(e.length === 1 && e[0].version === ELECTRON, `Apps lists ${JSON.stringify(e)}`);
    ok(links().length === 2 && links().every((l) => l.target.toLowerCase().startsWith(ELECTRON_DIR().toLowerCase())), `links: ${JSON.stringify(links())}`);
    win32('pin', path.join(ELECTRON_DIR(), 'wisp.exe')); // pinned to the taskbar, as most people's is
  });
  await check('INST-41', `v${ELECTRON} runs a task in ~/.wisp and keeps a Chromium profile in %APPDATA%`, async () => {
    const port = nextPort++;
    const child = start(path.join(ELECTRON_DIR(), 'wisp.exe'), [], real(port));
    await up(port, 'v0.57.0');
    await until(() => mainWindow(child.pid)?.visible, { what: 'its window' });
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'fix the add function in math.js', cwd: makeRepo(), agent: 'claude' }) });
    ok(r.status === 201, `launch ${r.status}`);
    opened.id = (await r.json()).id;
    await until(async () => { const s = await (await fetch(`http://127.0.0.1:${port}/api/sessions/${opened.id}`)).json(); return !['running', 'queued', 'starting'].includes(s.state); }, { timeout: 60_000, what: 'the task' });
    ok(fs.existsSync(path.join(home, 'sessions', `${opened.id}.json`)), `no task in ${home}`);
    ok(fs.existsSync(profile), `no profile at ${profile}`);
    await closeApp(child, port);
    fs.writeFileSync(path.join(profile, 'qa-kept'), 'stays');
    fs.writeFileSync(path.join(home, 'qa-kept'), 'stays');
  });
  await check('INST-42', 'Tauri over it, as an update: one wisp in Apps, Electron’s copy gone, every link on the new one', async () => {
    ok((await run(setup, ['/S'])) === 0, 'the installer failed');
    await until(() => fs.existsSync(path.join(TAURI_DIR(), 'wisp.exe')), { timeout: 120_000, every: 500, what: 'wisp.exe' });
    ok(!fs.existsSync(ELECTRON_DIR()), `left in ${ELECTRON_DIR()}: ${fs.existsSync(ELECTRON_DIR()) && fs.readdirSync(ELECTRON_DIR())}`);
    const e = entries();
    ok(e.length === 1 && e[0].key === 'wisp', `Apps lists ${JSON.stringify(e)}`);
    ok(toTauri(links()) && links().length === 3, `links: ${JSON.stringify(links())}`);
    ok(fs.existsSync(PIN()), 'the pin went');
  });
  await check('INST-43', 'what was yours stays, and the new app reads the same ~/.wisp', async () => {
    for (const f of [path.join(profile, 'qa-kept'), path.join(home, 'qa-kept'), path.join(home, 'sessions', `${opened.id}.json`)]) ok(fs.existsSync(f), `gone: ${f}`);
    const port = nextPort++;
    const child = start(path.join(TAURI_DIR(), 'wisp.exe'), [], real(port));
    const h = await up(port, 'the app');
    ok(sh('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${h.pid}).Path`]).trim().toLowerCase() === path.join(TAURI_DIR(), 'node/node.exe').toLowerCase(), 'not on the bundled Node');
    await until(() => mainWindow(child.pid)?.visible, { what: 'its window' });
    const task = await fetch(`http://127.0.0.1:${port}/api/sessions/${opened.id}`);
    ok(task.status === 200, `the Electron task: ${task.status}`);
    await closeApp(child, port);
  });
  await check('INST-44', 'an installer run with Electron still open stops it, and links it didn’t make are moved', async () => {
    await installElectron();
    const port = nextPort++;
    const child = start(path.join(ELECTRON_DIR(), 'wisp.exe'), [], real(port));
    await up(port, 'v0.57.0');
    // /NS makes no links, as a normal install makes no desktop one unless asked: only the hook can move them.
    ok((await run(setup, ['/S', '/NS'])) === 0, 'the installer failed');
    await down(port);
    await until(() => !fs.existsSync(ELECTRON_DIR()), { timeout: 30_000, every: 500, what: `${ELECTRON_DIR()} to go` }).catch((err) => {
      throw new Error(`${err.message}: holds ${fs.readdirSync(ELECTRON_DIR())}, Apps ${JSON.stringify(entries())}, ${sh('powershell', ['-NoProfile', '-Command', "Get-Process | Where-Object { $_.Name -match 'wisp' } | ForEach-Object { $_.Path }"]).trim()}`);
    });
    ok(child.exitCode !== null || !alive(child.pid), 'Electron kept running');
    ok(entries().length === 1, `Apps lists ${JSON.stringify(entries())}`);
    ok(toTauri(links()) && links().length === 3, `links: ${JSON.stringify(links())}`);
  });
  await check('INST-45', 'a link of your own stays yours, and Tauri’s uninstaller leaves ~/.wisp', async () => {
    const mine = path.join(path.dirname(links()[0].path), 'wisp notes.lnk');
    win32('link-to', mine, 'C:\\Windows\\notepad.exe');
    ok((await run(setup, ['/S'])) === 0, 'the installer failed');
    ok(links().find((l) => l.path === mine)?.target.toLowerCase().endsWith('notepad.exe'), 'it moved a link it didn’t make');
    fs.rmSync(mine);
    await run(path.join(TAURI_DIR(), 'uninstall.exe'), ['/S']);
    await until(() => !fs.existsSync(path.join(TAURI_DIR(), 'wisp.exe')), { timeout: 60_000, every: 500, what: 'the uninstall' });
    ok(fs.existsSync(path.join(home, 'sessions', `${opened.id}.json`)), '~/.wisp went with it');
  });
  // The whole road a Windows user's update takes, in v0.57.0's own code: its updater downloads the
  // installer, hands `/S --force-run` to a waiter run as its own wisp.exe, and quits. One line differs
  // from a user's copy: RELEASES, so the release list comes from here. The app it starts is the
  // desktop user's, on 4477 and the real home, as after a real update.
  await check('INST-46', `v${ELECTRON}’s own updater moves it onto this build: Tauri comes up in its place, Electron’s copy gone`, async () => {
    ok(!(await health(4477).catch(() => null)), 'something is on 4477');
    await installElectron();
    for (const key of ELECTRON_KEYS) ok(await hasKey(key), `v0.57.0 wrote no ${key}`);
    const code = path.join(ELECTRON_DIR(), 'resources/app/server/update.js');
    const was = fs.readFileSync(code, 'utf8');
    const patched = was.replace(/const RELEASES = '[^']+';/, 'const RELEASES = process.env.QA_RELEASES;');
    ok(patched !== was, 'RELEASES has moved');
    fs.writeFileSync(code, patched);
    const body = fs.readFileSync(setup);
    const releases = http.createServer((req, res) => res.end(req.url === `/${name}` ? body : JSON.stringify({ tag_name: 'v99.0.0', assets: [{ name, browser_download_url: `http://127.0.0.1:${releases.address().port}/${name}`, digest: `sha256:${sha256(setup)}` }] })));
    await new Promise((r) => releases.listen(0, '127.0.0.1', r));
    try {
      const env = { ...real(4477), QA_RELEASES: `http://127.0.0.1:${releases.address().port}` };
      delete env.WISP_UPDATE_CHECK;
      // From its own folder, as its Start menu shortcut starts it: the cmd.exe its update runs the
      // installer from stands there, and Windows won't delete a folder a process stands in.
      const child = start(path.join(ELECTRON_DIR(), 'wisp.exe'), [], env, { cwd: ELECTRON_DIR() });
      const old = await up(4477, 'v0.57.0');
      const offer = await until(async () => { const u = await (await fetch('http://127.0.0.1:4477/api/update?check=1')).json(); return u.available && u; }, { timeout: 30_000, what: 'the update on offer' });
      ok(offer.method === 'app', `method ${offer.method}`);
      const r = await fetch('http://127.0.0.1:4477/api/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      ok(r.status === 202, `POST /api/update: ${r.status} ${await r.text()}`);
      const node = path.join(TAURI_DIR(), 'node/node.exe').toLowerCase();
      const fresh = await until(async () => {
        const h = await health(4477).catch(() => null);
        if (!h || h.pid === old.pid) return null;
        return sh('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${h.pid}).Path`]).trim().toLowerCase() === node && h;
      }, { timeout: 120_000, every: 500, what: 'the Tauri app on 4477' });
      console.log(`  Tauri up as pid ${fresh.pid}, Electron ${child.exitCode === null ? 'still running' : 'gone'}`);
      await until(() => !fs.existsSync(ELECTRON_DIR()), { timeout: 30_000, every: 500, what: `${ELECTRON_DIR()} to go` });
      ok(entries().length === 1 && entries()[0].key === 'wisp', `Apps lists ${JSON.stringify(entries())}`);
      for (const key of ELECTRON_KEYS) ok(!(await hasKey(key)), `${key} is still there`);
      ok(toTauri(links()), `links: ${JSON.stringify(links())}`);
      ok(fs.existsSync(path.join(home, 'sessions', `${opened.id}.json`)), '~/.wisp lost a task');
    } finally {
      releases.close();
      try {
        sh('taskkill', ['/F', '/T', '/IM', 'wisp.exe']);
      } catch {}
      await down(4477).catch(() => {});
    }
  });
}

// --- links and what must stay out of this ---
function linkRows() {
  return check('INST-30', 'README, site and updater ask for names the release has', async () => {
    const files = ['README.md', 'docs/index.html', 'scripts/site.mjs', 'docs/install.sh'];
    const names = new Set(files.flatMap((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').match(/wisp-(?:mac|windows|linux)-[\w$.{}-]+/g) || []));
    const want = /^wisp-(mac-(arm64|x64)\.(dmg|zip)|windows-(arm64|x64)-setup\.exe|linux-(arm64|x64)\.(AppImage|deb))$/;
    const real = [...names].filter((n) => !n.includes('$'));
    for (const n of real) ok(want.test(n), `${n} is no release name`);
    ok(real.length >= 6, `only ${real.length} names found`);
    if (process.env.QA_OFFLINE) return;
    for (const n of real) {
      const r = await fetch(`https://github.com/M0xoo/wisp/releases/latest/download/${n}`, { method: 'HEAD', redirect: 'follow' });
      ok(r.ok, `${n}: HTTP ${r.status}`);
    }
  });
}

// --- npm with no Electron: the shell alone from this version's release (bin/desktop-shell.js) ---
// Windows on screen for a pid, from CGWindowList: needs no Accessibility or Screen Recording grant.
const WINDOWS_JXA = `ObjC.import('CoreGraphics');
function run(argv) {
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0)));
  return list.filter((w) => String(w.kCGWindowOwnerPID) === argv[0] && w.kCGWindowLayer === 0).map((w) => w.kCGWindowBounds.Width + 'x' + w.kCGWindowBounds.Height).join(' ');
}`;
const windowsOf = (pid) => sh('osascript', ['-l', 'JavaScript', '-e', WINDOWS_JXA, String(pid)]).trim();

async function shellRows() {
  let name;
  try {
    name = shellArtefact(hostTarget());
  } catch {
    return notRun.push(['npm with the shell alone', `no Tauri build for ${process.platform}`]);
  }
  if (!fs.existsSync(path.join(ARTEFACTS, name))) return notRun.push(['npm with the shell alone (INST-25–28)', `no ${name} in ${ARTEFACTS}`]);
  tarball ??= path.join(TMP, sh('npm', ['pack', '--silent', '--pack-destination', TMP], { cwd: ROOT, env: { ...process.env, ...CACHE } }).trim().split('\n').pop());
  const dir = releaseDir([name]);
  const release = await serveDir(dir);
  const url = `http://127.0.0.1:${release.address().port}`;
  const prefix = dirIn('prefix');
  const env = machine({ WISP_SHELL_URL: url });
  const wisp = binIn(prefix);
  const root = pkgIn(prefix);
  const shellDir = path.join(env.WISP_HOME, 'desktop', PKG.version);
  sh('npm', ['install', '-g', tarball, '--prefix', prefix], { env });
  fs.rmSync(path.join(root, 'node_modules/electron'), { recursive: true, force: true });

  const port = nextPort++;
  let pid = null;
  await check('INST-25', 'npm -g, no Electron: `wisp` gets the shell from the release, checks it, and its window opens on this Node', async () => {
    clearOpened();
    const said = await shA(wisp, ['--port', String(port)], { env, shell: WIN });
    ok(/getting the wisp app/.test(said) && /wisp is open/.test(said), `said: ${said}`);
    ok(fs.readdirSync(shellDir).length, `nothing in ${shellDir}`);
    const h = await up(port, 'the shell’s server');
    pid = h.pid;
    ok(h.version === PKG.version, `health says ${h.version}`);
    ok((await getUpdate(port)).method === 'global', 'update method');
    ok(!opened(), `a tab as well: ${opened()}`);
    if (WIN) return manual.push(['INST-25 the window on Windows', 'the server is up on the shell; a window is seen by hand']);
    const comm = sh('ps', ['-o', 'comm=', '-p', String(pid)]).trim();
    ok(comm === process.execPath, `the server runs on ${comm}, not this Node`);
    const parent = sh('ps', ['-o', 'comm=', '-p', String(shellOf(pid))]).trim();
    ok(parent.startsWith(shellDir), `the server's parent is ${parent}`);
    if (MAC) await until(() => windowsOf(shellOf(pid)).split(' ').some((s) => Number(s.split('x')[0]) >= 720), { timeout: 30_000, what: 'the shell’s window' });
  });
  await check('INST-26', 'the next `wisp` takes the shell from disk: no download', async () => {
    release.close();
    const said = await shA(wisp, ['--port', String(port)], { env, shell: WIN });
    ok(/wisp is open/.test(said) && !/getting/.test(said), `said: ${said}`);
  });
  if (!WIN && pid) {
    await check('INST-26b', 'killing the shell leaves no server behind', async () => {
      process.kill(shellOf(pid), 'SIGKILL');
      await until(() => !alive(pid), { timeout: 20_000, what: 'Node to go' });
      await down(port);
    });
  } else await stopPort(port).catch(() => {});

  const tab = async (id, title, files, why) => {
    const bad = dirIn('bad-release');
    for (const [n, body] of Object.entries(files)) fs.writeFileSync(path.join(bad, n), body);
    const s = await serveDir(bad);
    const home = dirIn('wisp-home');
    const p = nextPort++;
    await check(id, title, async () => {
      clearOpened();
      const child = start(wisp, ['--port', String(p)], { ...env, WISP_HOME: home, WISP_SHELL_URL: `http://127.0.0.1:${s.address().port}` }, { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      await up(p);
      await until(() => /floating at/.test(out), { what: 'its line' });
      ok(new RegExp(`no wisp app here \\(.*${why}.*\\): opening a browser tab\\. The app: https://trywisp\\.dev`).test(out), `said: ${out}`);
      if (!WIN) await until(() => opened().includes(`localhost:${p}`), { what: 'the tab' });
      ok(!fs.existsSync(path.join(home, 'desktop', PKG.version)), 'kept a shell');
    });
    s.close();
    await stopPort(p).catch(() => {});
  };
  const body = fs.readFileSync(path.join(dir, name));
  await tab('INST-27', 'a shell that doesn’t match SHA256SUMS.txt: a tab and one line', { 'SHA256SUMS.txt': `${'0'.repeat(64)}  ${name}\n`, [name]: body }, "doesn't match");
  await tab('INST-28', 'no build for this platform in the release: a tab and one line', { 'SHA256SUMS.txt': `${'0'.repeat(64)}  wisp-shell-linux-riscv.tar.gz\n` }, `has no ${name}`);
}

async function main() {
  console.log(`\n  install gate · wisp ${PKG.version} · ${process.platform} ${process.arch} · Node ${process.version} · artefacts ${ARTEFACTS}\n`);
  if (ONLY.includes('npm') || ONLY.includes('brew')) await npmRows();
  if (ONLY.includes('script')) await scriptRows();
  if (ONLY.includes('brew')) await brewRows();
  if (ONLY.includes('app') && MAC) await macRows();
  if (ONLY.includes('app') && WIN) await windowsRows();
  if (ONLY.includes('migrate') && WIN) await migrateRows();
  if (ONLY.includes('shell')) await shellRows();
  if (ONLY.includes('links')) await linkRows();
  for (const child of live) child.kill();
  manual.push(
    ['Mac dmg/zip downloaded in a browser: Gatekeeper, Open Anyway', 'needs a real quarantined download; ad hoc here, as Electron without its secrets'],
    ['Site Download button, clicked', 'INST-30 reads the links and HEADs them; a click is by hand'],
    ['Real `brew install`', 'tap bumped only after npm; INST-08 and 09 cover the formula and its steps'],
    ['Linux AppImage, .deb', 'stay on Electron: unchanged, built by electron-builder'],
  );
  const failed = results.filter((r) => !r.ok);
  const lines = ['| Row | Result |', '|---|---|', ...results.map((r) => `| ${r.id} ${r.title} | ${r.ok ? 'ran: pass' : `ran: FAIL, ${r.error}`} |`), ...notRun.map(([p, why]) => `| ${p} | NOT RUN: ${why} |`), ...manual.map(([p, why]) => `| ${p} | Manual: ${why} |`)];
  fs.writeFileSync(path.join(OUT, 'install.md'), `${lines.join('\n')}\n`);
  console.log(`\n${lines.slice(2).join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Install gate (${process.platform} ${process.arch})\n\n${lines.join('\n')}\n`);
  if (!process.env.QA_KEEP) fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
  process.exit(done() || (failed.length ? 1 : 0));
}

await main();
