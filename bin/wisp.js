#!/usr/bin/env node
// wisp — launcher + queue for coding agents.
//
//   wisp                       open the wisp desktop app (or focus the running one)
//   wisp "fix the tests"       launch a wisp in the current folder
//   wisp add [path]            add a folder as a project (default: current folder)
//   wisp ls | show | wait | reply | stop    script sessions (see --help)
//   wisp mcp                   stdio MCP server, so other agents and editors can use wisp
//   wisp skill [install]       the agent skill that teaches other agents to use wisp

import { exec, spawn } from 'node:child_process';
import fs, { existsSync } from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wispAppBinary } from './mac-app.js';

const HELP = `usage:
  wisp                          open wisp
  wisp "task"                   launch a task in this folder
  wisp add [path]               add a project
  wisp ls                       list sessions        (--state running,waiting  --limit N)
  wisp show <id>                state + latest presentation as markdown
  wisp wait <id>                block until it finishes or asks you something
  wisp reply <id> "text"        follow up (answers a pending question)   (--queue)
  wisp stop <id>                stop a run
  wisp mcp                      run the MCP server (stdio) for other agents and editors
  wisp skill [install]          print / install the wisp agent skill   (--agent claude|codex|opencode|all  --project)
  wisp -- "ls the repo"         a task that starts with a command name

launch options: --mode plan|edits|auto  --agent claude|codex|opencode|cursor|antigravity  --model ID  --effort LEVEL
                --cwd DIR  --wait  --json
options:        --port N  --browser  --no-open  --json  --version`;

const COMMANDS = new Set(['add', 'ls', 'list', 'show', 'wait', 'reply', 'stop', 'mcp', 'skill']);
const argv = process.argv.slice(2);
const flags = { open: true, browser: false, port: Number(process.env.WISP_PORT) || 4477, mode: null, agent: null, model: null, effort: null, cwd: null, json: false, wait: false, queue: undefined, state: null, limit: null, project: false };
const words = [];
let literal = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (literal) words.push(a);
  else if (a === '--') literal = words.length === 0 ? 'task' : true;
  else if (a === '--no-open') flags.open = false;
  else if (a === '--browser' || a === '-b') flags.browser = true;
  else if (a === '--port' || a === '-p') flags.port = Number(argv[++i]);
  else if (a === '--mode' || a === '-m') flags.mode = argv[++i];
  else if (a === '--agent' || a === '-a') flags.agent = argv[++i];
  else if (a === '--model') flags.model = argv[++i];
  else if (a === '--effort') flags.effort = argv[++i];
  else if (a === '--cwd' || a === '-C') flags.cwd = path.resolve(argv[++i].replace(/^~(?=$|[\\/])/, os.homedir()));
  else if (a === '--state') flags.state = argv[++i];
  else if (a === '--limit') flags.limit = Number(argv[++i]);
  else if (a === '--json') flags.json = true;
  else if (a === '--wait' || a === '-w') flags.wait = true;
  else if (a === '--queue') flags.queue = true;
  else if (a === '--project') flags.project = true;
  else if (a === '--version' || a === '-v') {
    console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version);
    process.exit(0);
  } else if (a === '--help' || a === '-h') {
    console.log(HELP);
    process.exit(0);
  } else words.push(a);
}
const command = literal !== 'task' && COMMANDS.has(words[0]) ? words[0] : null;
const cwd = flags.cwd || process.cwd();
const die = (msg) => {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
};

// --- commands that only talk to the API (and start a headless wisp if none is running) ---

if (command === 'mcp') {
  const { serveMcp } = await import('../server/mcp-wisp.js');
  serveMcp(); // stdout belongs to the MCP protocol from here on
} else if (command === 'skill') {
  skill(words[1]);
} else if (command && command !== 'add') {
  await scripted(command, words.slice(1)).catch((e) => die(e.message));
} else if (!command && words.length && (flags.json || flags.wait)) {
  await scripted('launch', words).catch((e) => die(e.message));
} else {
  await interactive();
}

