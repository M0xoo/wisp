// A stand-in for the claude / codex / opencode / cursor-agent / agy CLIs. It speaks each one's real
// output format (captured from the actual CLIs), edits files for real, and — when the prompt
// says ASK and an MCP server was injected — calls wisp's ask_user tool like a real agent would.
//
// Which harness it plays comes from the script's file name (test/helpers.js installs copies as
// claude.mjs, codex.mjs, …). Behaviour knobs, via env:
//   FAKE_RECORD  directory; each invocation appends { argv, stdin, cwd, pwd, pid, opencodeConfig } to <name>.jsonl
//   FAKE_HANG=1  stop after the first events and wait to be killed
//   FAKE_FAIL=1  exit 1 with an error on stderr, no result
//   FAKE_RETRO   what a claude retro run (wisp's preference learner) replies with
//   FAKE_DELAY   ms to work before answering (screenshots of live runs)
// A prompt with DELEGATE makes a lead call the injected `delegate` tool once per subagent
// (twice each with DELEGATE TWICE, which a member with copies spreads over two of them).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const name = path.basename(process.argv[1]).replace(/\.m?js$/, '');
const argv = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const flag = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (argv[0] === '--version' || argv[0] === '-v') {
  console.log(name === 'claude' ? '9.9.9 (Fake Claude Code)' : `fake-${name} 9.9.9`);
  process.exit(0);
}
if (name === 'opencode' && argv[0] === 'models') {
  // --verbose follows each id with pretty-printed metadata, including reasoning variants.
  if (argv.includes('--verbose')) {
    const meta = (variants) => JSON.stringify({ id: 'x', variants }, null, 2);
    console.log(`fake/model-a\n${meta({ low: {}, high: {} })}\nfake/model-b\n${meta(undefined)}`);
  } else console.log('fake/model-a\nfake/model-b');
  process.exit(0);
}
if (name === 'cursor-agent' && argv[0] === '--list-models') {
  console.log('Available models\n\nauto - Auto (current, default)\nfast-1 - Fast One\nbig-2 - Big Two');
  process.exit(0);
}
if (name === 'agy' && argv[0] === 'models') {
  console.log('Fetching available models...\ngemini-9-pro-high\tGemini 9 Pro (High)\ngemini-9-flash          Gemini 9 Flash');
  process.exit(0);
}

const stdin = await new Promise((resolve) => {
  let s = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (s += d)).on('end', () => resolve(s));
});

// A retro run (wisp's learner): recorded on its own, no tools, just the JSON reply.
const retro = name === 'claude' && !!flag('--append-system-prompt')?.includes('# wisp retro');

if (process.env.FAKE_RECORD) {
  fs.mkdirSync(process.env.FAKE_RECORD, { recursive: true });
  fs.appendFileSync(path.join(process.env.FAKE_RECORD, `${retro ? 'retro' : name}.jsonl`), JSON.stringify({ argv, stdin, cwd: process.cwd(), pwd: process.env.PWD, pid: process.pid, opencodeConfig: process.env.OPENCODE_CONFIG_CONTENT }) + '\n');
}

if (retro) {
  out({ type: 'system', subtype: 'init', session_id: 'retro-session' });
  out({ type: 'result', subtype: 'success', is_error: false, result: process.env.FAKE_RETRO || '{}', session_id: 'retro-session' });
  process.exit(0);
}

if (process.env.FAKE_FAIL) {
  process.stderr.write('fake: not logged in (401)\n');
  process.exit(1);
}

// --- the MCP servers wisp injected, per harness ---------------------------------------------

function injectedMcp() {
  if (name === 'claude') {
    const cfg = flag('--mcp-config');
    return cfg ? JSON.parse(cfg).mcpServers?.wisp : null;
  }
  if (name === 'codex') {
    // -c mcp_servers.wisp.command="…"  -c mcp_servers.wisp.args=[…]  -c mcp_servers.wisp.env={K="v"}
    const kv = {};
    argv.forEach((a, i) => {
      const m = argv[i - 1] === '-c' && a.match(/^mcp_servers\.wisp\.(\w+)=(.*)$/s);
      if (m) kv[m[1]] = m[2];
    });
    if (!kv.command) return null;
    const tomlToJson = (v) => JSON.parse(v.replace(/([{,])\s*([A-Za-z_][\w]*)=/g, '$1"$2":'));
    return { command: tomlToJson(kv.command), args: tomlToJson(kv.args || '[]'), env: kv.env ? tomlToJson(kv.env) : {} };
  }
  if (name === 'opencode') {
    const srv = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}').mcp?.wisp;
    return srv ? { command: srv.command[0], args: srv.command.slice(1), env: srv.environment } : null;
  }
  return null; // cursor-agent and agy can't take one
}

