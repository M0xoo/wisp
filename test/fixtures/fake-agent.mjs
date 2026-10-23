// A stand-in for the claude / codex / opencode / cursor-agent / agy / grok / copilot CLIs. It speaks each one's real
// output format (captured from the actual CLIs), edits files for real, and — when the prompt
// says ASK and an MCP server was injected — calls wisp's ask_user tool like a real agent would.
//
// Which harness it plays comes from the script's file name (test/helpers.js installs copies as
// claude.mjs, codex.mjs, …). Behaviour knobs, via env:
//   FAKE_RECORD  directory; each invocation appends { argv, stdin, cwd, pwd, pid, opencodeConfig, allowAll } to <name>.jsonl
//   FAKE_HANG=1  stop after the first events and wait to be killed
//   FAKE_FAIL=1  exit 1 with an error on stderr, no result
//   FAKE_LIMIT_ONCE=<file>  the first run hits a usage limit (stderr, exit 1); later runs work
//   FAKE_RATE_LIMIT  opencode: log a rate-limit error to stderr, then go quiet for good as the
//                real CLI does while it retries (`recover`: carry on with the turn after it)
//   FAKE_RETRO   what a claude retro run (wisp's preference learner) replies with
//   FAKE_DELAY   ms to work before answering (screenshots of live runs)
//   FAKE_LINGER  ms to stay alive after the result, as a real CLI flushing on its way out does
//   FAKE_MCP_POLICY=1  copilot: warn that an organization policy blocked wisp's MCP server
//   FAKE_SESSION_ERROR  copilot: report this session.error (a quota) and end with exit code 1
//   FAKE_LEAVE_CONFLICTS=1  asked to merge the base in (wisp's conflict fix): leave the conflicts
//   FAKE_BACKGROUND  claude only: end the turn with a background task still running ("I'll report
//                once it has finished"), then report again <ms> later the way the real CLI does;
//                `exit` quits instead, `hang` never finishes the task; FAKE_BACKGROUND_DONE=1 makes
//                the first reply a full presentation (a finished task that left a dev server up)
//   FAKE_ORPHANS=1  claude: on --resume, first answer the last run's stopped background tasks with
//                an empty zero-turn result, as the real CLI does
// A prompt with CAST (a Cast a spell task) reads wisp_spell_schema, checks a spell with
// wisp_spell_check and ends with a spell block; FAILTESTS reports a failing test run (until a
// follow-up says "Fix them"); DEPLOYBLOCK adds a `deploy` block, a type a spell adds.
//   FAKE_BTW     a /btw side question (recorded as btw.jsonl) answers at once, whatever else is set;
//                `nofork` fails a forked one the way a CLI without fork support does, `slow`
//                answers after 3s; FAKE_BTW_ANSWER is the answer (screenshots)
// A prompt with ALSO (a task across several folders) makes claude fix math.js in each --add-dir too.
// A prompt with NARRATE makes claude say a long message and run a command that prints something
// (what the transcript shows).
// A prompt with DELEGATE makes a lead call the injected `delegate` tool once per subagent
// (twice each with DELEGATE TWICE, which a member with copies spreads over two of them).
// Permissions: with APPROVE, claude asks wisp's `approve` tool (its --permission-prompt-tool)
// before `npm publish` (twice with APPROVE TWICE). With BLOCKED, `npm publish` is refused unless
// the run allows it (claude --allowedTools Bash(npm publish), or a Full auto run): claude reports
// it in permission_denials, opencode on stderr, codex in a `blocked` block of its presentation,
// copilot as a denied permission request (unless --allow-tool=shell(npm publish) or --allow-all).

