// Packaging the Tauri app (desktop/scripts): what can hold without a build. qa/install.mjs runs the
// real artefacts. Electron stays what users get, so a good part of this checks it stays that way.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { tmp } from './helpers.js';
import { NODE_VERSION, TARGETS, fetchNode, hostTarget } from '../desktop/scripts/fetch-node.mjs';
import { ENTITLEMENTS, appFiles, artefacts, overlay, signArgs, stage } from '../desktop/scripts/package.mjs';
import { Updater, installMethod } from '../server/update.js';

const ROOT = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const MAC = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
const WIN = ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc'];

test('fetch-node pins an official build with a sha256 for each target, and Linux has none', () => {
  assert.match(NODE_VERSION, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(TARGETS).sort(), [...MAC, ...WIN].sort());
  for (const t of Object.values(TARGETS)) assert.match(t.sha256, /^[0-9a-f]{64}$/);
  assert.equal(hostTarget('darwin', 'arm64'), MAC[0]);
  assert.equal(hostTarget('win32', 'x64'), WIN[0]);
  assert.throws(() => hostTarget('linux', 'x64'), /stays on Electron/);
});

// A stand-in for nodejs.org: the same path, one archive laid out as the official one.
async function fakeDist(t) {
  const dir = tmp('node-dist');
  const stem = 'node-v9.9.9-test';
  fs.mkdirSync(path.join(dir, stem, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, stem, 'bin/node'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, stem, 'bin/npm'), 'not wanted');
  fs.writeFileSync(path.join(dir, stem, 'LICENSE'), 'MIT');
  execFileSync('tar', ['-czf', 'a.tgz', stem], { cwd: dir });
  const body = fs.readFileSync(path.join(dir, 'a.tgz'));
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    assert.equal(req.url, `/v9.9.9/${stem}.tar.gz`);
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${server.address().port}`, sha256: createHash('sha256').update(body).digest('hex'), hits: () => hits };
}

test('fetch-node refuses an archive that isn’t the pinned one', { skip: process.platform === 'win32' }, async (t) => {
  const { base } = await fakeDist(t);
  const [dest, cache] = [path.join(tmp('node-dest'), 'node'), tmp('node-cache')];
  const targets = { x: { name: 'test', ext: 'tar.gz', sha256: '0'.repeat(64) } };
  await assert.rejects(fetchNode('x', dest, { base, version: '9.9.9', targets, cache }), /doesn't match its pinned sha256/);
  assert.ok(!fs.existsSync(dest));
  assert.deepEqual(fs.readdirSync(cache), [], 'a bad download is not kept');
  await assert.rejects(fetchNode('nope', dest, { base, targets }), /no pinned Node for nope/);
});

test('fetch-node leaves bin/node executable and LICENSE beside it, npm behind, and reuses its download', { skip: process.platform === 'win32' }, async (t) => {
  const { base, sha256, hits } = await fakeDist(t);
  const [dest, cache] = [path.join(tmp('node-dest'), 'node'), tmp('node-cache')];
  const targets = { x: { name: 'test', ext: 'tar.gz', sha256 } };
  for (let i = 0; i < 2; i++) {
    assert.equal(await fetchNode('x', dest, { base, version: '9.9.9', targets, cache }), path.join(dest, 'bin/node'));
    assert.equal(fs.statSync(path.join(dest, 'bin/node')).mode & 0o111, 0o111);
    assert.deepEqual(fs.readdirSync(path.join(dest, 'bin')), ['node']);
    assert.equal(fs.readFileSync(path.join(dest, 'LICENSE'), 'utf8'), 'MIT');
  }
  assert.equal(hits(), 1);
});

test('the app holds what electron-builder’s does, plus the Node side of the shell', () => {
  const files = appFiles();
  const yml = read('packaging/desktop/electron-builder.yml');
  const list = yml.slice(yml.indexOf('files:'), yml.indexOf('asar:')).matchAll(/^ {2}- ([\w.-]+?)(\/\*\*)?\r?$/gm);
  for (const [, f] of list) assert.ok(files.includes(f), `${f} is in electron-builder.yml`);
  assert.ok(files.includes('desktop/entry.mjs'));
  assert.ok(!JSON.parse(read('package.json')).files.some((f) => f.startsWith('desktop')), 'desktop/ is not on npm');
});

test('stage copies wisp’s files and leaves node_modules out', () => {
  const root = tmp('stage-root');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ files: ['bin/', 'CHANGELOG.md'] }));
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# log');
  fs.mkdirSync(path.join(root, 'bin/node_modules/x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin/wisp.js'), '//');
  fs.mkdirSync(path.join(root, 'desktop'));
  fs.writeFileSync(path.join(root, 'desktop/entry.mjs'), '//');
  fs.writeFileSync(path.join(root, 'desktop/other.mjs'), '//');
  const dest = stage(root, path.join(tmp('stage'), 'app'));
  assert.ok(fs.existsSync(path.join(dest, 'bin/wisp.js')));
  assert.ok(fs.existsSync(path.join(dest, 'CHANGELOG.md')));
  assert.ok(fs.existsSync(path.join(dest, 'desktop/entry.mjs')));
  assert.ok(!fs.existsSync(path.join(dest, 'desktop/other.mjs')));
  assert.ok(!fs.existsSync(path.join(dest, 'bin/node_modules')));
});

test('resources land where the shell and the updater look, on each OS', () => {
  const conf = JSON.parse(read('desktop/src-tauri/tauri.conf.json'));
  assert.equal(conf.bundle.resources, undefined, 'in tauri.conf.json they would break cargo check: no stage/ there');
  for (const t of MAC) {
    const { bundle } = overlay(t);
    assert.deepEqual(bundle.resources, { 'stage/app/': 'app/', 'stage/node/': 'node/' });
    assert.equal(installMethod(`/Applications/wisp.app/Contents/Resources/${bundle.resources['stage/app/']}`.replace(/\/$/, '')), 'app');
  }
  for (const t of WIN) {
    const { bundle } = overlay(t);
    // resource_dir on Windows is the exe's folder: `app` alone would read as an npm install.
    assert.equal(installMethod('C:\\Users\\u\\AppData\\Local\\wisp\\app'), 'global');
    assert.equal(installMethod(`C:\\Users\\u\\AppData\\Local\\wisp\\${bundle.resources['stage/app/'].replace(/\/$/, '').replace('/', '\\')}`), 'app');
    assert.equal(bundle.resources['stage/node/'], 'node/');
    assert.equal(bundle.windows.nsis.installMode, 'currentUser', 'the updater replaces it without admin rights');
  }
});

test('artefacts keep electron-builder’s names, the ones the updater, install.sh and the site ask for', () => {
  const update = (platform, arch) => new Updater({ port: 1, env: {}, platform, arch, root: tmp('upd') }).assetName();
  assert.deepEqual(artefacts(MAC[0]), ['wisp-mac-arm64.dmg', 'wisp-mac-arm64.zip']);
  assert.deepEqual(artefacts(MAC[1]), ['wisp-mac-x64.dmg', 'wisp-mac-x64.zip']);
  assert.deepEqual(artefacts(WIN[0]), ['wisp-windows-x64-setup.exe']);
  assert.deepEqual(artefacts(WIN[1]), ['wisp-windows-arm64-setup.exe']);
  assert.ok(artefacts(MAC[0]).includes(update('darwin', 'arm64')));
  assert.ok(artefacts(MAC[1]).includes(update('darwin', 'x64')));
  assert.ok(artefacts(WIN[0]).includes(update('win32', 'x64')));
  assert.ok(artefacts(WIN[1]).includes(update('win32', 'arm64')));
  const yml = read('packaging/desktop/electron-builder.yml');
  assert.match(yml, /artifactName: wisp-mac-\$\{arch\}\.\$\{ext\}/);
  assert.match(yml, /artifactName: wisp-windows-\$\{arch\}-setup\.\$\{ext\}/);
  assert.match(read('docs/install.sh'), /zip="wisp-mac-\$arch\.zip"/);
});

test('bundled Node is signed with the entitlements it needs under the hardened runtime', () => {
  const plist = fs.readFileSync(ENTITLEMENTS, 'utf8');
  for (const key of ['allow-jit', 'allow-unsigned-executable-memory', 'disable-library-validation']) assert.match(plist, new RegExp(`com\\.apple\\.security\\.cs\\.${key}</key>\\s*<true/>`));
  const args = signArgs('/x/node');
  assert.deepEqual(args.slice(args.indexOf('--options'), args.indexOf('--options') + 2), ['--options', 'runtime']);
  assert.equal(args[args.indexOf('--entitlements') + 1], ENTITLEMENTS);
  assert.equal(args[args.indexOf('--sign') + 1], '-');
});

test('Tauri is a dry run’s extra: released nowhere, and nothing waits for it', () => {
  const wf = read('.github/workflows/release.yml');
  const job = wf.slice(wf.indexOf('\n  tauri:\n'), wf.indexOf('\n  release:\n'));
  assert.match(job, /needs: plan\r?\n\s+if: needs\.plan\.outputs\.dry == 'true'/);
  assert.match(job, /uses: \.\/\.github\/workflows\/tauri-package\.yml/);
  for (const line of wf.match(/^\s+needs:.*$/gm)) assert.ok(!/\btauri\b/.test(line), line);
  const pack = read('.github/workflows/tauri-package.yml');
  assert.deepEqual(pack.match(/^on:\r?\n {2}(\w+):/m).slice(1), ['workflow_call'], 'it can’t start on its own');
  for (const [, name] of pack.matchAll(/name: (tauri-[\w-]+)/g)) assert.ok(!name.startsWith('desktop-'), name);
  assert.ok(!/npm publish|gh release|environment:/.test(pack));
  assert.match(wf, /pattern: desktop-\*/);
});

test('a Tauri window started from npm reopens as an app after an update, not a browser server', () => {
  const env = { WISP_DESKTOP: 'tauri' };
  const u = new Updater({ port: 5123, env, root: tmp('upd-global') });
  delete env.WISP_DESKTOP; // desktop/entry.mjs does this once the server is up, before any update
  assert.equal(u.method, 'global');
  const cmd = u.relaunchCommand();
  assert.ok(!/--browser|--no-open/.test(cmd), cmd);
  assert.ok(cmd.endsWith(' --port 5123'), cmd);
  assert.ok(cmd.startsWith(JSON.stringify(process.execPath)), 'its Node is a real one');
  u.method = 'npx';
  assert.equal(u.relaunchCommand(), 'npx -y wisp-agents@latest --port 5123');
});

test('no shell at all still relaunches as a browser server', () => {
  const u = new Updater({ port: 5123, env: {}, root: tmp('upd-global') });
  assert.match(u.relaunchCommand(), / --browser --no-open --port 5123$/);
});

test('the Windows relaunch restarts either installer', () => {
  const u = new Updater({ port: 1, env: {}, platform: 'win32', arch: 'x64', root: 'C:\\Users\\u\\AppData\\Local\\wisp\\resources\\app' });
  u.swap = { installer: 'C:\\t\\wisp-windows-x64-setup.exe' };
  const cmd = u.relaunchCommand();
  assert.match(cmd, / \/S /, 'silent: NSIS reads this one itself');
  assert.match(cmd, / --force-run\b/, 'electron-builder');
  assert.match(cmd, / \/R$/, 'Tauri: .onInstSuccess in its installer.nsi');
});

test('the Mac update swaps a bundle on the Tauri layout and keeps Node executable', { skip: process.platform !== 'darwin' }, async () => {
  const bundleOf = (dir, version) => {
    const res = path.join(dir, 'wisp.app/Contents/Resources');
    fs.mkdirSync(path.join(res, 'app'), { recursive: true });
    fs.mkdirSync(path.join(res, 'node/bin'), { recursive: true });
    fs.writeFileSync(path.join(res, 'app/package.json'), JSON.stringify({ version }));
    fs.writeFileSync(path.join(res, 'node/bin/node'), version, { mode: 0o755 });
    return res;
  };
  const installed = tmp('tauri-installed');
  const res = bundleOf(installed, '0.0.1');
  const built = tmp('tauri-new');
  bundleOf(built, '99.0.0');
  const zip = path.join(tmp('tauri-zip'), 'wisp-mac-arm64.zip');
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', path.join(built, 'wisp.app'), zip]);
  const body = fs.readFileSync(zip);
  const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
  const list = { tag_name: 'v99.0.0', assets: [{ name: 'wisp-mac-arm64.zip', browser_download_url: 'https://dl/x', digest }] };
  const u = new Updater({ port: 1, env: {}, platform: 'darwin', arch: 'arm64', root: path.join(res, 'app'), fetch: async () => ({ ok: true, json: async () => list }) });
  assert.equal(u.method, 'app');
  await u.check();
  u.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => body });
  await u.fetchApp();
  assert.equal(JSON.parse(fs.readFileSync(path.join(res, 'app/package.json'), 'utf8')).version, '99.0.0');
  assert.equal(fs.readFileSync(path.join(res, 'node/bin/node'), 'utf8'), '99.0.0');
  assert.equal(fs.statSync(path.join(res, 'node/bin/node')).mode & 0o111, 0o111);
  const old = u.swap.remove;
  assert.equal(fs.readFileSync(path.join(old, 'Contents/Resources/node/bin/node'), 'utf8'), '0.0.1', 'the running copy keeps its files');
  assert.equal(u.relaunchCommand(), `rm -rf "${old}"; open "${path.join(installed, 'wisp.app')}"`);
});
