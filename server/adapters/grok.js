// Grok Build adapter — drives `grok --prompt-file … --output-format streaming-messages-json`
// (Claude Code's stream-json shape, with grok's own tool names).
//
// grok has no flag for an extra MCP server (and its GROK_CONFIG overlay can't add one), but an
// agent definition passed with `--agent <file>` can declare `mcpServers`. So each turn writes a
// throwaway agent file that inherits the full stock prompt and only adds wisp's server; the model
// reaches it through grok's `use_tool` as `wisp__ask_user`. The protocol goes in with `--rules`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ASK_TIMEOUT_MS, attachmentNote, clip, crewToolLabel, detectVersion, exitText, fileTracker, flatten, quietOutput, rel, spawnJsonl } from './common.js';
import { describeCommand } from './commands.js';

const BIN = process.env.WISP_GROK_BIN || 'grok';

const PERMISSION_MODES = {
  plan: 'plan',
  edits: 'acceptEdits',
  auto: 'bypassPermissions',
};
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// A headless run refuses what would need approval and names it on stderr, once per call:
// "permission required: Edit calc.py was not run, as a headless run cannot ask for approval".
const REFUSED = /permission required: (\S+) ?(.*?) was not run\b/g;

export default {
  id: 'grok',
  name: 'Grok',
  askTool: 'wisp__ask_user',
  models: [{ id: '', label: 'Default', hint: 'Whatever Grok is set to' }],
  efforts: ['low', 'medium', 'high', 'xhigh'],

  resumeCommand({ resumeId, model, effort }) {
    return [BIN, ...(resumeId ? ['--resume', resumeId] : []), ...(model ? ['--model', model] : []), ...(effort ? ['--reasoning-effort', effort] : [])];
  },

  // How to get it, shown in Settings → Agents and the picker while it isn't found (this OS's steps).
  setup() {
    return { tip: 'Install Grok Build (grok) and sign in', url: 'https://x.ai/cli' };
  },

  async detect() {
    const found = await detectVersion(BIN);
    if (!found.available) return found;
    // `grok models` prints "  * grok-4.7 (default)" / "  - grok-4.6" lines.
    const out = await quietOutput(BIN, ['models']);
    const ids = [...out.matchAll(/^\s+[*-]\s+([\w.\-/:]+)/gm)].map((m) => m[1]);
    if (!ids.length) return found;
    const meta = cachedModels();
    const models = ids.map((id) => {
      const info = meta[id]?.info || {};
      const efforts = info.supports_reasoning_effort === false ? [] : effortsOf(info.reasoning_efforts);
      return { id, label: info.name || id, hint: clip(info.description || id, 60), ...(efforts && { efforts }) };
    });
    // Default runs grok's own default model ("* id"), so it takes that model's levels.
    const def = models.find((m) => m.id === out.match(/^\s+\*\s+([\w.\-/:]+)/m)?.[1]);
    return { ...found, ...(def?.efforts && { efforts: def.efforts }), models: [this.models[0], ...models] };
  },

  run({ prompt, attachments = [], cwd, resumeId, mode, model, effort, systemPrompt, mcpServers = {}, onEvent }) {
    // grok -p doesn't read stdin, and a prompt in argv is capped on Windows: hand it over as a file.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-grok-'));
    const promptFile = path.join(tmp, 'prompt.md');
    fs.writeFileSync(promptFile, prompt + attachmentNote(attachments));

    const args = [
      '--prompt-file', promptFile,
      '--output-format', 'streaming-messages-json',
      '--permission-mode', PERMISSION_MODES[mode] || 'acceptEdits',
      '--rules', systemPrompt,
      // A headless run can't answer grok's own question tool; wisp's ask_user (or a question block) replaces it.
      '--disallowed-tools', 'ask_user_question',
      '--no-auto-update',
    ];
    if (model) args.push('--model', model);
    if (effort) args.push('--reasoning-effort', effort);
    if (resumeId) args.push('--resume', resumeId);
    if (Object.keys(mcpServers).length) {
      const agentFile = path.join(tmp, 'wisp.md');
      fs.writeFileSync(agentFile, agentDefinition(mcpServers));
      args.push('--agent', agentFile);
    }

    const files = fileTracker(cwd);
    const pending = new Map(); // tool_use_id -> { name, input }
    let session = null;
    let sawResult = false;
    let error = null;
    let carry = ''; // a stderr line still being written

    const handle = spawnJsonl({
      bin: BIN,
      args,
      cwd,
      env: { ...process.env, GROK_DISABLE_AUTOUPDATER: '1' },
      onEvent,
      onStderr(chunk) {
        const lines = (carry + chunk).split('\n');
        carry = lines.pop();
        for (const [, tool, detail] of lines.join('\n').matchAll(REFUSED)) onEvent({ type: 'blocked', tool, detail: detail.replace(/ \(workflow .*\)$/, '') });
      },
      onJson(msg) {
        if (msg.session_id && msg.session_id !== session) onEvent({ type: 'session', id: (session = msg.session_id) });
        // Subagent traffic carries its parent's tool id; only the main conversation is shown.
        if (msg.parent_tool_use_id) return;
        switch (msg.type) {
          case 'assistant':
            for (const part of msg.message?.content || []) {
              if (part.type === 'text' && part.text?.trim()) onEvent({ type: 'text', text: part.text });
              else if (part.type === 'thinking') onEvent({ type: 'thinking' });
              else if (part.type === 'server_tool_use') onEvent({ type: 'tool', kind: 'web', label: `Searching the web: ${clip(part.input?.query, 50)}` });
              else if (part.type === 'tool_use') {
                const input = part.input || {};
                pending.set(part.id, { name: part.name, input });
                if (part.name === 'write' && input.file_path) files.remember(input.file_path);
                // Streamed once answered, so "waiting" would land after "You answered"; the trail has both.
                if (part.name === 'use_tool' && input.tool_name === 'wisp__ask_user') continue;
                onEvent({ type: 'tool', id: part.id, ...describeTool(part.name, input, cwd) });
              }
            }
            break;
          case 'user':
            for (const part of msg.message?.content || []) {
              if (part.type !== 'tool_result') continue;
              const call = pending.get(part.tool_use_id);
              pending.delete(part.tool_use_id);
              if (!call) continue;
              if (part.is_error) onEvent({ type: 'tool_error', name: call.name, text: clip(flatten(part.content), 400) });
              else {
                const change = captureChange(call.name, call.input, cwd, files);
                if (change) onEvent({ type: 'change', ...change });
                else onEvent({ type: 'tool_output', id: part.tool_use_id, text: flatten(part.content) });
              }
            }
            break;
          case 'result':
            sawResult = true;
            onEvent({
              type: 'result',
              text: msg.is_error ? (msg.errors || []).join('\n') || msg.result || `grok stopped: ${msg.subtype}` : msg.result ?? '',
              isError: !!msg.is_error || (msg.subtype && msg.subtype !== 'success'),
              stats: {
                costUsd: msg.total_cost_usd || undefined, // 0 means "not reported", never free
                durationMs: msg.duration_ms,
                turns: msg.num_turns,
                inputTokens: msg.usage?.input_tokens,
                outputTokens: msg.usage?.output_tokens,
              },
            });
            break;
          case 'error':
            error = msg.message || 'grok reported an error.';
            break;
        }
      },
      onClose({ code, signal, stderr, stopped }) {
        if (sawResult) return;
        onEvent({ type: 'result', isError: true, stopped, text: error || stderr || exitText('grok', code, signal) });
      },
    });
    handle.done.finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
    return handle;
  },
};

