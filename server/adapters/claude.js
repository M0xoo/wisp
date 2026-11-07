// Claude Code adapter — drives `claude -p --output-format stream-json`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ASK_TIMEOUT_MS, MAX_SNAPSHOT, attachmentNote, clip, crewToolLabel, detectFirst, exitText, flatten, helpEfforts, helpText, quietOutput, rel, spawnJsonl } from './common.js';
import { describeCommand } from './commands.js';
import { signedOutBy } from '../agent-login.js';
import { claudeLimits } from '../budget.js';
import { COSTLY_ENV, PARENT_SESSION_ENV } from '../pty.js';
import { LEAN_ENV } from '../lean.js';
import { tokenWords } from '../../web/js/receipt.js';

const DEFAULT_BIN = process.env.WISP_CLAUDE_BIN || 'claude';
let BIN = DEFAULT_BIN;
let VERSION = []; // [major, minor, patch] of the claude detect() found
// A lean run (the retro) only reads its prompt and answers: its own system prompt instead of Claude
// Code's, no tools, MCP servers, skills or saved session. A real retro went from 28k input tokens
// to 3k with the same reply. Claude Code 2.1 has all of these flags.
// --setting-sources user: nor the folder's hooks (server/project-trust.js).
const LEAN = ['--tools', '', '--strict-mcp-config', '--setting-sources', 'user', '--disable-slash-commands', '--no-session-persistence'];
// A run in a repo you haven't trusted (server/project-trust.js): only your own settings, so not the
// repo's hooks (.claude/settings.json, settings.local.json: a repo can commit that one too), and
// only the MCP servers wisp passes, so not .mcp.json's (nor, this run, your own).
const UNTRUSTED = ['--setting-sources', 'user', '--strict-mcp-config'];
const GATED = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash']; // what a gated run always asks wisp about
const leanOk = () => VERSION.length === 3 && (VERSION[0] > 2 || (VERSION[0] === 2 && VERSION[1] >= 1));
// Where claude lives when it isn't on PATH: the native installer's folders (an app started from
// the Dock never reads the shell profile that adds them), then the copies the Claude desktop app
// downloads for its Code tab into <userData>/claude-code/<version>/<sha12>/ (older builds: straight
// into <version>/; macOS builds may wrap it in claude.app), newest version first. That copy is
// signed in only while the app runs it, so on its own it needs one sign-in.
const newestFirst = (dir) => {
  try {
    return fs.readdirSync(dir).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  } catch {
    return [];
  }
};
export const fallbackBins = () => {
  const home = os.homedir();
  const win = process.platform === 'win32';
  const exe = win ? 'claude.exe' : 'claude';
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  // The app's userData: a direct install, then the two Store (MSIX) packages, whose AppData writes
  // land in their own LocalCache.
  const userData = {
    darwin: [path.join(home, 'Library', 'Application Support', 'Claude')],
    win32: [
      path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude'),
      ...['Claude_pzs8sxrjxfjjc', 'AnthropicPBC.Claude_fnn82j28hfe8t'].map((p) => path.join(local, 'Packages', p, 'LocalCache', 'Roaming', 'Claude')),
    ],
  }[process.platform] || [];
  const desktop = userData.flatMap((d) => {
    const root = path.join(d, 'claude-code');
    return newestFirst(root).flatMap((v) => [
      ...newestFirst(path.join(root, v)).flatMap((h) => [path.join(root, v, h, exe), path.join(root, v, h, 'claude.app', 'Contents', 'MacOS', 'claude')]),
      path.join(root, v, exe),
    ]);
  });
  return [path.join(home, '.local', 'bin', exe), ...(win ? [] : [path.join(home, '.claude', 'local', 'claude')]), ...desktop];
};

