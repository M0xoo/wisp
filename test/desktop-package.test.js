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
import { isElectronFolder, removeLeftover } from '../desktop/remove-electron.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n'); // Windows checkouts
const MAC = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
const WIN = ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc'];
const LINUX = ['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu'];

test('fetch-node pins an official build with a sha256 for each target', () => {
  assert.match(NODE_VERSION, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(TARGETS).sort(), [...MAC, ...WIN, ...LINUX].sort());
  for (const t of Object.values(TARGETS)) assert.match(t.sha256, /^[0-9a-f]{64}$/);
  assert.equal(hostTarget('darwin', 'arm64'), MAC[0]);
  assert.equal(hostTarget('win32', 'x64'), WIN[0]);
  assert.equal(hostTarget('linux', 'x64'), LINUX[0]);
  assert.equal(hostTarget('linux', 'arm64'), LINUX[1]);
  assert.equal(TARGETS[LINUX[0]].name, 'linux-x64');
  assert.equal(TARGETS[LINUX[1]].name, 'linux-arm64');
  assert.throws(() => hostTarget('freebsd', 'x64'), /no Tauri build/);
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
  const list = yml.slice(yml.indexOf('files:'), yml.indexOf('asar:')).matchAll(/^ {2}- ([\w.-]+?)(\/\*\*)?$/gm);
  for (const [, f] of list) assert.ok(files.includes(f), `${f} is in electron-builder.yml`);
  assert.ok(files.includes('desktop/entry.mjs'));
  assert.ok(files.includes('desktop/remove-electron.mjs'), 'the installer runs it from resources\\app\\desktop');
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
  fs.writeFileSync(path.join(root, 'desktop/remove-electron.mjs'), '//');
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
  for (const t of LINUX) {
    const { bundle } = overlay(t);
    assert.deepEqual(bundle.targets, ['appimage', 'deb']);
    // resource_dir is /usr/lib/<productName>, in the AppImage's mount too (tauri-utils platform.rs).
    assert.equal(installMethod(`/usr/lib/wisp/${bundle.resources['stage/app/'].replace(/\/$/, '')}`), 'app');
    assert.equal(installMethod(`/tmp/.mount_wispAb12/usr/lib/wisp/${bundle.resources['stage/app/'].replace(/\/$/, '')}`), 'app');
    assert.equal(bundle.resources['stage/node/'], 'node/');
    assert.equal(bundle.windows, undefined);
  }
  // main.rs looks for the same folder: app on macOS only.
  assert.match(read('desktop/src-tauri/src/main.rs'), /if cfg!\(target_os = "macos"\) \{ "app" \} else \{ "resources\/app" \}/);
});