import { execFileSync, spawn } from 'node:child_process';
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
    // FAKE_OPENCODE_EXTRA: a provider signed in to after wisp started (Settings → Re-check).
    const extra = process.env.FAKE_OPENCODE_EXTRA ? `\n${process.env.FAKE_OPENCODE_EXTRA}\n${meta(undefined)}` : '';
    console.log(`fake/model-a\n${meta({ low: {}, high: {} })}\nfake/model-b\n${meta(undefined)}${extra}`);
  } else console.log('fake/model-a\nfake/model-b');
  process.exit(0);
}
if (name === 'cursor-agent' && argv[0] === '--list-models') {
  console.log('Available models\n\nauto - Auto (current, default)\nfast-1 - Fast One\nbig-2 - Big Two');
  process.exit(0);
}
if (name === 'grok' && argv[0] === 'models') {
  console.log('You are logged in with grok.com.\n\nDefault model: grok-9\n\nAvailable models:\n  * grok-9 (default)\n  - grok-9-fast');
  process.exit(0);
}
if (name === 'copilot' && argv[0] === 'help' && argv[1] === 'config') {
  console.log('Configuration Settings:\n\n  `logLevel`: log level for CLI; defaults to "default".\n\n  `model`: AI model to use for Copilot CLI; can be changed with /model command or --model flag option.\n    - "claude-opus-9.5"\n    - "gpt-9.1-sol"\n\n  `contextTier`: context window tier for tiered-pricing models.');
  process.exit(0);
}
if (name === 'agy' && argv[0] === 'models') {
  console.log('Fetching available models...\ngemini-9-pro-high\tGemini 9 Pro (High)\ngemini-9-flash          Gemini 9 Flash');
  process.exit(0);
}

// On a terminal (take over in wisp): a little prompt that echoes each line, in colour, until /exit.
if (process.stdin.isTTY && process.stdout.isTTY) {
  const id = flag('--resume') || flag('--session') || flag('--conversation') || '';
  process.stdout.write(`\x1b[1mfake ${name}\x1b[0m interactive · session ${id} · ${process.stdout.columns}x${process.stdout.rows}\r\n\x1b[36m>\x1b[0m `);
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  let line = '';
  process.stdin.on('data', (d) => {
    for (const ch of d) {
      if (ch === '\r') {
        if (line === '/exit') process.exit(0);
        process.stdout.write(`\r\nyou said: \x1b[32m${line}\x1b[0m\r\n\x1b[36m>\x1b[0m `);
        line = '';
      } else if (ch === '\x7f') line && ((line = line.slice(0, -1)), process.stdout.write('\b \b'));
      else if (ch === '\x03') process.exit(130);
      else if (ch >= ' ') (line += ch), process.stdout.write(ch);
    }
  });
  process.stdout.on('resize', () => process.stdout.write(`\r\n[resized ${process.stdout.columns}x${process.stdout.rows}]\r\n\x1b[36m>\x1b[0m ${line}`));
  await new Promise(() => {});
}

// grok takes its prompt as --prompt-file (it never reads stdin); it's recorded as stdin.
const stdin =
  name === 'grok'
    ? fs.readFileSync(flag('--prompt-file'), 'utf8')
    : await new Promise((resolve) => {
        let s = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (d) => (s += d)).on('end', () => resolve(s));
      });

// A retro run (wisp's learner): recorded on its own, no tools, just the JSON reply.
const retro = name === 'claude' && !!flag('--append-system-prompt')?.includes('# wisp retro');
// A /btw side question (server/btw.js): recorded on its own too, answered in plain text.
const btw = stdin.includes('# wisp btw');

if (process.env.FAKE_RECORD) {
  fs.mkdirSync(process.env.FAKE_RECORD, { recursive: true });
  fs.appendFileSync(path.join(process.env.FAKE_RECORD, `${retro ? 'retro' : btw ? 'btw' : name}.jsonl`), JSON.stringify({ argv, stdin, cwd: process.cwd(), pwd: process.env.PWD, pid: process.pid, opencodeConfig: process.env.OPENCODE_CONFIG_CONTENT, allowAll: process.env.COPILOT_ALLOW_ALL }) + '\n');
}

if (retro) {
  out({ type: 'system', subtype: 'init', session_id: 'retro-session' });
  out({ type: 'result', subtype: 'success', is_error: false, result: process.env.FAKE_RETRO || '{}', session_id: 'retro-session' });
  process.exit(0);
}

