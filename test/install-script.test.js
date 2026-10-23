// docs/install.sh (served as trywisp.dev/install.sh): run it against fake node, npm and wisp binaries.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp, win } from './helpers.js';

// The installer covers macOS and Linux only (Windows users run npm directly), so skip on Windows.
const opts = { skip: win };
const script = fileURLToPath(new URL('../docs/install.sh', import.meta.url));

function fakeBin(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

// A fake toolchain: `node` reports `nodeVersion`, `npm` logs its args to npm.log and exits with
// `npmExit`, and `wisp` (only when `withWisp`) prints a version.
function setup({ nodeVersion = 'v22.11.0', npmExit = 0, withWisp = true } = {}) {
  const root = tmp('install-sh');
  const nodeDir = path.join(root, 'node');
  const npmDir = path.join(root, 'npm');
  const wispDir = path.join(root, 'wisp');
  const log = path.join(root, 'npm.log');
  const major = nodeVersion.slice(1).split('.')[0];
  fakeBin(nodeDir, 'node', `if [ "$1" = "-v" ]; then echo ${nodeVersion}; elif [ "$1" = "-p" ]; then echo ${major}; fi`);
  fakeBin(npmDir, 'npm', `if [ "$1" = "prefix" ]; then echo ${path.join(root, 'prefix')}; exit 0; fi\necho "$@" >> ${log}\nexit ${npmExit}`);
  if (withWisp) fakeBin(wispDir, 'wisp', 'echo 0.15.0');
  // Only the fakes plus the system tools (uname, ...) are on PATH.
  const PATH = [npmDir, nodeDir, withWisp ? wispDir : null, '/usr/bin', '/bin'].filter(Boolean).join(':');
  return { PATH, log };
}

function run(env, extra = {}) {
  return spawnSync('bash', [script], {
    env: { PATH: env.PATH, HOME: tmp('install-sh-home'), ...extra },
    encoding: 'utf8',
  });
}

test('install.sh installs the latest wisp-agents from npm and confirms wisp is on PATH', opts, () => {
  const env = setup();
  const r = run(env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(env.log, 'utf8').trim(), 'install -g wisp-agents@latest');
  assert.match(r.stdout, /Installed wisp 0\.15\.0/);
  assert.match(r.stdout, /wisp "fix the flaky auth test"/);
});

test('WISP_VERSION pins the npm version', opts, () => {
  const env = setup();
  const r = run(env, { WISP_VERSION: '0.14.0' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(env.log, 'utf8').trim(), 'install -g wisp-agents@0.14.0');
});

test('install.sh refuses Node.js older than 20 before touching npm', opts, () => {
  const env = setup({ nodeVersion: 'v18.20.0' });
  const r = run(env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Node\.js 20\+ is required, found v18\.20\.0/);
  assert.equal(fs.existsSync(env.log), false);
});

test('install.sh says what to do when npm fails', opts, () => {
  const env = setup({ npmExit: 243 });
  const r = run(env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /npm install failed/);
});

test('install.sh explains a PATH problem when wisp is not found after install', opts, () => {
  const env = setup({ withWisp: false });
  const r = run(env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /'wisp' is not on your PATH/);
});

// --app: the macOS app from a release folder (file:// stands in for GitHub), no Node involved.
function release({ corrupt = false } = {}) {
  const dir = tmp('install-sh-release');
  const app = path.join(dir, 'build', 'wisp.app', 'Contents');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'Info.plist'), 'wisp');
  const zip = `wisp-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip`;
  spawnSync('ditto', ['-ck', '--keepParent', path.join(dir, 'build', 'wisp.app'), path.join(dir, zip)]);
  const sum = spawnSync('shasum', ['-a', '256', zip], { cwd: dir, encoding: 'utf8' }).stdout.split(' ')[0];
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), `${corrupt ? '0'.repeat(64) : sum}  ${zip}\n`);
  return dir;
}
const mac = { skip: process.platform !== 'darwin' };
const appRun = (dir, dest) =>
  spawnSync('bash', [script, '--app'], { env: { PATH: '/usr/bin:/bin', HOME: tmp('install-sh-home'), WISP_DOWNLOADS: `file://${dir}`, WISP_APP_DIR: dest, WISP_NO_OPEN: '1' }, encoding: 'utf8' });

test('install.sh --app puts wisp.app in Applications, with no Node on PATH', mac, () => {
  const dest = tmp('install-sh-apps');
  fs.mkdirSync(path.join(dest, 'wisp.app', 'old'), { recursive: true }); // an older copy is replaced
  const r = appRun(release(), dest);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(dest, 'wisp.app/Contents/Info.plist'), 'utf8'), 'wisp');
  assert.equal(fs.existsSync(path.join(dest, 'wisp.app', 'old')), false);
  assert.match(r.stdout, /Installed .*wisp\.app/);
  const xattr = spawnSync('xattr', [path.join(dest, 'wisp.app')], { encoding: 'utf8' }).stdout;
  assert.doesNotMatch(xattr, /quarantine/);
});

test('install.sh --app refuses a download that fails the release checksum', mac, () => {
  const dest = tmp('install-sh-apps');
  const r = appRun(release({ corrupt: true }), dest);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /doesn't match the release's SHA256SUMS\.txt/);
  assert.equal(fs.existsSync(path.join(dest, 'wisp.app')), false);
});

test('install.sh --app on Linux points to the AppImage and .deb', { skip: process.platform !== 'linux' }, () => {
  const r = spawnSync('bash', [script, '--app'], { env: { PATH: '/usr/bin:/bin', HOME: tmp('install-sh-home') }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /AppImage or \.deb/);
});

test('install.sh refuses options it does not know', opts, () => {
  const r = spawnSync('bash', [script, '--nope'], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown option --nope/);
});
