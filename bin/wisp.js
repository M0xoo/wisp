#!/usr/bin/env node
// wisp — launcher + queue for coding agents.
//
//   wisp                       open the wisp desktop app (or focus the running one)
//   wisp "fix the tests"       launch a wisp in the current folder
//   wisp add [path]            add a folder as a project (default: current folder)
//   wisp ls | show | wait | reply | btw | stop    script sessions (see --help)
//   wisp run <recipe> [values…]             run a saved recipe
//   wisp spell [ls|cast|install|on|off|rm|export]  spells: changes to wisp itself
//   wisp mcp                   stdio MCP server, so other agents and editors can use wisp
//   wisp skill [install]       the agent skill that teaches other agents to use wisp
//   wisp grid <dev|init|serve|…>  run wisp for many people on your own server (grid/)

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
  wisp ls                       list sessions        (--state running,waiting,review,done|needs  --limit N  --all: archived too)
  wisp show <id>                state + latest presentation as markdown
  wisp wait <id>                block until it finishes or asks you something
  wisp reply <id> "text"        follow up (answers a pending question)   (--queue  --mode plan|edits|auto
                                --agent ID  --model ID  --effort LEVEL: switch harness / model from here on)
  wisp btw <id> "question"      ask on the side without interrupting the run; prints the answer
  wisp stop <id>                stop a run
  wisp ship <id>                commit, push and open a PR for a worktree session   (--draft)
  wisp merge <id>               squash-merge its PR and sync your local base branch
  wisp run <recipe> [values…]   run a saved recipe; values fill its {params} in order, or key=value
  wisp recipes                  list recipes
  wisp usage                    spend and outcomes   (--days 7|30|90)
  wisp spell                    list spells (changes to wisp itself: buttons, panels, blocks, looks)
  wisp spell cast "<change>"    an agent writes a spell for it; keep it in the app   (--wait)
  wisp spell install <file|url> add a spell someone sent (https, gist:<id>); off until --on
  wisp spell on|off|rm <id>     turn a spell on or off, or remove it   (wisp spell off --all)
  wisp spell export <id>        print the spell file to share
  wisp mcp                      run the MCP server (stdio) for other agents and editors
  wisp skill [install]          print / install the wisp agent skill   (--agent claude|codex|opencode|all  --project)
  wisp grid dev|init|serve|doctor  wisp Grid: wisp for many people on your server   (wisp grid help)
  wisp -- "ls the repo"         a task that starts with a command name

launch options: --mode plan|edits|auto  --agent claude|codex|opencode|cursor|antigravity|grok|copilot  --model ID  --effort LEVEL
                --cwd DIR  --also DIR (repeatable)  --wait  --json  --no-worktree  --compare agent[:model],…
