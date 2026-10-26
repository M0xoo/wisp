// Accounts: more than one subscription for a harness (two Claude plans, two ChatGPT logins). Each
// CLI keeps its login in one folder you can point it at (CLAUDE_CONFIG_DIR, CODEX_HOME), so an
// account is a folder. The CLI's own folder is the default account; an extra account's folder
// links to everything in it except the login, so settings, skills, MCP servers and transcripts
// stay the same on every account, and you can move a task to another of your accounts (design/accounts.md).
//
// ~/.wisp/accounts.json keeps the list per harness, in the user's order (Auto's order too), each
// account's kind (personal or work) and when it's at its usage limit. A harness with only its
// default account has no entry at all.
//
// wisp never switches accounts to get around a limit: providers' terms forbid bypassing their
// limits (legal review, design/accounts.md). A limit asks you what to do; launches you start
// yourself skip an account already known to be at its limit, unattended ones don't.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bad, newId, writeJsonAtomic } from './util.js';

// What each harness's account is. own: names in its folder that belong to the login, never linked.
// resumes: a conversation started on one account resumes on another (the transcripts are shared).
// Codex may tie its encrypted reasoning to the login's organisation, so it starts afresh with a
// handoff of the turns instead.
export const HOMES = {
  claude: {
    env: 'CLAUDE_CONFIG_DIR',
    home: (env, home) => env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
    own: ['.credentials.json', '.claude.json', '.claude.json.lock', 'backups', 'statsig', 'session-env', 'shell-snapshots'],
    resumes: true,
    extra: 'https://support.claude.com/en/articles/11145838', // the provider's own way past a limit
  },
  codex: {
    env: 'CODEX_HOME',
    home: (env, home) => env.CODEX_HOME || path.join(home, '.codex'),
    own: ['auth.json', 'installation_id', 'app-server-control', 'app-server-daemon', 'mcp-oauth-locks'],
    resumes: false,
    extra: 'https://developers.openai.com/codex/pricing',
  },
};
export const NAMES = { claude: 'Claude', codex: 'Codex' };
const MAX = 8; // accounts per harness
const LABEL = 40;
// Plans that belong to an employer or school: an account on one is a work account.
const WORK_PLANS = /team|enterprise|business|edu/i;
export const KINDS = ['personal', 'work'];
const NO_SYNC = new Set(['oauthAccount', 'userID', 'primaryApiKey', 'customApiKeyResponses', 'claudeCodeFirstTokenDate', 's1mAccessCache', 'cachedGrowthBookFeatures', 'cachedStatsigGates']);

const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// Claude's own settings file: inside the folder under CLAUDE_CONFIG_DIR, else next to ~/.claude.
const claudeJson = (dir, isDefault, env, home) => (isDefault && !env.CLAUDE_CONFIG_DIR ? path.join(home, '.claude.json') : path.join(dir, '.claude.json'));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// "a.b@gmail.com" → "A.b": the label an account gets when you don't name it.
const fromEmail = (email) => {
  const name = String(email || '').split('@')[0];
  return name ? name[0].toUpperCase() + name.slice(1) : '';
};

export class Accounts {
  // home: wisp's folder. env / userHome: for tests. platform: junctions on Windows.
  constructor(wispHome, { env = process.env, userHome = os.homedir(), platform = process.platform, now = () => Date.now() } = {}) {
    this.file = path.join(wispHome, 'accounts.json');
    this.root = path.join(wispHome, 'accounts');
    this.env = env;
    this.userHome = userHome;
    this.platform = platform;
    this.now = now;
    this.state = readJson(this.file) || {};
    if (typeof this.state !== 'object' || Array.isArray(this.state)) this.state = {};
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeJsonAtomic(this.file, this.state, 2);
  }

  supports(agent) {
    return Object.hasOwn(HOMES, agent);
  }

  defaultHome(agent) {
    return path.resolve(HOMES[agent].home(this.env, this.userHome));
  }