// `prompt_mode: full` keeps grok's stock system prompt; the body adds nothing.
function agentDefinition(mcpServers) {
  const servers = Object.entries(mcpServers).map(([name, srv]) => ({
    name,
    command: srv.command,
    args: srv.args || [],
    env: srv.env || {},
    tool_timeout_sec: ASK_TIMEOUT_MS / 1000,
    startup_timeout_sec: 60,
  }));
  // YAML is a superset of JSON, so JSON values need no escaping of their own.
  return `---\nname: wisp\ndescription: A task launched by wisp\nprompt_mode: full\nagents_md: true\nmcpServers: ${JSON.stringify(servers)}\n---\n`;
}

// grok caches the model catalog, with each model's reasoning levels, in $GROK_HOME.
function cachedModels() {
  try {
    const home = process.env.GROK_HOME || path.join(os.homedir(), '.grok');
    return JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8')).models || {};
  } catch {
    return {};
  }
}

function effortsOf(list) {
  if (!Array.isArray(list)) return undefined;
  const rank = (id) => (EFFORT_ORDER.includes(id) ? EFFORT_ORDER.indexOf(id) : EFFORT_ORDER.length);
  return list.map((e) => e.id).filter(Boolean).sort((a, b) => rank(a) - rank(b));
}

function describeTool(name, input, cwd) {
  const f = rel(input.target_file || input.file_path || input.path || input.target_directory, cwd);
  switch (name) {
    case 'read_file':
      return { kind: 'read', label: `Reading ${f}`, file: f };
    case 'search_replace':
      return { kind: 'edit', label: `Editing ${f}`, file: f };
    case 'write':
      return { kind: 'edit', label: `Writing ${f}`, file: f };
    case 'run_terminal_command':
    case 'run_terminal_cmd':
      return { kind: 'run', label: input.description ? clip(input.description) : describeCommand(input.command, cwd), detail: input.command };
    case 'grep':
      return { kind: 'search', label: `Searching for “${clip(input.pattern, 40)}”` };
    case 'list_dir':
      return { kind: 'search', label: `Listing ${isDir(input.target_directory, cwd) ? '.' : f || '.'}` };
    case 'web_search':
      return { kind: 'web', label: `Searching the web: ${clip(input.query, 50)}` };
    case 'web_fetch':
      return { kind: 'web', label: `Reading ${clip(input.url, 60)}` };
    case 'spawn_subagent':
    case 'task':
      return { kind: 'agent', label: `Delegating: ${clip(input.description || input.prompt, 60)}` };
    case 'todo_write': {
      const active = input.todos?.find((t) => t.status === 'in_progress' && t.content);
      return { kind: 'plan', label: active ? clip(active.content) : 'Planning' };
    }
    case 'enter_plan_mode':
    case 'exit_plan_mode':
      return { kind: 'plan', label: 'Planning' };
    case 'search_tool':
      return { kind: 'search', label: `Looking up tools: ${clip(input.query, 50)}` };
    case 'use_tool':
      return describeMcp(String(input.tool_name || ''), input.tool_input || {});
    default:
      return { kind: 'tool', label: `Using ${name.replace(/_/g, ' ')}` };
  }
}

