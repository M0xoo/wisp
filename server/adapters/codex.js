// Codex CLI adapter — drives `codex exec --json` (JSONL thread/turn/item events).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ASK_TIMEOUT_MS, attachmentNote, clip, crewToolLabel, detectFirst, exitText, fileTracker, flatten, quietOutput, rel, spawnJsonl, withProtocol } from './common.js';
import { describeCommand } from './commands.js';
import { codexLimits, codexRollout } from '../budget.js';

const DEFAULT_BIN = process.env.WISP_CODEX_BIN || 'codex';
let BIN = DEFAULT_BIN;
let VERSION = []; // [major, minor, patch] of the codex detect() found
const atLeast = (want) => VERSION.length === 3 && want.reduce((d, n, i) => d || VERSION[i] - n, 0) >= 0;
// codex 0.53 takes developer instructions from config. They go in front of its environment context,
// which names the task's folder, so wisp's protocol can be cached from one task to the next; as a
// prompt prefix it came after the folder, and a new task's folder missed the cache on all of it.
// The prefix stays on Windows (its command line stops at 32k characters) and where the user set
// developer_instructions in config.toml (-c would replace theirs).
const developerInstructions = (home) => process.platform !== 'win32' && atLeast([0, 53, 0]) && !ownDeveloperInstructions(home);
// A lean run (the retro) only reads its prompt and answers: none of codex's plugins, apps, subagents
// or browser, and a one-line base prompt instead of the coding agent's. Unknown keys only warn.
const LEAN_FEATURES = ['plugins', 'apps', 'multi_agent', 'skill_search', 'browser_use', 'computer_use', 'goals', 'code_mode_host'];
const LEAN_BASE = 'You answer in one message. Do not run tools, read files or edit anything.';
// Where codex lives when it isn't on PATH: the standalone installer's own copy (its ~/.local/bin
// link may not be on an app's PATH; on Windows it also keeps one in Programs\OpenAI\Codex), then
// the CLI the ChatGPT desktop app ships: in its bundle on macOS (the older Codex.app kept it at
// Resources/codex) and in /usr/lib/chatgpt from the Linux .deb. They share ~/.codex, so the app's
// sign-in carries. The Windows app is a Store package whose files can't be run from outside it.
export const fallbackBins = () => {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [path.join(home, '.codex', 'packages', 'standalone', 'current', 'bin', 'codex.exe'), path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')];
  }
  const apps = process.platform === 'darwin' ? ['/Applications', path.join(home, 'Applications')] : [];
  return [
    path.join(home, '.codex', 'packages', 'standalone', 'current', 'bin', 'codex'),
    ...apps.flatMap((d) => [path.join(d, 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex'), path.join(d, 'Codex.app', 'Contents', 'Resources', 'codex')]),
    ...(process.platform === 'linux' ? ['/usr/lib/chatgpt/resources/codex'] : []),
  ];
};
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
  fork: true, // run({ resumeId, fork }) answers on a copy of the conversation (/btw)
  models: [{ id: '', label: 'Default', hint: 'Whatever Codex is set to' }],
  efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],

  resumeCommand({ resumeId, model, effort }) {
    return [BIN, ...(resumeId ? ['resume', resumeId] : []), ...(model ? ['--model', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${toml(effort)}`] : [])];
  },

  // How to get it, shown in Settings → Agents and the picker while it isn't found (this OS's steps).
  setup(platform = process.platform) {
    return {
      tip:
        platform === 'win32'
          ? 'Install the Codex CLI and run codex once to sign in. On Windows the ChatGPT app’s built-in Codex can’t be run from outside the app'
          : 'Install the Codex CLI and run codex once to sign in. Or install the ChatGPT desktop app and sign in there: wisp uses the Codex inside it',
      command: 'npm i -g @openai/codex',
      url: 'https://github.com/openai/codex',
    };
  },

  async detect() {
    const { bin, ...found } = await detectFirst(DEFAULT_BIN, fallbackBins, !!process.env.WISP_CODEX_BIN);
    BIN = bin;
    VERSION = (String(found.version || '').match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
    if (!found.available) return found;
    // `codex debug models` prints the catalog (older builds lack it: then the copy codex caches).
    // Keep what its own /model picker shows ("list"), best first, each with the levels it takes.
    const models = (await catalog())
      .filter((m) => m?.slug && m.visibility === 'list')
      .sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9))
      .map((m) => {
        const efforts = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((l) => l.effort).filter(Boolean) : undefined;
        return { id: m.slug, label: m.display_name || m.slug, hint: clip(m.description || m.slug, 60), ...(efforts && { efforts }) };
      });
    if (!models.length) return found;
    // Default runs the model config.toml names, else codex's first choice: it takes those levels.
    const def = models.find((m) => m.id === configuredModel()) || models[0];
    return { ...found, ...(def.efforts && { efforts: def.efforts }), models: [this.models[0], ...models] };
  },

  // dirs: the task's other folders, writable like cwd.
  // fork: `exec fork` a copy of resumeId's conversation instead of resuming it (/btw).
  // accountEnv: the account it runs on (CODEX_HOME, server/accounts.js), {} for the default.
  // lean: a side run that only answers (the retro), with codex's extras off.
  run({ prompt, attachments = [], cwd, dirs: extra = [], resumeId, fork = false, mode, model, effort, systemPrompt, mcpServers = {}, accountEnv = {}, lean = false, onEvent }) {
    const args = ['exec', '--json', '--skip-git-repo-check'];
    let base = null;
    if (lean) {
      for (const f of LEAN_FEATURES) args.push('-c', `features.${f}=false`);
      base = path.join(os.tmpdir(), `wisp-codex-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.md`);
      try {
        fs.writeFileSync(base, LEAN_BASE);
        args.push('-c', `model_instructions_file=${toml(base)}`);
      } catch {
        base = null;
      }
    }
    // Resumed and forked threads have the protocol in their history already.
    const developer = !resumeId && !!systemPrompt?.trim() && developerInstructions(accountEnv.CODEX_HOME || codexHome());
    if (developer) args.push('-c', `developer_instructions=${toml(systemPrompt.trim())}`);
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
      // wisp's own tools (ask_user, the spell tools…) need no approval: outside Full auto, codex
      // exec's approval policy is never, which otherwise refuses every MCP call.
      args.push('-c', `${key}.default_tools_approval_mode=${toml('approve')}`);
    }
    const images = attachments.filter((a) => IMAGE.test(a.mime));
    for (const img of images) args.push('-i', img.path);
    if (!resumeId) {
      const dirs = [...new Set([...extra, ...attachments.map((a) => path.dirname(a.path))])];
      for (const d of dirs) args.push('--add-dir', d);
    }
    if (resumeId) args.push(fork ? 'fork' : 'resume', resumeId);
    // No prompt argument: codex reads it from stdin.

    let input = developer ? prompt : withProtocol(prompt, systemPrompt, resumeId);
    input += attachmentNote(attachments.filter((a) => !images.includes(a)), 'Read text files and PDFs from disk');
    if (images.length) input += `\n\n(${images.length} image${images.length > 1 ? 's are' : ' is'} attached to this message.)`;

    const files = fileTracker(cwd);
    let lastMessage = '';
    let failure = null;
    let lastError = '';
    let usage = null;
    let completed = false;
    let thread = resumeId && !fork ? resumeId : '';
    const started = Date.now();

    const readLimits = () => thread && codexLimits(codexRollout(thread, { home: accountEnv.CODEX_HOME || process.env.CODEX_HOME || undefined }));
    // The turn's one result: at turn.completed, or when the process ends without one.
    let reported = false;
    const report = ({ ok, stopped = false, text = '' }) => {
      reported = true;
      // codex exec doesn't print its usage windows; its session file has them (server/budget.js).
      const limits = readLimits();
      if (limits) onEvent({ type: 'limits', ...limits });
      onEvent({
        type: 'result',
        isError: !ok,
        stopped,
        text: ok ? lastMessage : text,
        stats: {
          durationMs: Date.now() - started,
          inputTokens: usage?.input_tokens,
          ...(usage?.cached_input_tokens && { cachedInputTokens: usage.cached_input_tokens }), // Ask near the limit counts what wasn't cached (server/guard.js)
          outputTokens: usage?.output_tokens,
        },
      });
    };

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
      env: { ...process.env, ...accountEnv },
      input,
      onEvent,
      onJson(msg) {
        switch (msg.type) {
          case 'thread.started':
            if (msg.thread_id) onEvent({ type: 'session', id: (thread = msg.thread_id) });
            break;
          case 'item.started':
          case 'item.updated':
          case 'item.completed':
            if (msg.item) onItem(msg.item, msg.type.slice(5));
            break;
          case 'turn.completed':
            completed = true;
            usage = msg.usage || null;
            // The answer is in: show it now. codex then takes ~0.4 s to stop its MCP servers and
            // exit, which every task used to wait for (the runner lets the process wind down).
            if (!failure) report({ ok: true });
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
        if (base) fs.rmSync(base, { force: true });
        if (!reported) return report({ ok: completed && !failure && code === 0, stopped, text: failure || lastError || stderr || exitText('codex', code, signal) });
        // Reported at turn.completed: the session file is complete now, so read the windows again.
        const limits = readLimits();
        if (limits) onEvent({ type: 'limits', ...limits });
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

const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

// The model catalog: from the CLI, else what it cached in $CODEX_HOME after signing in or starting.
async function catalog() {
  for (const read of [async () => JSON.parse(await quietOutput(BIN, ['debug', 'models'])), () => JSON.parse(fs.readFileSync(path.join(codexHome(), 'models_cache.json'), 'utf8'))]) {
    try {
      const list = (await read()).models;
      if (Array.isArray(list) && list.length) return list;
    } catch {}
  }
  return [];
}

function ownDeveloperInstructions(home) {
  try {
    return /^\s*developer_instructions\s*=/m.test(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'));
  } catch {
    return false;
  }
}

// The top-level `model = "…"` in config.toml (before any [table]), or ''.
function configuredModel() {
  try {
    const top = fs.readFileSync(path.join(codexHome(), 'config.toml'), 'utf8').split(/^\s*\[/m)[0];
    return top.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1] || '';
  } catch {
    return '';
  }
}

function describeMcp(item) {
  if (item.server === 'wisp' && item.tool === 'ask_user') return { kind: 'wait', label: 'Waiting for your answer' };
  if (item.server === 'wisp' && (item.tool === 'delegate' || item.tool === 'subagent_results')) return { kind: 'agent', label: 'Waiting on subagents' };
  if (item.server === 'wisp' && item.tool === 'wisp_tag') return { kind: 'tool', label: 'Tagging the task' };
  if (item.server === 'wisp' && item.tool === 'wisp_pr') return { kind: 'tool', label: 'Attaching a PR' };
  if (item.server === 'wisp' && item.tool === 'wisp_save') return { kind: 'tool', label: 'Saving to My Stuff' };
  if (item.server === 'wisp' && item.tool === 'wisp_stuff') return { kind: 'tool', label: 'Looking in My Stuff' };
  if (item.server === 'wisp' && item.tool === 'wisp_blocks') return { kind: 'tool', label: 'Reading block formats' };
  if (item.server === 'wisp' && item.tool === 'wisp_stats') return { kind: 'tool', label: 'Reading wisp stats' };
  if (item.server === 'wisp' && item.tool === 'wisp_sessions') return { kind: 'tool', label: 'Listing wisp tasks' };
  if (item.server === 'wisp' && item.tool === 'wisp_session') return { kind: 'tool', label: 'Reading a wisp task' };
  return (item.server === 'wisp' && crewToolLabel(item.tool, item.arguments)) || { kind: 'tool', label: `Using ${item.server} · ${item.tool}` };
}