async function mcpCall(srv, tool, args) {
  const child = spawn(srv.command, srv.args || [], { env: { ...process.env, ...srv.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    const msg = JSON.parse(l);
    pending.get(msg.id)?.(msg);
  });
  let id = 0;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      pending.set(++id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: `fake-${name}`, version: '0' } });
  const tools = await rpc('tools/list', {});
  const list = tools.result.tools;
  if (!list.some((t) => t.name === tool)) {
    child.kill();
    return null;
  }
  const res = await rpc('tools/call', { name: tool, arguments: typeof args === 'function' ? args(list) : args });
  child.kill();
  return res.result.content[0].text;
}
const askUser = (srv, question) => mcpCall(srv, 'ask_user', { question, options: ['Yes', 'No'] });

// --- the work ---------------------------------------------------------------------------

const cwd = process.cwd();
const target = path.join(cwd, 'math.js');
const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
const after = before.replace('a - b', 'a + b');
const resumeId = name === 'claude' || name === 'cursor-agent' ? flag('--resume') : name === 'opencode' ? flag('--session') : name === 'agy' ? flag('--conversation') : argv.includes('resume') ? argv[argv.indexOf('resume') + 1] : undefined;
const session = resumeId || `${name}-session-1`;
const final = (answer) =>
  'All done.\n```wisp\n' + JSON.stringify({ blocks: [{ type: 'hero', title: `Fake ${name} finished`, summary: answer ? `Answer was: ${answer}` : 'No question asked.', status: 'done' }] }) + '\n```';

const hang = () => setInterval(() => {}, 1 << 30);
if (process.env.FAKE_DELAY) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_DELAY)));
const ask = async () => {
  const srv = injectedMcp();
  if (stdin.includes('DELEGATE') && srv) {
    const names = (list) => list.find((t) => t.name === 'delegate').inputSchema.properties.tasks.items.properties.subagent.enum.filter((n) => !n.includes('#'));
    const times = stdin.includes('DELEGATE TWICE') ? 2 : 1;
    const report = await mcpCall(srv, 'delegate', (list) => ({ tasks: names(list).flatMap((n) => Array.from({ length: times }, (_, i) => ({ subagent: n, prompt: `Check math.js for ${n}${i ? ` (${i + 1})` : ''}` }))) }));
    return report ? `delegated (${report.length} chars) ${report.match(/### [\w#-]+/g)?.join(' ')}` : 'no delegate tool';
  }
  return stdin.includes('ASK') && srv ? askUser(srv, 'Proceed with the fix?') : '';
};

