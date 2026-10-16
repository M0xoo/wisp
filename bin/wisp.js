#!/usr/bin/env node
// wisp — launcher + queue for coding agents.
//
//   wisp                   open the wisp desktop app (or focus the running one)
//   wisp "fix the tests"   launch a wisp in the current folder
//   wisp add [path]        add a folder as a project (default: current folder)
//   --port N               port (default 4477, or WISP_PORT)
//   --mode plan|edits|auto permission mode for a launch
//   --agent ID             claude, codex, opencode or cursor (default: the launcher's pick)
//   --browser              use the browser instead of the desktop app
//   --no-open              just run the server, open nothing

import { exec, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wispAppBinary } from './mac-app.js';

const argv = process.argv.slice(2);
const flags = { open: true, browser: false, port: Number(process.env.WISP_PORT) || 4477, mode: null, agent: null };
const words = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--no-open') flags.open = false;
  else if (a === '--browser' || a === '-b') flags.browser = true;
  else if (a === '--port' || a === '-p') flags.port = Number(argv[++i]);
  else if (a === '--mode' || a === '-m') flags.mode = argv[++i];
  else if (a === '--agent' || a === '-a') flags.agent = argv[++i];
  else if (a === '--version' || a === '-v') {
    const { readFileSync } = await import('node:fs');
    console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
    process.exit(0);
  } else if (a === '--help' || a === '-h') {
    console.log('usage:\n  wisp                    open wisp\n  wisp "task"             launch a task in this folder\n  wisp add [path]         add a project\n\noptions: --port N  --mode plan|edits|auto  --agent claude|codex|opencode|cursor  --browser  --no-open  --version');
    process.exit(0);
  } else words.push(a);
}

const base = `http://localhost:${flags.port}`;
const api = (p, body) =>
  fetch(`${base}/api${p}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  });

let running = false;
try {
  await api('/config');
  running = true;
} catch {}

// The desktop app (Electron is an optional dependency) runs the server in its own process, so
// it outlives this terminal. Without Electron, or with --browser/--no-open, serve from here.
// A task or `add` sent to an already-running wisp just goes over the API, no window.
const electron = flags.open && !flags.browser && (!running || !words.length) ? electronBinary() : null;
if (electron) {
  const child = spawn(electron, [fileURLToPath(new URL('..', import.meta.url))], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, WISP_PORT: String(flags.port) },
  });
  child.unref();
  if (!running) await waitForServer();
  console.log(`\n  ◌ wisp is open\n`);
} else if (!running) {
  const { startServer } = await import('../server/index.js');
  await startServer({ port: flags.port });
  console.log(`\n  ◌ wisp is floating at ${base}\n`);
}

let openPath = '/';
if (words[0] === 'add') {
  const dir = path.resolve(words[1] || process.cwd());
  const p = await api('/projects', { path: dir }).catch((e) => console.error(`  ✗ ${e.message}`));
  if (p) console.log(`  ✓ project added: ${p.name}  (${p.path})`);
  if (running || electron) process.exit(0);
} else if (words.length) {
  const cfg = await api('/config');
  const agent = flags.agent || cfg.defaults.agent;
  // Models are remembered per agent (ids aren't portable between harnesses).
  const model = cfg.defaults.models?.[agent] ?? (agent === cfg.defaults.agent ? cfg.defaults.model : '');
  const s = await api('/sessions', { prompt: words.join(' '), cwd: process.cwd(), agent, mode: flags.mode || cfg.defaults.mode, model });
  console.log(`  ◌ launched: ${s.title}`);
  openPath = `/#/s/${s.id}`;
  if (running || electron) process.exit(0); // the running wisp will show it in the queue
}

if (electron) process.exit(0);
if (flags.open) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${cmd} "${base}${openPath}"`);
}

function electronBinary() {
  try {
    const bin = createRequire(import.meta.url)('electron'); // the electron package exports its binary path
    if (typeof bin !== 'string' || !existsSync(bin)) return null;
    return process.platform === 'darwin' ? wispAppBinary(bin) : bin;
  } catch {
    return null;
  }
}

async function waitForServer() {
  for (let i = 0; i < 150; i++) {
    try {
      return await api('/config');
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  console.error('  ✗ the wisp app did not start in time — try `wisp --browser`');
  process.exit(1);
}