test('the Windows installer takes Electron’s copy away, from where v0.57.0 really put it', () => {
  for (const t of WIN) assert.equal(overlay(t).bundle.windows.nsis.installerHooks, 'installer-hooks.nsh');
  for (const t of MAC) assert.equal(overlay(t).bundle.windows, undefined);
  assert.ok(fs.existsSync(path.join(ROOT, 'desktop/src-tauri', overlay(WIN[0]).bundle.windows.nsis.installerHooks)));
  const hooks = read('desktop/src-tauri/installer-hooks.nsh');
  // electron-builder names the folder after package.json's name, not the product: read, not assumed.
  assert.ok(hooks.includes(`$LOCALAPPDATA\\Programs\\${JSON.parse(read('package.json')).name}`), 'not the folder electron-builder installs to');
  assert.match(hooks, /_\?=\$\{ELECTRON_COPY\}'/, 'without _?= ExecWait returns before it has finished');
  assert.match(hooks, /--keep-shortcuts/, 'our links have the same names as its');
  assert.match(hooks, /\$INSTDIR != "\$\{ELECTRON_COPY\}"/, 'picked as the install folder, it holds the new app');
  assert.ok(!/RMDir \/r|APPDATA\\wisp|\.wisp/.test(hooks.replace(/^;.*$/gm, '')), 'nothing here may reach user data');
});

test('a folder the update’s cmd.exe still stands in goes once it’s free, by a hidden helper', () => {
  const hooks = read('desktop/src-tauri/installer-hooks.nsh');
  const after = hooks.slice(hooks.indexOf('RMDir "${ELECTRON_COPY}"'));
  assert.match(after, /\$\{If\} \$\{FileExists\} "\$\{ELECTRON_COPY\}\\\*\.\*"/, 'only when the folder is still there');
  assert.match(after, /ExecShell "open" "\$INSTDIR\\node\\node\.exe" '"\$INSTDIR\\resources\\app\\desktop\\remove-electron\.mjs" "\$\{ELECTRON_COPY\}"' SW_HIDE/, 'no window, not waited for');
  assert.ok(after.indexOf('ExecShell') < after.indexOf('RunAsUser'));
});

// electron-builder's per-app GUID: UUID v5 of the appId in its own namespace (NsisTarget.js).
test('the install gate looks for Electron’s registry keys under electron-builder’s GUID for our appId', () => {
  const ns = Buffer.from('50e065bc313411e69bab38c9862bdaf3', 'hex');
  const appId = read('packaging/desktop/electron-builder.yml').match(/^appId: (\S+)$/m)[1];
  const h = createHash('sha1').update(ns).update(appId).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  const guid = `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  assert.ok(read('qa/install.mjs').includes(`\\\\${guid}\``), guid);
});

test('remove-electron.mjs only ever removes Programs\\wisp-agents, once it’s free', async () => {
  assert.ok(isElectronFolder('C:\\Users\\a b\\AppData\\Local\\Programs\\wisp-agents'));
  assert.ok(isElectronFolder('c:\\users\\x\\appdata\\local\\programs\\WISP-AGENTS'));
  for (const bad of ['', undefined, 'C:\\Users\\x\\AppData\\Local\\wisp', 'C:\\Users\\x\\AppData\\Roaming\\wisp-agents', 'C:\\Users\\x', 'C:\\Programs']) assert.equal(isElectronFolder(bad), false, String(bad));
  const calls = [];
  assert.equal(await removeLeftover('C:\\Users\\x\\.wisp', { rm: (d) => calls.push(d), exists: () => false }), false);
  assert.deepEqual(calls, [], 'nothing else is touched');
  let busy = 3;
  const gone = await removeLeftover('C:\\Users\\x\\AppData\\Local\\Programs\\wisp-agents', {
    every: 1,
    rm: (d) => {
      calls.push(d);
      if (busy-- > 0) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    },
    exists: () => busy >= 0,
  });
  assert.equal(gone, true);
  assert.equal(calls.length, 4, 'tried again while it was in use');
  assert.equal(await removeLeftover('C:\\Users\\x\\AppData\\Local\\Programs\\wisp-agents', { tries: 3, every: 1, rm: () => {}, exists: () => true }), false, 'gives up');
});

test('the helper removes a real leftover folder, run as the installer runs it', () => {
  const programs = path.join(tmp('electron-left'), 'Programs');
  const dir = path.join(programs, 'wisp-agents');
  fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'resources/left'), 'x');
  execFileSync(process.execPath, [path.join(ROOT, 'desktop/remove-electron.mjs'), dir]);
  assert.equal(fs.existsSync(dir), false);
  assert.ok(fs.existsSync(programs));
});

