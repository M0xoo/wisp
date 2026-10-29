// Antigravity CLI adapter — drives `agy --input-format stream-json --output-format stream-json`
// (headless mode: one init event, step_update events, one result event per turn).
//
// agy has no flag to inject an MCP server (it reads ~/.gemini/config/mcp_config.json and
// .agents/mcp_config.json), so wisp's ask_user tool isn't available here; the protocol tells
// the agent to end with a question block. Same for the system prompt: it goes in front of the
// first message.

import fs from 'node:fs';
import path from 'node:path';
import { attachmentNote, clip, detectVersion, exitText, fileTracker, helpEfforts, helpText, quietOutput, rel, spawnJsonl, withProtocol } from './common.js';
import { describeCommand } from './commands.js';

const BIN = process.env.WISP_ANTIGRAVITY_BIN || 'agy';

// Headless runs give up after --print-timeout (default 5m); wisp tasks routinely take longer.
const PRINT_TIMEOUT = '24h';

// `--mode` sets the execution mode; shell commands are governed by permissions, which only
// --dangerously-skip-permissions lifts in headless mode.
const MODE_ARGS = {
  plan: ['--mode', 'plan'],
  edits: ['--mode', 'accept-edits'],
  auto: ['--dangerously-skip-permissions'],
};

const realDir = (dir) => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
};

const EDIT_TOOL = /write|replace|edit|delete/i;
const EFFORT_SUFFIX = /-(low|medium|high)$/;

export default {
  id: 'antigravity',
  name: 'Antigravity',
  askTool: null,
  models: [{ id: '', label: 'Default', hint: 'Whatever Antigravity is set to' }],
  efforts: ['low', 'medium', 'high'],

  // trusted: a folder wisp made (scratch, worktree), which it would otherwise stop to ask about.
  // agy has no --trust; --settings is for this session only, and only the folder itself counts.
  resumeCommand({ resumeId, model, effort, cwd, trusted = false }) {
    const trust = trusted && cwd ? ['--settings', JSON.stringify({ trustedWorkspaces: [realDir(cwd)] })] : [];
    return [BIN, ...(resumeId ? ['--conversation', resumeId] : []), ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []), ...trust];
  },

  // How to get it, shown in Settings → Agents and the picker while it isn't found (this OS's steps).
  setup() {
    return { tip: 'Install the Antigravity CLI (agy) and sign in. The Antigravity app doesn’t include it', url: 'https://antigravity.google/docs/cli/headless/' };
  },

  async detect() {
    const found = await detectVersion(BIN);
    if (!found.available) return found;
    // `agy models` prints a "Fetching…" line, then "slug<TAB>Label" lines (older builds pad with
    // spaces). Most slugs bake the effort in (…-high), so those get no separate selector.
    const [list, help] = await Promise.all([quietOutput(BIN, ['models']), helpText(BIN)]);
    const efforts = helpEfforts(help);
    const models = [];
    for (const line of list.split('\n')) {
      const m = line.trim().match(/^([\w.\-]+)(?:\t|\s{2,})\s*(.+)$/);
      if (m) models.push({ id: m[1], label: m[2].trim(), hint: m[1], ...(EFFORT_SUFFIX.test(m[1]) ? { efforts: [] } : {}) });
    }
    return { ...found, ...(efforts.length && { efforts }), models: [this.models[0], ...models] };
  },

  run({ prompt, attachments = [], cwd, resumeId, mode, model, effort, systemPrompt, onEvent }) {
    // The prompt goes on stdin as a single `user` event; closing stdin ends the session once
    // that turn's result is out.
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', PRINT_TIMEOUT];
    args.push(...(MODE_ARGS[mode] || MODE_ARGS.edits));
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (resumeId) args.push('--conversation', resumeId);
    for (const d of new Set(attachments.map((a) => path.dirname(a.path)))) args.push('--add-dir', d);

    const content = withProtocol(prompt, systemPrompt, resumeId) + attachmentNote(attachments);
    const input = JSON.stringify({ event: 'user', message: { content } }) + '\n';
    const files = fileTracker(cwd);
    const text = new Map(); // step_index -> text_delta so far
    const shown = new Set(); // tool steps already announced
    let sawResult = false;
    let session = null;
    const sessionFrom = (id) => {
      if (id && id !== session) onEvent({ type: 'session', id: (session = id) });
    };

    return spawnJsonl({
      bin: BIN,
      args,
      cwd,
      env: process.env,
      input,
      onEvent,
      onJson(msg) {
        if (msg.event === 'init') sessionFrom(msg.conversation_id);
        else if (msg.event === 'step_update') {
          const s = msg.step_update || {};
          sessionFrom(s.conversation_id);
          const done = s.state === 'DONE';
          if (s.step_type === 'agent_response') {
            const t = (text.get(s.step_index) || '') + (s.text_delta || '');
            text.set(s.step_index, t);
            if (done && t.trim()) onEvent({ type: 'text', text: t });
          } else if (s.subagent_info && !shown.has(s.step_index)) {
            shown.add(s.step_index);
            const sub = s.subagent_info.subagents?.[0];
            onEvent({ type: 'tool', kind: 'agent', label: `Delegating${sub ? ` to ${sub.role || sub.type_name}` : ''}` });
          } else if (s.step_type === 'tool') {
            const info = s.tool_info || {};
            const name = s.tool_name || info.name;
            const params = info.parameters || {};
            if (!name) return;
            const file = fileOf(params);
            const editing = file && EDIT_TOOL.test(name);
            // Announce once we know the arguments: on ACTIVE if it carries them, else on DONE.
            if (!shown.has(s.step_index) && (done || Object.keys(params).length)) {
              shown.add(s.step_index);
              if (editing && !done) files.remember(file);
              onEvent({ type: 'tool', ...describeTool(name, params, cwd) });
            }
            if (!done) return;
            if (info.error) {
              onEvent({ type: 'tool_error', name, text: clip(info.error.message || info.error.type || 'failed', 400) });
              // Refused by its permissions (no --dangerously-skip-permissions): the card offers a retry.
              if (/PERMISSION/i.test(info.error.type || '')) onEvent({ type: 'blocked', tool: name, detail: String(params.CommandLine ?? fileOf(params) ?? params.Url ?? '') });
            }
            else if (editing) {
              const change = files.change(file);
              if (change) onEvent({ type: 'change', ...change });
            }
          }
        } else if (msg.event === 'result') {
          const r = msg.result || {};
          sessionFrom(r.conversation_id);
          sawResult = true;
          onEvent({
            type: 'result',
            text: r.status === 'SUCCESS' ? r.response ?? '' : r.error || r.response || `Antigravity ended with status ${r.status}`,
            isError: r.status !== 'SUCCESS',
            stats: { durationMs: r.duration_seconds != null ? Math.round(r.duration_seconds * 1000) : undefined, inputTokens: r.usage?.input_tokens, outputTokens: r.usage?.output_tokens },
          });
        }
      },
      onClose({ code, signal, stderr, stopped }) {
        if (sawResult) return;
        onEvent({ type: 'result', isError: true, stopped, text: stderr || exitText('agy', code, signal) });
      },
    });
  },
};

