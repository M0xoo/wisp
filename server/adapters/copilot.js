// GitHub Copilot CLI adapter — drives `copilot --output-format json` (JSONL session events:
// assistant.message, tool.execution_start / _complete, permission.*, …, then one `result` line).
//
// The prompt goes in on stdin, copilot's other non-interactive input next to -p, so a long task
// isn't cut by argv limits. copilot has no system-prompt flag: the protocol goes in front of the
// first message. wisp's MCP server goes in with --additional-mcp-config, and the model sees its
// tools as `wisp-ask_user`, `wisp-delegate`, …. copilot can't hand a permission prompt to a tool,
// so what its permissions refuse comes back as `blocked`, with --allow-tool rules for the retry.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ASK_TIMEOUT_MS, attachmentNote, clip, crewToolLabel, detectVersion, exitText, fileTracker, helpEfforts, helpText, quietOutput, rel, spawnJsonl, withProtocol } from './common.js';
import { describeCommand } from './commands.js';

const BIN = process.env.WISP_COPILOT_BIN || 'copilot';
const IMAGE = /^image\/(png|jpe?g|gif|webp)$/;

// Edits: file writes need no approval, anything else goes by copilot's own permissions (which a
// headless run can't ask about, so it's refused). Plan: its plan mode, with nothing allowed but reading.
const MODE_ARGS = {
  plan: ['--mode', 'plan'],
  edits: ['--allow-tool=write'],
  auto: ['--allow-all'],
};

// The `result` line comes as copilot shuts down; the usage file may land just after it. Give the
// process this long to exit before the turn ends without it.
const EXIT_GRACE_MS = 1500;

// copilot's usage file counts the whole session, follow-ups included: the totals the last turn of
// each session ended on, so a follow-up reports only its own share.
const totals = new Map();

