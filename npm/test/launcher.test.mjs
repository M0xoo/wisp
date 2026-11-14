// The real bin/wisp.js, run end to end against a fake binary named by WISP_BINARY.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../wisp-agents', import.meta.url));
const skipOnWindows = process.platform === 'win32' ? 'a shebang script is not executable on Windows' : false;
let tmp;
let launcher;
let fake;

// Copies the launcher into a tmp package so a web/ folder can be added without touching the source tree.
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-launcher-'));
  const pkg = path.join(tmp, 'wisp-agents');
  fs.cpSync(SRC, pkg, { recursive: true });
  fs.mkdirSync(path.join(pkg, 'web'), { recursive: true });
  launcher = path.join(pkg, 'bin', 'wisp.js');
  fake = path.join(tmp, 'fake-wisp');
  fs.writeFileSync(
    fake,
    `#!${process.execPath}
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({ args, web: process.env.WISP_WEB_DIR ?? null }));
const code = args.find((a) => a.startsWith('--exit='));
if (args.includes('--hang')) setInterval(() => {}, 1000);
else process.exit(code ? Number(code.slice(7)) : 0);
`,
  );
  fs.chmodSync(fake, 0o755);
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [launcher, ...args], { env: { ...process.env, WISP_WEB_DIR: '', ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr, child }));
  });
}

test('passes args through and sets WISP_WEB_DIR to the package web/ folder', { skip: skipOnWindows }, async () => {
  const r = await run(['--no-open', '--port', '5555', 'two words'], { WISP_BINARY: fake, WISP_WEB_DIR: undefined });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.args, ['--no-open', '--port', '5555', 'two words']);
  assert.equal(fs.realpathSync(out.web), fs.realpathSync(path.join(tmp, 'wisp-agents', 'web')));
});

test('keeps an explicit WISP_WEB_DIR', { skip: skipOnWindows }, async () => {
  const r = await run([], { WISP_BINARY: fake, WISP_WEB_DIR: '/somewhere/else' });
  assert.equal(JSON.parse(r.stdout).web, '/somewhere/else');
});

test("exits with the child's exit code", { skip: skipOnWindows }, async () => {
  const r = await run(['--exit=7'], { WISP_BINARY: fake });
  assert.equal(r.code, 7);
});

test('forwards SIGTERM to the child and dies of the same signal', { skip: skipOnWindows }, async () => {
  const child = spawn(process.execPath, [launcher, '--hang'], { env: { ...process.env, WISP_BINARY: fake } });
  // The fake writes its args once it runs; only then is there a child to forward to.
  await new Promise((resolve) => child.stdout.once('data', resolve));
  child.kill('SIGTERM');
  const [code, signal] = await new Promise((resolve) => child.on('exit', (c, s) => resolve([c, s])));
  assert.equal(code, null);
  assert.equal(signal, 'SIGTERM');
});

test('finds the binary in the installed @wisp/core package for this platform', { skip: skipOnWindows }, async () => {
  // The layout npm makes: node_modules/wisp-agents next to node_modules/@wisp/core-<os>-<arch>.
  const nm = path.join(tmp, 'install', 'node_modules');
  const core = path.join(nm, '@wisp', `core-${process.platform}-${process.arch}`);
  fs.mkdirSync(path.join(core, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(core, 'package.json'), JSON.stringify({ name: `@wisp/core-${process.platform}-${process.arch}`, version: '2.0.0' }));
  fs.copyFileSync(fake, path.join(core, 'bin', 'wisp'));
  fs.chmodSync(path.join(core, 'bin', 'wisp'), 0o755);
  fs.cpSync(SRC, path.join(nm, 'wisp-agents'), { recursive: true });
  const child = spawn(process.execPath, [path.join(nm, 'wisp-agents', 'bin', 'wisp.js'), 'hi'], { env: { ...process.env, WISP_BINARY: '' } });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout).args, ['hi']);
});

test('a WISP_BINARY that does not exist fails with a clear message', async () => {
  const r = await run([], { WISP_BINARY: path.join(tmp, 'nope') });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not run .*nope: it does not exist/);
});

test('a missing platform package prints the fix and exits 1', async () => {
  const r = await run([], { WISP_BINARY: '' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, new RegExp(`${process.platform}-${process.arch}`));
  assert.match(r.stderr, /npm install -g wisp-agents|no wisp build/);
});