options:        --port N  --browser  --no-open  --json  --version`;

const COMMANDS = new Set(['add', 'ls', 'list', 'show', 'wait', 'reply', 'btw', 'stop', 'mcp', 'skill', 'ship', 'merge', 'run', 'recipes', 'usage', 'spell', 'spells', 'grid']);
const LS_STATES = ['running', 'waiting', 'review', 'done'];
const GRID_SUB = new Set(['dev', 'init', 'serve', 'doctor', 'rotate-key', 'backup', 'users', 'help']);
const argv = process.argv.slice(2);
const flags = { open: true, browser: false, port: Number(process.env.WISP_PORT) || 4477, mode: null, agent: null, model: null, effort: null, cwd: null, also: [], json: false, wait: false, queue: undefined, state: null, limit: null, project: false, worktree: undefined, compare: null, draft: false, days: null };
const words = [];
let literal = false;
for (let i = 0; i < argv.length; i++) {
  let a = argv[i];
  // --state=review is --state review (it used to become a word, and the filter was dropped).
  if (!literal && /^--[a-z-]+=/.test(a)) {
    argv.splice(i + 1, 0, a.slice(a.indexOf('=') + 1));
    a = a.slice(0, a.indexOf('='));
  }
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
  else if (a === '--also') flags.also.push(path.resolve(argv[++i].replace(/^~(?=$|[\\/])/, os.homedir())));
  else if (a === '--state') flags.state = argv[++i];
  else if (a === '--limit') flags.limit = Number(argv[++i]);
  else if (a === '--json') flags.json = true;
  else if (a === '--wait' || a === '-w') flags.wait = true;
  else if (a === '--queue') flags.queue = true;
  else if (a === '--project') flags.project = true;
  else if (a === '--no-worktree') flags.worktree = false;
  else if (a === '--worktree') flags.worktree = true;
  else if (a === '--compare') flags.compare = argv[++i].split(',').filter(Boolean).map((x) => ({ agent: x.split(':')[0], model: x.split(':').slice(1).join(':') || undefined }));
  else if (a === '--draft') flags.draft = true;
  else if (a === '--on') flags.on = true;
  else if (a === '--all') flags.all = true;
  else if (a === '--days') flags.days = Number(argv[++i]);
  else if (a === '--version' || a === '-v') {
    console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version);
    process.exit(0);
  } else if (a === '--help' || a === '-h') {
    console.log(HELP);
    process.exit(0);
  } else words.push(a);
}
// Newer commands are also common first words of a task ("ship the docs", "usage of X"), so they
// only count when the rest fits; `wisp run` falls back to a task when no recipe has that name.
const SESSION_ID = /^[a-f0-9]{12}$/;
const FITS = { grid: (w) => !w[1] || GRID_SUB.has(w[1]), ship: (w) => SESSION_ID.test(w[1] || ''), merge: (w) => SESSION_ID.test(w[1] || ''), btw: (w) => SESSION_ID.test(w[1] || ''), usage: (w) => w.length === 1, recipes: (w) => w.length === 1, run: (w) => w.length > 1 };
const command = literal !== 'task' && COMMANDS.has(words[0]) && (FITS[words[0]]?.(words) ?? true) ? words[0] : null;
const cwd = flags.cwd || process.cwd();
const die = (msg) => {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
};

// --- commands that only talk to the API (and start a headless wisp if none is running) ---

if (command === 'grid') {
  // Its own flags (--data, --domain, …): parse from the raw arguments after `grid`.
  const { gridCli } = await import('../grid/cli.js');
  await gridCli(argv.slice(argv.indexOf('grid') + 1)).catch((e) => die(e.message));
} else if (command === 'mcp') {
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
  const btw = (b) => out(b, b.status === 'done' ? b.answer : b.status === 'running' ? '  … still answering; it will show on the card' : `  ! ${b.error}`);
  const show = async (id, summary) => {
    const p = await wisp.presentation(id);
    const s = summary || (await wisp.sessions()).find((x) => x.id === id);
    out({ ...s, presentation: p }, `◌ ${s?.title}  [${s?.state}${summary?.timedOut ? ', still running' : ''}]  ${id}\n\n${p.markdown}`);
  };
  switch (cmd) {
    case 'launch': {
      const s = await wisp.launch({ prompt: args.join(' '), cwd, also: flags.also, agent: flags.agent || undefined, mode: flags.mode || undefined, model: flags.model ?? undefined, effort: flags.effort ?? undefined, worktree: flags.worktree, compare: flags.compare || undefined });
      if (s.group && !flags.wait) return out(s, s.group.map((x) => `  ◌ launched on ${x.agent}: ${x.title}  (${x.id})`).join('\n'));
      if (!flags.wait) return out(s, `  ◌ launched: ${s.title}  (${s.id})`);
      if (!flags.json) console.error(`  ◌ launched: ${s.title}  (${s.id}) — waiting…`);
      return show(s.id, await wisp.wait(s.id));
    }
    case 'ls':
    case 'list': {
      // The page's Needs you is review + waiting; an unknown state would just print nothing.
      const states = flags.state && [...new Set(flags.state.split(',').flatMap((x) => (x === 'needs' ? ['review', 'waiting'] : [x.trim()])).filter(Boolean))];
      const bad = states && states.filter((x) => !LS_STATES.includes(x));
      if (bad?.length) die(`unknown state ${bad.join(', ')}: use ${LS_STATES.join(', ')} or needs (review + waiting)`);
      // Like the page, archived tasks are hidden unless --all (an archived review isn't waiting on you).
      const list = await wisp.sessions({ state: states?.join(','), limit: flags.limit, cwd: flags.cwd || undefined, archived: flags.all ? undefined : false });
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
      const r = await wisp.reply(id, need(args.slice(1).join(' ').trim(), 'text'), { queue: flags.queue, mode: flags.mode || undefined, agent: flags.agent || undefined, model: flags.model ?? undefined, effort: flags.effort ?? undefined });
      if (r.btw) return btw(await wisp.btwAnswer(id, r.btw.id)); // "/btw …": a side question
      if (!flags.wait) return out(r, r.answered ? '  ✓ answered' : r.interrupted ? '  ✓ interrupted; resuming with your message' : r.queued ? '  ✓ queued' : '  ✓ sent');
      return show(id, await wisp.wait(id));
    }
    case 'btw': {
      const id = need(args[0], 'session id');
      return btw(await wisp.btw(id, need(args.slice(1).join(' ').trim(), 'question')));
    }
    case 'stop':
      return out(await wisp.stop(need(args[0], 'session id')), '  ✓ stopped');
    case 'ship': {
      const pr = await wisp.ship(need(args[0], 'session id'), { draft: flags.draft });
      return out(pr, `  ✓ PR #${pr.number}${pr.draft ? ' (draft)' : ''}: ${pr.url}`);
    }
    case 'merge': {
      const r = await wisp.merge(need(args[0], 'session id'));
      return out(r, `  ✓ merged PR #${r.pr.number}\n  ${r.sync.ok ? '✓' : '!'} ${r.sync.text}`);
    }
    case 'recipes': {
      const list = await wisp.recipes();
      return out(list, list.map((r) => `${r.name.padEnd(24)}  ${r.params.map((p) => `{${p}}`).join(' ').padEnd(20)}  ${r.prompt.replace(/\s+/g, ' ').slice(0, 60)}`).join('\n') || 'No recipes yet. Save one from wisp (⌘K → Recipes).');
    }
    case 'run': {
      const key = need(args[0], 'recipe name');
      const kv = Object.fromEntries(args.slice(1).filter((a) => /^[a-zA-Z][\w-]*=/.test(a)).map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
      const words = args.slice(1).filter((a) => !/^[a-zA-Z][\w-]*=/.test(a));
      const s = await wisp.runRecipe(key, { params: kv, words, cwd, agent: flags.agent || undefined, model: flags.model ?? undefined, effort: flags.effort ?? undefined, mode: flags.mode || undefined }).catch((err) => {
        if (err.status !== 404) throw err;
        return wisp.launch({ prompt: ['run', ...args].join(' '), cwd, agent: flags.agent || undefined, mode: flags.mode || undefined, model: flags.model ?? undefined, effort: flags.effort ?? undefined, worktree: flags.worktree });
      });
      if (!flags.wait) return out(s, `  ◌ launched: ${s.title}  (${s.id})`);
      if (!flags.json) console.error(`  ◌ launched: ${s.title}  (${s.id}) — waiting…`);
      return show(s.id, await wisp.wait(s.id));
    }
    case 'spell':
    case 'spells':
      return spellCommand(wisp, args, { out, need, show });
    case 'usage': {
      const u = await wisp.usage({ days: flags.days || 30 });
      const money = (v) => `$${v.toFixed(2)}`;
      const pct = (v) => (v === null ? '—' : `${Math.round(v * 100)}%`);
      const rows = (list, label) => list.map((x) => `  ${label(x).padEnd(32).slice(0, 32)}  ${money(x.cost).padStart(8)}  ${String(x.turns).padStart(5)} turns  ${pct(x.successRate).padStart(4)} ok`).join('\n');
      return out(u, `Last ${u.days} days: ${money(u.total.cost)} · ${u.total.turns} turns in ${u.total.sessions} sessions · ${pct(u.total.successRate)} worked · ${u.total.questions} questions\n\nBy project\n${rows(u.projects, (x) => x.name)}\n\nBy harness · model\n${rows(u.runners, (x) => `${x.agent} · ${x.model || 'default'}`)}`);
    }
  }
}

