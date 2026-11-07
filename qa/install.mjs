// Install gate: every way into wisp, on real artefacts. Scenarios: qa/scenarios/install.md.
//
//   node qa/install.mjs [--artefacts dist/tauri] [--only npm,script,brew,app,links]
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
import { OUT, ROOT, ok, qaEnv, runner } from './lib.mjs';
import { Updater } from '../server/update.js';
import { artefacts } from '../desktop/scripts/package.mjs';
import { NODE_VERSION, hostTarget } from '../desktop/scripts/fetch-node.mjs';

const { check, done, results } = runner('install');
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const ARTEFACTS = path.resolve(argOf('--artefacts', path.join(ROOT, 'dist/tauri')));
const ONLY = argOf('--only', 'npm,script,brew,app,links').split(',');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const [MAC, WIN] = [process.platform === 'darwin', process.platform === 'win32'];
const SYSTEM = WIN ? process.env.PATH : '/usr/bin:/bin:/usr/sbin:/sbin';
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-install-')));
const dirIn = (name) => fs.mkdtempSync(path.join(TMP, `${name}-`));
// One download of each per run, whichever prefix or HOME asks.
const CACHE = { npm_config_cache: process.env.QA_NPM_CACHE || path.join(TMP, 'npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', electron_config_cache: process.env.QA_ELECTRON_CACHE || path.join(TMP, 'electron-cache') };
let nextPort = Number(process.env.QA_INSTALL_PORT) || 4771;
const live = new Set();
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
  await check('INST-01', 'npm pack: wisp, and nothing of the Tauri shell', async () => {
    tarball = path.join(dest, sh('npm', ['pack', '--silent', '--pack-destination', dest], { cwd: ROOT, env: { ...process.env, ...CACHE } }).trim().split('\n').pop());
    // System32's: Git Bash's GNU tar takes C:\ for a host name.
    const tar = WIN ? path.join(process.env.SystemRoot, 'System32/tar.exe') : 'tar';
    const files = sh(tar, ['-tzf', tarball]).split(/\r?\n/);
    for (const f of ['package/bin/wisp.js', 'package/server/index.js', 'package/electron/main.js', 'package/web/index.html']) ok(files.includes(f), `${f} isn't in it`);
    ok(!files.some((f) => f.startsWith('package/desktop/')), 'desktop/ is on npm');
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
    ok(/homebrew:\n\s+needs: \[plan, publish\]/.test(wf), 'the tap follows npm and the release');
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

  // Tauri won't say where its resources are when the path holds a symlink.
  const d = nextPort++;
  const linked = path.join(dirIn('linked'), 'Apps');
  fs.symlinkSync(installed, linked);
  await launchChecks('INST-17', 'the .app reached through a symlinked folder', d, () => start(path.join(linked, 'wisp.app/Contents/MacOS/wisp'), [], clean(d)));

  // The real swap, on the real app, from a real newer zip. Only the release list is stood in for.
  const c = nextPort++;
  await check('INST-16', 'self-update: the running app swaps itself for a newer build and reopens', async () => {
    const bump = dirIn('bump');
    sh('ditto', [app, path.join(bump, 'wisp.app')]);
    const [ma, mi, pa] = PKG.version.split('-')[0].split('.').map(Number);
    const version = `${ma}.${mi}.${pa + 1}`;
    const pkg = path.join(bump, 'wisp.app/Contents/Resources/app/package.json');
    fs.writeFileSync(pkg, JSON.stringify({ ...JSON.parse(fs.readFileSync(pkg, 'utf8')), version }, null, 2));
    sh('codesign', ['--force', '--sign', '-', path.join(bump, 'wisp.app')]);
    const up2 = dirIn('newer');
    sh('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', path.join(bump, 'wisp.app'), path.join(up2, zip)]);
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
    const h = await up(port, 'the app');
    const update = await getUpdate(port);
    ok(update.method === 'app', `update method ${update.method}`);
    const comm = sh('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${h.pid}).Path`]).trim();
    ok(comm.toLowerCase() === path.join(dir, 'node/node.exe').toLowerCase(), `the server runs on ${comm}`);
    sh('taskkill', ['/F', '/T', '/IM', 'wisp.exe']);
    await down(port);
  });
  await check('INST-22', 'the update command: /S --force-run /R reinstalls and starts the app again', async () => {
    const u = new Updater({ port, env: {}, platform: 'win32', arch, root: path.join(dir, 'resources/app') });
    u.swap = { installer: setup };
    const flags = u.relaunchCommand().split(`"${setup}" `)[1].split(' ');
    ok(flags.includes('/R') && flags.includes('--force-run'), flags.join(' '));
    ok((await run(flags)) === 0, 'the installer failed');
    // Started as the desktop user, not as this process's child: it has none of this env, so its port is the default.
    await up(4477, 'the app the installer started');
    sh('taskkill', ['/F', '/T', '/IM', 'wisp.exe']);
    await down(4477);
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

async function main() {
  console.log(`\n  install gate · wisp ${PKG.version} · ${process.platform} ${process.arch} · Node ${process.version} · artefacts ${ARTEFACTS}\n`);
  if (ONLY.includes('npm') || ONLY.includes('brew')) await npmRows();
  if (ONLY.includes('script')) await scriptRows();
  if (ONLY.includes('brew')) await brewRows();
  if (ONLY.includes('app') && MAC) await macRows();
  if (ONLY.includes('app') && WIN) await windowsRows();
  if (ONLY.includes('links')) await linkRows();
  for (const child of live) child.kill();
  manual.push(
    ['Mac dmg/zip downloaded in a browser: Gatekeeper, Open Anyway', 'needs a real quarantined download; ad hoc here, as Electron without its secrets'],
    ['Site Download button, clicked', 'INST-30 reads the links and HEADs them; a click is by hand'],
    ['Real `brew install`', 'tap bumped only after npm; INST-08 and 09 cover the formula and its steps'],
    ['Linux AppImage, .deb', 'stay on Electron: unchanged, built by electron-builder'],
    ['Electron→Tauri self-update, seen', 'needs a Tauri build on a release'],
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
