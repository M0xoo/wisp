// Codex CLI adapter — drives `codex exec --json` (JSONL thread/turn/item events).

import path from 'node:path';
import { ASK_TIMEOUT_MS, attachmentNote, clip, detectVersion, exitText, fileTracker, flatten, rel, spawnJsonl, withProtocol } from './common.js';
import { describeCommand } from './commands.js';

const BIN = process.env.WISP_CODEX_BIN || 'codex';
const IMAGE = /^image\/(png|jpe?g|gif|webp)$/;

// Codex has no "accept edits only" mode; workspace-write lets it edit the project and run
// sandboxed commands without asking, which is the closest match.
const SANDBOX = {
  plan: 'read-only',
  edits: 'workspace-write',
};

const toml = (v) =>
  Array.isArray(v) ? `[${v.map(toml).join(',')}]` : typeof v === 'object' ? `{${Object.entries(v).map(([k, x]) => `${k}=${toml(x)}`).join(',')}}` : JSON.stringify(v);

export default {
  id: 'codex',
  name: 'Codex',
  askTool: 'mcp__wisp__ask_user',
  models: [{ id: '', label: 'Default', hint: 'Whatever Codex is set to' }],
  efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],

  resumeCommand({ resumeId, model, effort }) {
    return [BIN, ...(resumeId ? ['resume', resumeId] : []), ...(model ? ['--model', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${toml(effort)}`] : [])];
  },

  detect() {
    return detectVersion(BIN);
  },

  // dirs: the task's other folders, writable like cwd.
  run({ prompt, attachments = [], cwd, dirs: extra = [], resumeId, mode, model, effort, systemPrompt, mcpServers = {}, onEvent }) {
    const args = ['exec', '--json', '--skip-git-repo-check'];
    // `resume` doesn't take --sandbox, so set it through config for both paths.
    if (mode === 'auto') args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('-c', `sandbox_mode=${toml(SANDBOX[mode] || 'workspace-write')}`);
    // `resume` doesn't take --add-dir either: the other folders are writable roots through config.
    if (extra.length && mode !== 'auto') args.push('-c', `sandbox_workspace_write.writable_roots=${toml(extra)}`);
    if (model) args.push('-m', model);
    if (effort) args.push('-c', `model_reasoning_effort=${toml(effort)}`);
    for (const [name, srv] of Object.entries(mcpServers)) {
      const key = `mcp_servers.${name}`;
      args.push('-c', `${key}.command=${toml(srv.command)}`, '-c', `${key}.args=${toml(srv.args || [])}`);
      if (srv.env) args.push('-c', `${key}.env=${toml(srv.env)}`);
      args.push('-c', `${key}.tool_timeout_sec=${ASK_TIMEOUT_MS / 1000}`);
    }
    const images = attachments.filter((a) => IMAGE.test(a.mime));
    for (const img of images) args.push('-i', img.path);
    if (!resumeId) {
      const dirs = [...new Set([...extra, ...attachments.map((a) => path.dirname(a.path))])];
      for (const d of dirs) args.push('--add-dir', d);
    }
    if (resumeId) args.push('resume', resumeId);
    // No prompt argument: codex reads it from stdin.

    let input = withProtocol(prompt, systemPrompt, resumeId);
    input += attachmentNote(attachments.filter((a) => !images.includes(a)), 'Read text files and PDFs from disk');
    if (images.length) input += `\n\n(${images.length} image${images.length > 1 ? 's are' : ' is'} attached to this message.)`;

    const files = fileTracker(cwd);
    let lastMessage = '';
    let failure = null;
    let lastError = '';
    let usage = null;
    let completed = false;
    const started = Date.now();

    const onItem = (item, phase) => {
      const type = item.type || item.item_type;
      if (phase === 'started') {
        if (type === 'command_execution') {
          onEvent({ type: 'tool', id: item.id, kind: 'run', label: describeCommand(unwrapShell(item.command), cwd), detail: item.command });
        } else if (type === 'mcp_tool_call') {
          onEvent({ type: 'tool', id: item.id, ...describeMcp(item) });
        } else if (type === 'web_search') {
          onEvent({ type: 'tool', kind: 'web', label: item.query ? `Searching the web: ${clip(item.query, 50)}` : 'Searching the web' });
        }
        return;
      }
      if (phase === 'updated') {
        if (type === 'todo_list') {
          const next = item.items?.find((t) => !t.completed);
          if (next) onEvent({ type: 'tool', kind: 'plan', label: clip(next.text) });
        }
        return;
      }
      // completed
      switch (type) {
        case 'agent_message':
        case 'assistant_message':
          if (item.text?.trim()) {
            lastMessage = item.text;
            onEvent({ type: 'text', text: item.text });
          }
          break;
        case 'reasoning':
          onEvent({ type: 'thinking' });
          break;
        case 'command_execution':
          if (item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0)) {
            onEvent({ type: 'tool_error', name: clip(unwrapShell(item.command), 40), text: clip(item.aggregated_output || `exit ${item.exit_code}`, 400) });
          } else if (item.aggregated_output) onEvent({ type: 'tool_output', id: item.id, text: item.aggregated_output });
          break;
        case 'file_change':
          for (const c of item.changes || []) {
            const f = rel(c.path, cwd);
            onEvent({ type: 'tool', kind: 'edit', label: `${c.kind === 'add' ? 'Writing' : c.kind === 'delete' ? 'Deleting' : 'Editing'} ${f}`, file: f });
            const change = files.change(c.path);
            if (change) onEvent({ type: 'change', ...change });
          }
          if (item.status === 'failed') onEvent({ type: 'tool_error', name: 'apply_patch', text: 'The patch did not apply.' });
          break;
        case 'mcp_tool_call':
          if (item.status === 'failed') onEvent({ type: 'tool_error', name: `${item.server}.${item.tool}`, text: clip(item.error?.message || 'failed', 400) });
          else if (item.result?.content) onEvent({ type: 'tool_output', id: item.id, text: flatten(item.result.content) });
          break;
        case 'todo_list': {
          const next = item.items?.find((t) => !t.completed);
          if (next) onEvent({ type: 'tool', kind: 'plan', label: clip(next.text) });
          break;
        }
      }
    };

    return spawnJsonl({
      bin: BIN,
      args,
      cwd,
      env: process.env,
      input,
      onEvent,
      onJson(msg) {
        switch (msg.type) {
          case 'thread.started':
            if (msg.thread_id) onEvent({ type: 'session', id: msg.thread_id });
            break;
          case 'item.started':
          case 'item.updated':
          case 'item.completed':
            if (msg.item) onItem(msg.item, msg.type.slice(5));
            break;
          case 'turn.completed':
            completed = true;
            usage = msg.usage || null;
            break;
          case 'turn.failed':
            failure = msg.error?.message || 'The turn failed.';
            break;
          case 'error':
            // "Reconnecting... n/5" is transient; keep the last one in case the turn dies.
            if (msg.message) lastError = msg.message;
            break;
        }
      },
      onClose({ code, signal, stderr, stopped }) {
        const ok = completed && !failure && code === 0;
        onEvent({
          type: 'result',
          isError: !ok,
          stopped,
          text: ok ? lastMessage : failure || lastError || stderr || exitText('codex', code, signal),
          stats: {
            durationMs: Date.now() - started,
            inputTokens: usage?.input_tokens,
            outputTokens: usage?.output_tokens,
          },
        });
      },
    });
  },
};

// codex reports commands wrapped in a shell: `bash -lc '…'` on Unix, `powershell.exe -Command "…"`
// on Windows. Show the inner command.
export function unwrapShell(cmd) {
  if (Array.isArray(cmd)) {
    const i = cmd.findIndex((a) => /^(-l?c|-Command|\/c)$/i.test(a));
    return i >= 0 && i === cmd.length - 2 ? cmd.at(-1) : cmd.join(' ');
  }
  const s = String(cmd ?? '');
  const m =
    s.match(/^(?:\S*\/)?(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/) ||
    s.match(/^"?(?:[^"]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"?(?: -NoProfile| -NoLogo)* -(?:Command|c) (['"]?)([\s\S]*)\1$/i) ||
    s.match(/^"?(?:[^"]*[\\/])?cmd(?:\.exe)?"? \/[cC] (['"]?)([\s\S]*)\1$/);
  return m ? m[2] : s;
}

function describeMcp(item) {
  if (item.server === 'wisp' && item.tool === 'ask_user') return { kind: 'wait', label: 'Waiting for your answer' };
  if (item.server === 'wisp' && (item.tool === 'delegate' || item.tool === 'subagent_results')) return { kind: 'agent', label: 'Waiting on subagents' };
  if (item.server === 'wisp' && item.tool === 'wisp_stats') return { kind: 'tool', label: 'Reading wisp stats' };
  if (item.server === 'wisp' && item.tool === 'wisp_sessions') return { kind: 'tool', label: 'Listing wisp tasks' };
  if (item.server === 'wisp' && item.tool === 'wisp_session') return { kind: 'tool', label: 'Reading a wisp task' };
  return { kind: 'tool', label: `Using ${item.server} · ${item.tool}` };
}