// Claude in Chrome turns itself on only in interactive sessions; `-p` needs --chrome. Follow the
// user's own "enabled by default" choice (/chrome in Claude Code) so a wisp run gets the same tools.
// WISP_CLAUDE_CHROME=1/0 overrides it.
const claudeJson = (env) => (env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json'));

export function chromeEnabled(env = process.env) {
  if (env.WISP_CLAUDE_CHROME) return env.WISP_CLAUDE_CHROME !== '0';
  try {
    return JSON.parse(fs.readFileSync(claudeJson(env), 'utf8')).claudeInChromeDefaultEnabled === true;
  } catch {
    return false;
  }
}

// Interactive claude won't start in a folder nobody has said "Yes, I trust this folder" for (`-p`
// skips the question, so runs never see it). Take over opens it in folders wisp made itself, a
// scratch folder or a worktree, so say yes for it in .claude.json: projects[dir].hasTrustDialogAccepted,
// what the dialog writes. Under claude's own lock (<file>.lock, a directory), so a running claude
// saving its config at the same moment doesn't lose either write.
export function trustFolder(dir, env = process.env) {
  const file = claudeJson(env);
  if (!fs.existsSync(file)) return; // never run: its first start asks more than this anyway
  const key = realDir(dir);
  const lock = `${fs.realpathSync(file)}.lock`;
  let locked = false;
  for (let i = 0; i < 40 && !locked; i++) {
    try {
      fs.mkdirSync(lock);
      locked = true;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cfg.projects?.[key]?.hasTrustDialogAccepted) return;
    cfg.projects = { ...cfg.projects, [key]: { ...cfg.projects?.[key], hasTrustDialogAccepted: true } };
    const real = fs.realpathSync(file);
    const tmp = `${real}.wisp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: fs.statSync(real).mode });
    fs.renameSync(tmp, real);
  } catch {
    // Unreadable config: claude asks, as before.
  } finally {
    if (locked) fs.rmSync(lock, { recursive: true, force: true });
  }
}

const realDir = (dir) => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
};

const PERMISSION_MODES = {
  plan: 'plan',
  edits: 'acceptEdits',
  auto: 'bypassPermissions',
};

// Where a turn's tokens went (the receipt, server/budget.js whereSubagents). As claude 2.1.316
// streams it (captured): result.modelUsage has the tokens per model, subagents' and side calls'
// included, and adds up over every result of the process (a background task's wake-up result holds
// the first one's too), so each result keeps only what's new since the last. result.usage is the
// main thread's alone. Subagents: each Agent (or Task) call, or task_started, gives its
// subagent_type; the messages carrying its id as parent_tool_use_id give their model and what they
// read. Their output_tokens are a snapshot from the stream's start (1 for a whole answer), so a
// model's output comes from modelUsage: what that model wrote minus the main thread's usage (when
// it's the main thread's model), shared among the subagents on it by their messages' counts. An
// Agent result that carries its own usage (tool_use_result.usage) wins. A web-fetch agent on a run
// whose init had no WebFetch (Claude Code's tengu_clever_orbit experiment, CC#106743) is marked
// `instead: 'WebFetch'`.
// Subagents on Haiku (Settings → Usage, defaults.subagentModel): '' is the task's own model.
export const SUBAGENT_MODELS = ['', 'haiku', 'sonnet'];

// Where the CLI runs another model than --model says. Seen on claude 2.1.318 from modelUsage: `--model
// haiku --permission-mode plan` runs claude-sonnet-5-5, `--model claude-haiku-5-5` with it stays on
// Haiku, and Haiku with edits is Haiku. So the alias only, and only in plan.
const MODEL_OVERRIDES = [{ model: 'haiku', mode: 'plan', label: 'Sonnet', note: 'Plan runs on Sonnet here, not Haiku: the Claude CLI picks it.' }];

const n0 = (x) => (Number.isFinite(x) && x > 0 ? x : 0);
const MODEL_KEYS = { input: 'inputTokens', output: 'outputTokens', cacheRead: 'cacheReadInputTokens', cacheWrite: 'cacheCreationInputTokens' };
// → [{ model, input, output, cacheRead, cacheWrite }] most output first, what's new since `prev`
// (the last result's modelUsage), or undefined.
export function modelsOf(modelUsage, prev) {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined;
  const list = Object.entries(modelUsage)
    .map(([model, u]) => {
      const e = { model };
      for (const [k, key] of Object.entries(MODEL_KEYS)) e[k] = Math.max(0, n0(u?.[key]) - n0(prev?.[model]?.[key]));
      return e;
    })
    .filter((m) => m.input + m.output + m.cacheRead + m.cacheWrite > 0)
    .sort((a, b) => b.output - a.output);
  return list.length ? list : undefined;
}

// On --resume the CLI starts from the conversation's saved counters: total_cost_usd and modelUsage
// hold its earlier runs too, while usage is this run's alone. It can also start from zero (another
// account's login folder), so prior (the last turn's stats.totals) counts only when the counters
// grew by at least what this run's main thread wrote.
export function restoredFrom(msg, prior) {
  if (!prior || !(msg.total_cost_usd >= prior.costUsd)) return false;
  const now = Object.values(msg.modelUsage || {}).reduce((a, u) => a + n0(u?.outputTokens), 0);
  const was = (prior.models || []).reduce((a, m) => a + n0(m.output), 0);
  return now - was >= n0(msg.usage?.output_tokens);
}
// The counters this process started from, from its first result, or null: it started from zero.
// unknownPrior: a chat that ran elsewhere (services/bring-in.js). Its counters hold all it ever spent
// and the chat can't be read to learn how much, so that first result is the baseline: one turn
// undercounts, rather than a whole conversation overcounting on one turn.
export function countedFrom(msg, prior, unknownPrior = false) {
  if (restoredFrom(msg, prior)) return prior;
  return unknownPrior && !prior && Number.isFinite(msg.total_cost_usd) ? { costUsd: msg.total_cost_usd, models: modelsOf(msg.modelUsage) } : null;
}
export const costSince = (msg, counted) => Math.max(0, Math.round((msg.total_cost_usd - counted.costUsd) * 1e7) / 1e7);
// A modelsOf list back in modelUsage's shape, for modelsOf's prev.
const modelUsageOf = (list) => list && Object.fromEntries(list.map((m) => [m.model, Object.fromEntries(Object.entries(MODEL_KEYS).map(([k, key]) => [key, m[k]]))]));

export function subagentTally() {
  const calls = new Map(); // Agent tool_use id -> { type, model, msgs: Map(message id -> { model, read, output }), total }
  let tools = null; // init's tools, when it sent them
  let main = ''; // the main thread's model, from its own messages
  const usageOf = (u) => ({ read: n0(u?.input_tokens) + n0(u?.cache_read_input_tokens) + n0(u?.cache_creation_input_tokens), output: n0(u?.output_tokens) });
  return {
    init(list) {
      if (Array.isArray(list)) tools = list;
    },
    call(id, name, input) {
      if ((name === 'Agent' || name === 'Task') && id && !calls.has(id)) calls.set(id, { type: String(input?.subagent_type || 'general-purpose'), model: input?.model ? String(input.model) : '', msgs: new Map(), total: null });
    },
    // An assistant message: from inside a subagent (parent_tool_use_id), or the main thread's.
    message(msg) {
      const m = msg.message || {};
      const c = msg.parent_tool_use_id && calls.get(msg.parent_tool_use_id);
      if (!msg.parent_tool_use_id) {
        if (m.model) main = String(m.model);
        return;
      }
      if (!c) return;
      if (m.model) c.model = String(m.model);
      if (!m.usage) return;
      const key = m.id || `#${c.msgs.size}`;
      const u = usageOf(m.usage);
      const was = c.msgs.get(key);
      c.msgs.set(key, { model: c.model, read: Math.max(was?.read || 0, u.read), output: Math.max(was?.output || 0, u.output) });
    },
    // The Agent call's result; an older Claude Code put the subagent's usage on tool_use_result.
    result(id, toolUseResult) {
      const c = calls.get(id);
      if (!c) return;
      if (toolUseResult?.resolvedModel && !c.model) c.model = String(toolUseResult.resolvedModel);
      if (toolUseResult?.usage && typeof toolUseResult.usage === 'object' && Number.isFinite(toolUseResult.usage.output_tokens)) c.total = usageOf(toolUseResult.usage);
    },
    // models: this result's modelsOf; mainOut: its usage.output_tokens.
    // → [{ type, calls, model, read, output, instead? }], most output first, or undefined. Clears the tally.
    take({ models, mainOut = 0 } = {}) {
      if (!calls.size) return undefined;
      // Per call and model: what its messages say.
      const parts = []; // { c, model, read, output }
      for (const c of calls.values()) {
        if (c.total) {
          parts.push({ c, model: c.model, ...c.total, fixed: true });
          continue;
        }
        const by = new Map();
        for (const m of c.msgs.values()) {
          const e = by.get(m.model || c.model) || { c, model: m.model || c.model, read: 0, output: 0 };
          e.read += m.read;
          e.output += m.output;
          by.set(e.model, e);
        }
        if (!by.size) by.set(c.model, { c, model: c.model, read: 0, output: 0 });
        parts.push(...by.values());
      }
      // A model's output from modelUsage, past what the main thread and fixed totals account for.
      // None (modelUsage can't be split, see unsplit): the messages' snapshots aren't output either.
      if (!models) for (const p of parts) if (!p.fixed) p.output = 0;
      const mainModel = main || models?.[0]?.model || '';
      for (const m of models || []) {
        const on = parts.filter((p) => p.model === m.model && !p.fixed);
        if (!on.length) continue;
        const pool = m.output - (m.model === mainModel ? n0(mainOut) : 0) - parts.filter((p) => p.model === m.model && p.fixed).reduce((a, p) => a + p.output, 0);
        const seen = on.reduce((a, p) => a + p.output, 0);
        if (!(pool > seen)) continue;
        for (const p of on) p.output = seen ? Math.round((pool * p.output) / seen) : Math.round(pool / on.length);
      }
      const types = new Map();
      for (const p of parts) {
        const e = types.get(p.c.type) || { type: p.c.type, ids: new Set(), models: new Map(), read: 0, output: 0 };
        e.ids.add(p.c);
        e.read += p.read;
        e.output += p.output;
        if (p.model) e.models.set(p.model, (e.models.get(p.model) || 0) + p.output + 1);
        types.set(p.c.type, e);
      }
      calls.clear();
      const noFetch = tools && !tools.includes('WebFetch');
      return [...types.values()]
        .map(({ models: ms, ids, ...e }) => {
          const model = [...ms].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
          // same: on the main thread's model, as its own messages name it (the receipt offers Subagents on Haiku, web/js/receipt.js).
          return { type: e.type, calls: ids.size, read: e.read, output: e.output, model, ...(model && model === main && { same: true }), ...(noFetch && /^web[-_ ]?fetch/i.test(e.type) && { instead: 'WebFetch' }) };
        })
        .sort((a, b) => b.output - a.output || b.calls - a.calls);
    },
  };
}

// Signed in through a Console profile (`ant auth login`, or a keyless Console sign-in): Claude Code
// takes it when the claude.ai login stops working (or ANTHROPIC_PROFILE names one) and bills the
// Console org. stream-json never says (apiKeySource is `none` for a login and a profile alike), so
// the sign is `claude auth status --text`'s `Profile:` line, read from the CLI's own output only.
// Once a minute per account folder, beside the run and never in its way: a failure or a CLI that
// takes longer than AUTH_TIMEOUT_MS reads as no profile.
const AUTH_TTL_MS = 60_000;
const AUTH_TIMEOUT_MS = 5_000;
const authSeen = new Map(); // account folder (+ ANTHROPIC_PROFILE) -> { at, said: Promise<string> }
// A line ending in `· not in use` is a profile on disk the run doesn't bill to (an API key outranks
// it, with the login ended): no Console sign-in then.
export const profileIn = (text) => {
  const line = String(text || '').match(/^[ \t]*Profile:[ \t]*(\S[^\r\n]*)/m)?.[1].trim() || '';
  return /·\s*not in use$/i.test(line) ? '' : line;
};
export function consoleProfile(env = process.env, now = Date.now()) {
  const key = `${env.CLAUDE_CONFIG_DIR || ''}\0${env.ANTHROPIC_PROFILE || ''}`;
  const hit = authSeen.get(key);
  if (hit && now - hit.at < AUTH_TTL_MS) return hit.said;
  const said = quietOutput(BIN, ['auth', 'status', '--text'], AUTH_TIMEOUT_MS, env).then(profileIn, () => '');
  authSeen.set(key, { at: now, said });
  return said;
}
export const forgetAuthStatus = () => authSeen.clear(); // tests

export default {
  id: 'claude',
  reportsCli: true, // says its own version per run: `cli` events, no version from detect (runner.js)
  bin: () => BIN, // the program it runs (server/harness-watch.js)
  name: 'Claude Code',
  // Asks wisp before a tool call its permission mode won't allow on its own (Edits mode).
  approveTool: 'mcp__wisp__approve',
  sideGate: true, // a side discussion can change the work: wisp hears of every write first
  fork: true, // run({ resumeId, fork }) answers on a copy of the conversation (/btw)
  models: [
    { id: '', label: 'Default', hint: 'Whatever Claude Code is set to' },
    { id: 'opus', label: 'Opus', hint: 'Most capable, for hard problems' },
    { id: 'sonnet', label: 'Sonnet', hint: 'Fast and smart, everyday work' },
    { id: 'haiku', label: 'Haiku', hint: 'Fastest, for quick tasks' },
  ],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  modelOverride({ model, mode }) {
    const o = MODEL_OVERRIDES.find((x) => x.model === model && x.mode === mode);
    return o && { label: o.label, note: o.note };
  },

  // Interactive command to take over a session in a terminal, or (terminal sessions) to start one
  // with its first prompt: sessionId names the new conversation, so wisp can resume it later.
  // The prompt goes after `--`: --add-dir takes every word after it.
  resumeCommand({ resumeId, sessionId, model, effort, dirs = [], mode, systemPrompt, prompt }) {
    return [
      BIN,
      ...(resumeId ? ['--resume', resumeId] : sessionId ? ['--session-id', sessionId] : []),
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
      ...(PERMISSION_MODES[mode] ? ['--permission-mode', PERMISSION_MODES[mode]] : []),
      ...(systemPrompt ? ['--append-system-prompt', systemPrompt] : []),
      ...dirs.flatMap((d) => ['--add-dir', d]),
      ...(prompt ? ['--', prompt] : []),
    ];
  },
  sessionIds: true, // resumeCommand({ sessionId }) picks the new conversation's id
  // Whether claude kept conversation id: one that exited at a start-up question never saved it.
  // Kept in <config>/projects/<cwd with every non-alphanumeric as ->/<id>.jsonl; every project is
  // looked through too, in case that naming changes.
  hasSession(id, cwd, env = process.env) {
    const root = path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
    const file = `${id}.jsonl`;
    if (cwd && fs.existsSync(path.join(root, realDir(cwd).replace(/[^a-zA-Z0-9]/g, '-'), file))) return true;
    try {
      return fs.readdirSync(root).some((d) => fs.existsSync(path.join(root, d, file)));
    } catch {
      return false;
    }
  },
  // The newest conversation kept for this folder, or null. Names and sizes only: nothing here opens
  // a transcript, and it never looks in another project's folder. agent-*.jsonl are subagents'.
  latestSession(cwd, env = process.env) {
    const dir = path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects', realDir(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return null;
    }
    let best = null;
    let at = -1;
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.jsonl$/i.test(name)) continue;
      try {
        const st = fs.statSync(path.join(dir, name));
        if (st.isFile() && st.size > 0 && st.mtimeMs > at) [best, at] = [name.slice(0, -'.jsonl'.length), st.mtimeMs];
      } catch {} // gone since the readdir
    }
    return best;
  },
  trust: (dir) => trustFolder(dir),

  // How to get it, shown in Settings → Agents and the picker while it isn't found (this OS's steps).
  setup(platform = process.platform) {
    return {
      tip: platform === 'linux' ? 'Install Claude Code, then run claude once to sign in' : 'Install Claude Code and run claude once to sign in. Or open the Claude app’s Code tab once: wisp uses the copy it downloads',
      command: platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash',
      url: 'https://claude.com/claude-code',
    };
  },

  async detect() {
    const { bin, ...found } = await detectFirst(DEFAULT_BIN, fallbackBins, !!process.env.WISP_CLAUDE_BIN);
    BIN = bin;
    VERSION = (String(found.version || '').match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
    if (!found.available) return found;
    const efforts = helpEfforts(await helpText(BIN));
    return efforts.length ? { ...found, efforts } : found;
  },

  // What a permission prompt is about, for the approval card and for matching "always allow".
  permission(tool, input, cwd) {
    return { tool, action: actionOf(tool, input, cwd), detail: detailOf(tool, input, cwd), why: tool === 'Bash' ? input.description || '' : '' };
  },

  // Returns { stop(), done: Promise<void> }. Everything else is reported through onEvent.
  // grants: --allowedTools rules (Bash(npm publish)) for what the user allowed after a denial.
  // dirs: the task's other folders, which it may read and edit like cwd.
  // fork: resume a throwaway copy of resumeId's conversation, leaving the original as it is.
  // accountEnv: the account it runs on (CLAUDE_CONFIG_DIR, server/accounts.js), {} for the default.
  // lean: a side run that only answers (the retro), without Claude Code's prompt and tools.
  // untrusted: without the repo's hooks and MCP servers (server/project-trust.js).
  // quiet: without Claude Code's nonessential traffic, which also drops claude.ai connectors (server/lean.js).
  // subagentModel: '' | 'haiku' | 'sonnet', the model its subagents and workflow agents run on
  // (defaults.subagentModel). Never _FORCE: an Agent call's own model, or a custom agent's, still wins.
  // gate: every write and command goes to the approve tool first (a side discussion, server/side-gate.js).
  // probe: a task's turn, which checks the sign-in it bills to (side runs don't pay for another process).
  run({ prompt, attachments = [], cwd, dirs: extra = [], resumeId, prior = null, unknownPrior = false, fork = false, mode, model, effort, systemPrompt, mcpServers = {}, delegating = false, grants = [], accountEnv = {}, lean = false, untrusted = false, quiet = false, subagentModel = '', gate = false, probe = false, onEvent }) {
    lean = lean && leanOk();
    const args = [
      '-p',
      '--output-format', 'stream-json',
      lean ? '--system-prompt' : '--append-system-prompt', systemPrompt,
      // acceptEdits never reaches the approve tool (nor does rm or touch): only default does.
      '--permission-mode', gate ? 'default' : PERMISSION_MODES[mode] || 'acceptEdits',
    ];
    // An ask rule beats allow rules, so the user's own settings can't take a write past the gate.
    if (gate) args.push('--settings', JSON.stringify({ permissions: { ask: GATED } }));
    if (lean) args.push(...LEAN);
    else if (untrusted) args.push(...UNTRUSTED);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (chromeEnabled({ ...process.env, ...accountEnv })) args.push('--chrome');
    if (resumeId) args.push('--resume', resumeId);
    if (resumeId && fork) args.push('--fork-session', '--no-session-persistence');
    if (Object.keys(mcpServers).length) args.push('--mcp-config', JSON.stringify({ mcpServers }));
    // In Edits mode, what would prompt goes to wisp's approve tool (the user decides) instead of being denied.
    if (mcpServers.wisp && mode === 'edits') args.push('--permission-prompt-tool', this.approveTool);
    const allowed = [...Object.keys(mcpServers).map((n) => `mcp__${n}`), ...grants.filter((g) => typeof g === 'string')];
    if (allowed.length) args.push('--allowedTools', ...allowed);
    // Its built-in subagents (Task, or Agent in newer versions) would bypass the user's team.
    if (delegating) args.push('--disallowedTools', 'Task', 'Agent', 'Workflow');
    const dirs = [...new Set([...extra, ...attachments.map((a) => path.dirname(a.path))])];
    if (dirs.length) args.push('--add-dir', ...dirs);
    args.push('--verbose'); // terminates the variadic flags above
    prompt += attachmentNote(attachments, 'Read images and PDFs with the Read tool');

    const env = { ...process.env, ...accountEnv };
    for (const k of PARENT_SESSION_ENV) delete env[k]; // don't let a parent Claude Code session leak into the child
    for (const k of COSTLY_ENV) delete env[k];
    if (quiet) Object.assign(env, LEAN_ENV);
    if (SUBAGENT_MODELS.includes(subagentModel) && subagentModel) env.CLAUDE_CODE_SUBAGENT_MODEL = env.CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL = subagentModel;
    env.MCP_TOOL_TIMEOUT ??= String(ASK_TIMEOUT_MS);

    let sawResult = false;
    const subagents = subagentTally();
    let lastModels = null; // the last result's modelUsage (it adds up over the process)
    let counted; // the counters this process started from, once its first result says (see restoredFrom)
    let unsplit = false; // the next result's modelUsage can't be told from the conversation's
    // This turn's last main-thread message the API ended with stop_reason "refusal" (server/refusal.js).
    // Per turn, not per process: a refusal the CLI retried past (refusal_retry) can still end in
    // success, and a background task that finishes starts a turn of its own.
    let refused = false;
    let authFailed = ''; // the words of an assistant message with error: 'authentication_failed' (no model wrote it)
    let early = null; // an empty result that came before our prompt was answered (see below)
    const pendingTools = new Map(); // tool_use_id -> name, to flag failed tool results
    // Background tasks (run_in_background shells, background subagents) still running. While any
    // are, the CLI stays up after its result and starts another turn when they finish.
    let background = new Map(); // task_id -> description
    const setBackground = (next) => {
      const was = [...background.keys()].join(' ');
      background = next;
      if ([...next.keys()].join(' ') !== was) onEvent({ type: 'background', tasks: [...next.values()] });
    };

    // The main thread's last request: what a reply reads back if the cache lapses (web/js/cold-cache.js).
    // result.usage can't say: it sums every request of the turn. Each message's usage is one request.
    let contextTokens = 0;
    let cacheTtlMs = 0; // 0: unknown
    let compacted = false; // a /compact with no main-thread request since: the size is gone, and says 0
    let boundary = null; // the last compact_boundary's compact_metadata, until a result takes it
    let unshrunk = null; // a status that says compacting failed: { error }, until a boundary says it worked
    const noteContext = (msg) => {
      const u = msg.message?.usage;
      if (!u || msg.parent_tool_use_id) return; // a subagent's context is its own
      const size = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (size) [contextTokens, compacted] = [size, false]; // 0: a <synthetic> message
      // The TTL the provider wrote with, read from the latest message that wrote any. Both: unknown.
      const { ephemeral_1h_input_tokens: h1, ephemeral_5m_input_tokens: m5 } = u.cache_creation || {};
      if (h1 || m5) cacheTtlMs = h1 && m5 ? 0 : h1 ? 3_600_000 : 300_000;
    };

    const onJson = (msg) => {
      if (msg.session_id) onEvent({ type: 'session', id: msg.session_id });

      if (msg.type === 'assistant') {
        subagents.message(msg);
        noteContext(msg);
        const stop = msg.message?.stop_reason;
        if (stop && !msg.parent_tool_use_id) refused = stop === 'refusal'; // a subagent's refusal isn't the turn's
        if (msg.error === 'authentication_failed' && !msg.parent_tool_use_id) authFailed = flatten(msg.message?.content || []) || msg.error;
        for (const part of msg.message?.content || []) {
          if (part.type === 'text' && part.text.trim()) {
            onEvent({ type: 'text', text: part.text });
          } else if (part.type === 'thinking') {
            onEvent({ type: 'thinking', ...(part.thinking && { text: part.thinking }) });
          } else if (part.type === 'tool_use') {
            pendingTools.set(part.id, part.name);
            subagents.call(part.id, part.name, part.input);
            onEvent({ type: 'tool', id: part.id, ...describeTool(part.name, part.input || {}, cwd) });
            const change = captureChange(part.name, part.input || {}, cwd);
            // Streamed before the call runs, and before any permission prompt for it (early).
            if (change) onEvent({ type: 'change', early: true, ...change });
          }
        }
      } else if (msg.type === 'user') {
        for (const part of msg.message?.content || []) {
          if (part.type !== 'tool_result') continue;
          subagents.result(part.tool_use_id, msg.tool_use_result);
          if (part.is_error) {
            const name = pendingTools.get(part.tool_use_id);
            onEvent({ type: 'tool_error', id: part.tool_use_id, name, text: flatten(part.content).slice(0, 400) });
          } else onEvent({ type: 'tool_output', id: part.tool_use_id, text: flatten(part.content) });
        }
      } else if (msg.type === 'rate_limit_event') {
        // How much of the account's 5-hour and weekly windows is gone (Settings → Usage, the limit card).
        const limits = claudeLimits(msg.rate_limit_info);
        if (limits) onEvent({ type: 'limits', ...limits });
      } else if (msg.type === 'system' && msg.subtype === 'init') {
        // Signed in with an API key (ANTHROPIC_API_KEY, apiKeyHelper…): billed as API credit, not the plan.
        // `none` is the plan or a Console profile: consoleProfile() tells those apart.
        if (msg.apiKeySource && !/^(?:none|oauth)$/i.test(msg.apiKeySource)) onEvent({ type: 'billing', kind: 'api' });
        // The tools this run had (built-ins and MCP tools): two accounts of the same harness can differ
        // (one's settings deny WebFetch), which the account comparison says (server/budget.js).
        if (Array.isArray(msg.tools)) onEvent({ type: 'tools', list: msg.tools });
        // What the CLI was this turn (stats.cli, web/js/what-changed.js).
        if (msg.claude_code_version) onEvent({ type: 'cli', version: String(msg.claude_code_version) });
        subagents.init(msg.tools);
      } else if (msg.type === 'system') {
        if (msg.subtype === 'compact_boundary') [contextTokens, compacted, boundary, unshrunk] = [0, true, msg.compact_metadata || {}, null];
        if (msg.subtype === 'status' && msg.compact_result) unshrunk = msg.compact_result === 'success' ? null : { error: String(msg.compact_error || msg.error || '').trim() };
        // A subagent started (claude 2.1.316 runs Agent calls in the background): its type.
        if (msg.subtype === 'task_started' && msg.task_type === 'local_agent' && msg.tool_use_id) subagents.call(msg.tool_use_id, 'Agent', { subagent_type: msg.subagent_type });
        // background_tasks_changed carries the full list; task_started/task_notification are the
        // per-task edges, kept as a fallback in case a CLI version only sends those.
        if (msg.subtype === 'background_tasks_changed' && Array.isArray(msg.tasks)) {
          setBackground(new Map(msg.tasks.map((t) => [t.task_id, t.description || 'Background task'])));
        } else if (msg.subtype === 'task_started' && msg.is_backgrounded && msg.task_id) {
          setBackground(new Map(background).set(msg.task_id, msg.description || 'Background task'));
        } else if (msg.subtype === 'task_notification' && background.has(msg.task_id)) {
          const next = new Map(background);
          next.delete(msg.task_id);
          setBackground(next);
        }
      } else if (msg.type === 'result') {
        const ev = resultEvent(msg, authFailed);
        if (counted === undefined) {
          counted = countedFrom(msg, prior, unknownPrior);
          lastModels = modelUsageOf(counted?.models) || null;
          // Restored, from a turn that left no models: this modelUsage is the whole conversation
          // with nothing to take off. It's still the baseline for the next result and the next run.
          unsplit = !!counted && !counted.models?.length;
        }
        if (counted) ev.stats.costUsd = costSince(msg, counted);
        if (counted && counted !== prior && !ev.stats.costUsd) ev.stats.baseline = true; // no measure of this run: see unitsOf
        // What the next --resume starts from. Its presence says stats.models is this turn's alone.
        ev.stats.totals = { costUsd: msg.total_cost_usd, models: modelsOf(msg.modelUsage) };
        // On --resume, background tasks the last run left behind come back as a task
        // notification queued ahead of our prompt. The CLI answers it with an empty,
        // zero-turn result, then goes on to the prompt and reports a second result. Ending the
        // turn on the first one would drop the real answer, so hold it in case it's all we get.
        // A compaction reports the same empty, zero-turn result, and that one is final: it never
        // goes on to a prompt. A boundary or local_command says which one this is.
        const local = msg.local_command === 'compact';
        if (!ev.isError && !ev.text.trim() && !msg.num_turns && !boundary && !local && !unshrunk) {
          early = ev;
          return;
        }
        sawResult = true;
        // A turn that auto-compacted on its way has a boundary too: that one is an ordinary answer.
        if (!ev.isError && boundary && (local || !msg.num_turns)) compactedResult(ev, boundary);
        // A /compact that didn't: "Not enough messages to compact." ends in success with no boundary.
        else if (!ev.isError && (local || (unshrunk && !ev.text.trim()))) notCompacted(ev, unshrunk?.error);
        if (contextTokens || compacted) ev.stats.contextTokens = contextTokens;
        if (cacheTtlMs) ev.stats.cacheTtlMs = cacheTtlMs;
        [contextTokens, cacheTtlMs, compacted, boundary, unshrunk] = [0, 0, false, null, null]; // one process can report several results
        // modelUsage adds up over the process: this result's part is what's new since the last.
        const models = unsplit ? undefined : modelsOf(msg.modelUsage, lastModels);
        unsplit = false;
        if (msg.modelUsage) lastModels = msg.modelUsage;
        if (models) ev.stats.models = models;
        const subs = subagents.take({ models, mainOut: msg.usage?.output_tokens });
        if (subs) ev.stats.subagents = subs;
        // Refused tool calls (no approve tool here, or the user said no): the card offers a retry.
        for (const d of msg.permission_denials || []) {
          const input = d.tool_input || {};
          onEvent({ type: 'blocked', tool: d.tool_name, detail: detailOf(d.tool_name, input, cwd), rule: ruleOf(d.tool_name, input) });
        }
        if (refused && !msg.stop_reason) ev.stopReason = 'refusal'; // the result's own stop_reason, when it has one, says
        refused = false;
        onEvent({ ...ev, background: background.size }); // > 0: another turn and result follow when they finish
      }
    };

    // Started before the run and never awaited: a Console profile is a notice (Past your plan), never a hold.
    if (probe && !lean) consoleProfile(env).then((p) => p && onEvent({ type: 'billing', kind: 'profile' })).catch(() => {});

    return spawnJsonl({
      bin: BIN,
      args,
      cwd,
      env,
      input: prompt,
      onEvent,
      onJson,
      onClose: ({ code, signal, stderr, stopped, stopRequested }) => {
        if (sawResult) return;
        if (early && !stopRequested) return onEvent(early);
        onEvent({ type: 'result', isError: true, stopped, text: stderr || exitText('claude', code, signal) });
      },
    });
  },
};




// A compaction's result says nothing itself (result: ''): the boundary has the numbers.
function compactedResult(ev, { pre_tokens: pre, post_tokens: post }) {
  const known = Number.isFinite(pre) && Number.isFinite(post);
  ev.stats.compact = known ? { pre, post } : {};
  if (!ev.text.trim()) ev.text = known ? `Compacted from ${tokenWords(pre)} to ${tokenWords(post)} tokens.` : 'Compacted.';
}

// stats.compact.none: nothing shrank, so the context stays as it was (contextTokens stays unset).
function notCompacted(ev, error) {
  ev.stats.compact = { none: true };
  ev.text = error || ev.text.trim() || 'Nothing was compacted.';
}

// A failed sign-in can end with is_error false (subtype success, zero API time), which would read
// as a finished task. Only when no model answered: a real API duration is the agent's own answer,
// whatever it says, and the words alone never count there.
const unanswered = (msg, authFailed) => !(msg.duration_api_ms > 0) && (!!authFailed || (msg.duration_api_ms === 0 && signedOutBy('claude', msg.result)));

function resultEvent(msg, authFailed = '') {
  return {
    type: 'result',
    text: msg.result || authFailed,
    isError: !!msg.is_error || (msg.subtype && msg.subtype !== 'success') || unanswered(msg, authFailed),
    ...(authFailed && { authFailed: true }),
    ...(msg.stop_reason && { stopReason: msg.stop_reason }),
    stats: {
      costUsd: msg.total_cost_usd,
      durationMs: msg.duration_ms,
      turns: msg.num_turns,
      inputTokens: msg.usage?.input_tokens,
      outputTokens: msg.usage?.output_tokens,
      // Not in inputTokens (Anthropic counts them apart): the turn's receipt adds them up.
      ...(Number.isFinite(msg.usage?.cache_read_input_tokens) && { cacheReadTokens: msg.usage.cache_read_input_tokens }),
      ...(Number.isFinite(msg.usage?.cache_creation_input_tokens) && { cacheWriteTokens: msg.usage.cache_creation_input_tokens }),
    },
  };
}

// Human sentence for the live ticker + a coarse kind for the trail summary.
function describeTool(name, input, cwd) {
  const f = rel(input.file_path || input.notebook_path || input.path, cwd);
  switch (name) {
    case 'Read':
      return { kind: 'read', label: `Reading ${f}`, file: f };
    case 'Edit':
    case 'MultiEdit':
      return { kind: 'edit', label: `Editing ${f}`, file: f };
    case 'Write':
      return { kind: 'edit', label: `Writing ${f}`, file: f };
    case 'NotebookEdit':
      return { kind: 'edit', label: `Editing notebook ${f}`, file: f };
    case 'Bash':
      return { kind: 'run', label: input.description ? clip(input.description) : describeCommand(input.command, cwd), detail: input.command };
    case 'Grep':
      return { kind: 'search', label: `Searching for “${clip(input.pattern, 40)}”` };
    case 'Glob':
      return { kind: 'search', label: `Finding ${clip(input.pattern, 50)}` };
    case 'WebSearch':
      return { kind: 'web', label: `Searching the web: ${clip(input.query, 50)}` };
    case 'WebFetch':
      return { kind: 'web', label: `Reading ${clip(input.url, 60)}` };
    case 'Task':
    case 'Agent':
      return { kind: 'agent', label: `Delegating: ${clip(input.description || input.prompt, 60)}` };
    case 'TodoWrite': {
      const active = input.todos?.find((t) => t.status === 'in_progress');
      return { kind: 'plan', label: active ? clip(active.activeForm || active.content) : 'Planning' };
    }
    case 'Skill': // the name is how a shared task finds the skills it used (services/share.js)
      return { kind: 'tool', label: input?.skill ? `Using the ${clip(String(input.skill), 64)} skill` : 'Using a skill' };
    case 'mcp__wisp__ask_user':
      return { kind: 'wait', label: 'Waiting for your answer' };
    case 'mcp__wisp__delegate':
      return { kind: 'agent', label: `Delegating to ${clip([...new Set((input.tasks || []).map((t) => t.subagent))].join(', ') || 'subagents', 60)}` };
    case 'mcp__wisp__subagent_results':
      return { kind: 'agent', label: 'Waiting on subagents' };
    case 'mcp__wisp__resume_later':
      return { kind: 'tool', label: input?.cancel ? 'Cancelling a scheduled follow-up' : `Scheduling a follow-up${input?.minutes ? ` in ${input.minutes} min` : ''}` };
    case 'mcp__wisp__wisp_tag':
      return { kind: 'tool', label: `Tagging the task${input?.tags?.length ? `: ${clip(input.tags.map((t) => `#${t}`).join(' '), 60)}` : ''}` };
    case 'mcp__wisp__wisp_pr':
      return { kind: 'tool', label: input?.remove ? 'Detaching a PR' : `Attaching PR ${clip(String(input?.pr || '').replace(/^https:\/\/github\.com\//, ''), 60)}` };
    case 'mcp__wisp__wisp_save':
      return { kind: 'tool', label: `${input?.id ? 'Updating' : 'Saving'} ${clip(String(input?.title || input?.name || String(input?.app || input?.path || input?.url || '').split(/[\\/]/).pop() || 'it'), 50)} ${input?.id ? 'in' : 'to'} My Stuff` };
    case 'mcp__wisp__wisp_stuff':
      return { kind: 'tool', label: 'Looking in My Stuff' };
    case 'mcp__wisp__wisp_blocks':
      return { kind: 'tool', label: 'Reading block formats' };
    case 'mcp__wisp__wisp_stats':
      return { kind: 'tool', label: 'Reading wisp stats' };
    case 'mcp__wisp__wisp_sessions':
      return { kind: 'tool', label: 'Listing wisp tasks' };
    case 'mcp__wisp__wisp_session':
      return { kind: 'tool', label: `Reading wisp task ${clip(input?.id || '', 40)}` };
    default:
      return crewToolLabel(name.replace(/^mcp__wisp__/, ''), input) || { kind: 'tool', label: name.startsWith('mcp__') ? `Using ${name.split('__').slice(1).join(' · ')}` : `Using ${name}` };
  }
}

// A permission prompt's subject: "run `npm publish`", "edit src/a.ts", "fetch https://…".
function actionOf(tool, input, cwd) {
  const f = rel(input.file_path || input.notebook_path || input.path, cwd);
  if (tool === 'Bash') return `run \`${clip(input.command, 200)}\``;
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool) && f) return `${tool === 'Write' ? 'write' : 'edit'} ${f}`;
  if (tool === 'WebFetch') return `fetch ${clip(input.url, 120)}`;
  if (tool === 'WebSearch') return `search the web for “${clip(input.query, 80)}”`;
  if (tool === 'ExitPlanMode') return 'leave plan mode and start making changes';
  if (tool.startsWith('mcp__')) return `use ${tool.split('__').slice(1).join(' · ')}`;
  return `use ${tool}`;
}