  #spec(agent) {
    if (!this.supports(agent)) throw bad(`${agent} can’t have more than one account in wisp yet.`, 400);
    return HOMES[agent];
  }

  // The stored list, with the default first when there's nothing stored.
  #raw(agent) {
    const list = Array.isArray(this.state[agent]) ? this.state[agent].filter((a) => a && typeof a.id === 'string') : [];
    return list.length ? list : [{ id: 'default', label: '' }];
  }

  // [{ id, label, email, plan, default, home, state: 'ready'|'limit'|'signedOut', until, why }]
  list(agent) {
    if (!this.supports(agent)) return [];
    const now = this.now();
    return this.#raw(agent).map((a) => {
      const limit = a.limit && a.limit.until > now ? a.limit : null;
      return {
        id: a.id,
        label: a.label || fromEmail(a.email) || (a.id === 'default' ? 'Main' : 'Account'),
        email: a.email || '',
        plan: a.plan || '',
        default: a.id === 'default',
        kind: KINDS.includes(a.kind) ? a.kind : WORK_PLANS.test(a.plan || '') ? 'work' : 'personal',
        home: this.homeOf(agent, a.id),
        state: a.signedIn === false ? 'signedOut' : limit ? 'limit' : 'ready',
        until: limit?.until || null,
        why: limit?.why || '',
      };
    });
  }

  // For the page: no folders.
  view(agent) {
    return this.list(agent).map(({ home, ...a }) => a);
  }

  multi(agent) {
    return this.supports(agent) && this.#raw(agent).length > 1;
  }

  get(agent, id) {
    return this.list(agent).find((a) => a.id === id) || null;
  }

  homeOf(agent, id) {
    return !id || id === 'default' ? this.defaultHome(agent) : path.join(this.root, agent, id);
  }

  // The env a run (or a sign-in) on this account needs. The default account needs nothing.
  envFor(agent, id) {
    if (!this.supports(agent) || !id || id === 'default' || !this.#raw(agent).some((a) => a.id === id)) return {};
    return { [HOMES[agent].env]: this.homeOf(agent, id) };
  }

  // Which account a run gets: `prefer` (your last pick), else the first in your order. A launch you
  // start yourself (byHand) skips one already known to be at its limit or signed out, as you would
  // in the picker; an unattended one (crew, schedules, subagents) takes your pick as it is, and a
  // limit there asks you. '' when the harness has one account (nothing to choose).
  pick(agent, prefer = '', { byHand = false } = {}) {
    if (!this.multi(agent)) return '';
    const list = this.list(agent);
    const want = list.find((a) => a.id === prefer) || list[0];
    if (!byHand || want.state === 'ready') return want.id;
    return (list.find((a) => a.state === 'ready') || want).id;
  }

  // A usage limit on this account: it's skipped until `ms` from now.
  cool(agent, id, { ms = 60 * 60_000, why = '' } = {}) {
    const a = this.#stored(agent, id || 'default');
    if (!a) return;
    a.limit = { until: this.now() + ms, why: String(why).slice(0, 160) };
    this.save();
  }

  #stored(agent, id) {
    if (!Array.isArray(this.state[agent])) return null;
    return this.state[agent].find((a) => a.id === id) || null;
  }

  // What the CLI says about a login (email, plan, signed in), kept for the page.
  identify(agent, id, info = {}) {
    const a = this.#stored(agent, id);
    if (!a) return;
    if (info.email) a.email = String(info.email).slice(0, 200);
    if (info.plan) a.plan = String(info.plan).slice(0, 40);
    if (info.signedIn === true || info.signedIn === false) a.signedIn = info.signedIn;
    if (info.signedIn) delete a.limit;
    this.save();
  }

  // A new account: its folder (linked to the default one) and a place in the list, last.
  // kind: personal or work; none: guessed from its plan once it's signed in.
  add(agent, label = '', kind = '') {
    this.#spec(agent);
    const list = this.#raw(agent);
    if (list.length >= MAX) throw bad(`${NAMES[agent]} already has ${MAX} accounts.`, 400);
    const id = newId().slice(0, 8);
    if (kind && !KINDS.includes(kind)) throw bad(`kind must be one of ${KINDS.join(', ')}.`, 400);
    const acc = { id, label: String(label || '').trim().slice(0, LABEL), ...(kind && { kind }), addedAt: this.now() };
    this.state[agent] = [...list, acc];
    this.prepare(agent, id);
    this.save();
    return this.get(agent, id);
  }

  update(agent, id, { label, move, kind } = {}) {
    this.#spec(agent);
    const list = this.#raw(agent);
    const at = list.findIndex((a) => a.id === id);
    if (at < 0) throw bad('No such account.', 404);
    if (label !== undefined) list[at].label = String(label || '').trim().slice(0, LABEL);
    if (kind !== undefined) {
      if (!KINDS.includes(kind)) throw bad(`kind must be one of ${KINDS.join(', ')}.`, 400);
      list[at].kind = kind;
    }
    if (move === 'up' || move === 'down') {
      const to = move === 'up' ? at - 1 : at + 1;
      if (to >= 0 && to < list.length) [list[at], list[to]] = [list[to], list[at]];
    }
    this.state[agent] = list;
    this.save();
    return this.view(agent);
  }

  // Forget an account and its folder (the caller signs it out first). The default stays.
  remove(agent, id) {
    this.#spec(agent);
    if (id === 'default') throw bad('That’s the account the CLI uses on its own: sign out of it instead.', 400);
    const list = this.#raw(agent);
    if (!list.some((a) => a.id === id)) throw bad('No such account.', 404);
    const dir = this.homeOf(agent, id);
    const rest = list.filter((a) => a.id !== id);
    if (rest.length <= 1 && rest[0]?.id === 'default') delete this.state[agent];
    else this.state[agent] = rest;
    this.save();
    // Only what's in the folder itself: links are removed, never followed.
    if (dir.startsWith(this.root + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
    return this.view(agent);
  }

  // Before a run or a sign-in on an extra account: its folder links to everything in the default
  // one except the login, and Claude's settings file carries the same MCP servers. Cheap enough to
  // run every time, so links a CLI replaced (an atomic write turns a link into a file) are mended.
  prepare(agent, id) {
    if (!id || id === 'default' || !this.supports(agent)) return;
    const spec = HOMES[agent];
    const base = this.defaultHome(agent);
    const dir = this.homeOf(agent, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(base, { recursive: true });
    // The folders transcripts live in exist first, so a link to them is never dangling.
    for (const d of agent === 'claude' ? ['projects', 'todos', 'plans', 'file-history', 'skills', 'agents', 'commands'] : ['sessions']) fs.mkdirSync(path.join(base, d), { recursive: true });
    const own = new Set(spec.own);
    for (const name of fs.readdirSync(base)) {
      if (own.has(name) || /\.(lock|tmp)$/.test(name) || name.startsWith('.tmp')) continue;
      this.#link(path.join(base, name), path.join(dir, name));
    }
    if (agent === 'claude') this.#syncClaudeJson(dir);
  }

  #link(target, at) {
    let st;
    try {
      st = fs.lstatSync(at);
    } catch {}
    if (st?.isSymbolicLink()) {
      if (fs.readlinkSync(at) === target) return;
      fs.unlinkSync(at);
    } else if (st?.isFile()) {
      // The CLI replaced the link with a file of its own (a settings change made on this account):
      // the newer of the two wins, then it's a link again.
      try {
        if (st.mtimeMs > fs.statSync(target).mtimeMs) fs.copyFileSync(at, target);
      } catch {}
      fs.unlinkSync(at);
    } else if (st) return; // a real folder: leave it alone
    const isDir = fs.statSync(target).isDirectory();
    fs.symlinkSync(target, at, isDir ? (this.platform === 'win32' ? 'junction' : 'dir') : 'file');
  }

  // Claude keeps the login and your MCP servers in one file (.claude.json), so it can't be linked.
  // The account's copy gets everything from the default one except who's signed in.
  #syncClaudeJson(dir) {
    const from = readJson(claudeJson(this.defaultHome('claude'), true, this.env, this.userHome)) || {};
    const file = path.join(dir, '.claude.json');
    const mine = readJson(file) || {};
    const next = { ...mine };
    for (const [k, v] of Object.entries(from)) if (!NO_SYNC.has(k)) next[k] = v;
    if (!exists(file) || JSON.stringify(next) !== JSON.stringify(mine)) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
  }
}

// wisp's own small runs (titles, JSON helpers, learned preferences) bill the account a task of that
// harness would get. Set once at boot; nothing (tests) means the CLI's own account.
let shared = null;
export const useAccounts = (a) => (shared = a);
export function sideEnv(agent, id = '') {
  if (!shared?.multi(agent)) return {};
  const pick = id && shared.get(agent, id) ? id : shared.pick(agent);
  try {
    shared.prepare(agent, pick);
  } catch {}
  return shared.envFor(agent, pick);
}
