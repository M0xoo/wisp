// opencode adapter — drives `opencode run --format json` (one JSON event per line).

import os from 'node:os';
import path from 'node:path';
import { toolsDir } from '../util.js';
import { ASK_TIMEOUT_MS, attachmentNote, clip, crewToolLabel, detectFirst, exitText, fileTracker, quietOutput, rel, spawnJsonl, withProtocol } from './common.js';
import { describeCommand } from './commands.js';

const exe = process.platform === 'win32' ? 'opencode.cmd' : 'opencode';
// Where opencode lives when it isn't on PATH: the copy wisp installs (POST /agents/install),
// and the official install script's folder (it edits your shell profile, which an app started
// from the Dock or a service never reads).
export const fallbackBins = () => [path.join(toolsDir(), 'node_modules', '.bin', exe), path.join(os.homedir(), '.opencode', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode')];
const DEFAULT_BIN = process.env.WISP_OPENCODE_BIN || 'opencode';
let BIN = DEFAULT_BIN;
// opencode 2 (Homebrew's build, GitHub's latest) changed `run`: --log-level only takes lowercase
// names, and --variant is gone (the effort rides on the model: provider/model#high). npm and the
// install script still ship 1.x. Set by detect() from `opencode --version`.
let V2 = false;
export const majorVersion = (version) => Number(/(?:^|\s)v?(\d+)\.\d+/.exec(version || '')?.[1]) || 0;
// Rate-limited (the free models, mostly), `opencode run` keeps retrying and prints nothing, so
// the task would sit at "Starting up" for good. Its error log says so: give it this long to get
// through, then stop and tell the user what to do.
const rateLimitGrace = () => Number(process.env.WISP_RATE_LIMIT_GRACE_MS) || 60_000;
const RATE_LIMITED = /Rate limit exceeded|Too Many Requests|status(?:Code)?[=: ]+429\b/i;
// `run` answers every permission prompt itself and says so on stderr (cli/cmd/run.ts):
// "! permission requested: bash (npm publish); auto-rejecting".
const REJECTED = /permission requested: ([\w.-]+) \((.*?)\); auto-rejecting/g;
const ANSI = /\x1b\[[0-9;]*m/g;

// `opencode auth list`: a provider signed in to ("└  1 credentials") or a key in the environment
// (an "Environment" section). Without either it only has its free models, so home's setup tip
// doesn't count it. null when the output isn't one we know.
export function hasKey(out) {
  const text = out.replace(ANSI, '');
  const n = /(\d+) credentials?/.exec(text);
  if (!n) return null;
  return Number(n[1]) > 0 || /[1-9]\d* environment variables?/.test(text);
}

export default {
  id: 'opencode',
  name: 'opencode',
  askTool: 'wisp_ask_user',
  fork: true, // run({ resumeId, fork }) answers on a copy of the session (/btw)
  models: [{ id: '', label: 'Default', hint: 'Whatever opencode is set to' }],

  resumeCommand({ resumeId, model, prompt }) {
    // The TUI has no --variant flag; the effort only applies to `run`.
    return [BIN, ...(resumeId ? ['--session', resumeId] : []), ...(model ? ['--model', model] : []), ...(prompt ? ['--prompt', prompt] : [])];
  },

  // How to get it, shown in Settings → Agents and the picker while it isn't found (this OS's steps).
  setup() {
    return { tip: 'wisp can install it here: free models, no account needed', command: 'npm i -g opencode-ai', url: 'https://opencode.ai' };
  },

  async detect() {
    const { bin, ...found } = await detectFirst(DEFAULT_BIN, fallbackBins, !!process.env.WISP_OPENCODE_BIN);
    BIN = bin;
    V2 = majorVersion(found.version) >= 2;
    if (!found.available) return found;
    // `opencode models --verbose` prints each provider/model id followed by its JSON metadata;
    // the metadata's `variants` are the reasoning efforts `run --variant` accepts for that model
    // (opencode 2 has no --verbose: plain ids below, no efforts).
    const out = await quietOutput(BIN, ['models', '--verbose']);
    const models = [];
    for (const [, id, json] of out.matchAll(/^([\w.-]+\/\S+)\n(\{[\s\S]*?\n\})$/gm)) {
      let efforts = [];
      try {
        efforts = Object.keys(JSON.parse(json).variants || {});
      } catch {}
      models.push({ id, label: id.split('/').slice(1).join('/'), hint: id.split('/')[0], efforts });
    }
    if (!models.length) {
      // Older builds without --verbose: plain ids, one per line.
      for (const l of (await quietOutput(BIN, ['models'])).split('\n').map((x) => x.trim())) {
        if (/^[\w.-]+\/\S+$/.test(l)) models.push({ id: l, label: l.split('/').slice(1).join('/'), hint: l.split('/')[0] });
      }
    }
    return { ...found, models: [this.models[0], ...models], hasKey: hasKey(await quietOutput(BIN, ['auth', 'list'])) };
  },

  // grants: { permission, patterns } the user allowed after `run` rejected them, for this turn.
  // fork: continue a copy of resumeId's session instead of the session itself (/btw).
  run({ prompt, attachments = [], cwd, resumeId, fork = false, mode, model, effort, systemPrompt, mcpServers = {}, delegating = false, grants = [], onEvent }) {
    // The prompt goes on stdin; `run` appends piped stdin to the (empty) message.
    // Errors to stderr: the only place a rate limit shows up (see RATE_LIMITED).
    const args = ['run', '--format', 'json', '--print-logs', '--log-level', V2 ? 'error' : 'ERROR'];
    if (mode === 'plan') args.push('--agent', 'plan');
    if (mode === 'auto') args.push('--auto');
    if (model) args.push('--model', V2 && effort ? `${model}#${effort}` : model);
    if (model && effort && !V2) args.push('--variant', effort);
    if (resumeId) args.push('--session', resumeId);
    if (resumeId && fork) args.push('--fork');
    for (const a of attachments) args.push('--file', a.path);

    // Inject the ask_user server through inline config, merged over the user's own.
    const mcp = {};
    for (const [name, srv] of Object.entries(mcpServers)) {
      mcp[name] = { type: 'local', command: [srv.command, ...(srv.args || [])], environment: srv.env || {}, enabled: true, timeout: ASK_TIMEOUT_MS };
    }
    const env = { ...process.env };
    const allow = grants.filter((g) => g && typeof g.permission === 'string' && Array.isArray(g.patterns));
    if (Object.keys(mcp).length || allow.length) {
      const inline = env.OPENCODE_CONFIG_CONTENT ? safeJson(env.OPENCODE_CONFIG_CONTENT) : {};
      const permission = typeof inline.permission === 'object' ? { ...inline.permission } : inline.permission ? { '*': inline.permission } : {};
      // Its built-in `task` subagents would bypass the user's team.
      if (delegating) permission.task = 'deny';
      for (const g of allow) {
        const was = permission[g.permission];
        permission[g.permission] = { ...(typeof was === 'object' ? was : was && { '*': was }), ...Object.fromEntries(g.patterns.map((p) => [String(p), 'allow'])) };
      }
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        ...inline,
        ...(Object.keys(mcp).length && { mcp: { ...inline.mcp, ...mcp }, experimental: { ...inline.experimental, mcp_timeout: ASK_TIMEOUT_MS } }),
        ...(Object.keys(permission).length && { permission }),
      });
    }

    const input = withProtocol(prompt, systemPrompt, resumeId) + attachmentNote(attachments, 'They are also attached to this message');
    const files = fileTracker(cwd);
    const started = Date.now();
    let session = null;
    let lastMsg = null; // messageID of the latest assistant text
    let text = [];
    let error = null;
    const tokens = { input: 0, output: 0 };
    let cost = 0;

    let limitTimer = null;
    let limited = false;
    let carry = ''; // a stderr line still being written
    const proc = spawnJsonl({
      bin: BIN,
      args,
      cwd,
      env,
      input,
      onEvent,
      onStderr(chunk) {
        // Whole lines only: a chunk can end mid-line.
        const lines = (carry + chunk).split('\n');
        carry = lines.pop();
        for (const [, permission, list] of lines.join('\n').replace(ANSI, '').matchAll(REJECTED)) {
          const patterns = list.split(', ').filter(Boolean);
          onEvent({ type: 'blocked', tool: permission, detail: patterns.join(', '), rule: { permission, patterns } });
        }
        if (limitTimer || limited || !RATE_LIMITED.test(chunk)) return;
        limitTimer = setTimeout(() => ((limited = true), proc.stop()), rateLimitGrace());
      },
      onJson(msg) {
        // Anything coming through means a retry got an answer.
        if (limitTimer && msg.type !== 'error') (clearTimeout(limitTimer), (limitTimer = null));
        if (msg.sessionID && msg.sessionID !== session) onEvent({ type: 'session', id: (session = msg.sessionID) });
        const part = msg.part || {};
        switch (msg.type) {
          case 'text':
            if (!part.text?.trim()) break;
            // The final answer is the text of the last assistant message.
            if (part.messageID !== lastMsg) ((lastMsg = part.messageID), (text = []));
            text.push(part.text);
            onEvent({ type: 'text', text: part.text });
            break;
          case 'reasoning':
            onEvent({ type: 'thinking' });
            break;
          case 'tool_use': {
            // Emitted once the tool has finished, with its input and output.
            const state = part.state || {};
            const input = state.input || {};
            onEvent({ type: 'tool', ...describeTool(part.tool, input, cwd), ...(state.status !== 'error' && typeof state.output === 'string' && { output: state.output }) });
            if (state.status === 'error') onEvent({ type: 'tool_error', name: part.tool, text: clip(state.error || state.output, 400) });
            else {
              for (const change of captureChanges(part.tool, input, state.metadata || {}, cwd, files)) onEvent({ type: 'change', ...change });
            }
            break;
          }
          case 'step_finish':
            tokens.input += part.tokens?.input || 0;
            tokens.output += part.tokens?.output || 0;
            cost += part.cost || 0;
            break;
          case 'error':
            error = msg.error?.data?.message || msg.error?.message || msg.error?.name || 'opencode reported an error.';
            break;
        }
      },
      onClose({ code, signal, stderr, stopped }) {
        clearTimeout(limitTimer);
        if (limited) {
          const which = model ? `\`${model}\`` : 'opencode’s default model';
          return onEvent({ type: 'result', isError: true, text: `${which} is rate-limited right now: opencode kept retrying for ${Math.round(rateLimitGrace() / 1000)}s without an answer. Try again in a few minutes, pick another model, or connect your own provider with \`opencode auth login\`.`, stats: { durationMs: Date.now() - started } });
        }
        const ok = code === 0 && !error;
        onEvent({
          type: 'result',
          isError: !ok,
          stopped,
          text: ok ? text.join('\n') : error || lastLoggedError(stderr) || exitText('opencode', code, signal),
          stats: { durationMs: Date.now() - started, costUsd: cost || undefined, inputTokens: tokens.input, outputTokens: tokens.output },
        });
      },
    });
    return proc;
  },
};

// stderr with --print-logs: the last logged error's message, else stderr as it is.
const lastLoggedError = (stderr) => [...stderr.matchAll(/error\.error="((?:[^"\\]|\\.)*)"/g)].at(-1)?.[1] || stderr;