export default {
  id: 'copilot',
  name: 'Copilot',
  askTool: 'wisp-ask_user',
  models: [{ id: '', label: 'Default', hint: 'Whatever Copilot is set to' }],
  efforts: ['low', 'medium', 'high', 'xhigh'],

  resumeCommand({ resumeId, model, effort }) {
    return [BIN, ...(resumeId ? [`--resume=${resumeId}`] : []), ...(model ? ['--model', model] : []), ...(effort ? ['--reasoning-effort', effort] : [])];
  },

  // How to get it, shown in Settings → Agents and the picker while it isn't found (this OS's steps).
  setup() {
    return { tip: 'Install the GitHub Copilot CLI, then run copilot login. It needs a GitHub Copilot plan', command: 'npm i -g @github/copilot', url: 'https://github.com/features/copilot/cli' };
  },

  async detect() {
    const found = await detectVersion(BIN);
    if (!found.available) return found;
    const [config, help] = await Promise.all([quietOutput(BIN, ['help', 'config']), helpText(BIN)]);
    const ids = modelIds(config);
    const efforts = helpEfforts(help);
    return { ...found, ...(efforts.length && { efforts }), ...(ids.length && { models: [this.models[0], ...ids.map((id) => ({ id, label: modelLabel(id), hint: id }))] }) };
  },

  // grants: --allow-tool rules (shell(npm publish)) for what the user allowed after a refusal.
  // dirs: the task's other folders, which it may read and edit like cwd.
  run({ prompt, attachments = [], cwd, dirs: extra = [], resumeId, mode, model, effort, systemPrompt, mcpServers = {}, delegating = false, grants = [], onEvent }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-copilot-'));
    const usageFile = path.join(tmp, 'usage.json');
    // A new session gets an id up front, so a follow-up can resume it even if this run dies early.
    const session = resumeId || crypto.randomUUID();
    const args = ['--output-format', 'json', ...(MODE_ARGS[mode] || MODE_ARGS.edits)];
    args.push(...(resumeId ? [`--resume=${resumeId}`] : ['--session-id', session]));
    if (model) args.push('--model', model);
    if (effort) args.push('--reasoning-effort', effort);
    // A headless run can't answer copilot's own question tool; wisp's ask_user (or a question block) replaces it.
    args.push('--no-ask-user', '--usage-output-file', usageFile);
    if (Object.keys(mcpServers).length) {
      const servers = Object.fromEntries(Object.entries(mcpServers).map(([name, srv]) => [name, { type: 'local', command: srv.command, args: srv.args || [], env: srv.env || {}, tools: ['*'], timeout: ASK_TIMEOUT_MS }]));
      args.push('--additional-mcp-config', JSON.stringify({ mcpServers: servers }));
      // Its permissions would refuse an MCP call outside Full auto: wisp's own tools need no asking.
      for (const name of Object.keys(servers)) args.push(`--allow-tool=${name}`);
    }
    // The --allow-tool / --deny-tool lists take several values: one per flag, joined with `=`.
    for (const rule of grants.flat()) if (typeof rule === 'string' && rule) args.push(`--allow-tool=${rule}`);
    // Its built-in subagents (task) would bypass the user's team.
    if (delegating) args.push('--excluded-tools=task');
    const images = attachments.filter((a) => IMAGE.test(a.mime));
    for (const img of images) args.push('--attachment', img.path);
    for (const d of new Set([...extra, ...attachments.map((a) => path.dirname(a.path))])) args.push('--add-dir', d);

    const input = withProtocol(prompt, systemPrompt, resumeId) + attachmentNote(attachments.filter((a) => !images.includes(a)), 'Read them with your view tool');
    const env = { ...process.env };
    // COPILOT_ALLOW_ALL in the user's shell would lift the permission mode wisp picked.
    if (mode !== 'auto') delete env.COPILOT_ALLOW_ALL;

    const files = fileTracker(cwd);
    const calls = new Map(); // toolCallId -> { name, args }
    const asks = new Map(); // permission requestId -> what it asked for
    const started = Date.now();
    let announced = null;
    let lastText = '';
    let error = null;
    let result = null; // the `result` line
    let ended = false;
    let grace = null;

    const announce = (id) => {
      if (id && id !== announced) onEvent({ type: 'session', id: (announced = id) });
    };
    const end = (ev) => {
      if (ended) return;
      ended = true;
      clearTimeout(grace);
      onEvent(ev);
    };
    const finish = () => {
      const exit = result.exitCode ?? 0;
      const ok = exit === 0 && !error;
      end({
        type: 'result',
        isError: !ok,
        text: ok ? lastText : error || exitText('copilot', exit, null),
        stats: { durationMs: result.usage?.sessionDurationMs ?? Date.now() - started, ...tokensOf(readUsage(usageFile), resumeId, result.sessionId || session) },
      });
    };

    const handle = spawnJsonl({
      bin: BIN,
      args,
      cwd,
      env,
      input,
      onEvent,
      onJson(msg) {
        announce(session); // it's up: this session exists now
        if (msg.type === 'result') {
          result = msg;
          announce(msg.sessionId);
          grace = setTimeout(finish, EXIT_GRACE_MS);
          return;
        }
        // Subagents' events carry their agent id: only the main conversation is shown.
        const d = msg.data || {};
        if (msg.agentId || d.parentToolCallId) return;
        switch (msg.type) {
          case 'assistant.message':
            if (d.content?.trim()) onEvent({ type: 'text', text: (lastText = d.content) });
            break;
          case 'assistant.reasoning':
            onEvent({ type: 'thinking' });
            break;
          case 'tool.execution_start': {
            const name = String(d.toolName || '');
            const a = d.arguments && typeof d.arguments === 'object' ? d.arguments : {};
            calls.set(d.toolCallId, { name, args: a });
            if ((name === 'edit' || name === 'create') && a.path) files.remember(a.path);
            onEvent({ type: 'tool', id: d.toolCallId, ...(d.mcpServerName ? describeMcp(d.mcpServerName, d.mcpToolName || name, a) : describeTool(name, a, cwd)) });
            break;
          }
          case 'tool.execution_complete': {
            const call = calls.get(d.toolCallId);
            calls.delete(d.toolCallId);
            if (!call) break;
            if (d.success === false) {
              onEvent({ type: 'tool_error', name: call.name, text: clip(d.error?.message || d.result?.content || 'failed', 400) });
              break;
            }
            const change = captureChange(call.name, call.args, cwd, files);
            if (change) onEvent({ type: 'change', ...change });
            else if (d.result?.content) onEvent({ type: 'tool_output', id: d.toolCallId, text: String(d.result.content) });
            break;
          }
          case 'permission.requested':
            asks.set(d.requestId, d.permissionRequest || {});
            break;
          case 'permission.completed': {
            const ask = asks.get(d.requestId);
            asks.delete(d.requestId);
            // Refused because nobody could be asked: the card offers to retry with it allowed. A
            // rule the user wrote (denied-by-rules) stays refused.
            if (ask && /could-not-request/.test(d.result?.kind || '')) onEvent({ type: 'blocked', ...blockedOf(ask, cwd) });
            break;
          }
          case 'session.warning':
            // An organization policy can turn third-party MCP servers off, wisp's among them.
            if (d.warningType === 'mcp' && /'wisp'/.test(d.message || '')) onEvent({ type: 'tool_error', name: 'wisp', text: `${d.message} Copilot can't reach wisp's ask_user, so it can't ask you mid-run.` });
            break;
          case 'session.error':
            // model_call errors are single requests copilot retries itself.
            if (d.errorType !== 'model_call') error = d.message || d.errorType || 'Copilot reported an error.';
            break;
        }
      },
      onClose({ code, signal, stderr, stopped }) {
        if (result && !stopped) return finish();
        end({ type: 'result', isError: true, stopped, text: error || stderr || exitText('copilot', code, signal) });
      },
    });
    handle.done.finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
    return handle;
  },
};