// The exact thing being allowed, so "always allow" matches only the same command or file.
function detailOf(tool, input, cwd) {
  if (tool === 'Bash') return String(input.command ?? '');
  const f = input.file_path || input.notebook_path || input.path;
  if (f) return rel(f, cwd);
  return String(input.url ?? input.query ?? input.pattern ?? '');
}

// An --allowedTools rule for a retry: the exact command for Bash, the tool for the rest.
const ruleOf = (tool, input) => (tool === 'Bash' && input.command ? `Bash(${input.command})` : tool);

// Capture edit inputs so wisp can show real diffs without asking the agent for them.
function captureChange(name, input, cwd) {
  const file = input.file_path;
  if (!file) return null;
  if (name === 'Edit') {
    return { file: rel(file, cwd), op: 'edit', edits: [{ before: input.old_string ?? '', after: input.new_string ?? '' }] };
  }
  if (name === 'MultiEdit') {
    return { file: rel(file, cwd), op: 'edit', edits: (input.edits || []).map((e) => ({ before: e.old_string ?? '', after: e.new_string ?? '' })) };
  }
  if (name === 'Write') {
    // tool_use is streamed before the tool runs, so the file still holds its old content here.
    let before = null;
    try {
      const st = fs.statSync(path.resolve(cwd, file));
      if (st.size <= MAX_SNAPSHOT) before = fs.readFileSync(path.resolve(cwd, file), 'utf8');
    } catch {}
    const after = String(input.content ?? '');
    return { file: rel(file, cwd), op: before === null ? 'create' : 'write', edits: [{ before: before ?? '', after: after.slice(0, MAX_SNAPSHOT) }] };
  }
  return null;
}