if (name === 'claude') {
  out({ type: 'system', subtype: 'init', session_id: session });
  out({ type: 'assistant', session_id: session, message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: target } }] } });
  if (process.env.FAKE_HANG) hang();
  else {
    out({ type: 'assistant', session_id: session, message: { content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: target, old_string: 'a - b', new_string: 'a + b' } }] } });
    fs.writeFileSync(target, after);
    out({ type: 'assistant', session_id: session, message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }] } });
    out({ type: 'user', session_id: session, message: { content: [{ type: 'tool_result', tool_use_id: 't3', is_error: true, content: '1 failing' }] } });
    const answer = await ask();
    out({ type: 'result', subtype: 'success', is_error: false, result: final(answer), session_id: session, duration_ms: 5, num_turns: 3, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } });
  }
} else if (name === 'codex') {
  out({ type: 'thread.started', thread_id: session });
  out({ type: 'turn.started' });
  out({ type: 'item.started', item: { id: 'i0', type: 'command_execution', command: process.platform === 'win32' ? '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "npm test"' : "/bin/bash -lc 'npm test'", status: 'in_progress' } });
  if (process.env.FAKE_HANG) hang();
  else {
    out({ type: 'item.completed', item: { id: 'i0', type: 'command_execution', command: 'npm test', exit_code: 1, aggregated_output: '1 failing', status: 'failed' } });
    fs.writeFileSync(target, after);
    fs.writeFileSync(path.join(cwd, 'notes.txt'), 'new file\n');
    out({ type: 'item.completed', item: { id: 'i1', type: 'file_change', changes: [{ path: target, kind: 'update' }, { path: 'notes.txt', kind: 'add' }], status: 'completed' } });
    const answer = await ask();
    out({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: final(answer) } });
    out({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
  }
} else if (name === 'opencode') {
  const base = { sessionID: session, timestamp: Date.now() };
  const tool = (tool, input, output = '', metadata = {}) => out({ ...base, type: 'tool_use', part: { type: 'tool', tool, callID: `c-${tool}`, messageID: 'm1', state: { status: 'completed', input, output, metadata } } });
  out({ ...base, type: 'step_start', part: { type: 'step-start', messageID: 'm1' } });
  tool('read', { filePath: target }, before);
  if (process.env.FAKE_HANG) hang();
  else {
    fs.writeFileSync(target, after);
    tool('edit', { filePath: target, oldString: 'a - b', newString: 'a + b' }, 'Edit applied');
    fs.writeFileSync(path.join(cwd, 'notes.txt'), 'new file\n');
    tool('write', { filePath: path.join(cwd, 'notes.txt'), content: 'new file\n' });
    tool('bash', { command: 'npm test', description: 'Run the tests' }, '1 failing');
    const answer = await ask();
    if (answer) tool('wisp_ask_user', { question: 'Proceed with the fix?' }, answer);
    out({ ...base, type: 'step_finish', part: { type: 'step-finish', messageID: 'm1', tokens: { input: 7, output: 3 }, cost: 0 } });
    out({ ...base, type: 'step_start', part: { type: 'step-start', messageID: 'm2' } });
    out({ ...base, type: 'text', part: { type: 'text', messageID: 'm2', text: final(answer) } });
    out({ ...base, type: 'step_finish', part: { type: 'step-finish', messageID: 'm2', tokens: { input: 3, output: 2 }, cost: 0 } });
  }
} else if (name === 'cursor-agent') {
  const ev = (o) => out({ ...o, session_id: session });
  ev({ type: 'system', subtype: 'init', cwd, model: 'Auto' });
  ev({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: stdin }] } });
  ev({ type: 'tool_call', subtype: 'started', call_id: 'r', tool_call: { readToolCall: { args: { path: target } } } });
  if (process.env.FAKE_HANG) hang();
  else {
    ev({ type: 'tool_call', subtype: 'started', call_id: 'e', tool_call: { editToolCall: { args: { path: target } } } });
    fs.writeFileSync(target, after);
    ev({ type: 'tool_call', subtype: 'completed', call_id: 'e', tool_call: { editToolCall: { args: { path: target }, result: { success: { path: target, beforeFullFileContent: before, afterFullFileContent: after } } } } });
    ev({ type: 'tool_call', subtype: 'started', call_id: 's', tool_call: { shellToolCall: { args: { command: 'npm test' } } } });
    ev({ type: 'tool_call', subtype: 'completed', call_id: 's', tool_call: { shellToolCall: { args: { command: 'npm test' }, result: { rejected: { reason: 'needs --force' } } } } });
    ev({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed it.' }] } });
    ev({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, result: final('') });
  }
} else if (name === 'agy') {
  // --input-format stream-json: one `user` event per line on stdin.
  const prompt = JSON.parse(stdin.split('\n')[0]).message.content;
  const step = (i, o) => out({ event: 'step_update', step_update: { conversation_id: session, step_index: i, ...o } });
  out({ event: 'init', conversation_id: session, init: { cwd, tools: ['run_command', 'view_file', 'write_to_file', 'replace_file_content'], permission_mode: argv.includes('--dangerously-skip-permissions') ? 'always-proceed' : 'request-review' } });
  step(0, { state: 'DONE', step_type: 'user_input' });
  step(1, { state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: target }, output: before } });
  if (process.env.FAKE_HANG) hang();
  else {
    const edit = { name: 'replace_file_content', parameters: { TargetFile: target, TargetContent: 'a - b', ReplacementContent: 'a + b' } };
    step(2, { state: 'ACTIVE', step_type: 'tool', tool_name: edit.name, tool_info: edit });
    fs.writeFileSync(target, after);
    step(2, { state: 'DONE', step_type: 'tool', tool_name: edit.name, tool_info: { ...edit, output: 'ok' } });
    step(3, { state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'npm test' }, output: '', error: { type: 'PERMISSION_DENIED', message: 'run_command needs approval' } } });
    step(4, { state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Fixed ' });
    step(4, { state: 'DONE', step_type: 'agent_response', text_delta: 'it.' });
    const usage = { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 15 };
    out({ event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: final(''), duration_seconds: 0.01, num_turns: 1, usage } });
  }
}