if (btw) {
  const forked = name === 'claude' ? argv.includes('--fork-session') : name === 'codex' ? argv.includes('fork') : name === 'opencode' ? argv.includes('--fork') : false;
  if (forked && process.env.FAKE_BTW === 'nofork') {
    process.stderr.write(`error: unknown option '${name === 'codex' ? 'fork' : '--fork-session'}'\n`);
    process.exit(1);
  }
  if (process.env.FAKE_BTW === 'slow') await new Promise((r) => setTimeout(r, 3000));
  const question = stdin.split('## Side question\n\n').pop().trim();
  const text = process.env.FAKE_BTW_ANSWER || `Side answer (${forked ? 'forked' : 'digest'}): ${question}`;
  const id = `${name}-btw`;
  if (name === 'codex') {
    out({ type: 'thread.started', thread_id: id });
    out({ type: 'item.completed', item: { id: 'b1', type: 'agent_message', text } });
    out({ type: 'turn.completed', usage: { input_tokens: 4, cached_input_tokens: 0, output_tokens: 2 } });
  } else if (name === 'opencode') {
    const base = { sessionID: id, timestamp: Date.now() };
    out({ ...base, type: 'step_start', part: { type: 'step-start', messageID: 'b1' } });
    out({ ...base, type: 'text', part: { type: 'text', messageID: 'b1', text } });
    out({ ...base, type: 'step_finish', part: { type: 'step-finish', messageID: 'b1', tokens: { input: 4, output: 2 }, cost: 0 } });
  } else {
    // claude and cursor-agent share the shape: an init, then the result.
    out({ type: 'system', subtype: 'init', session_id: id });
    out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: id, duration_ms: 4, num_turns: 1, total_cost_usd: 0.002 });
  }
  process.exit(0);
}

// FAKE_LIMIT_ONCE=<file>: the first run (whichever harness) hits a usage limit, later ones work.
if (process.env.FAKE_LIMIT_ONCE && !retro && !fs.existsSync(process.env.FAKE_LIMIT_ONCE)) {
  fs.writeFileSync(process.env.FAKE_LIMIT_ONCE, name);
  process.stderr.write("You've hit your session limit · resets 9pm (Europe/Zurich)\n");
  process.exit(1);
}
if (process.env.FAKE_FAIL) {
  process.stderr.write('fake: not logged in (401)\n');
  process.exit(1);
}

