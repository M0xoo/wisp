#!/usr/bin/env node
// wisp — launcher + queue for coding agents.
//
//   wisp                   start wisp (or focus the running one) and open the browser
//   wisp "fix the tests"   launch a wisp in the current folder
//   wisp add [path]        add a folder as a project (default: current folder)
//   --port N               port (default 4477, or WISP_PORT)
//   --mode plan|edits|auto permission mode for a launch
//   --no-open              don't open a browser

import { exec } from 'node:child_process';
import path from 'node:path';

const argv = process.argv.slice(2);
const flags = { open: true, port: Number(process.env.WISP_PORT) || 4477, mode: null };
const words = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--no-open') flags.open = false;
  else if (a === '--port' || a === '-p') flags.port = Number(argv[++i]);
  else if (a === '--mode' || a === '-m') flags.mode = argv[++i];
  else if (a === '--help' || a === '-h') {
    console.log('usage:\n  wisp                    open wisp\n  wisp "task"             launch a task in this folder\n  wisp add [path]         add a project\n\noptions: --port N  --mode plan|edits|auto  --no-open');
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

if (!running) {
  const { startServer } = await import('../server/index.js');
  await startServer({ port: flags.port });
  console.log(`\n  ◌ wisp is floating at ${base}\n`);
}

let openPath = '/';
if (words[0] === 'add') {
  const dir = path.resolve(words[1] || process.cwd());
  const p = await api('/projects', { path: dir }).catch((e) => console.error(`  ✗ ${e.message}`));
  if (p) console.log(`  ✓ project added: ${p.name}  (${p.path})`);
  if (running) process.exit(0);
} else if (words.length) {
  const cfg = await api('/config');
  const s = await api('/sessions', { prompt: words.join(' '), cwd: process.cwd(), agent: cfg.defaults.agent, mode: flags.mode || cfg.defaults.mode, model: cfg.defaults.model });
  console.log(`  ◌ launched: ${s.title}`);
  openPath = `/#/s/${s.id}`;
  if (running) process.exit(0); // the running wisp will show it in the queue
}

if (flags.open) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${cmd} "${base}${openPath}"`);
}
