// The Tauri shell for a wisp from npm (bin/desktop-shell.js): found, downloaded from a release,
// checked against SHA256SUMS.txt, unpacked, or refused with a reason so bin/wisp.js opens a tab.
// The release is a server in this process: no network.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { installFakeBins, tmp, until } from './helpers.js';
import { desktopShell, releaseUrl, shellAsset, shellDir, shellEnv, shellExe, sumFor, noAppLine, GET_APP } from '../bin/desktop-shell.js';
import { shellArtefact } from '../desktop/scripts/package.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BIN = path.join(ROOT, 'bin/wisp.js');
const WIN = process.platform === 'win32';
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
installFakeBins();
process.env.WISP_UPDATE_CHECK = '0';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const tarBin = WIN ? path.join(process.env.SystemRoot, 'System32/tar.exe') : 'tar';

// An archive as package.mjs packShell() makes it: wisp.app on a Mac, the binary elsewhere.
function archive(platform, script = '#!/bin/sh\necho shell\n', { empty = false } = {}) {
  const room = tmp('shell-src');
  const name = shellAsset(platform, 'arm64');
  const inside = platform === 'darwin' ? 'wisp.app' : platform === 'win32' ? 'wisp.exe' : 'wisp';
  const exe = shellExe(room, platform);
  if (!empty) {
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, script, { mode: 0o755 });
  } else fs.mkdirSync(path.join(room, inside));
  execFileSync(tarBin, ['-czf', name, inside], { cwd: room });
  return fs.readFileSync(path.join(room, name));
}

// A release folder: { 'SHA256SUMS.txt': …, 'wisp-shell-…': … }, and every path asked for.
function release(files) {
  const asked = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url);
    const body = files[path.posix.basename(req.url)];
    if (body == null) return (res.statusCode = 404), res.end();
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, asked, url: `http://127.0.0.1:${server.address().port}/download/v${VERSION}` })));
}
const servers = [];
after(() => servers.forEach((s) => s.close()));
async function serve(files) {
  const r = await release(files);
  servers.push(r.server);
  return r;
}
const sumsOf = (entries) => entries.map(([name, body]) => `${sha(body)}  ${name}`).join('\n') + '\n';

test('one archive name per platform, the same in package.mjs; none where there is no build', () => {
  const triples = {
    'aarch64-apple-darwin': ['darwin', 'arm64', 'wisp-shell-mac-arm64.tar.gz'],
    'x86_64-apple-darwin': ['darwin', 'x64', 'wisp-shell-mac-x64.tar.gz'],
    'x86_64-pc-windows-msvc': ['win32', 'x64', 'wisp-shell-windows-x64.tar.gz'],
    'aarch64-pc-windows-msvc': ['win32', 'arm64', 'wisp-shell-windows-arm64.tar.gz'],
    'x86_64-unknown-linux-gnu': ['linux', 'x64', 'wisp-shell-linux-x64.tar.gz'],
    'aarch64-unknown-linux-gnu': ['linux', 'arm64', 'wisp-shell-linux-arm64.tar.gz'],
  };
  for (const [triple, [platform, arch, name]] of Object.entries(triples)) {
    assert.equal(shellAsset(platform, arch), name);
    assert.equal(shellArtefact(triple), name);
  }
  assert.equal(shellAsset('freebsd', 'x64'), null);
  assert.equal(shellAsset('win32', 'ia32'), null);
  assert.ok(!/\d+\.\d+/.test(shellAsset('darwin', 'arm64')), 'no version in the name');
});

test('the release a version comes from, WISP_HOME and the stand-in URL', () => {
  assert.equal(releaseUrl('0.58.0', {}), 'https://github.com/WispAgents/wisp/releases/download/v0.58.0');
  assert.equal(releaseUrl('0.59.0-beta.1', {}), 'https://github.com/WispAgents/wisp/releases/download/v0.59.0-beta.1');
  assert.equal(releaseUrl('0.58.1-nightly.20261108.317', {}), 'https://github.com/WispAgents/wisp/releases/download/nightly');
  assert.equal(releaseUrl('0.58.0', { WISP_SHELL_URL: 'http://127.0.0.1:9/r/' }), 'http://127.0.0.1:9/r');
  assert.equal(shellDir('0.58.0', '/h/.wisp'), path.join('/h/.wisp', 'desktop', '0.58.0'));
  assert.equal(shellExe('/d', 'darwin'), path.join('/d', 'wisp.app/Contents/MacOS/wisp'));
  assert.equal(shellExe('/d', 'win32'), path.join('/d', 'wisp.exe'));
  assert.equal(shellExe('/d', 'linux'), path.join('/d', 'wisp'));
});

