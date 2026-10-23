// Update check: polls the npm registry for a newer wisp-agents and, when asked, installs it and
// relaunches wisp. How depends on how this copy was installed:
//   global  npm install -g wisp-agents@latest (also what install.sh does), then rerun bin/wisp.js
//   npx     nothing to install: relaunch through `npx -y wisp-agents@latest`
//   brew    brew upgrade m0xoo/tap/wisp-agents, then rerun it from the keg's opt/ link
//   app     the desktop app from GitHub Releases (wisp.app, the Windows installer, the AppImage):
//           downloads the new build from the latest release, swaps it in and reopens it
//   git     a clone of the repo, i.e. working on wisp itself: never offers an update
// The channel (Settings → General → Updates) picks which releases count: stable (npm `latest`, the
// latest GitHub release), beta (also npm `next` and prereleases like 0.38.0-beta.1) or nightly (also
// npm `nightly` and the rolling `nightly` release built from main every night). The newest of
// those wins, so a beta or nightly gives way to the stable release that follows it. Homebrew only
// has stable releases. Opt out with WISP_UPDATE_CHECK=0.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bad } from './util.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const REGISTRY = `https://registry.npmjs.org/-/package/${PKG.name}/dist-tags`;
const DAY = 24 * 3600_000;
const TICK = 30 * 60_000; // timers stall while the machine sleeps, so poll the wall clock instead
const TAP = 'm0xoo/tap/wisp-agents';
// <prefix>/Cellar/wisp-agents/<version>/libexec/lib/node_modules/wisp-agents
const CELLAR = /^(.*)[\\/]Cellar[\\/]wisp-agents[\\/]/;
// The desktop app keeps wisp's files unpacked in wisp.app/Contents/Resources/app (resources\app on
// Windows and Linux). Releases name their downloads without a version, see packaging/desktop.
const PACKAGED = /[\\/](Contents[\\/]Resources|resources)[\\/]app$/;
const RELEASES = 'https://api.github.com/repos/M0xoo/wisp/releases';
export const DOWNLOADS = 'https://github.com/M0xoo/wisp/releases/latest';

// Which npm dist-tags each channel follows; the rolling GitHub release `nightly` goes with the last.
export const CHANNELS = { stable: ['latest'], beta: ['latest', 'next'], nightly: ['latest', 'next', 'nightly'] };
export const channelOf = (c) => (Object.hasOwn(CHANNELS, c) ? c : 'stable');

// Semver order, prereleases included: 0.38.0-beta.1 < 0.38.0-beta.2 < 0.38.0-nightly.20261024.317
// < 0.38.0. Numeric identifiers compare as numbers and sort before words; build metadata (+…) is ignored.
export function newer(a, b) {
  const p = (v) => {
    const [core, ...pre] = String(v || '').replace(/^v/, '').split('+')[0].split('-');
    return [core.split('.').map(Number), pre.length ? pre.join('-').split('.') : []];
  };
  const [[x, xp], [y, yp]] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  if (!xp.length || !yp.length) return !xp.length && !!yp.length; // a release beats its prereleases
  for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
    const [s, t] = [xp[i], yp[i]];
    if (s === t) continue;
    if (s === undefined || t === undefined) return t === undefined; // more identifiers sort later
    const [m, n] = [/^\d+$/.test(s), /^\d+$/.test(t)];
    if (m && n) return Number(s) > Number(t);
    if (m !== n) return n; // numbers sort before words
    return s > t;
  }
  return false;
}

const newest = (versions) => versions.filter(Boolean).reduce((best, v) => (!best || newer(v, best) ? v : best), null);
// The rolling nightly release is tagged `nightly`; its title carries the version ("wisp 0.38.0-nightly.…").
const releaseVersion = (r) => (r.tag_name === 'nightly' ? String(r.name || '').match(/\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?/)?.[0] : String(r.tag_name || '').replace(/^v/, ''));

export function installMethod(root = ROOT) {
  if (CELLAR.test(root)) return 'brew';
  if (PACKAGED.test(root)) return 'app';
  if (fs.existsSync(path.join(root, '.git'))) return 'git';
  if (/[\\/]_npx[\\/]/.test(root)) return 'npx';
  return 'global';
}

export class Updater {
  constructor({ port, onChange = () => {}, env = process.env, fetch = globalThis.fetch, now = Date.now, root = ROOT, platform = process.platform, arch = process.arch, channel = () => 'stable' } = {}) {
    this.port = port;
    this.channelPref = channel;
    this.onChange = onChange;
    this.fetch = fetch;
    this.now = now;
    this.checkedAt = -Infinity;
    this.root = root;
    this.method = installMethod(root);
    this.platform = platform;
    this.arch = arch;
    this.env = env;
    this.asset = null; // app: the latest release's download for this OS and CPU
    this.release = null; // app: that release's page
    this.tag = 'latest'; // npm: the dist-tag that has the version on offer
    this.swap = null; // app: what the relaunch has to finish once this process is gone
    this.brew = root.match(CELLAR)?.[1]; // Homebrew's prefix, e.g. /opt/homebrew
    this.enabled = this.method !== 'git' && !/^(0|false|no|off)$/i.test(env.WISP_UPDATE_CHECK || '') && !env.CI;
    this.state = { current: PKG.version, latest: null, available: false, method: this.method, channel: this.channel(), status: 'idle', error: null };
  }