// grok passes absolute paths, also for the project root itself (which rel() leaves as is).
function isDir(dir, cwd) {
  try {
    return !!dir && fs.realpathSync(path.resolve(cwd, dir)) === fs.realpathSync(cwd);
  } catch {
    return false;
  }
}

// MCP tools are called through `use_tool` with a `server__tool` name.
function describeMcp(tool, input) {
  switch (tool) {
    case 'wisp__ask_user':
      return { kind: 'wait', label: 'Waiting for your answer' };
    case 'wisp__delegate':
      return { kind: 'agent', label: `Delegating to ${clip([...new Set((input.tasks || []).map((t) => t.subagent))].join(', ') || 'subagents', 60)}` };
    case 'wisp__subagent_results':
      return { kind: 'agent', label: 'Waiting on subagents' };
    case 'wisp__wisp_tag':
      return { kind: 'tool', label: `Tagging the task${input?.tags?.length ? `: ${clip(input.tags.map((t) => `#${t}`).join(' '), 60)}` : ''}` };
    case 'wisp__wisp_stats':
      return { kind: 'tool', label: 'Reading wisp stats' };
    case 'wisp__wisp_sessions':
      return { kind: 'tool', label: 'Listing wisp tasks' };
    case 'wisp__wisp_session':
      return { kind: 'tool', label: `Reading wisp task ${clip(input?.id || '', 40)}` };
    default:
      return crewToolLabel(tool.replace(/^wisp__/, ''), input) || { kind: 'tool', label: `Using ${tool.split('__').join(' · ') || 'an integration'}` };
  }
}

// Called once a tool succeeded. grok may stream a batch of tool calls after running them, so the
// "before" side of a write can't come from disk at tool_use time: the tracker supplies it.
function captureChange(name, input, cwd, files) {
  const file = input.file_path;
  if (!file) return null;
  if (name === 'search_replace' && typeof input.old_string === 'string' && input.old_string) {
    files.change(file); // keep the tracker's snapshot current for later writes
    return { file: rel(file, cwd), op: 'edit', edits: [{ before: input.old_string, after: input.new_string ?? '' }] };
  }
  if (name === 'search_replace' || name === 'write') return files.change(file);
  return null;
}