test('SHA256SUMS.txt: sha256sum and shasum lines, binary mode, CRLF, nothing for a missing name', () => {
  const h = 'a'.repeat(64);
  const sums = `${'b'.repeat(64)}  wisp-mac-arm64.zip\r\n${h} *wisp-shell-mac-arm64.tar.gz\r\n`;
  assert.equal(sumFor(sums, 'wisp-shell-mac-arm64.tar.gz'), h);
  assert.equal(sumFor(sums, 'wisp-shell-mac-x64.tar.gz'), null);
  assert.equal(sumFor('not a sum line\n', 'x'), null);
});

test('downloads the shell once, checks it, unpacks it under ~/.wisp/desktop/<version>/', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const body = archive(platform);
    const name = shellAsset(platform, 'arm64');
    const { url, asked } = await serve({ 'SHA256SUMS.txt': sumsOf([['wisp-mac-arm64.zip', Buffer.from('zip')], [name, body]]), [name]: body });
    const home = tmp('shell-home');
    const said = [];
    const got = await desktopShell({ version: VERSION, home, platform, arch: 'arm64', env: { WISP_SHELL_URL: url }, say: (l) => said.push(l) });
    assert.equal(got.exe, shellExe(shellDir(VERSION, home), platform), platform);
    assert.ok(fs.existsSync(got.exe));
    if (!WIN) assert.ok(fs.statSync(got.exe).mode & 0o100, 'still executable');
    assert.deepEqual(fs.readdirSync(path.join(home, 'desktop')), [VERSION], 'no part folder or archive left');
    assert.ok(!fs.existsSync(path.join(shellDir(VERSION, home), name)), 'the archive is gone');
    assert.match(said.join('\n'), /getting the wisp app/);
    assert.deepEqual(asked, [`/download/v${VERSION}/SHA256SUMS.txt`, `/download/v${VERSION}/${name}`]);
    // Found from now on: no request.
    const again = await desktopShell({ version: VERSION, home, platform, arch: 'arm64', env: { WISP_SHELL_URL: url } });
    assert.equal(again.exe, got.exe);
    assert.equal(asked.length, 2);
  }
});

test('WISP_HOME is where it goes when no home is given', async () => {
  const body = archive('linux');
  const name = shellAsset('linux', 'x64');
  const { url } = await serve({ 'SHA256SUMS.txt': sumsOf([[name, body]]), [name]: body });
  const home = tmp('shell-wisp-home');
  const got = await desktopShell({ version: VERSION, platform: 'linux', arch: 'x64', env: { WISP_SHELL_URL: url, WISP_HOME: home } });
  assert.equal(got.exe, path.join(home, 'desktop', VERSION, 'wisp'));
});

test('a bad checksum, no build, a release that isn’t there, offline: no shell, a reason, nothing kept', async () => {
  const platform = 'linux';
  const name = shellAsset(platform, 'x64');
  const body = archive(platform);
  const hollow = archive(platform, '', { empty: true });
  const cases = {
    checksum: { 'SHA256SUMS.txt': `${'0'.repeat(64)}  ${name}\n`, [name]: body },
    missing: { 'SHA256SUMS.txt': sumsOf([['wisp-shell-mac-arm64.tar.gz', body]]), [name]: body }, // no build for this platform
    'no sums': { [name]: body },
    'no exe': { 'SHA256SUMS.txt': sumsOf([[name, hollow]]), [name]: hollow },
  };
  const want = { checksum: 'checksum', missing: 'missing', 'no sums': 'missing', 'no exe': 'unpack' };
  for (const [label, files] of Object.entries(cases)) {
    const { url } = await serve(files);
    const home = tmp('shell-bad');
    const got = await desktopShell({ version: VERSION, home, platform, arch: 'x64', env: { WISP_SHELL_URL: url } });
    assert.equal(got.exe, null, label);
    assert.equal(got.reason, want[label], `${label}: ${got.message}`);
    assert.ok(got.message, label);
    assert.ok(!fs.existsSync(path.join(home, 'desktop', VERSION)), `${label}: left a shell`);
    assert.deepEqual(fs.existsSync(path.join(home, 'desktop')) ? fs.readdirSync(path.join(home, 'desktop')) : [], [], `${label}: left a part folder`);
  }
  // A port nothing listens on.
  const closed = await new Promise((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => s.close(() => r(s.address()?.port ?? 0)));
  });
  const port = closed || 9;
  const off = await desktopShell({ version: VERSION, home: tmp('shell-off'), platform, arch: 'x64', env: { WISP_SHELL_URL: `http://127.0.0.1:${port}` } });
  assert.equal(off.reason, 'offline', off.message);
  // No build at all for this computer: not even a request.
  let asked = 0;
  const none = await desktopShell({ version: VERSION, home: tmp('shell-none'), platform: 'freebsd', arch: 'x64', fetch: () => asked++ });
  assert.equal(none.reason, 'platform');
  assert.equal(asked, 0);
  assert.match(noAppLine(off.message), new RegExp(`browser tab.*${GET_APP.replace(/[.#/]/g, '\\$&')}`));
});

