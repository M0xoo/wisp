// Update check: polls the npm registry for a newer wisp-agents and, when asked, installs it and
// relaunches wisp. How depends on how this copy was installed:
//   global  npm install -g wisp-agents@latest, then rerun bin/wisp.js from the same folder
//   npx     nothing to install: relaunch through `npx -y wisp-agents@latest`
//   git     a clone: we only tell you to pull
// Opt out with WISP_UPDATE_CHECK=0.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const REGISTRY = `https://registry.npmjs.org/${PKG.name}/latest`;
const EVERY = 6 * 3600_000;

export function newer(a, b) {
  const p = (v) => String(v).replace(/^v/, '').split(/[-+]/)[0].split('.').map(Number);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

export function installMethod(root = ROOT) {
  if (fs.existsSync(path.join(root, '.git'))) return 'git';
  if (/[\\/]_npx[\\/]/.test(root)) return 'npx';
  return 'global';
}

export class Updater {
  constructor({ port, onChange = () => {}, env = process.env } = {}) {
    this.port = port;
    this.onChange = onChange;
    this.enabled = !/^(0|false|no|off)$/i.test(env.WISP_UPDATE_CHECK || '') && !env.CI;
    this.method = installMethod();
    this.state = { current: PKG.version, latest: null, available: false, method: this.method, status: 'idle', error: null };
  }

  start() {
    if (!this.enabled) return;
    setTimeout(() => this.check(), 5000).unref();
    setInterval(() => this.check(), EVERY).unref();
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.onChange(this.view());
  }

  view() {
    const s = this.state;
    const command = { global: `npm install -g ${PKG.name}@latest`, npx: `npx -y ${PKG.name}@latest`, git: 'git pull' }[s.method];
    return { ...s, command, auto: s.method !== 'git' };
  }

  async check() {
    try {
      const r = await fetch(REGISTRY, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return this.view();
      const { version } = await r.json();
      const available = newer(version, PKG.version);
      if (version !== this.state.latest || available !== this.state.available) this.set({ latest: version, available });
    } catch {} // offline: try again next round
    return this.view();
  }

  // Installs (global) then hands off to a detached helper that waits for this server's port to
  // free up and starts the new version. The caller shuts this process down.
  async install() {
    if (this.method === 'git') throw Object.assign(new Error('This is a git checkout: run `git pull` to update.'), { status: 400 });
    if (this.state.status === 'installing') throw Object.assign(new Error('Already updating.'), { status: 409 });
    this.set({ status: 'installing', error: null });
    try {
      if (this.method === 'global') await run(`npm install -g ${PKG.name}@latest`);
    } catch (err) {
      this.set({ status: 'idle', error: err.message });
      throw err;
    }
    const args = process.versions.electron ? '' : ' --browser --no-open'; // desktop: reopen the app; browser: keep the tab
    const node = JSON.stringify(process.versions.electron ? 'node' : process.execPath);
    const relaunch = this.method === 'npx' ? `npx -y ${PKG.name}@latest${args}` : `${node} ${JSON.stringify(path.join(ROOT, 'bin', 'wisp.js'))}${args}`;
    handOff(this.port, relaunch);
    this.set({ status: 'restarting' });
  }
}

function run(cmd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, stdio: ['ignore', 'ignore', 'pipe'], env: withoutElectronNode() });
    let err = '';
    child.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      const hint = /EACCES|permission denied/i.test(err) ? ' (permission denied — run it yourself, maybe with sudo)' : '';
      reject(Object.assign(new Error(`\`${cmd}\` failed${hint}: ${err.trim().split('\n').slice(-3).join(' ')}`), { status: 400 }));
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