test('artefacts keep electron-builder’s names, the ones the updater, install.sh and the site ask for', () => {
  const update = (platform, arch) => new Updater({ port: 1, env: {}, platform, arch, root: tmp('upd') }).assetName();
  assert.deepEqual(artefacts(MAC[0]), ['wisp-mac-arm64.dmg', 'wisp-mac-arm64.zip']);
  assert.deepEqual(artefacts(MAC[1]), ['wisp-mac-x64.dmg', 'wisp-mac-x64.zip']);
  assert.deepEqual(artefacts(WIN[0]), ['wisp-windows-x64-setup.exe']);
  assert.deepEqual(artefacts(WIN[1]), ['wisp-windows-arm64-setup.exe']);
  assert.deepEqual(artefacts(LINUX[0]), ['wisp-linux-x64.AppImage', 'wisp-linux-x64.deb']);
  assert.deepEqual(artefacts(LINUX[1]), ['wisp-linux-arm64.AppImage', 'wisp-linux-arm64.deb']);
  const image = (arch) => new Updater({ port: 1, env: { APPIMAGE: '/x/wisp.AppImage' }, platform: 'linux', arch, root: tmp('upd') }).assetName();
  assert.ok(artefacts(LINUX[0]).includes(image('x64')));
  assert.ok(artefacts(LINUX[1]).includes(image('arm64')));
  assert.equal(update('linux', 'x64'), null, 'a .deb updates by a new .deb');
  assert.ok(artefacts(MAC[0]).includes(update('darwin', 'arm64')));
  assert.ok(artefacts(MAC[1]).includes(update('darwin', 'x64')));
  assert.ok(artefacts(WIN[0]).includes(update('win32', 'x64')));
  assert.ok(artefacts(WIN[1]).includes(update('win32', 'arm64')));
  const yml = read('packaging/desktop/electron-builder.yml');
  assert.match(yml, /artifactName: wisp-mac-\$\{arch\}\.\$\{ext\}/);
  assert.match(yml, /artifactName: wisp-windows-\$\{arch\}-setup\.\$\{ext\}/);
  assert.match(yml, /artifactName: wisp-linux-\$\{arch\}\.\$\{ext\}/);
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
  // The channel too: a nightly's plan says dry=false whatever was ticked, and it must stay out of this.
  assert.match(job, /needs: \[plan, desktop\]\r?\n\s+if: needs\.plan\.outputs\.dry == 'true' && needs\.plan\.outputs\.channel == 'stable'/);
  assert.match(job, /uses: \.\/\.github\/workflows\/tauri-package\.yml/);
  for (const line of wf.match(/^\s+needs:.*$/gm)) assert.ok(!/\btauri\b/.test(line), line);
  const pack = read('.github/workflows/tauri-package.yml');
  assert.deepEqual(pack.match(/^on:\n {2}(\w+):/m).slice(1), ['workflow_call'], 'it can’t start on its own');
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

test('the Windows relaunch says what its own installer knows, and Electron\'s stays as it was', () => {
  const root = 'C:\\Users\\u\\AppData\\Local\\wisp\\resources\\app';
  const cmd = (env) => {
    const u = new Updater({ port: 1, env, platform: 'win32', arch: 'x64', root });
    u.swap = { installer: 'C:\\t\\wisp-windows-x64-setup.exe' };
    return u.relaunchCommand();
  };
  assert.equal(cmd({}), '"C:\\t\\wisp-windows-x64-setup.exe" /S --force-run', 'electron-builder');
  assert.equal(cmd({ WISP_DESKTOP: 'tauri' }), '"C:\\t\\wisp-windows-x64-setup.exe" /S /R', 'Tauri: .onInstSuccess in its installer.nsi');
});

test('the shell is Node for an Electron build finishing its update, first thing and on macOS only', () => {
  // The bundle is swapped before handOff runs process.execPath, which is then this binary.
  const main = read('desktop/src-tauri/src/main.rs');
  assert.match(main, /fn main\(\) \{\r?\n {2}#\[cfg\(target_os = "macos"\)\]\r?\n {2}macos::be_node_for_electron\(\);/);
  assert.match(read('server/update.js'), /spawn\(process\.execPath, \['-e', WAITER/, 'if the hand-off changes, so does this');
  const fn = read('desktop/src-tauri/src/macos.rs');
  assert.match(fn, /var_os\("ELECTRON_RUN_AS_NODE"\)\.is_none\(\)/);
  assert.match(fn, /\.\.\/Resources\/node\/bin\/node/);
});

test('a Tauri app opens the new build only once the old shell, and its lock, are gone', () => {
  const mac = (env) => {
    const u = new Updater({ port: 1, env, platform: 'darwin', arch: 'arm64', root: '/Applications/wisp.app/Contents/Resources/app' });
    u.swap = { open: '/Applications/wisp.app', remove: '/tmp/old.app' };
    return u.relaunchCommand();
  };
  assert.equal(mac({}), 'rm -rf "/tmp/old.app"; open "/Applications/wisp.app"', 'Electron stays as it was');
  const cmd = mac({ WISP_DESKTOP: 'tauri' });
  assert.ok(cmd.indexOf(`kill -0 ${process.ppid}`) > 0 && cmd.indexOf('kill -0') < cmd.indexOf('open "'), cmd);
  assert.match(cmd, /seq 100/, 'and it can\'t wait for ever');
});

test('the shell gives Node a plain Windows path', () => {
  assert.match(read('desktop/src-tauri/src/main.rs'), /strip_prefix\(r"\\\\\?\\"\)/);
});

test('Tauri\'s installer starts the app on the --force-run of builds already out', () => {
  assert.equal(overlay('x86_64-pc-windows-msvc').bundle.windows.nsis.installerHooks, 'installer-hooks.nsh');
  assert.equal(overlay('aarch64-apple-darwin').bundle.windows, undefined);
  const hook = read('desktop/src-tauri/installer-hooks.nsh');
  assert.match(hook, /!macro NSIS_HOOK_POSTINSTALL/);
  assert.match(hook, /GetOptions\} \$CMDLINE "--force-run"/);
  assert.match(hook, /ClearErrors/, 'GetOptions leaves the error flag alone when it finds the word');
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

test('Linux ships: no compile_error! left, and the page is watched where on_navigation can’t tell a frame', () => {
  const main = read('desktop/src-tauri/src/main.rs');
  assert.ok(!/compile_error!/.test(main), 'a release build for Linux must compile');
  assert.match(main, /if cfg!\(target_os = "linux"\) \|\| any_nav\(\) \{\r?\n\s+return true;/, 'frames go through on Linux');
  assert.match(main, /linux::keep_page_home\(&window, base\(port\), app\.clone\(\)\)\?;/);
  const linux = read('desktop/src-tauri/src/linux.rs');
  assert.match(linux, /connect_uri_notify/, 'the main frame’s address, which a frame never moves');
  assert.match(linux, /stop_loading\(\)/);
  assert.match(linux, /connect_load_failed/);
  assert.match(read('desktop/src-tauri/Cargo.toml'), /\[target\.'cfg\(target_os = "linux"\)'\.dependencies\]\r?\nwebkit2gtk = "=2\.0\.2"/, 'pinned to what wry uses');
});

test('the dry run builds and gates Linux on each arch’s own runner', () => {
  const pack = read('.github/workflows/tauri-package.yml');
  const job = pack.slice(pack.indexOf('\n  linux:\n'), pack.indexOf('\n  sizes:\n'));
  assert.match(job, /triple: x86_64-unknown-linux-gnu/);
  assert.match(job, /os: ubuntu-22\.04-arm, triple: aarch64-unknown-linux-gnu/);
  assert.match(job, /package\.mjs --target \$\{\{ matrix\.triple \}\}/);
  assert.match(job, /xvfb-run -a dbus-run-session -- node qa\/install\.mjs --only \$\{\{ matrix\.rows \}\}/);
  assert.match(job, /name: tauri-linux-\$\{\{ matrix\.arch \}\}/);
  assert.match(pack, /needs: \[mac, windows, linux\]/);
});
