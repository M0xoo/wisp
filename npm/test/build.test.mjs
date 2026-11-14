import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TARGETS } from '../wisp-agents/lib/resolve.js';

const SCRIPT = fileURLToPath(new URL('../scripts/build.mjs', import.meta.url));
let tmp;
let binary;
let web;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-build-'));
  binary = path.join(tmp, 'wisp-built');
  fs.writeFileSync(binary, 'not really a binary', { mode: 0o644 });
  web = path.join(tmp, 'web-dist');
  fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(web, 'assets', 'app.js'), 'export {}');
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const build = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(...p), 'utf8'));

test('--list-targets prints every target with its Rust triple', () => {
  const r = build('--list-targets');
  assert.equal(r.status, 0, r.stderr);
  for (const [t, triple] of Object.entries(TARGETS)) assert.match(r.stdout, new RegExp(`^${t}\\s+${triple}$`, 'm'));
  assert.match(r.stdout, /linux-arm\s+armv7-unknown-linux-musleabihf/);
});

test('builds a platform package and the launcher with one version everywhere', () => {
  const out = path.join(tmp, 'out');
  const r = build('--target', 'linux-arm64', '--binary', binary, '--web', web, '--out', out, '--version', '2.3.4');
  assert.equal(r.status, 0, r.stderr);

  const plat = readJson(out, 'core-linux-arm64', 'package.json');
  assert.equal(plat.name, '@wisp/core-linux-arm64');
  assert.equal(plat.version, '2.3.4');
  assert.deepEqual(plat.os, ['linux']);
  assert.deepEqual(plat.cpu, ['arm64']);
  assert.deepEqual(plat.files, ['bin']);
  assert.equal(plat.preferUnplugged, true);
  assert.ok(!JSON.stringify(plat).includes('${'), 'no placeholder left');

  const bin = path.join(out, 'core-linux-arm64', 'bin', 'wisp');
  assert.equal(fs.readFileSync(bin, 'utf8'), 'not really a binary');
  if (process.platform !== 'win32') assert.equal(fs.statSync(bin).mode & 0o777, 0o755);

  const launcher = readJson(out, 'wisp-agents', 'package.json');
  assert.equal(launcher.version, '2.3.4');
  assert.equal(launcher.dependencies, undefined);
  const expected = Object.keys(TARGETS).map((t) => `@wisp/core-${t}`).sort();
  assert.deepEqual(Object.keys(launcher.optionalDependencies).sort(), expected);
  for (const v of Object.values(launcher.optionalDependencies)) assert.equal(v, '2.3.4');

  for (const f of ['bin/wisp.js', 'lib/resolve.js', 'client.js', 'client.d.ts', 'web/index.html', 'web/assets/app.js']) {
    assert.ok(fs.existsSync(path.join(out, 'wisp-agents', f)), f);
  }
});

test('a win32 target gets bin/wisp.exe', () => {
  const out = path.join(tmp, 'out-win');
  const r = build('--target', 'win32-x64', '--binary', binary, '--out', out);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(out, 'core-win32-x64', 'bin', 'wisp.exe')));
  const version = readJson(fileURLToPath(new URL('../wisp-agents/package.json', import.meta.url))).version;
  assert.equal(readJson(out, 'core-win32-x64', 'package.json').version, version, 'defaults to the launcher version');
  assert.ok(!fs.existsSync(path.join(out, 'wisp-agents', 'web')), 'no --web, no web/');
});

test('refuses an unknown target and lists the supported ones', () => {
  const r = build('--target', 'plan9-mips', '--binary', binary, '--out', path.join(tmp, 'x'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown target "plan9-mips"/);
  assert.match(r.stderr, /darwin-arm64/);
});

test('refuses a missing binary with the build command', () => {
  const r = build('--target', 'darwin-arm64', '--binary', path.join(tmp, 'missing'), '--out', path.join(tmp, 'x'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /does not exist/);
  assert.match(r.stderr, /aarch64-apple-darwin/);
  assert.ok(!fs.existsSync(path.join(tmp, 'x')), 'nothing written');
});

test('refuses a bad version', () => {
  const r = build('--target', 'darwin-x64', '--binary', binary, '--version', 'two', '--out', path.join(tmp, 'x'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /semver/);
});