async function scripted(cmd, args) {
  const { WispClient } = await import('../server/client.js');
  const wisp = await WispClient.connect({ port: argv.some((a) => a === '--port' || a === '-p') ? flags.port : undefined });
  const out = (v, text) => console.log(flags.json ? JSON.stringify(v, null, 2) : text);
  const need = (v, what) => v || die(`${what} required — see wisp --help`);
  const show = async (id, summary) => {
    const p = await wisp.presentation(id);
    const s = summary || (await wisp.sessions()).find((x) => x.id === id);
    out({ ...s, presentation: p }, `◌ ${s?.title}  [${s?.state}${summary?.timedOut ? ', still running' : ''}]  ${id}\n\n${p.markdown}`);
  };
  switch (cmd) {
    case 'launch': {
      const s = await wisp.launch({ prompt: args.join(' '), cwd, agent: flags.agent || undefined, mode: flags.mode || undefined, model: flags.model ?? undefined, effort: flags.effort ?? undefined });
      if (!flags.wait) return out(s, `  ◌ launched: ${s.title}  (${s.id})`);
      if (!flags.json) console.error(`  ◌ launched: ${s.title}  (${s.id}) — waiting…`);
      return show(s.id, await wisp.wait(s.id));
    }
    case 'ls':
    case 'list': {
      const list = await wisp.sessions({ state: flags.state, limit: flags.limit, cwd: flags.cwd || undefined, archived: flags.state ? undefined : false });
      return out(list, list.map((s) => `${s.id}  ${s.state.padEnd(7)}  ${s.agent.padEnd(8)}  ${s.project.padEnd(16).slice(0, 16)}  ${s.title}${s.question ? `  — asks: ${s.question}` : ''}`).join('\n') || 'No sessions.');
    }
    case 'show':
      return show(need(args[0], 'session id'));
    case 'wait': {
      const id = need(args[0], 'session id');
      return show(id, await wisp.wait(id));
    }
    case 'reply': {
      const id = need(args[0], 'session id');
      const r = await wisp.reply(id, need(args.slice(1).join(' ').trim(), 'text'), { queue: flags.queue });
      if (!flags.wait) return out(r, r.answered ? '  ✓ answered' : r.interrupted ? '  ✓ interrupted; resuming with your message' : r.queued ? '  ✓ queued' : '  ✓ sent');
      return show(id, await wisp.wait(id));
    }
    case 'stop':
      return out(await wisp.stop(need(args[0], 'session id')), '  ✓ stopped');
  }
}

// Installs skills/wisp/SKILL.md where each harness looks for skills.
function skill(sub) {
  const src = fileURLToPath(new URL('../skills/wisp/SKILL.md', import.meta.url));
  if (sub !== 'install') return process.stdout.write(fs.readFileSync(src, 'utf8'));
  const home = os.homedir();
  const base = flags.project ? cwd : null;
  const targets = {
    claude: base ? path.join(base, '.claude', 'skills') : path.join(home, '.claude', 'skills'),
    codex: base ? path.join(base, '.codex', 'skills') : path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'skills'),
    opencode: base ? path.join(base, '.opencode', 'skill') : path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode', 'skill'),
  };
  const which = !flags.agent ? ['claude'] : flags.agent === 'all' ? Object.keys(targets) : [flags.agent];
  for (const a of which) {
    if (!targets[a]) die(`no skill location for ${a} (try claude, codex, opencode or all)`);
    const dir = path.join(targets[a], 'wisp');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, path.join(dir, 'SKILL.md'));
    console.log(`  ✓ ${a}: ${path.join(dir, 'SKILL.md')}`);
  }
}

// --- the original flow: open the app, launch from the terminal, add projects ---

async function interactive() {
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
    if (!running) await waitForServer(api);
    console.log(`\n  ◌ wisp is open\n`);
  } else if (!running) {
    const { startServer } = await import('../server/index.js');
    await startServer({ port: flags.port });
    console.log(`\n  ◌ wisp is floating at ${base}\n`);
  }

  let openPath = '/';
  if (command === 'add') {
    const dir = path.resolve(words[1] || process.cwd());
    const p = await api('/projects', { path: dir }).catch((e) => console.error(`  ✗ ${e.message}`));
    if (p) console.log(`  ✓ project added: ${p.name}  (${p.path})`);
    if (running || electron) process.exit(0);
  } else if (words.length) {
    const cfg = await api('/config');
    const agent = flags.agent || cfg.defaults.agent;
    // Models are remembered per agent (ids aren't portable between harnesses).
    const model = flags.model ?? cfg.defaults.models?.[agent] ?? (agent === cfg.defaults.agent ? cfg.defaults.model : '');
    const s = await api('/sessions', { prompt: words.join(' '), cwd, agent, mode: flags.mode || cfg.defaults.mode, model, effort: flags.effort || '' });
    console.log(`  ◌ launched: ${s.title}`);
    openPath = `/#/s/${s.id}`;
    if (running || electron) process.exit(0); // the running wisp will show it in the queue
  }

  if (electron) process.exit(0);
  if (flags.open) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
    exec(`${cmd} "${base}${openPath}"`);
  }
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

async function waitForServer(api) {
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
