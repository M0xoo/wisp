// Update check helpers: version comparison, install detection, and the relaunch hand-off.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { newer, installMethod, Updater } from '../server/update.js';
import { tmp } from './helpers.js';

test('newer compares major.minor.patch numerically and ignores prerelease tags', () => {
  assert.equal(newer('0.7.0', '0.6.0'), true);
  assert.equal(newer('0.10.0', '0.9.9'), true);
  assert.equal(newer('1.0.0', '0.99.99'), true);
  assert.equal(newer('0.6.0', '0.6.0'), false);
  assert.equal(newer('0.5.9', '0.6.0'), false);
  assert.equal(newer('v0.6.1', '0.6.0'), true);
  assert.equal(newer('0.6.0-beta.1', '0.6.0'), false);
});

const KEG = (prefix) => path.join(prefix, 'Cellar/wisp-agents/0.15.0/libexec/lib/node_modules/wisp-agents');

test('installMethod tells a clone, an npx cache, a Homebrew keg and a global install apart', () => {
  const clone = tmp('upd-clone');
  fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
  assert.equal(installMethod(clone), 'git');
  assert.equal(installMethod(path.join('/home/u/.npm/_npx/abc123/node_modules/wisp-agents')), 'npx');
  assert.equal(installMethod(KEG('/opt/homebrew')), 'brew');
  assert.equal(installMethod(KEG('/home/linuxbrew/.linuxbrew')), 'brew');
  assert.equal(installMethod(tmp('upd-global')), 'global');
});

test('a git clone never offers an update, even when npm has a newer one', async () => {
  const clone = tmp('upd-clone');
  fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
  const fetch = async () => ({ ok: true, json: async () => ({ version: '99.0.0' }) });
  const u = new Updater({ port: 1, fetch, env: {}, root: clone });
  assert.equal(u.enabled, false);
  const v = await u.check();
  assert.equal(v.available, false);
  assert.equal(v.command, undefined);
  await assert.rejects(u.install(), { status: 400 });
});

test('maybeCheck hits the registry at most once a day, on the wall clock', async () => {
  let t = 1_000_000;
  let calls = 0;
  const seen = [];
  const fetch = async () => (calls++, { ok: true, json: async () => ({ version: '99.0.0' }) });
  const u = new Updater({ port: 1, fetch, now: () => t, env: {}, root: tmp('upd-global'), onChange: (v) => seen.push(v) });
  u.maybeCheck();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  assert.equal(seen.at(-1).available, true);
  assert.equal(seen.at(-1).latest, '99.0.0');
  t += 23 * 3600_000;
  u.maybeCheck();
  assert.equal(calls, 1);
  t += 3600_000;
  u.maybeCheck();
  assert.equal(calls, 2);
});

