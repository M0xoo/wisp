// Update check: polls the npm registry for a newer wisp-agents and, when asked, installs it and
// relaunches wisp. How depends on how this copy was installed:
//   global  npm install -g wisp-agents@latest (also what install.sh does), then rerun bin/wisp.js
//   npx     nothing to install: relaunch through `npx -y wisp-agents@latest`
//   brew    brew upgrade m0xoo/tap/wisp-agents, then rerun it from the keg's opt/ link
//   git     a clone of the repo, i.e. working on wisp itself: never offers an update
// Opt out with WISP_UPDATE_CHECK=0.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bad } from './util.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const REGISTRY = `https://registry.npmjs.org/${PKG.name}/latest`;
const DAY = 24 * 3600_000;
const TICK = 30 * 60_000; // timers stall while the machine sleeps, so poll the wall clock instead
const TAP = 'm0xoo/tap/wisp-agents';
// <prefix>/Cellar/wisp-agents/<version>/libexec/lib/node_modules/wisp-agents
const CELLAR = /^(.*)[\\/]Cellar[\\/]wisp-agents[\\/]/;

export function newer(a, b) {
  const p = (v) => String(v).replace(/^v/, '').split(/[-+]/)[0].split('.').map(Number);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

export function installMethod(root = ROOT) {
  if (CELLAR.test(root)) return 'brew';
  if (fs.existsSync(path.join(root, '.git'))) return 'git';
  if (/[\\/]_npx[\\/]/.test(root)) return 'npx';
  return 'global';
}

export class Updater {
  constructor({ port, onChange = () => {}, env = process.env, fetch = globalThis.fetch, now = Date.now, root = ROOT } = {}) {
    this.port = port;
    this.onChange = onChange;
    this.fetch = fetch;
    this.now = now;
    this.checkedAt = -Infinity;
    this.root = root;
    this.method = installMethod(root);
    this.brew = root.match(CELLAR)?.[1]; // Homebrew's prefix, e.g. /opt/homebrew
    this.enabled = this.method !== 'git' && !/^(0|false|no|off)$/i.test(env.WISP_UPDATE_CHECK || '') && !env.CI;
    this.state = { current: PKG.version, latest: null, available: false, method: this.method, status: 'idle', error: null };
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

  set(patch) {
    Object.assign(this.state, patch);
    this.onChange(this.view());
  }

  view() {
    return { ...this.state, command: this.command() };
  }

  // What installs the latest version; shown to copy if it fails. A clone has none.
  command() {
    if (this.method === 'brew') return `${JSON.stringify(path.join(this.brew, 'bin', 'brew'))} upgrade ${TAP}`;
    return { global: `npm install -g ${PKG.name}@latest`, npx: `npx -y ${PKG.name}@latest` }[this.method];
  }

  // Where the updated copy lives: the same folder, except Homebrew puts each version in its own
  // keg and keeps opt/wisp-agents pointing at the current one.
  home() {
    if (this.method !== 'brew') return this.root;
    return path.join(this.brew, 'opt', 'wisp-agents', 'libexec', 'lib', 'node_modules', PKG.name);
  }

  async check() {
    this.checkedAt = this.now();
    try {
      const r = await this.fetch(REGISTRY, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return this.view();
      const { version } = await r.json();
      const available = this.method !== 'git' && newer(version, PKG.version);
      if (version !== this.state.latest || available !== this.state.available) this.set({ latest: version, available });
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
      if (this.method !== 'npx') {
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

  // Same port as now (wisp may have been started with --port), so the open tab finds it again.
  relaunchCommand(electron = !!process.versions.electron) {
    const args = `${electron ? '' : ' --browser --no-open'} --port ${this.port}`; // desktop: reopen the app; browser: keep the tab
    const node = JSON.stringify(electron ? 'node' : process.execPath);
    return this.method === 'npx' ? `npx -y ${PKG.name}@latest${args}` : `${node} ${JSON.stringify(path.join(this.home(), 'bin', 'wisp.js'))}${args}`;
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