// Tool parameters are PascalCase (TargetFile, AbsolutePath, CommandLine, …).
const pick = (p, ...keys) => {
  for (const k of keys) if (p[k] != null && p[k] !== '') return p[k];
};
const fileOf = (p) => pick(p, 'TargetFile', 'AbsolutePath', 'FilePath', 'File', 'Path', 'path', 'file_path');

function describeTool(name, p, cwd) {
  const f = rel(fileOf(p), cwd);
  const n = name.toLowerCase();
  if (n === 'run_command') return { kind: 'run', label: describeCommand(p.CommandLine, cwd), detail: p.CommandLine };
  if (EDIT_TOOL.test(n) && f) return { kind: 'edit', label: `${/delete/.test(n) ? 'Deleting' : 'Editing'} ${f}`, file: f };
  if (/^view_/.test(n) && f) return { kind: 'read', label: `Reading ${f}`, file: f };
  if (n === 'list_dir') return { kind: 'search', label: `Listing ${rel(p.DirectoryPath, cwd) || '.'}` };
  if (n === 'find_by_name') return { kind: 'search', label: `Finding ${clip(p.Pattern, 50)}` };
  if (/grep/.test(n)) return { kind: 'search', label: `Searching for “${clip(p.Query || p.Pattern, 40)}”` };
  if (/code_?search|codebase/.test(n)) return { kind: 'search', label: `Searching the codebase: ${clip(p.Query || p.query, 50)}` };
  if (/search_web|web_search/.test(n)) return { kind: 'web', label: `Searching the web: ${clip(p.query || p.Query, 50)}` };
  if (/url|fetch/.test(n)) return { kind: 'web', label: `Reading ${clip(p.Url || p.url, 60)}` };
  if (/browser/.test(n)) return { kind: 'web', label: `Browsing: ${clip(p.Task || p.TaskName || 'browser', 60)}` };
  if (/task_boundary|todo/.test(n)) return { kind: 'plan', label: clip(p.TaskStatus || p.TaskName || 'Planning') };
  return { kind: 'tool', label: `Using ${n.replace(/_/g, ' ')}` };
}
