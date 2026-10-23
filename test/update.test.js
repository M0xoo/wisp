// Update check helpers: version comparison, install detection, and the relaunch hand-off.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { newer, installMethod, Updater } from '../server/update.js';
import { tmp } from './helpers.js';

test('newer compares major.minor.patch numerically', () => {
  assert.equal(newer('0.7.0', '0.6.0'), true);
  assert.equal(newer('0.10.0', '0.9.9'), true);
  assert.equal(newer('1.0.0', '0.99.99'), true);
  assert.equal(newer('0.6.0', '0.6.0'), false);
  assert.equal(newer('0.5.9', '0.6.0'), false);
  assert.equal(newer('v0.6.1', '0.6.0'), true);
});

test('newer orders prereleases the semver way: before their release, after the one before', () => {
  const order = ['0.37.0', '0.38.0-beta.1', '0.38.0-beta.2', '0.38.0-beta.10', '0.38.0-nightly.20261024.317', '0.38.0-nightly.20261024.1200', '0.38.0-nightly.20261025.317', '0.38.0', '0.38.1-nightly.20261026.317'];
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) assert.equal(newer(order[i], order[j]), i > j, `${order[i]} vs ${order[j]}`);
  }
  assert.equal(newer('1.0.0-alpha.1', '1.0.0-alpha'), true); // more identifiers sort later
  assert.equal(newer('1.0.0-alpha.beta', '1.0.0-alpha.1'), true); // words after numbers
  assert.equal(newer('1.0.0+build.2', '1.0.0+build.1'), false); // build metadata doesn't count
  assert.equal(newer(null, '0.1.0'), false);
});

const tags = (t) => async () => ({ ok: true, json: async () => t });

test('npm installs follow the dist-tags of their channel, and the newest of them wins', async () => {
  const dist = { latest: '0.37.0', next: '0.38.0-beta.1', nightly: '0.38.0-nightly.20261024.317' };
  const cases = [
    ['stable', '0.37.0', 'latest'],
    ['beta', '0.38.0-beta.1', 'next'],
    ['nightly', '0.38.0-nightly.20261024.317', 'nightly'],
    ['bogus', '0.37.0', 'latest'], // unknown: stable
  ];
  for (const [channel, latest, tag] of cases) {
    const u = new Updater({ port: 1, env: {}, root: tmp('upd-global'), fetch: tags(dist), channel: () => channel });
    const v = await u.check();
    assert.equal(v.latest, latest, channel);
    assert.equal(v.channel, channel === 'bogus' ? 'stable' : channel);
    assert.equal(v.command, `npm install -g wisp-agents@${tag}`);
  }
  // A stable release newer than the last beta: beta takes it, from latest.
  const u = new Updater({ port: 1, env: {}, root: tmp('upd-global'), fetch: tags({ latest: '0.38.0', next: '0.38.0-beta.3' }), channel: () => 'beta' });
  assert.equal((await u.check()).latest, '0.38.0');
  assert.equal(u.command(), 'npm install -g wisp-agents@latest');
  u.method = 'npx';
  assert.match(u.relaunchCommand(false), /^npx -y wisp-agents@latest /);
});

test('Homebrew stays on stable whatever the channel says', async () => {
  const u = new Updater({ port: 1, env: {}, root: KEG('/opt/homebrew'), fetch: tags({ latest: '0.37.0', nightly: '99.0.0-nightly.1' }), channel: () => 'nightly' });
  const v = await u.check();
  assert.equal(v.channel, 'stable');
  assert.equal(v.latest, '0.37.0');
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
  const fetch = async () => ({ ok: true, json: async () => ({ latest: '99.0.0' }) });
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
  const fetch = async () => (calls++, { ok: true, json: async () => ({ latest: '99.0.0' }) });
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

test('the app on beta or nightly picks the newest release its channel allows, nightly by its title', async () => {
  const asset = (v) => [{ name: 'wisp-mac-arm64.zip', browser_download_url: `https://dl/${v}/wisp-mac-arm64.zip` }];
  const list = [
    { tag_name: 'nightly', name: 'wisp 99.1.0-nightly.20261024.317', prerelease: true, html_url: 'https://github.com/M0xoo/wisp/releases/tag/nightly', assets: asset('nightly') },
    { tag_name: 'v99.1.0-beta.1', name: 'v99.1.0-beta.1', prerelease: true, html_url: 'https://github.com/M0xoo/wisp/releases/tag/v99.1.0-beta.1', assets: asset('beta') },
    { tag_name: 'v99.2.0-beta.1', name: 'v99.2.0-beta.1', draft: true, prerelease: true, assets: asset('draft') },
    { tag_name: 'v99.0.0', name: 'v99.0.0', prerelease: false, html_url: 'https://github.com/M0xoo/wisp/releases/tag/v99.0.0', assets: asset('stable') },
  ];
  const urls = [];
  const fetch = async (url) => (urls.push(url), { ok: true, json: async () => list });
  for (const [channel, latest, from] of [['beta', '99.1.0-beta.1', 'beta'], ['nightly', '99.1.0-nightly.20261024.317', 'nightly']]) {
    const u = new Updater({ port: 1, env: {}, platform: 'darwin', arch: 'arm64', root: APP('darwin'), fetch, channel: () => channel });
    const v = await u.check();
    assert.equal(v.latest, latest, channel);
    assert.equal(u.asset.browser_download_url, `https://dl/${from}/wisp-mac-arm64.zip`);
    assert.equal(v.command, list.find((r) => r.assets.includes(u.asset)).html_url);
  }
  assert.ok(urls.every((u) => u === 'https://api.github.com/repos/M0xoo/wisp/releases?per_page=30'));
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
  // Windows has no exec bits: chmod there only toggles read-only, so the mode can't show 0o755
  if (process.platform !== 'win32') assert.equal(fs.statSync(image).mode & 0o111, 0o111);
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
