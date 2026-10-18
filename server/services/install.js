// One-click setup for people with no harness yet. opencode is the one wisp installs: its free
// models work without an account, so a fresh computer can run a task right away. It goes into
// wisp's own folder (~/.wisp/tools) through npm, which every wisp install already has: no sudo,
// no shell profile edits, the same on Windows. The opencode adapter finds it there.

import fs from 'node:fs';
import { spawn } from '../proc.js';
import { bad, toolsDir } from '../util.js';

export const INSTALLABLE = {
  opencode: { pkg: 'opencode-ai', name: 'opencode' },
};
const TIMEOUT_MS = 5 * 60_000;

// npm install --prefix <dir> <pkg>@latest. Resolves when it worked, rejects with the tail of
// npm's output when it didn't: a 424, since offline or a broken npm isn't a wisp bug (it's
// counted in the harness_install event instead of reported as an exception).
export function npmInstall(pkg, dir, { npm = process.env.WISP_NPM || 'npm', timeout = TIMEOUT_MS } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // the desktop app's node mode must not leak into npm
  return new Promise((resolve, reject) => {
    const child = spawn(npm, ['install', '--prefix', dir, '--no-audit', '--no-fund', '--loglevel=error', `${pkg}@latest`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = (d) => (out = (out + d).slice(-4000));
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill(), timeout);
    child.on('error', (err) => (clearTimeout(timer), reject(bad(err.code === 'ENOENT' ? 'npm isn’t on PATH, so wisp can’t install it. Install Node.js (it comes with npm), then try again.' : err.message, 424))));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const tail = out.trim().split('\n').filter(Boolean).slice(-3).join(' ');
      reject(bad(`npm install ${pkg} ${signal ? 'timed out' : 'failed'}${tail ? `: ${tail}` : ''}`, 424));
    });
  });
}

export function createInstaller(app, { install = npmInstall } = {}) {
  const running = new Map(); // id -> promise: a second click (or tab) waits for the same install

  // Installs the harness, detects again and returns the harness list. Throws when the install
  // failed or the harness still isn't found afterwards.
  async function run(id) {
    const spec = INSTALLABLE[id];
    if (!spec) throw bad(`wisp can’t install ${id}. Install it yourself, then re-check.`);
    if (!running.has(id)) {
      const job = (async () => {
        const started = Date.now();
        try {
          await install(spec.pkg, toolsDir());
        } catch (err) {
          app.telemetry?.track('harness_install', { agent: id, ok: false, ms: Date.now() - started });
          throw err;
        }
        const agents = await app.auto.detect({ fresh: true });
        const ok = agents.find((a) => a.id === id)?.available;
        app.telemetry?.track('harness_install', { agent: id, ok: !!ok, ms: Date.now() - started });
        if (!ok) throw bad(`${spec.name} was installed but doesn’t start: ${agents.find((a) => a.id === id)?.error || 'unknown error'}`, 500);
        app.broadcast('agents', {});
        return agents;
      })().finally(() => running.delete(id));
      running.set(id, job);
    }
    return running.get(id);
  }

  return { run, installing: (id) => running.has(id) };
}
