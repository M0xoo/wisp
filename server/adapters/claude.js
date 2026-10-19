// Claude Code adapter — drives `claude -p --output-format stream-json`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ASK_TIMEOUT_MS, MAX_SNAPSHOT, attachmentNote, clip, detectVersion, exitText, flatten, rel, spawnJsonl } from './common.js';
import { describeCommand } from './commands.js';

const BIN = process.env.WISP_CLAUDE_BIN || 'claude';

// Claude in Chrome turns itself on only in interactive sessions; `-p` needs --chrome. Follow the
// user's own "enabled by default" choice (/chrome in Claude Code) so a wisp run gets the same tools.
// WISP_CLAUDE_CHROME=1/0 overrides it.
export function chromeEnabled(env = process.env) {
  if (env.WISP_CLAUDE_CHROME) return env.WISP_CLAUDE_CHROME !== '0';
  const file = env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).claudeInChromeDefaultEnabled === true;
  } catch {
    return false;
  }
}

const PERMISSION_MODES = {
  plan: 'plan',
  edits: 'acceptEdits',
  auto: 'bypassPermissions',
};

export default {
  id: 'claude',
  name: 'Claude Code',
  // Asks wisp before a tool call its permission mode won't allow on its own (Edits mode).
  approveTool: 'mcp__wisp__approve',
  models: [
    { id: '', label: 'Default', hint: 'Whatever Claude Code is set to' },
    { id: 'opus', label: 'Opus', hint: 'Most capable, for hard problems' },
    { id: 'sonnet', label: 'Sonnet', hint: 'Fast and smart, everyday work' },
    { id: 'haiku', label: 'Haiku', hint: 'Fastest, for quick tasks' },
  ],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],

  // Interactive command to take over a session in a terminal.
  resumeCommand({ resumeId, model, effort }) {
    return [BIN, ...(resumeId ? ['--resume', resumeId] : []), ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
  },

  detect() {
    return detectVersion(BIN);
  },

  // What a permission prompt is about, for the approval card and for matching "always allow".
  permission(tool, input, cwd) {
    return { tool, action: actionOf(tool, input, cwd), detail: detailOf(tool, input, cwd), why: tool === 'Bash' ? input.description || '' : '' };
  },

  // Returns { stop(), done: Promise<void> }. Everything else is reported through onEvent.
  // grants: --allowedTools rules (Bash(npm publish)) for what the user allowed after a denial.
  run({ prompt, attachments = [], cwd, resumeId, mode, model, effort, systemPrompt, mcpServers = {}, delegating = false, grants = [], onEvent }) {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--append-system-prompt', systemPrompt,
      '--permission-mode', PERMISSION_MODES[mode] || 'acceptEdits',
    ];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (chromeEnabled()) args.push('--chrome');
    if (resumeId) args.push('--resume', resumeId);
    if (Object.keys(mcpServers).length) args.push('--mcp-config', JSON.stringify({ mcpServers }));
    // In Edits mode, what would prompt goes to wisp's approve tool (the user decides) instead of being denied.
    if (mcpServers.wisp && mode === 'edits') args.push('--permission-prompt-tool', this.approveTool);
    const allowed = [...Object.keys(mcpServers).map((n) => `mcp__${n}`), ...grants.filter((g) => typeof g === 'string')];
    if (allowed.length) args.push('--allowedTools', ...allowed);
    // Its built-in subagents (Task, or Agent in newer versions) would bypass the user's team.
    if (delegating) args.push('--disallowedTools', 'Task', 'Agent', 'Workflow');
    const dirs = [...new Set(attachments.map((a) => path.dirname(a.path)))];
    if (dirs.length) args.push('--add-dir', ...dirs);
    args.push('--verbose'); // terminates the variadic flags above
    prompt += attachmentNote(attachments, 'Read images and PDFs with the Read tool');

    const env = { ...process.env };
    delete env.CLAUDECODE; // don't let a parent Claude Code session leak into the child
    delete env.CLAUDE_CODE_ENTRYPOINT;
    env.MCP_TOOL_TIMEOUT ??= String(ASK_TIMEOUT_MS);

    let sawResult = false;
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

    const onJson = (msg) => {
      if (msg.session_id) onEvent({ type: 'session', id: msg.session_id });

      if (msg.type === 'assistant') {
        for (const part of msg.message?.content || []) {
          if (part.type === 'text' && part.text.trim()) {
            onEvent({ type: 'text', text: part.text });
          } else if (part.type === 'thinking') {
            onEvent({ type: 'thinking' });
          } else if (part.type === 'tool_use') {
            pendingTools.set(part.id, part.name);
            onEvent({ type: 'tool', ...describeTool(part.name, part.input || {}, cwd) });
            const change = captureChange(part.name, part.input || {}, cwd);
            if (change) onEvent({ type: 'change', ...change });
          }
        }
      } else if (msg.type === 'user') {
        for (const part of msg.message?.content || []) {
          if (part.type === 'tool_result' && part.is_error) {
            const name = pendingTools.get(part.tool_use_id);
            onEvent({ type: 'tool_error', name, text: flatten(part.content).slice(0, 400) });
          }
        }
      } else if (msg.type === 'system') {
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
        const ev = resultEvent(msg);
        // On --resume, background tasks the last run left behind come back as a task
        // notification queued ahead of our prompt. The CLI answers it with an empty,
        // zero-turn result, then goes on to the prompt and reports a second result. Ending the
        // turn on the first one would drop the real answer, so hold it in case it's all we get.
        if (!ev.isError && !ev.text.trim() && !msg.num_turns) {
          early = ev;
          return;
        }
        sawResult = true;
        // Refused tool calls (no approve tool here, or the user said no): the card offers a retry.
        for (const d of msg.permission_denials || []) {
          const input = d.tool_input || {};
          onEvent({ type: 'blocked', tool: d.tool_name, detail: detailOf(d.tool_name, input, cwd), rule: ruleOf(d.tool_name, input) });
        }
        onEvent({ ...ev, background: background.size }); // > 0: another turn and result follow when they finish
      }
    };

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




function resultEvent(msg) {
  return {
    type: 'result',
    text: msg.result ?? '',
    isError: !!msg.is_error || (msg.subtype && msg.subtype !== 'success'),
    stats: {
      costUsd: msg.total_cost_usd,
      durationMs: msg.duration_ms,
      turns: msg.num_turns,
      inputTokens: msg.usage?.input_tokens,
      outputTokens: msg.usage?.output_tokens,
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
    case 'mcp__wisp__ask_user':
      return { kind: 'wait', label: 'Waiting for your answer' };
    case 'mcp__wisp__delegate':
      return { kind: 'agent', label: `Delegating to ${clip([...new Set((input.tasks || []).map((t) => t.subagent))].join(', ') || 'subagents', 60)}` };
    case 'mcp__wisp__subagent_results':
      return { kind: 'agent', label: 'Waiting on subagents' };
    case 'mcp__wisp__wisp_stats':
      return { kind: 'tool', label: 'Reading wisp stats' };
    case 'mcp__wisp__wisp_sessions':
      return { kind: 'tool', label: 'Listing wisp tasks' };
    case 'mcp__wisp__wisp_session':
      return { kind: 'tool', label: `Reading wisp task ${clip(input?.id || '', 40)}` };
    default:
      return { kind: 'tool', label: name.startsWith('mcp__') ? `Using ${name.split('__').slice(1).join(' · ')}` : `Using ${name}` };
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

