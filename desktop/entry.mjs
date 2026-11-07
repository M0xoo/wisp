// The Node side of the Tauri shell (desktop/src-tauri): the same unchanged server `wisp` runs from
// a terminal, here as a child of the shell on a real Node binary.
//
// stdin is a pipe only the shell holds. It closes when the shell quits, crashes or is killed -9, so
// this process can never outlive it. stdout lines starting with `wisp:shell ` are for the shell.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShellPath } from './shell-path.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WISP_PORT) || 4477;
const DATA = process.env.WISP_DESKTOP_DATA;

let server = null;
const stop = () => {
  try {
    server?.shutdown();
  } finally {
    // process.exit waits for work on the thread pool: right after boot that's the page's brotli,
    // up to a minute on a busy machine, with the port still held. All is on disk by now, so go.
    if (process.platform !== 'win32') process.kill(process.pid, 'SIGKILL');
    process.exit(0);
  }
};
process.stdin.on('end', stop).on('close', stop).on('error', stop);
process.stdin.resume();
// The shell is gone: nothing reads stdout any more, which mustn't cut the shutdown short.
process.stdout.on('error', () => {});
const say = (word) => process.stdout.write(`wisp:shell ${word}\n`);

// An app started from Finder or the Dock has a minimal PATH. Start on the PATH read last time
// and ask the login shell again behind it (true when its PATH changed).
function inheritShellPath() {
  if (process.platform === 'win32' || !DATA) return null;
  const file = path.join(DATA, 'shell-path');
  let saved = '';
  try {
    saved = fs.readFileSync(file, 'utf8');
  } catch {}
  if (saved) process.env.PATH = saved;
  const fresh = readShellPath().then((p) => {
    if (!p || p === saved) return false;
    process.env.PATH = p;
    try {
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(file, p);
    } catch {}
    return true;
  });
  return { saved: !!saved, fresh };
}

// Dev: web/ edits reload the window, server/ or desktop/ edits relaunch the app. Agents run in this
// process, so a relaunch waits until nothing is running.
function watchForDev() {
  const root = path.join(here, '..');
  let timer;
  let pending = null;
  const debounce = (fn) => (clearTimeout(timer), (timer = setTimeout(fn, 120)));
  const busy = () => server.runner.live.size;
  const relaunch = () => {
    if (busy()) return;
    clearInterval(pending);
    say('relaunch');
  };
  fs.watch(path.join(root, 'web'), { recursive: true }, () => debounce(() => say('reload')));
  for (const [dir, skip] of [['server'], ['desktop', /^src-tauri/]])
    fs.watch(path.join(root, dir), { recursive: true }, (_, file) => {
      if (skip?.test(file || '')) return; // Rust: cargo has to build it first
      debounce(() => {
        if (!busy()) return relaunch();
        console.log(`[wisp dev] ${dir}/${file} changed — relaunching once ${busy()} running session(s) finish`);
        pending ??= setInterval(relaunch, 2000);
      });
    });
}

const shellPath = inheritShellPath();
if (shellPath && !shellPath.saved) await shellPath.fresh; // the first open: nothing saved yet
const { startServer } = await import('../server/index.js');
server = await startServer({ port: PORT });
// Read by the server's telemetry just now; agents and any wisp they start aren't this shell.
delete process.env.WISP_DESKTOP;
delete process.env.WISP_DESKTOP_DATA;
if (process.stdin.readableEnded || process.stdin.destroyed) stop(); // the shell went while we started
// The shell's PATH differs from the saved one (a CLI installed since): look for harnesses again.
if (shellPath?.saved) shellPath.fresh.then((changed) => changed && server.auto.detect({ fresh: true }).then(() => server.broadcast('agents', {}))).catch(() => {});
if (process.env.WISP_DEV === '1') watchForDev();