test('relaunchCommand keeps the port wisp is serving on', () => {
  const u = new Updater({ port: 5123, env: {}, root: tmp('upd-global') });
  for (const method of ['global', 'npx']) {
    u.method = method;
    assert.match(u.relaunchCommand(false), / --browser --no-open --port 5123$/);
    assert.match(u.relaunchCommand(true), /wisp(-agents@latest|\.js") --port 5123$/);
  }
});

test('Homebrew installs upgrade through brew and relaunch from the opt/ link, not the old keg', () => {
  const u = new Updater({ port: 5123, env: {}, root: KEG('/opt/homebrew') });
  assert.equal(u.method, 'brew');
  assert.equal(u.command(), `${JSON.stringify(path.join('/opt/homebrew', 'bin', 'brew'))} upgrade m0xoo/tap/wisp-agents`);
  const wisp = path.join('/opt/homebrew', 'opt/wisp-agents/libexec/lib/node_modules/wisp-agents', 'bin', 'wisp.js');
  assert.ok(u.relaunchCommand(false).endsWith(`${JSON.stringify(wisp)} --browser --no-open --port 5123`));
});

test('install refuses to relaunch when the install left this copy on the same version', async () => {
  const current = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const brew = tmp('upd-brew');
  const opt = path.join(brew, 'opt/wisp-agents/libexec/lib/node_modules/wisp-agents');
  fs.mkdirSync(opt, { recursive: true });
  fs.writeFileSync(path.join(opt, 'package.json'), JSON.stringify({ version: current })); // the tap hasn't caught up
  const global = tmp('upd-global');
  fs.writeFileSync(path.join(global, 'package.json'), JSON.stringify({ version: current })); // npm put it elsewhere
  for (const [root, why] of [
    [KEG(brew), /Homebrew doesn't have wisp 99\.0\.0 yet/],
    [global, /npm installed wisp somewhere else/],
  ]) {
    const u = new Updater({ port: 1, env: {}, root });
    u.state.latest = '99.0.0';
    u.command = () => 'exit 0';
    await assert.rejects(u.install(), why);
    assert.equal(u.state.status, 'idle');
    assert.match(u.state.error, why);
  }
});

const APP = (os) => ({ darwin: '/Applications/wisp.app/Contents/Resources/app', win32: 'C:\\Users\\u\\AppData\\Local\\Programs\\wisp\\resources\\app', linux: '/tmp/.mount_wispAb12/resources/app' })[os];
const release = (version, assets) => async () => ({ ok: true, json: async () => ({ tag_name: `v${version}`, assets }) });

test('the desktop app from GitHub Releases is its own install method', () => {
  for (const os of ['darwin', 'win32', 'linux']) assert.equal(installMethod(APP(os)), 'app');
  assert.equal(installMethod('/opt/wisp/resources/app'), 'app'); // the .deb
});

test('the app checks GitHub Releases and picks the download for its OS and CPU', async () => {
  const assets = ['wisp-mac-arm64.zip', 'wisp-mac-x64.zip', 'wisp-windows-x64-setup.exe', 'wisp-linux-arm64.AppImage'].map((name) => ({ name, browser_download_url: `https://dl/${name}` }));
  const urls = [];
  const fetch = async (url, opts) => (urls.push(url), release('99.0.0', assets)(url, opts));
  const cases = [
    ['darwin', 'arm64', {}, 'wisp-mac-arm64.zip'],
    ['win32', 'x64', {}, 'wisp-windows-x64-setup.exe'],
    ['linux', 'arm64', { APPIMAGE: '/home/u/wisp.AppImage' }, 'wisp-linux-arm64.AppImage'],
    ['linux', 'x64', {}, undefined], // a .deb: no automatic update
  ];
  for (const [platform, arch, env, name] of cases) {
    const u = new Updater({ port: 1, fetch, env, platform, arch, root: APP(platform) });
    const v = await u.check();
    assert.equal(v.method, 'app');
    assert.equal(v.latest, '99.0.0');
    assert.equal(v.available, true);
    assert.equal(v.command, 'https://github.com/M0xoo/wisp/releases/latest');
    assert.equal(u.asset?.name, name);
  }
  assert.ok(urls.every((u) => u === 'https://api.github.com/repos/M0xoo/wisp/releases/latest'));
});

test('an AppImage update checks the sha256, replaces the file and reopens it', async () => {
  const dir = tmp('upd-appimage');
  const image = path.join(dir, 'wisp.AppImage');
  fs.writeFileSync(image, 'old build');
  const body = Buffer.from('new build');
  const sha = (await import('node:crypto')).createHash('sha256').update(body).digest('hex');
  const asset = (digest) => [{ name: 'wisp-linux-x64.AppImage', browser_download_url: 'https://dl/x', digest }];
  const download = async () => ({ ok: true, arrayBuffer: async () => body });

  const bad = new Updater({ port: 1, env: { APPIMAGE: image }, platform: 'linux', arch: 'x64', root: APP('linux'), fetch: release('99.0.0', asset('sha256:' + '0'.repeat(64))) });
  await bad.check();
  bad.fetch = download;
  await assert.rejects(bad.fetchApp(), /didn't match the release's checksum/);
  assert.equal(fs.readFileSync(image, 'utf8'), 'old build');

  const u = new Updater({ port: 1, env: { APPIMAGE: image }, platform: 'linux', arch: 'x64', root: APP('linux'), fetch: release('99.0.0', asset('sha256:' + sha)) });
  await u.check();
  u.fetch = download;
  await u.fetchApp();
  assert.equal(fs.readFileSync(image, 'utf8'), 'new build');
  assert.equal(fs.statSync(image).mode & 0o111, 0o111);
  assert.equal(u.relaunchCommand(true), `"${image}" >/dev/null 2>&1`);
});

test('the app relaunches through the installer on Windows and open on macOS', () => {
  const win = new Updater({ port: 1, env: {}, platform: 'win32', arch: 'x64', root: APP('win32') });
  win.swap = { installer: 'C:\\Temp\\wisp-update-1\\wisp-windows-x64-setup.exe' };
  assert.equal(win.relaunchCommand(true), '"C:\\Temp\\wisp-update-1\\wisp-windows-x64-setup.exe" /S --force-run');
  const mac = new Updater({ port: 1, env: {}, platform: 'darwin', arch: 'arm64', root: APP('darwin') });
  mac.swap = { open: '/Applications/wisp.app', remove: '/tmp/wisp-update-1/old.app' };
  assert.equal(mac.relaunchCommand(true), 'rm -rf "/tmp/wisp-update-1/old.app"; open "/Applications/wisp.app"');
});

test('an app with no download for it says where to get the new version', async () => {
  const u = new Updater({ port: 1, env: {}, platform: 'linux', arch: 'x64', root: '/opt/wisp/resources/app', fetch: release('99.0.0', []) });
  await u.check();
  await assert.rejects(u.fetchApp(), /no automatic update.*releases\/latest/);
});