  start() {
    if (!this.enabled) return;
    setTimeout(() => this.check(), 5000).unref();
    setInterval(() => this.maybeCheck(), TICK).unref();
  }

  // At most once a day, however long wisp stays open (or asleep). Callers fire and forget:
  // a new version reaches the UI through onChange.
  maybeCheck() {
    if (this.enabled && this.now() - this.checkedAt >= DAY) this.check();
  }

  // Homebrew's tap only follows stable releases.
  channel() {
    return this.method === 'brew' ? 'stable' : channelOf(this.channelPref());
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.onChange(this.view());
  }

  view() {
    return { ...this.state, channel: this.channel(), enabled: this.enabled, command: this.command() };
  }

  // What installs the latest version; shown to copy if it fails. A clone has none.
  command() {
    if (this.method === 'brew') return `${JSON.stringify(path.join(this.brew, 'bin', 'brew'))} upgrade ${TAP}`;
    if (this.method === 'app') return this.release || DOWNLOADS;
    return { global: `npm install -g ${PKG.name}@${this.tag}`, npx: `npx -y ${PKG.name}@${this.tag}` }[this.method];
  }

  // Where the updated copy lives: the same folder, except Homebrew puts each version in its own
  // keg and keeps opt/wisp-agents pointing at the current one.
  home() {
    if (this.method !== 'brew') return this.root;
    return path.join(this.brew, 'opt', 'wisp-agents', 'libexec', 'lib', 'node_modules', PKG.name);
  }

