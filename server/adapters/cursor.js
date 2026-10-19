// Cursor CLI adapter — drives `cursor-agent -p --output-format stream-json`.
//
// cursor-agent has no flag to inject an MCP server (it only reads .cursor/mcp.json), so wisp's
// ask_user tool isn't available here; the protocol tells the agent to end with a question block.

import { attachmentNote, clip, detectVersion, exitText, fileTracker, quietOutput, rel, spawnJsonl, withProtocol } from './common.js';
import { describeCommand } from './commands.js';

const BIN = process.env.WISP_CURSOR_BIN || 'cursor-agent';

export default {
  id: 'cursor',
  name: 'Cursor',
  askTool: null,
  models: [{ id: '', label: 'Default', hint: 'Whatever Cursor is set to' }],

  resumeCommand({ resumeId, model }) {
    return [BIN, ...(resumeId ? ['--resume', resumeId] : []), ...(model ? ['--model', model] : [])];
  },

  async detect() {
    const found = await detectVersion(BIN);
    if (!found.available) return found;
    // `--list-models` prints "id - Label" lines, with "(current, default)" on the active one.
    const models = [];
    for (const line of (await quietOutput(BIN, ['--list-models'])).split('\n')) {
      const m = line.trim().match(/^([\w.\-[\]=,]+) - (.+?)(?:\s+\((?:current|default)[^)]*\))?$/);
      if (m && m[1] !== 'auto') models.push({ id: m[1], label: m[2], hint: m[1] });
    }
    return { ...found, models: [this.models[0], ...models] };
  },

  run({ prompt, attachments = [], cwd, resumeId, mode, model, systemPrompt, onEvent }) {
    const args = ['-p', '--output-format', 'stream-json', '--trust'];
    if (mode === 'plan') args.push('--mode', 'plan');
    if (mode === 'auto') args.push('--force');
    if (model) args.push('--model', model);
    if (resumeId) args.push('--resume', resumeId);
    // No prompt argument: in --print mode cursor-agent reads it from stdin.

    const input = withProtocol(prompt, systemPrompt, resumeId) + attachmentNote(attachments);
    const files = fileTracker(cwd);
    let sawResult = false;
    let session = null;

    return spawnJsonl({
      bin: BIN,
      args,
      cwd,
      env: process.env,
      input,
      onEvent,
      onJson(msg) {
        if (msg.session_id && msg.session_id !== session) onEvent({ type: 'session', id: (session = msg.session_id) });
        switch (msg.type) {
          case 'assistant':
            for (const part of msg.message?.content || []) {
              if (part.type === 'text' && part.text?.trim()) onEvent({ type: 'text', text: part.text });
            }
            break;
          case 'thinking':
            if (msg.subtype === 'completed') onEvent({ type: 'thinking' });
            break;
          case 'tool_call': {
            const [name, body = {}] = toolOf(msg.tool_call);
            if (!name) break;
            const args = body.args || {};
            if (msg.subtype === 'started') {
              if ((name === 'editToolCall' || name === 'deleteToolCall') && args.path) files.remember(args.path);
              onEvent({ type: 'tool', ...describeTool(name, args, cwd) });
            } else if (msg.subtype === 'completed') {
              const [outcome, value = {}] = resultOf(body.result);
              if (outcome && outcome !== 'success') {
                onEvent({ type: 'tool_error', name: name.replace(/ToolCall$/, ''), text: clip(value.error || value.message || value.reason || value.stderr || outcome, 400) });
                // Refused by its permissions (no --force): the card offers to retry it.
                if (/reject|denied|permission/i.test(outcome)) onEvent({ type: 'blocked', tool: name.replace(/ToolCall$/, ''), detail: String(args.command ?? args.path ?? args.url ?? '') });
              } else if (name === 'editToolCall' || name === 'deleteToolCall') {
                const change = editChange(args.path || value.path, value, cwd, files);
                if (change) onEvent({ type: 'change', ...change });
              }
            }
            break;
          }
          case 'result':
            sawResult = true;
            onEvent({
              type: 'result',
              text: msg.result ?? '',
              isError: !!msg.is_error || (msg.subtype && msg.subtype !== 'success'),
              stats: { durationMs: msg.duration_ms, inputTokens: msg.usage?.inputTokens ?? msg.usage?.input_tokens, outputTokens: msg.usage?.outputTokens ?? msg.usage?.output_tokens },
            });
            break;
        }
      },
      onClose({ code, signal, stderr, stopped }) {
        if (sawResult) return;
        onEvent({ type: 'result', isError: true, stopped, text: stderr || exitText('cursor-agent', code, signal) });
      },
    });
  },
};

// Tool calls are protobuf oneofs; depending on the serializer they arrive as
// { editToolCall: {...} } or { tool: { case: 'editToolCall', value: {...} } }.
function oneof(o) {
  if (!o || typeof o !== 'object') return [];
  if ('case' in o) return [o.case, o.value];
  const k = Object.keys(o)[0];
  return k ? [k, o[k]] : [];
}
const toolOf = (tc) => oneof(tc?.tool && typeof tc.tool === 'object' ? tc.tool : tc);
const resultOf = (r) => oneof(r?.result && typeof r.result === 'object' && 'case' in r.result ? r.result : r);

function editChange(file, value, cwd, files) {
  if (!file) return null;
  if (typeof value.afterFullFileContent === 'string') {
    files.change(file); // keep the snapshot current
    const before = value.beforeFullFileContent;
    return { file: rel(file, cwd), op: before == null ? 'create' : 'write', edits: [{ before: before ?? '', after: value.afterFullFileContent }] };
  }
  return files.change(file);
}

function describeTool(name, a, cwd) {
  const f = rel(a.path, cwd);
  switch (name) {
    case 'readToolCall':
      return { kind: 'read', label: `Reading ${f}`, file: f };
    case 'editToolCall':
      return { kind: 'edit', label: `Editing ${f}`, file: f };
    case 'deleteToolCall':
      return { kind: 'edit', label: `Deleting ${f}`, file: f };
    case 'shellToolCall':
      return { kind: 'run', label: a.description ? clip(a.description) : describeCommand(a.command, cwd), detail: a.command };
    case 'grepToolCall':
      return { kind: 'search', label: `Searching for “${clip(a.pattern, 40)}”` };
    case 'globToolCall':
      return { kind: 'search', label: `Finding ${clip(a.globPattern || a.pattern, 50)}` };
    case 'lsToolCall':
      return { kind: 'search', label: `Listing ${f || '.'}` };
    case 'semSearchToolCall':
      return { kind: 'search', label: `Searching the codebase: ${clip(a.query, 50)}` };
    case 'webSearchToolCall':
      return { kind: 'web', label: `Searching the web: ${clip(a.searchTerm || a.query, 50)}` };
    case 'webFetchToolCall':
    case 'fetchToolCall':
      return { kind: 'web', label: `Reading ${clip(a.url, 60)}` };
    case 'taskToolCall':
      return { kind: 'agent', label: `Delegating: ${clip(a.description || a.prompt, 60)}` };
    case 'updateTodosToolCall': {
      const active = a.todos?.find((t) => /in_?progress/i.test(String(t.status)));
      return { kind: 'plan', label: active ? clip(active.content) : 'Planning' };
    }
    case 'mcpToolCall':
      return { kind: 'tool', label: `Using ${a.providerIdentifier || 'mcp'} · ${a.toolName || 'tool'}` };
    default:
      return { kind: 'tool', label: `Using ${name.replace(/ToolCall$/, '').replace(/([A-Z])/g, ' $1').toLowerCase()}` };
  }
}