if (process.env.FAKE_RATE_LIMIT && name === 'opencode') {
  process.stderr.write('timestamp=2026-10-18T22:48:58.147Z level=ERROR run=df7c9c30 message="stream error" providerID=opencode modelID=big-pickle small=false agent=build mode=primary error.error="AI_APICallError: Rate limit exceeded. Please try again later."\n');
  if (process.env.FAKE_RATE_LIMIT !== 'recover') {
    setInterval(() => {}, 60_000); // alive until killed, saying nothing
    await new Promise(() => {});
  }
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
  if (name === 'grok') {
    // --agent <file>: an agent definition whose frontmatter declares `mcpServers: [ … ]`.
    const file = flag('--agent');
    const line = file && fs.readFileSync(file, 'utf8').match(/^mcpServers: (.*)$/m);
    return line ? JSON.parse(line[1]).find((s) => s.name === 'wisp') : null;
  }
  if (name === 'copilot') {
    const cfg = flag('--additional-mcp-config');
    return cfg ? JSON.parse(cfg).mcpServers?.wisp : null;
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
const resumeId =
  name === 'claude' || name === 'cursor-agent' || name === 'grok' ? flag('--resume')
  : name === 'opencode' ? flag('--session')
  : name === 'agy' ? flag('--conversation')
  : name === 'copilot' ? argv.find((a) => a.startsWith('--resume='))?.slice(9)
  : argv.includes('resume') ? argv[argv.indexOf('resume') + 1] : undefined;
// copilot is handed the id of a new session (--session-id) rather than making one up.
const session = resumeId || (name === 'copilot' && flag('--session-id')) || `${name}-session-1`;
const fullAuto = argv.includes('--dangerously-bypass-approvals-and-sandbox') || argv.includes('--auto') || argv.includes('--allow-all') || flag('--permission-mode') === 'bypassPermissions';
const allowedPublish = fullAuto || argv.slice(argv.indexOf('--allowedTools') + 1).includes('Bash(npm publish)') || argv.includes('--allow-tool=shell(npm publish)') || JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}').permission?.bash?.['npm publish'] === 'allow';
const publishing = /BLOCKED|blocked by your permissions/.test(stdin); // the task, or wisp's retry of it
const refused = publishing && !allowedPublish;
const final = (answer) => {
  const blocks = [{ type: 'hero', title: `Fake ${name} finished`, summary: answer ? `Answer was: ${answer}` : refused ? 'npm publish was blocked.' : publishing ? 'Published.' : 'No question asked.', status: 'done' }];
  if (refused && name === 'codex') blocks.push({ type: 'blocked', items: [{ tool: 'shell', detail: 'npm publish', why: 'needs network access' }] });
  // FAILTESTS: the report shows a failing test run (what spell hooks react to).
  if (stdin.includes('FAILTESTS') && !stdin.includes('Fix them')) blocks.push({ type: 'tests', command: 'npm test', passed: 3, failed: 1 });
  // DEPLOYBLOCK: a block type a spell added.
  if (stdin.includes('DEPLOYBLOCK')) blocks.push({ type: 'deploy', env: 'staging', url: 'https://staging.example.com', status: 'ok', checks: [{ label: 'health', ok: true }] });
  // CAST: a Cast a spell task hands its spell back.
  if (stdin.includes('CAST')) blocks.push({ type: 'spell', spell: FAKE_SPELL });
  return 'All done.\n```wisp\n' + JSON.stringify({ blocks }) + '\n```';
};

const hang = () => setInterval(() => {}, 1 << 30);
if (process.env.FAKE_DELAY) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_DELAY)));
// wisp's merge-conflict fix-up: really merge the base in (this side wins each conflict), or with
// FAKE_LEAVE_CONFLICTS=1 stop halfway, conflicts and all.
const fixup = stdin.match(/`git merge ([\w.-]+\/[\w./-]+)`/);
if (fixup) {
  const g = (...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });
  g('fetch', '--quiet', fixup[1].split('/')[0]);
  try {
    g('merge', '--quiet', '--no-edit', ...(process.env.FAKE_LEAVE_CONFLICTS ? [] : ['-X', 'ours']), fixup[1]);
  } catch {}
}
// FAKE_SPELL: a JSON file with the spell a CAST task hands back (screenshots and UI checks).
const FAKE_SPELL = process.env.FAKE_SPELL ? JSON.parse(fs.readFileSync(process.env.FAKE_SPELL, 'utf8')) : { wispSpell: 1, id: 'fake-hello', name: 'Fake hello', prompt: ['Say hello first.'] };
const ask = async () => {
  const srv = injectedMcp();
  if (stdin.includes('CAST') && srv) {
    const schema = await mcpCall(srv, 'wisp_spell_schema', {});
    const check = await mcpCall(srv, 'wisp_spell_check', { spell: FAKE_SPELL });
    return `schema ${schema ? 'read' : 'missing'} | check: ${String(check).split('\n')[0]}`;
  }
  if (stdin.includes('DELEGATE') && srv) {
    const names = (list) => list.find((t) => t.name === 'delegate').inputSchema.properties.tasks.items.properties.subagent.enum.filter((n) => !n.includes('#'));
    const times = stdin.includes('DELEGATE TWICE') ? 2 : 1;
    const report = await mcpCall(srv, 'delegate', (list) => ({ tasks: names(list).flatMap((n) => Array.from({ length: times }, (_, i) => ({ subagent: n, prompt: `Check math.js for ${n}${i ? ` (${i + 1})` : ''}` }))) }));
    return report ? `delegated (${report.length} chars) ${report.match(/### [\w#-]+/g)?.join(' ')}` : 'no delegate tool';
  }
  const mention = stdin.match(/\(wisp task ([a-z0-9]+)\)/);
  if (mention && srv) {
    const task = await mcpCall(srv, 'wisp_session', { id: mention[1] });
    const list = await mcpCall(srv, 'wisp_sessions', { limit: 2 });
    return `read ${task.split('\n')[0]} | listed ${list.split('\n')[0]}`;
  }
  if (stdin.includes('APPROVE') && srv && flag('--permission-prompt-tool')) {
    const tool = flag('--permission-prompt-tool').replace(/^mcp__wisp__/, '');
    const once = () => mcpCall(srv, tool, { tool_name: 'Bash', input: { command: 'npm publish', description: 'Publish the package' }, tool_use_id: 'tp' });
    const answers = [await once()];
    if (stdin.includes('APPROVE TWICE')) answers.push(await once());
    return answers.join(' | ');
  }
  if (stdin.includes('STATS') && srv) {
    const text = await mcpCall(srv, 'wisp_stats', { days: 7, agent: 'claude' });
    return text ? text.split('\n').slice(0, 2).join(' ') : 'no wisp_stats tool';
  }
  return stdin.includes('ASK') && srv ? askUser(srv, 'Proceed with the fix?') : '';
};
// grok's own words (docs/user-guide/14-headless-mode.md), split over two writes as a pipe may.
if (refused && name === 'grok') process.stderr.write('permission required: Edit calc.py was not run, as a headless run ca'), process.stderr.write('nnot ask for approval\n');
if (refused && name === 'opencode') process.stderr.write('\x1b[93m\x1b[1m! \x1b[0mpermission requested: bash (npm publish); auto-rejecting\n');