function safeJson(s) {
  try {
    return JSON.parse(s) || {};
  } catch {
    return {};
  }
}

function describeTool(name, input, cwd) {
  const f = rel(input.filePath || input.path, cwd);
  switch (name) {
    case 'read':
      return { kind: 'read', label: `Reading ${f}`, file: f };
    case 'edit':
    case 'patch':
    case 'apply_patch':
    case 'multiedit':
      return { kind: 'edit', label: f ? `Editing ${f}` : 'Editing files', file: f || undefined };
    case 'write':
      return { kind: 'edit', label: `Writing ${f}`, file: f };
    case 'bash':
    case 'shell':
      return { kind: 'run', label: input.description ? clip(input.description) : describeCommand(input.command, cwd), detail: input.command };
    case 'grep':
      return { kind: 'search', label: `Searching for “${clip(input.pattern, 40)}”` };
    case 'glob':
    case 'list':
      return { kind: 'search', label: input.pattern ? `Finding ${clip(input.pattern, 50)}` : `Listing ${f || '.'}` };
    case 'webfetch':
      return { kind: 'web', label: `Reading ${clip(input.url, 60)}` };
    case 'websearch':
      return { kind: 'web', label: `Searching the web: ${clip(input.query, 50)}` };
    case 'task':
      return { kind: 'agent', label: `Delegating: ${clip(input.description || input.prompt, 60)}` };
    case 'todowrite': {
      const active = input.todos?.find((t) => t.status === 'in_progress');
      return { kind: 'plan', label: active ? clip(active.content) : 'Planning' };
    }
    case 'wisp_ask_user':
      return { kind: 'wait', label: 'Waiting for your answer' };
    case 'wisp_delegate':
      return { kind: 'agent', label: `Delegated to ${clip([...new Set((input.tasks || []).map((t) => t.subagent))].join(', ') || 'subagents', 60)}` };
    case 'wisp_subagent_results':
      return { kind: 'agent', label: 'Collected subagent reports' };
    case 'wisp_wisp_tag':
      return { kind: 'tool', label: `Tagging the task${input?.tags?.length ? `: ${clip(input.tags.map((t) => `#${t}`).join(' '), 60)}` : ''}` };
    case 'wisp_wisp_pr':
      return { kind: 'tool', label: input?.remove ? 'Detaching a PR' : `Attaching PR ${clip(String(input?.pr || '').replace(/^https:\/\/github\.com\//, ''), 60)}` };
    case 'wisp_wisp_save':
      return { kind: 'tool', label: `${input?.id ? 'Updating' : 'Saving'} ${clip(String(input?.title || input?.name || String(input?.app || input?.path || input?.url || '').split(/[\\/]/).pop() || 'it'), 50)} ${input?.id ? 'in' : 'to'} My Stuff` };
    case 'wisp_wisp_stuff':
      return { kind: 'tool', label: 'Looking in My Stuff' };
    case 'wisp_wisp_blocks':
      return { kind: 'tool', label: 'Reading block formats' };
    case 'wisp_wisp_stats':
      return { kind: 'tool', label: 'Reading wisp stats' };
    case 'wisp_wisp_sessions':
      return { kind: 'tool', label: 'Listing wisp tasks' };
    case 'wisp_wisp_session':
      return { kind: 'tool', label: `Reading wisp task ${clip(input?.id || '', 40)}` };
    default:
      return crewToolLabel(name.replace(/^wisp_/, ''), input) || { kind: 'tool', label: `Using ${name.replace(/_/g, ' ')}` };
  }
}

// opencode reports tools after they ran. Edits carry old/new strings (key names vary across
// versions); anything else is diffed against the tracker's snapshot of the file.
function captureChanges(tool, input, meta, cwd, files) {
  const file = input.filePath || input.path;
  const before = input.oldString ?? input.old_string;
  if (tool === 'edit' && file && typeof before === 'string') {
    files.change(file); // keep the tracker's snapshot current for later writes
    return [{ file: rel(file, cwd), op: 'edit', edits: [{ before, after: input.newString ?? input.new_string ?? '' }] }];
  }
  let paths = [];
  if (['write', 'edit', 'multiedit'].includes(tool) && file) paths = [file];
  else if (tool === 'patch' || tool === 'apply_patch') {
    const listed = (meta.files || []).map((x) => (typeof x === 'string' ? x : x.filePath || x.file));
    paths = [...new Set([...listed, ...patchPaths(input.patchText || input.patch || '')])].filter((p) => typeof p === 'string');
  }
  return paths.map((p) => files.change(p)).filter(Boolean);
}

function patchPaths(text) {
  return [...String(text).matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
}