// `copilot help config` lists the models it accepts under the `model` setting: `    - "id"` lines.
export function modelIds(text) {
  const at = text.search(/^[ \t]*`model`:/m);
  if (at < 0) return [];
  const ids = [];
  for (const line of text.slice(at).split('\n').slice(1)) {
    const m = line.match(/^\s+- "([\w.\-/:]+)"\s*$/);
    if (!m) break;
    ids.push(m[1]);
  }
  return ids;
}

// claude-opus-5.5 → Claude Opus 5.5, gpt-6.1-sol → GPT-6.1 Sol, mai-code-1.1-flash → MAI Code 1.1 Flash.
export const modelLabel = (id) =>
  id
    .split('-')
    .map((w) => (w === 'gpt' || w === 'mai' ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
    .replace(/^GPT (\d)/, 'GPT-$1');

function readUsage(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// This turn's tokens: the session's totals, less what earlier turns already reported. A follow-up
// whose earlier totals wisp didn't see (it restarted) reports none rather than the whole session.
function tokensOf(usage, resumeId, session) {
  const metrics = Object.values(usage?.modelMetrics || {}).map((m) => m?.usage || {});
  if (!metrics.length) return {};
  const now = { input: 0, output: 0 };
  for (const u of metrics) (now.input += u.inputTokens || 0), (now.output += u.outputTokens || 0);
  const before = resumeId ? totals.get(resumeId) : { input: 0, output: 0 };
  totals.set(session, now);
  if (!before || now.input < before.input) return {};
  return { inputTokens: now.input - before.input, outputTokens: now.output - before.output };
}

function describeTool(name, a, cwd) {
  const f = rel(a.path, cwd);
  switch (name) {
    case 'view':
      return isDir(a.path, cwd) ? { kind: 'search', label: `Listing ${f || '.'}` } : { kind: 'read', label: `Reading ${f}`, file: f };
    case 'create':
      return { kind: 'edit', label: `Writing ${f}`, file: f };
    case 'edit':
      return { kind: 'edit', label: `Editing ${f}`, file: f };
    case 'bash':
    case 'powershell': // its shell tool on Windows
      return { kind: 'run', label: a.description ? clip(a.description) : describeCommand(a.command, cwd), detail: a.command };
    case 'read_bash':
    case 'read_powershell':
      return { kind: 'run', label: 'Reading command output' };
    case 'write_bash':
    case 'write_powershell':
      return { kind: 'run', label: 'Typing into a running command' };
    case 'stop_bash':
    case 'stop_powershell':
      return { kind: 'run', label: 'Stopping a command' };
    case 'list_bash':
    case 'list_powershell':
      return { kind: 'run', label: 'Checking running commands' };
    case 'grep':
      return { kind: 'search', label: `Searching for “${clip(a.pattern, 40)}”` };
    case 'glob':
      return { kind: 'search', label: `Finding ${clip(a.pattern, 50)}` };
    case 'search_code_subagent':
      return { kind: 'search', label: a.query ? `Searching the codebase: ${clip(a.query, 50)}` : 'Searching the codebase' };
    case 'web_fetch':
      return { kind: 'web', label: `Reading ${clip(a.url, 60)}` };
    case 'web_search':
      return { kind: 'web', label: `Searching the web: ${clip(a.query, 50)}` };
    case 'task':
      return { kind: 'agent', label: `Delegating: ${clip(a.description || a.prompt, 60)}` };
    case 'read_agent':
    case 'list_agents':
    case 'write_agent':
      return { kind: 'agent', label: 'Checking on its subagents' };
    case 'skill':
      return { kind: 'tool', label: 'Using a skill' };
    default:
      return { kind: 'tool', label: `Using ${name.replace(/_/g, ' ') || 'a tool'}` };
  }
}

function isDir(p, cwd) {
  try {
    return !!p && fs.statSync(path.resolve(cwd, p)).isDirectory();
  } catch {
    return false;
  }
}

function describeMcp(server, tool, input) {
  if (server !== 'wisp') return { kind: 'tool', label: `Using ${server} · ${tool.replace(`${server}-`, '')}` };
  switch (tool.replace(/^wisp-/, '')) {
    case 'ask_user':
      return { kind: 'wait', label: 'Waiting for your answer' };
    case 'delegate':
      return { kind: 'agent', label: `Delegating to ${clip([...new Set((input.tasks || []).map((t) => t.subagent))].join(', ') || 'subagents', 60)}` };
    case 'subagent_results':
      return { kind: 'agent', label: 'Waiting on subagents' };
    case 'wisp_tag':
      return { kind: 'tool', label: `Tagging the task${input?.tags?.length ? `: ${clip(input.tags.map((t) => `#${t}`).join(' '), 60)}` : ''}` };
    case 'wisp_stats':
      return { kind: 'tool', label: 'Reading wisp stats' };
    case 'wisp_sessions':
      return { kind: 'tool', label: 'Listing wisp tasks' };
    case 'wisp_session':
      return { kind: 'tool', label: `Reading wisp task ${clip(input?.id || '', 40)}` };
    default:
      return crewToolLabel(tool, input) || { kind: 'tool', label: `Using wisp · ${tool}` };
  }
}

// What a refused permission request was for, with the --allow-tool rules that allow exactly it.
// A shell request names each command it runs (`git add`, `npm publish`); a request with no rule
// to scope it (a path outside the project) retries in Full auto.
function blockedOf(ask, cwd) {
  switch (ask.kind) {
    case 'shell': {
      const ids = (ask.commands || []).map((c) => (typeof c === 'string' ? c : c?.identifier)).filter(Boolean);
      return { tool: 'shell', detail: String(ask.fullCommandText ?? ids.join(' && ')), ...(ids.length && { rule: ids.map((c) => `shell(${c})`) }) };
    }
    case 'write':
      return { tool: 'write', detail: rel(ask.fileName, cwd), ...(ask.fileName && { rule: [`write(${ask.fileName})`] }) };
    case 'url':
      return { tool: 'url', detail: String(ask.url ?? ''), ...(ask.url && { rule: [`url(${ask.url})`] }) };
    case 'mcp':
      return { tool: String(ask.serverName || 'mcp'), detail: String(ask.toolName ?? ''), ...(ask.serverName && ask.toolName && { rule: [`${ask.serverName}(${ask.toolName})`] }) };
    default:
      return { tool: String(ask.kind || 'tool'), detail: rel(ask.path, cwd) || String(ask.toolName ?? '') };
  }
}

// Called once a tool succeeded. `edit` names the text it replaced; `create` (and an edit without
// it) is read back from disk, with the tracker supplying the side before the write.
function captureChange(name, a, cwd, files) {
  if (!a.path || (name !== 'edit' && name !== 'create')) return null;
  if (name === 'edit' && typeof a.old_str === 'string' && a.old_str) {
    files.change(a.path); // keep the tracker's snapshot current for later writes
    return { file: rel(a.path, cwd), op: 'edit', edits: [{ before: a.old_str, after: a.new_str ?? '' }] };
  }
  return files.change(a.path);
}