test('the shell’s environment: this Node, this package, the port; never Electron-as-Node', () => {
  const env = shellEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', WISP_PORT: '1' }, { port: 4590, root: '/pkg' });
  assert.deepEqual(env, { PATH: '/bin', WISP_PORT: '4590', WISP_NODE: process.execPath, WISP_ROOT: '/pkg' });
});

// The shell's root() needs desktop/entry.mjs under WISP_ROOT, so npm has to carry it and what it
// imports from desktop/ (only those).
test('npm carries desktop/entry.mjs and its imports for the shell, and nothing else of desktop/', () => {
  const files = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files.filter((f) => f.startsWith('desktop'));
  assert.deepEqual(files, ['desktop/entry.mjs', 'desktop/shell-path.js']);
  const entry = fs.readFileSync(path.join(ROOT, 'desktop/entry.mjs'), 'utf8');
  const local = [...entry.matchAll(/from '\.\/([\w.-]+)'/g)].map((m) => `desktop/${m[1]}`);
  assert.deepEqual(local, ['desktop/shell-path.js'], 'entry.mjs imports from desktop/ only what npm carries');
  const main = fs.readFileSync(path.join(ROOT, 'desktop/src-tauri/src/main.rs'), 'utf8');
  assert.match(main, /var_os\("WISP_ROOT"\)[^;]*\.find\(entry\)/s, 'root() takes WISP_ROOT when it holds desktop/entry.mjs');
  assert.match(main, /var_os\("WISP_NODE"\)\.map\(PathBuf::from\)\.or\(bundled\)/, 'node() takes WISP_NODE first');
  assert.doesNotMatch(main.slice(main.indexOf('fn root('), main.indexOf('#[tauri::command]')), /debug_assertions\)\s*\.then\(\|\| std::env::var/, 'not for dev builds only');
});

// --- bin/wisp.js, end to end. The shell here is a script that starts wisp's server the way the real
// one does (its child, on WISP_NODE, from WISP_ROOT) and writes down what it was given. ---

