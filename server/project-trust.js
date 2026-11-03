// Project trust: a repo can make the agent run its own programs. Claude Code runs the hooks in
// .claude/settings.json (and settings.local.json) and starts the servers in .mcp.json, without
// asking, in `-p` (how wisp runs it), whatever the permission mode, Plan included. wisp itself runs
// the setup in .wisp/worktree.json (or .cursor/worktrees.json) on each new worktree. So before the
// first run in a repo, and again when one of those changes, wisp lists what the repo would run and
// waits: Trust and start, Run without them (claude with --setting-sources user --strict-mcp-config,
// no setup), or Skip. What you trusted is kept per repo (the main checkout, so its worktrees share
// it) as one hash per item: a new or changed hook asks again, one that's gone doesn't matter.
// A repo with none of these files runs as before. Settings → Privacy → projectAsk ('off' to stop).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const FILE = 'project-trust.json';
// Claude Code settings keys whose value is a program it runs (besides hooks).
const HELPERS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'];

// .native: on Windows it expands 8.3 names (RUNNER~1), as git's own paths are, so a checkout and
// its worktrees get one key.
const realDir = (dir) => {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
};

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// { top: the checkout dir is in (a worktree's own folder), key: the repo's main checkout }, or the
// folder itself for both outside git. Reads .git (a worktree's is a file naming its gitdir) without
// running git: this is on every run's path.
export function repoOf(dir) {
  const start = realDir(dir);
  for (let d = start; ; ) {
    const g = path.join(d, '.git');
    let st = null;
    try {
      st = fs.statSync(g);
    } catch {}
    if (st?.isDirectory()) return { top: d, key: d };
    if (st?.isFile()) {
      try {
        const gitdir = path.resolve(d, fs.readFileSync(g, 'utf8').match(/^gitdir:\s*(.+)$/m)[1].trim());
        const common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim());
        return { top: d, key: path.dirname(realDir(common)) };
      } catch {
        return { top: d, key: d };
      }
    }
    const up = path.dirname(d);
    if (up === d) return { top: start, key: start };
    d = up;
  }
}

const idOf = (x) => crypto.createHash('sha256').update(JSON.stringify([x.kind, x.file, x.name, x.command, x.extra || null])).digest('hex').slice(0, 24);
const item = (x) => ({ ...x, id: idOf(x) });
const words = (cmd, args) => [cmd, ...(Array.isArray(args) ? args : [])].filter((w) => typeof w === 'string').join(' ');

// What Claude Code would run from one settings file: each hook, the helper programs, the plugins it
// enables. rel: the file as the card names it.
function settingsItems(json, rel) {
  if (!json || typeof json !== 'object') return [];
  const out = [];
  for (const [event, groups] of Object.entries(json.hooks || {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
        const command = typeof h?.command === 'string' ? h.command : typeof h?.prompt === 'string' ? h.prompt : typeof h?.url === 'string' ? h.url : JSON.stringify(h);
        out.push(item({ kind: 'hook', file: rel, name: g?.matcher ? `${event} (${g.matcher})` : event, command }));
      }
    }
  }
  for (const k of HELPERS) if (typeof json[k] === 'string' && json[k].trim()) out.push(item({ kind: 'command', file: rel, name: k, command: json[k] }));
  if (typeof json.statusLine?.command === 'string') out.push(item({ kind: 'command', file: rel, name: 'statusLine', command: json.statusLine.command }));
  for (const [name, on] of Object.entries(json.enabledPlugins || {})) if (on) out.push(item({ kind: 'plugin', file: rel, name, command: `plugin ${name}` }));
  return out;
}

function mcpItems(json, rel) {
  const out = [];
  for (const [name, s] of Object.entries(json?.mcpServers || {})) {
    if (!s || typeof s !== 'object') continue;
    const command = typeof s.command === 'string' ? words(s.command, s.args) : typeof s.url === 'string' ? s.url : JSON.stringify(s);
    out.push(item({ kind: 'mcp', file: rel, name, command, extra: s.env ? Object.keys(s.env).sort() : null }));
  }
  return out;
}

// Claude Code's items for a run in `dir`: its folder's files and, launched from a subfolder, the
// checkout's. Never the home folder's (~/.claude/settings.json is the user's own). file: relative
// to dir, as Open file wants it.
export function claudeItems(dir) {
  const home = realDir(os.homedir());
  const at = realDir(dir);
  const { top } = repoOf(dir);
  const out = [];
  for (const d of [...new Set([at, top])].filter((d) => d !== home)) {
    const rel = (f) => path.relative(at, path.join(d, f)).split(path.sep).join('/');
    for (const f of ['.claude/settings.json', '.claude/settings.local.json']) out.push(...settingsItems(readJson(path.join(d, f)), rel(f)));
    out.push(...mcpItems(readJson(path.join(d, '.mcp.json')), rel('.mcp.json')));
  }
  return out;
}

// The setup steps a new worktree of `root` would run (server/worktree-setup.js setupCommands, same order).
export function setupItems(root) {
  const own = readJson(path.join(root, '.wisp/worktree.json'))?.setup;
  const file = own != null ? '.wisp/worktree.json' : '.cursor/worktrees.json';
  const list = own ?? readJson(path.join(root, '.cursor/worktrees.json'))?.['setup-worktree'] ?? [];
  return (Array.isArray(list) ? list : [list]).filter((c) => typeof c === 'string' && c.trim()).map((command, i) => item({ kind: 'setup', file, name: `step ${i + 1}`, command }));
}

export const asks = (defaults) => defaults?.projectAsk !== 'off';

export class ProjectTrust {
  constructor(home, { now = Date.now } = {}) {
    this.file = path.join(home, FILE);
    this.now = now;
    this.state = { repos: {} };
    const raw = readJson(this.file);
    if (raw?.repos && typeof raw.repos === 'object') this.state = { repos: raw.repos };
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    } catch {}
  }

  trusted(key, id) {
    return !!this.state.repos[key]?.ids?.includes(id);
  }

  // The items not trusted yet: { key, items, changed (something here was trusted before) } or null.
  untrusted(key, items) {
    const seen = new Set();
    const open = items.filter((x) => !seen.has(x.id) && seen.add(x.id) && !this.trusted(key, x.id));
    return open.length ? { key, items: open, ...(this.state.repos[key]?.ids?.length && { changed: true }) } : null;
  }

  // What a run of `agent` in `dir` would run that isn't trusted: Claude Code's items (other
  // harnesses don't read them) plus `extra` (a new worktree's held setup).
  pending(dir, agent, extra = []) {
    const { key } = repoOf(dir);
    return this.untrusted(key, [...(agent === 'claude' ? claudeItems(dir) : []), ...extra]);
  }

  // A new worktree of root: its setup steps when they aren't trusted (they wait), else null.
  setupHold(root, defaults) {
    if (!asks(defaults)) return null;
    return this.untrusted(repoOf(root).key, setupItems(root))?.items || null;
  }

  trust(key, ids) {
    const r = (this.state.repos[key] ||= { ids: [] });
    r.ids = [...new Set([...r.ids, ...ids])];
    r.at = this.now();
    this.#save();
  }
}
