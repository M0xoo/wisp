// Claude Code adapter — drives `claude -p --output-format stream-json`.

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, killTree } from '../proc.js';
import { ASK_TIMEOUT_MS, MAX_SNAPSHOT, attachmentNote, clip, detectVersion, flatten, rel } from './common.js';

const BIN = process.env.WISP_CLAUDE_BIN || 'claude';

const PERMISSION_MODES = {
  plan: 'plan',
  edits: 'acceptEdits',
  auto: 'bypassPermissions',
};

export default {
  id: 'claude',
  name: 'Claude Code',
  models: [
    { id: '', label: 'Default', hint: 'Whatever Claude Code is set to' },
    { id: 'opus', label: 'Opus', hint: 'Most capable, for hard problems' },
    { id: 'sonnet', label: 'Sonnet', hint: 'Fast and smart, everyday work' },
    { id: 'haiku', label: 'Haiku', hint: 'Fastest, for quick tasks' },
  ],

  // Interactive command to take over a session in a terminal.
  resumeCommand({ resumeId, model }) {
    return [BIN, ...(resumeId ? ['--resume', resumeId] : []), ...(model ? ['--model', model] : [])];
  },

  detect() {
    return detectVersion(BIN);
  },

  // Returns { stop(), done: Promise<void> }. Everything else is reported through onEvent.
  run({ prompt, attachments = [], cwd, resumeId, mode, model, systemPrompt, mcpServers = {}, onEvent }) {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--append-system-prompt', systemPrompt,
      '--permission-mode', PERMISSION_MODES[mode] || 'acceptEdits',
    ];
    if (model) args.push('--model', model);
    if (resumeId) args.push('--resume', resumeId);
    if (Object.keys(mcpServers).length) {
      args.push('--mcp-config', JSON.stringify({ mcpServers }));
      args.push('--allowedTools', ...Object.keys(mcpServers).map((n) => `mcp__${n}`));
    }
    const dirs = [...new Set(attachments.map((a) => path.dirname(a.path)))];
    if (dirs.length) args.push('--add-dir', ...dirs);
    args.push('--verbose'); // terminates the variadic flags above
    prompt += attachmentNote(attachments, 'Read images and PDFs with the Read tool');

    const env = { ...process.env };
    delete env.CLAUDECODE; // don't let a parent Claude Code session leak into the child
    delete env.CLAUDE_CODE_ENTRYPOINT;
    env.MCP_TOOL_TIMEOUT ??= String(ASK_TIMEOUT_MS);

    const child = spawn(BIN, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(prompt);

    let sawResult = false;
    let stderr = '';
    const pendingTools = new Map(); // tool_use_id -> name, to flag failed tool results

    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-8000);
    });

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
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
      } else if (msg.type === 'result') {
        sawResult = true;
        onEvent({
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
        });
      }
    });

    let stopping = false;
    const done = new Promise((resolve) => {
      child.on('error', (err) => {
        onEvent({ type: 'result', isError: true, text: `Could not start \`${BIN}\`: ${err.message}` });
        sawResult = true;
        resolve();
      });
      child.on('close', (code, signal) => {
        if (!sawResult) {
          onEvent({
            type: 'result',
            isError: true,
            stopped: stopping || signal === 'SIGTERM' || signal === 'SIGINT',
            text: stderr.trim() || `claude exited with ${signal || `code ${code}`}`,
          });
        }
        resolve();
      });
    });

    return {
      done,
      stop() {
        stopping = true;
        killTree(child);
      },
    };
  },
};




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
      return { kind: 'run', label: input.description ? clip(input.description) : `Running ${clip(input.command, 60)}`, detail: input.command };
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
    default:
      return { kind: 'tool', label: name.startsWith('mcp__') ? `Using ${name.split('__').slice(1).join(' · ')}` : `Using ${name}` };
  }
}

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