// wisp spell …: list, cast, install, turn on/off, remove and export spells (server/routes/spells.js).
async function spellCommand(wisp, [sub = 'ls', ...rest], { out, need, show }) {
  const api = (method, p, body) => wisp.request(method, p, body);
  const line = (s) => `${s.enabled ? '●' : '○'} ${s.id.padEnd(24)} ${`v${s.version}`.padEnd(8)} ${s.kind.padEnd(5)}  ${s.name}${s.description ? ` — ${s.description}` : ''}`;
  switch (sub) {
    case 'ls':
    case 'list': {
      const r = await api('GET', '/spells');
      return out(r, [r.safe ? '! safe mode: every spell is off' : '', ...r.spells.map(line), ...r.broken.map((b) => `! ${b.id}: ${b.error}`)].filter(Boolean).join('\n') || 'No spells yet. Cast one: wisp spell cast "a floating button that opens my PRs"');
    }
    case 'cast': {
      const s = await wisp.launch({ prompt: need(rest.join(' ').trim(), 'what to change'), kind: 'spell', agent: flags.agent || undefined, model: flags.model ?? undefined, effort: flags.effort ?? undefined });
      if (!flags.wait) return out(s, `  🧙 casting: ${s.title}  (${s.id})\n  Try it and keep it from its card in wisp.`);
      if (!flags.json) console.error(`  🧙 casting: ${s.title}  (${s.id}) — waiting…`);
      return show(s.id, await wisp.wait(s.id));
    }
    case 'install':
    case 'add': {
      const src = need(rest[0], 'a .spell.json file or a link');
      const body = /^(https:\/\/|gist:)/i.test(src) ? { url: src } : { text: fs.readFileSync(path.resolve(src), 'utf8'), name: path.basename(src) };
      const check = await api('POST', '/spells/check', body);
      if (!check.ok) die(`That spell has problems:\n- ${check.problems.join('\n- ')}`);
      const r = await api('POST', '/spells', { ...body, enable: !!flags.on });
      return out(r, [`  ✓ ${r.updated ? 'updated' : 'added'} ${r.spell.name} (${r.spell.id} v${r.spell.version}, ${r.spell.kind})${r.spell.enabled ? ', on' : ' — off; turn it on with: wisp spell on ' + r.spell.id}`, ...check.summary.map((l) => `    · ${l}`)].join('\n'));
    }
    case 'on':
    case 'off': {
      if (sub === 'off' && flags.all) return out(await api('POST', '/spells/off', {}), '  ✓ every spell is off');
      const r = await api('PATCH', `/spells/${encodeURIComponent(need(rest[0], 'spell id'))}`, { enabled: sub === 'on' });
      return out(r, `  ✓ ${r.name} is ${r.enabled ? 'on' : 'off'}`);
    }
    case 'rm':
    case 'remove':
      return out(await api('DELETE', `/spells/${encodeURIComponent(need(rest[0], 'spell id'))}`, {}), '  ✓ removed');
    case 'export': {
      const s = await api('GET', `/spells/${encodeURIComponent(need(rest[0], 'spell id'))}/export`);
      return console.log(JSON.stringify(s, null, 2));
    }
    default:
      die(`unknown: wisp spell ${sub} (ls, cast, install, on, off, rm, export)`);
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
    // WISP_HOST: in a wisp Grid container the edge reaches wisp through a published port.
    await startServer({ port: flags.port, ...(process.env.WISP_HOST && { host: process.env.WISP_HOST }) });
    console.log(`\n  ◌ wisp is floating at ${base}\n`);
  }

  let openPath = '/';
  if (command === 'add') {
    // A repo URL is cloned by the server (into ~/code unless defaults.cloneDir says otherwise).
    const url = /^(https?:|ssh:|git:|git@|(www\.)?github\.com\/)/i.test(words[1] || '');
    if (url) console.log(`  ◌ cloning ${words[1]}…`);
    const p = await api('/projects', url ? { repo: words[1] } : { path: path.resolve(words[1] || process.cwd()) }).catch((e) => console.error(`  ✗ ${e.message}`));
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