  async check() {
    this.checkedAt = this.now();
    const channel = this.channel();
    try {
      const app = this.method === 'app';
      // The app follows GitHub Releases: a release is published once all its downloads are up.
      // Stable asks for the latest one; the other channels look through the newest few.
      const url = !app ? REGISTRY : channel === 'stable' ? `${RELEASES}/latest` : `${RELEASES}?per_page=30`;
      const r = await this.fetch(url, { headers: { accept: app ? 'application/vnd.github+json' : 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return this.view();
      const body = await r.json();
      let version;
      if (app) {
        const ok = (x) => !x.draft && (channel === 'nightly' || (channel === 'beta' ? x.tag_name !== 'nightly' : !x.prerelease));
        const list = (Array.isArray(body) ? body : [body]).filter(ok);
        version = newest(list.map(releaseVersion));
        const pick = list.find((x) => releaseVersion(x) === version);
        this.asset = pick?.assets?.find((a) => a.name === this.assetName()) || null;
        this.release = channel === 'stable' ? null : pick?.html_url || null;
      } else {
        version = newest(CHANNELS[channel].map((t) => body[t]));
        this.tag = CHANNELS[channel].find((t) => body[t] === version) || 'latest';
      }
      const available = this.method !== 'git' && !!version && newer(version, PKG.version);
      if (version !== this.state.latest || available !== this.state.available || channel !== this.state.channel) this.set({ latest: version, available, channel });
    } catch {} // offline: try again next round
    return this.view();
  }

  // Installs (npm or brew; npx fetches on relaunch) then hands off to a detached helper that waits
  // for this server's port to free up and starts the new version. The caller shuts this process down.
  async install() {
    if (this.method === 'git') throw bad('This copy of wisp is a git clone, so it does not update itself.');
    if (this.state.status === 'installing') throw bad('Already updating.', 409);
    this.set({ status: 'installing', error: null });
    try {
      if (this.method === 'app') await this.fetchApp();
      else if (this.method !== 'npx') {
        // Old kegs stay until brew's own periodic cleanup: this process still runs from one.
        await run(this.command(), this.method === 'brew' ? { HOMEBREW_NO_INSTALL_CLEANUP: '1' } : {});
        // Relaunching a copy that didn't change would leave the UI waiting for a version that never comes.
        const got = installedVersion(this.home());
        if (!newer(got, PKG.version)) {
          throw bad(this.method === 'brew' ? `Homebrew doesn't have wisp ${this.state.latest} yet. Try again later.` : `npm installed wisp somewhere else: this copy is still ${got || PKG.version}.`);
        }
      }
    } catch (err) {
      this.set({ status: 'idle', error: err.message });
      throw err;
    }
    handOff(this.port, this.relaunchCommand());
    this.set({ status: 'restarting' });
  }

  // The release download for this copy of the app. A .deb (no $APPIMAGE) updates through apt or a new
  // .deb, so it gets none and the update says where to download.
  assetName() {
    const arch = this.arch === 'arm64' ? 'arm64' : 'x64';
    if (this.platform === 'darwin') return `wisp-mac-${arch}.zip`;
    if (this.platform === 'win32') return `wisp-windows-${arch}-setup.exe`;
    if (this.platform === 'linux' && this.env.APPIMAGE) return `wisp-linux-${arch}.AppImage`;
    return null;
  }

  // Downloads the new build, checks it against the release's sha256 and gets it ready to replace
  // this one. The swap of a running macOS bundle is a rename (the running app keeps its files); the
  // old one is deleted and the new one opened by the relaunch, once this process has quit.
  async fetchApp() {
    const later = `Download it from ${this.release || DOWNLOADS}`;
    if (!this.asset) throw bad(`There's no automatic update for this copy of wisp. ${later}`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-update-'));
    const file = path.join(dir, this.asset.name);
    const r = await this.fetch(this.asset.browser_download_url, { signal: AbortSignal.timeout(15 * 60_000) });
    if (!r.ok) throw bad(`Couldn't download ${this.asset.name} (HTTP ${r.status}). ${later}`);
    const data = Buffer.from(await r.arrayBuffer());
    const want = String(this.asset.digest || '').replace(/^sha256:/, '');
    if (want && createHash('sha256').update(data).digest('hex') !== want) throw bad(`${this.asset.name} didn't match the release's checksum. ${later}`);
    fs.writeFileSync(file, data);
    if (this.platform === 'darwin') {
      const bundle = path.resolve(this.root, '../../..'); // …/wisp.app/Contents/Resources/app
      await run(`/usr/bin/ditto -xk ${JSON.stringify(file)} ${JSON.stringify(dir)}`);
      const fresh = path.join(dir, 'wisp.app'); // the zip's name, even if this copy was renamed
      if (!newer(installedVersion(path.join(fresh, 'Contents/Resources/app')), PKG.version)) throw bad(`The download isn't newer than wisp ${PKG.version}. ${later}`);
      const old = path.join(dir, 'old.app');
      try {
        fs.renameSync(bundle, old);
      } catch {
        throw bad(`wisp can't replace itself in ${path.dirname(bundle)} (no permission). ${later}`);
      }
      try {
        fs.renameSync(fresh, bundle);
      } catch (err) {
        fs.renameSync(old, bundle);
        throw bad(`Couldn't put the new wisp in place: ${err.message}. ${later}`);
      }
      this.swap = { open: bundle, remove: old };
    } else if (this.platform === 'win32') {
      this.swap = { installer: file }; // runs once wisp has quit, so it can replace the files
    } else {
      const image = this.env.APPIMAGE;
      const next = `${image}.new`;
      try {
        fs.copyFileSync(file, next);
        fs.chmodSync(next, 0o755);
        fs.renameSync(next, image); // the running AppImage stays mounted from the old file
      } catch {
        fs.rmSync(next, { force: true });
        throw bad(`wisp can't replace ${image} (no permission). ${later}`);
      }
      this.swap = { open: image };
    }
  }

  // Same port as now (wisp may have been started with --port), so the open tab finds it again.
  relaunchCommand(electron = !!process.versions.electron) {
    if (this.method === 'app') {
      const q = (p) => `"${p}"`; // cmd.exe takes no JSON escapes
      const { open, remove, installer } = this.swap || {};
      // NSIS: /S installs silently over this copy, --force-run starts the new one.
      if (this.platform === 'win32') return `${q(installer)} /S --force-run`;
      if (this.platform === 'darwin') return `rm -rf ${q(remove)}; open ${q(open)}`;
      return `${q(open)} >/dev/null 2>&1`;
    }
    const args = `${electron ? '' : ' --browser --no-open'} --port ${this.port}`; // desktop: reopen the app; browser: keep the tab
    const node = JSON.stringify(electron ? 'node' : process.execPath);
    return this.method === 'npx' ? `npx -y ${PKG.name}@${this.tag}${args}` : `${node} ${JSON.stringify(path.join(this.home(), 'bin', 'wisp.js'))}${args}`;
  }
}

function installedVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

function run(cmd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...withoutElectronNode(), ...env } });
    let err = '';
    child.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      const hint = /EACCES|permission denied/i.test(err) ? ' (permission denied — run it yourself, maybe with sudo)' : '';
      reject(bad(`\`${cmd}\` failed${hint}: ${err.trim().split('\n').slice(-3).join(' ')}`));
    });
  });
}

// Electron's binary only acts as node with this set; never leak it into the relaunched app.
function withoutElectronNode() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

const WAITER = `
const net = require('node:net'), { spawn } = require('node:child_process');
const [port, cmd] = process.argv.slice(1);
delete process.env.ELECTRON_RUN_AS_NODE;
const start = Date.now();
(function poll() {
  const s = net.connect(Number(port), '127.0.0.1');
  s.once('connect', () => (s.destroy(), Date.now() - start < 60000 ? setTimeout(poll, 300) : process.exit(1)));
  s.once('error', () => (spawn(cmd, { shell: true, detached: true, stdio: 'ignore' }).unref(), setTimeout(() => process.exit(0), 500)));
})();`;

function handOff(port, cmd) {
  const electron = process.versions.electron;
  const env = electron ? { ...withoutElectronNode(), ELECTRON_RUN_AS_NODE: '1' } : process.env;
  const child = spawn(process.execPath, ['-e', WAITER, String(port), cmd], { detached: true, stdio: 'ignore', env });
  child.unref();
}