if (name === 'claude') {
  if (process.env.FAKE_ORPHANS && resumeId) {
    out({ type: 'system', subtype: 'task_notification', session_id: session });
    out({ type: 'system', subtype: 'init', session_id: session });
    out({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: session, duration_ms: 74, num_turns: 0, total_cost_usd: 0.01 });
  }
  out({ type: 'system', subtype: 'init', session_id: session });
  out({ type: 'assistant', session_id: session, message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: target } }] } });
  if (process.env.FAKE_HANG) hang();
  else {
    out({ type: 'user', session_id: session, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: before }] }] } });
    if (stdin.includes('NARRATE')) {
      out({ type: 'assistant', session_id: session, message: { content: [{ type: 'text', text: `Looking around first.${' Here is why.'.repeat(100)}` }] } });
      out({ type: 'assistant', session_id: session, message: { content: [{ type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'git status --short', description: 'Check the tree' } }] } });
      out({ type: 'user', session_id: session, message: { content: [{ type: 'tool_result', tool_use_id: 't4', content: ' M math.js' }] } });
    }
    out({ type: 'assistant', session_id: session, message: { content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: target, old_string: 'a - b', new_string: 'a + b' } }] } });
    fs.writeFileSync(target, after);
    if (stdin.includes('ALSO')) {
      const at = argv.indexOf('--add-dir');
      const dirs = at < 0 ? [] : argv.slice(at + 1, argv.findIndex((a, i) => i > at && a.startsWith('--')));
      for (const f of dirs.map((d) => path.join(d, 'math.js')).filter((f) => fs.existsSync(f))) {
        out({ type: 'assistant', session_id: session, message: { content: [{ type: 'tool_use', id: `t2-${f}`, name: 'Edit', input: { file_path: f, old_string: 'a - b', new_string: 'a + b' } }] } });
        fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('a - b', 'a + b'));
      }
    }
    out({ type: 'assistant', session_id: session, message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }] } });
    out({ type: 'user', session_id: session, message: { content: [{ type: 'tool_result', tool_use_id: 't3', is_error: true, content: '1 failing' }] } });
    const answer = await ask();
    const bg = process.env.FAKE_BACKGROUND;
    if (bg) {
      // Captured from claude 2.1.302: the result arrives while the task runs, then the task's
      // notification wakes the agent up for a second turn and a second result.
      const task = { task_id: 'bg1', task_type: 'local_bash', description: 'Run the full test suite' };
      out({ type: 'system', subtype: 'background_tasks_changed', tasks: [task], session_id: session });
      out({ type: 'system', subtype: 'task_started', ...task, is_backgrounded: true, session_id: session });
      const first = process.env.FAKE_BACKGROUND_DONE ? final('dev server left running') : "I'll report once it has finished.";
      out({ type: 'assistant', session_id: session, message: { content: [{ type: 'text', text: first }] } });
      out({ type: 'result', subtype: 'success', is_error: false, result: first, session_id: session });
      if (bg === 'exit') process.exit(0);
      if (bg === 'hang') hang();
      else {
        await new Promise((r) => setTimeout(r, Number(bg)));
        out({ type: 'system', subtype: 'task_notification', task_id: 'bg1', status: 'completed', session_id: session });
        out({ type: 'system', subtype: 'background_tasks_changed', tasks: [], session_id: session });
        out({ type: 'system', subtype: 'init', session_id: session });
        out({ type: 'result', subtype: 'success', is_error: false, result: final('background done'), session_id: session });
      }
    } else out({ type: 'result', subtype: 'success', is_error: false, result: final(answer), session_id: session, duration_ms: 5, num_turns: 3, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, permission_denials: refused ? [{ tool_name: 'Bash', tool_use_id: 't9', tool_input: { command: 'npm publish', description: 'Publish' } }] : [] });
  }
} else if (name === 'codex') {
  out({ type: 'thread.started', thread_id: session });
  out({ type: 'turn.started' });
  out({ type: 'item.started', item: { id: 'i0', type: 'command_execution', command: process.platform === 'win32' ? '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "npm test"' : "/bin/bash -lc 'npm test'", status: 'in_progress' } });
  if (process.env.FAKE_HANG) hang();
  else {
    out({ type: 'item.completed', item: { id: 'i0', type: 'command_execution', command: 'npm test', exit_code: 1, aggregated_output: '1 failing', status: 'failed' } });
    out({ type: 'item.started', item: { id: 'i3', type: 'command_execution', command: "/bin/bash -lc 'git status --short'", status: 'in_progress' } });
    out({ type: 'item.completed', item: { id: 'i3', type: 'command_execution', command: "/bin/bash -lc 'git status --short'", exit_code: 0, aggregated_output: ' M math.js', status: 'completed' } });
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
} else if (name === 'grok') {
  // --output-format streaming-messages-json: Claude's stream-json shape with grok's tool names.
  // A batch of tool calls may be streamed after it ran; results follow as `user` tool_results.
  const ev = (o) => out({ ...o, parent_tool_use_id: null, session_id: session });
  const use = (id, tool, input) => ev({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input }] } });
  const result = (id, content, isError = false) => ev({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
  out({ type: 'system', subtype: 'init', session_id: session, cwd, tools: ['read_file', 'search_replace', 'write', 'run_terminal_command', 'use_tool'] });
  use('c1', 'read_file', { target_file: target });
  if (process.env.FAKE_HANG) hang();
  else {
    result('c1', JSON.stringify({ type: 'ReadFile' }));
    fs.writeFileSync(target, after);
    fs.writeFileSync(path.join(cwd, 'notes.txt'), 'new file\n');
    ev({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'fixing' },
      { type: 'tool_use', id: 'c2', name: 'search_replace', input: { file_path: target, old_string: 'a - b', new_string: 'a + b' } },
      { type: 'tool_use', id: 'c3', name: 'write', input: { file_path: path.join(cwd, 'notes.txt'), content: 'new file\n' } },
    ] } });
    ev({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c2', content: '{}', is_error: false }, { type: 'tool_result', tool_use_id: 'c3', content: '{}', is_error: false }] } });
    use('c4', 'run_terminal_command', { command: 'npm test', description: 'Run the tests' });
    result('c4', '1 failing', true);
    const answer = await ask();
    if (answer) {
      use('c5', 'use_tool', { tool_name: 'wisp__ask_user', tool_input: { question: 'Proceed with the fix?' } });
      result('c5', answer);
    }
    out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: 3, result: final(answer), stop_reason: 'end_turn', total_cost_usd: 0.02, usage: { input_tokens: 10, output_tokens: 5 }, session_id: session });
  }
} else if (name === 'copilot') {
  // --output-format json: copilot's session events (as captured from copilot 1.0.86), deltas left
  // out, then one `result` line. Tools announce themselves before they run and report when done.
  let n = 0;
  const ev = (type, data, extra = {}) => out({ type, data, id: `e${++n}`, timestamp: new Date().toISOString(), parentId: n > 1 ? `e${n - 1}` : null, ...extra });
  const start = (id, toolName, args, extra = {}) => ev('tool.execution_start', { toolCallId: id, toolName, arguments: args, turnId: '0', ...extra });
  const done = (id, result, success = true) => ev('tool.execution_complete', { toolCallId: id, success, ...(success ? { result } : { error: result }), turnId: '0' });
  const notes = path.join(cwd, 'notes.txt');
  ev('session.mcp_server_status_changed', { serverName: 'github-mcp-server', status: 'connected' }, { ephemeral: true });
  // FAKE_MCP_POLICY: an organization that turned third-party MCP servers off (copilot's own words).
  if (process.env.FAKE_MCP_POLICY && injectedMcp()) ev('session.warning', { message: "1 MCP server was blocked by policy: 'wisp'", warningType: 'mcp' }, { ephemeral: true });
  ev('user.message', { content: stdin, turnId: '0' });
  ev('assistant.turn_start', { turnId: '0' });
  ev('assistant.message', { messageId: 'm1', content: 'Reading math.js first.', toolRequests: [{ toolCallId: 'c1', name: 'view', arguments: { path: target } }] });
  start('c1', 'view', { path: target });
  if (process.env.FAKE_HANG) hang();
  else {
    done('c1', { content: before });
    ev('assistant.reasoning', { reasoningId: 'r1', content: 'fixing' });
    // A subagent's own steps carry its agent id.
    ev('assistant.message', { messageId: 's1', content: 'subagent chatter' }, { agentId: 'sub-1' });
    start('c2', 'edit', { path: target, old_str: 'a - b', new_str: 'a + b' });
    fs.writeFileSync(target, after);
    done('c2', { content: `File ${target} updated with changes.` });
    start('c3', 'create', { path: notes, file_text: 'new file\n' });
    fs.writeFileSync(notes, 'new file\n');
    done('c3', { content: `Created file ${notes} with 9 characters` });
    start('c4', 'bash', { command: 'npm test', description: 'Run the tests' });
    done('c4', { content: '1 failing\n<exited with exit code 1>' });
    if (publishing) {
      start('c6', 'bash', { command: 'npm publish', description: 'Publish the package' });
      if (refused) {
        ev('permission.requested', { requestId: 'p1', permissionRequest: { kind: 'shell', toolCallId: 'c6', fullCommandText: 'npm publish', intention: 'Publish the package', commands: [{ identifier: 'npm publish', readOnly: false }], possiblePaths: [] } });
        ev('permission.completed', { requestId: 'p1', result: { kind: 'denied-no-approval-rule-and-could-not-request-from-user' } });
        done('c6', { message: 'Permission denied and could not request permission from user' }, false);
      } else done('c6', { content: '+ fake@1.0.0' });
    }
    const answer = await ask();
    if (answer) {
      start('c5', 'wisp-ask_user', { question: 'Proceed with the fix?' }, { mcpServerName: 'wisp', mcpToolName: 'ask_user' });
      done('c5', { content: answer });
    }
    ev('assistant.turn_end', { turnId: '0' });
    ev('assistant.turn_start', { turnId: '1' });
    ev('assistant.message', { messageId: 'm2', content: final(answer), toolRequests: [] });
    ev('assistant.turn_end', { turnId: '1' });
    ev('assistant.idle', {}, { ephemeral: true });
    // FAKE_SESSION_ERROR: the run hit a quota after its work (copilot then exits 1).
    if (process.env.FAKE_SESSION_ERROR) ev('session.error', { errorType: 'quota', message: process.env.FAKE_SESSION_ERROR });
    // The usage file counts the whole session: a follow-up's totals include the turns before it.
    const prior = resumeId ? 1 : 0;
    const usage = flag('--usage-output-file');
    if (usage) fs.writeFileSync(usage, JSON.stringify({ totalPremiumRequestCost: 1 + prior, modelMetrics: { 'fake-model': { requests: { count: 2, cost: 1 }, usage: { inputTokens: 10 + 15 * prior, outputTokens: 5 + 7 * prior } } } }));
    out({ type: 'result', timestamp: new Date().toISOString(), sessionId: session, exitCode: process.env.FAKE_SESSION_ERROR ? 1 : 0, usage: { premiumRequests: 1 + prior, totalApiDurationMs: 4, sessionDurationMs: 6, codeChanges: { linesAdded: 2, linesRemoved: 1, filesModified: [target, notes] } } });
  }
}
if (process.env.FAKE_LINGER) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_LINGER)));