const cliSkip = WIN ? 'a shell script stands in for the shell' : false;

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const health = async (port) => (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
const killServer = async (port) => {
  const h = await health(port).catch(() => null);
  if (h) process.kill(h.pid);
  await until(() => health(port).then(() => false, () => true), { what: `port ${port} to free up` });
};

function cliEnv(extra) {
  const stubs = tmp('shell-stubs');
  const opened = path.join(stubs, 'opened.log');
  for (const n of ['open', 'xdg-open']) fs.writeFileSync(path.join(stubs, n), `#!/bin/sh\necho "$@" >> "${opened}"\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${stubs}${path.delimiter}${process.env.PATH}`, WISP_HOME: tmp('shell-cli-home'), ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return { env, opened: () => (fs.existsSync(opened) ? fs.readFileSync(opened, 'utf8') : '') };
}

const FAKE_SHELL = '#!/bin/sh\nenv > "$WISP_HOME/shell-env"\nexec "$WISP_NODE" "$WISP_ROOT/bin/wisp.js" --no-open --port "$WISP_PORT" >/dev/null 2>&1\n';

test('`wisp` gets the shell, runs it detached on this Node and package, and opens no tab', { skip: cliSkip }, async () => {
  const name = shellAsset();
  const body = archive(process.platform, FAKE_SHELL);
  const { url, asked } = await serve({ 'SHA256SUMS.txt': sumsOf([[name, body]]), [name]: body });
  const port = await freePort();
  const { env, opened } = cliEnv({ WISP_SHELL_URL: url, ELECTRON_RUN_AS_NODE: '1' });
  const { stdout } = await promisify(execFile)(process.execPath, [BIN, '--port', String(port)], { env, timeout: 60_000 });
  try {
    assert.match(stdout, /getting the wisp app/);
    assert.match(stdout, /wisp is open/);
    const shellEnv = fs.readFileSync(path.join(env.WISP_HOME, 'shell-env'), 'utf8');
    assert.match(shellEnv, new RegExp(`^WISP_NODE=${process.execPath.replace(/[.\\]/g, '\\$&')}$`, 'm'));
    assert.match(shellEnv, new RegExp(`^WISP_ROOT=${ROOT}$`, 'm'));
    assert.match(shellEnv, new RegExp(`^WISP_PORT=${port}$`, 'm'));
    assert.doesNotMatch(shellEnv, /^ELECTRON_RUN_AS_NODE=/m);
    assert.equal((await health(port)).version, VERSION);
    assert.equal(opened(), '', 'a tab as well');
    assert.equal(asked.length, 2);
    // A second `wisp` on the running one: the same shell, from disk.
    await promisify(execFile)(process.execPath, [BIN, '--port', String(port)], { env, timeout: 60_000 });
    assert.equal(asked.length, 2, 'downloaded again');
  } finally {
    await killServer(port);
  }
});

test('a shell that doesn’t check out: one line, and the browser tab as today', { skip: cliSkip }, async () => {
  const name = shellAsset();
  const body = archive(process.platform, FAKE_SHELL);
  const { url } = await serve({ 'SHA256SUMS.txt': `${'0'.repeat(64)}  ${name}\n`, [name]: body });
  const port = await freePort();
  const { env, opened } = cliEnv({ WISP_SHELL_URL: url });
  const child = spawn(process.execPath, [BIN, '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  try {
    await until(() => /floating at/.test(out), { timeout: 30_000, what: 'the server' });
    assert.match(out, /no wisp app here \(.*doesn't match SHA256SUMS\.txt\): opening a browser tab\. The app: https:\/\/trywisp\.dev/);
    await until(() => opened().includes(`localhost:${port}`), { what: 'the tab' });
    assert.ok(!fs.existsSync(path.join(env.WISP_HOME, 'desktop', VERSION)), 'kept a bad shell');
    assert.equal((await health(port)).pid, child.pid, 'the server is this process, as with --browser');
  } finally {
    child.kill();
    await until(() => health(port).then(() => false, () => true), { what: `port ${port} to free up` });
  }
});

test('--browser, --no-open and words for a running wisp never look for the shell', { skip: cliSkip }, async () => {
  const { url, asked } = await serve({});
  const port = await freePort();
  const { env, opened } = cliEnv({ WISP_SHELL_URL: url });
  const child = spawn(process.execPath, [BIN, '--no-open', '--port', String(port)], { env, stdio: 'ignore' });
  try {
    await until(() => health(port), { timeout: 30_000, what: 'the server' });
    await promisify(execFile)(process.execPath, [BIN, '--browser', '--port', String(port)], { env, timeout: 30_000 });
    await until(() => opened().includes(`localhost:${port}`), { what: 'the tab' });
    await promisify(execFile)(process.execPath, [BIN, 'add', ROOT, '--port', String(port)], { env, timeout: 30_000 });
    assert.deepEqual(asked, []);
    assert.ok(!fs.existsSync(path.join(env.WISP_HOME, 'desktop')));
  } finally {
    child.kill();
    await until(() => health(port).then(() => false, () => true), { what: `port ${port} to free up` });
  }
});

test('every Tauri build packs the shell alone, and the release publishes them with their sums', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
  const pack = read('desktop/scripts/package.mjs');
  // Mac and Windows: Linux has no shell archive yet, so npm there still opens a browser tab.
  assert.match(pack, /\(isMac\(triple\) \? packMac : isLinux\(triple\) \? packLinux : packWindows\)\(triple, out\);\n {2}if \(!isLinux\(triple\)\) packShell\(triple, out\);/);
  assert.match(pack, /for \(const dir of \['app', 'node'\]\) fs\.rmSync/, 'no Node or wisp files in it');
  const yml = read('.github/workflows/tauri-package.yml');
  assert.match(yml, /path: dist\/tauri\/wisp-\*/, 'the shells go in the desktop-* artifacts with the rest');
  assert.match(yml, /sha256sum wisp-\* > SHA256SUMS\.txt/, 'the same line as release.yml');
  for (const a of ['mac-arm64', 'mac-x64', 'windows-x64', 'windows-arm64']) assert.ok(yml.includes(a), a);
  // release.yml publishes desktop-*, sums every wisp-* in it, and uploads it all: bin/desktop-shell.js reads those.
  const rel = read('.github/workflows/release.yml');
  assert.match(rel, /pattern: desktop-\*/);
  assert.match(rel, /sha256sum wisp-\* > SHA256SUMS\.txt/);
  assert.match(rel, /gh release upload "\$TAG" out\/\* --clobber/);
});
