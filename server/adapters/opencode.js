// opencode adapter — drives `opencode run --format json` (one JSON event per line).

import { ASK_TIMEOUT_MS, attachmentNote, clip, detectVersion, fileTracker, quietOutput, rel, spawnJsonl, withProtocol } from './common.js';

const BIN = process.env.WISP_OPENCODE_BIN || 'opencode';

export default {
  id: 'opencode',
  name: 'opencode',
  askTool: 'wisp_ask_user',
  models: [{ id: '', label: 'Default', hint: 'Whatever opencode is set to' }],

  resumeCommand({ resumeId, model }) {
    // The TUI has no --variant flag; the effort only applies to `run`.
    return [BIN, ...(resumeId ? ['--session', resumeId] : []), ...(model ? ['--model', model] : [])];
  },

  async detect() {
    const found = await detectVersion(BIN);
    if (!found.available) return found;
    // `opencode models --verbose` prints each provider/model id followed by its JSON metadata;
    // the metadata's `variants` are the reasoning efforts `run --variant` accepts for that model.
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
    return { ...found, models: [this.models[0], ...models] };
  },

  run({ prompt, attachments = [], cwd, resumeId, mode, model, effort, systemPrompt, mcpServers = {}, onEvent }) {
    // The prompt goes on stdin; `run` appends piped stdin to the (empty) message.
    const args = ['run', '--format', 'json'];
    if (mode === 'plan') args.push('--agent', 'plan');
    if (mode === 'auto') args.push('--auto');
    if (model) args.push('--model', model);
    if (model && effort) args.push('--variant', effort);
    if (resumeId) args.push('--session', resumeId);
    for (const a of attachments) args.push('--file', a.path);

    // Inject the ask_user server through inline config, merged over the user's own.
    const mcp = {};
    for (const [name, srv] of Object.entries(mcpServers)) {
      mcp[name] = { type: 'local', command: [srv.command, ...(srv.args || [])], environment: srv.env || {}, enabled: true, timeout: ASK_TIMEOUT_MS };
    }
    const env = { ...process.env };
    if (Object.keys(mcp).length) {
      const inline = env.OPENCODE_CONFIG_CONTENT ? safeJson(env.OPENCODE_CONFIG_CONTENT) : {};
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        ...inline,
        mcp: { ...inline.mcp, ...mcp },
        experimental: { ...inline.experimental, mcp_timeout: ASK_TIMEOUT_MS },
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

    return spawnJsonl({
      bin: BIN,
      args,
      cwd,
      env,
      input,
      onEvent,
      onJson(msg) {
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
            onEvent({ type: 'tool', ...describeTool(part.tool, input, cwd) });
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
        const ok = code === 0 && !error;
        onEvent({
          type: 'result',
          isError: !ok,
          stopped,
          text: ok ? text.join('\n') : error || stderr || `opencode exited with ${signal || `code ${code}`}`,
          stats: { durationMs: Date.now() - started, costUsd: cost || undefined, inputTokens: tokens.input, outputTokens: tokens.output },
        });
      },
    });
  },
};

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
      return { kind: 'run', label: input.description ? clip(input.description) : `Running ${clip(input.command, 60)}`, detail: input.command };
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
    default:
      return { kind: 'tool', label: `Using ${name.replace(/_/g, ' ')}` };
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
