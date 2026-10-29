#!/usr/bin/env node
// A stand-in `claude` and `codex` for the guide screenshots. Prompts it knows get scripted, believable
// work and a report (claude's stream-json or codex's JSONL); anything else (--version, model lists,
// goal checks, the Auto scout) goes to wisp's own fake agent, test/fixtures/fake-agent.mjs.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const name = path.basename(process.argv[1]).replace(/\.m?js$/, '');
const argv = process.argv.slice(2);
const flag = (f) => (argv.indexOf(f) >= 0 ? argv[argv.indexOf(f) + 1] : undefined);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * Number(process.env.DIRECTOR_SCALE || 1)));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

const stdin = argv[0] === '--version' || argv[0] === '--help' || argv[0] === 'debug' || argv[0] === 'auth'
  ? ''
  : await new Promise((r) => {
    let s = '';
    process.stdin.on('data', (d) => (s += d));
    process.stdin.on('end', () => r(s));
    setTimeout(() => r(s), 400);
  });

// Not one of ours: the fake agent, with the same name, args and stdin.
const fallback = () => {
  const child = spawn(process.execPath, [path.join(process.env.FAKE_AGENTS, `${name}.mjs`), ...argv], { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(stdin);
  child.on('exit', (code) => process.exit(code ?? 0));
};

const SESSION_BEFORE = `export class SessionStore {
  constructor({ ttlMs }) {
    this.ttlMs = ttlMs;
    this.map = new Map();
  }
  touch(id) {
    this.map.set(id, Date.now() + this.ttlMs);
  }
  expired(id) {
    return (this.map.get(id) ?? 0) < Date.now();
  }
}
`;
const SESSION_AFTER = `export class SessionStore {
  constructor({ ttlMs, clock = Date }) {
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.map = new Map();
  }
  touch(id) {
    this.map.set(id, this.clock.now() + this.ttlMs);
  }
  expired(id) {
    return (this.map.get(id) ?? 0) <= this.clock.now();
  }
}
`;

const BOARD_SPELL = {
  wispSpell: 1,
  id: 'task-board',
  name: 'Task board',
  version: '1.0.0',
  description: 'How many tasks are working, need you and are done, from a floating button.',
  data: { sessions: { wisp: '/sessions' } },
  buttons: [{ slot: 'float', icon: 'stats', label: 'Board', do: { panel: 'board' } }],
  panels: [{ id: 'board', title: 'Task board', as: 'dialog', data: ['sessions'], render: 'board' }],
  script:
    "export function board({ sessions }) {\n  const n = (f) => sessions.filter(f).length;\n  return [{ type: 'stats', items: [\n    { label: 'working', value: n((s) => s.state === 'running') },\n    { label: 'need you', value: n((s) => s.state === 'waiting' || s.unread) },\n    { label: 'done', value: n((s) => s.state === 'review' && !s.unread) },\n  ] }];\n}",
};

// [match, harness, work] — work returns { tools: [[kind, input, result]], edits: [[file, before, after]], blocks, cost }
const SCENES = [
  [/flaky session-expiry test/i, 'claude', () => ({
    tools: [['Read', { file_path: 'src/auth/session.ts' }], ['Bash', { command: 'npx vitest run session --repeat 200', description: 'Run the test 200 times' }, '7 failed of 200']],
    edits: [['src/auth/session.ts', SESSION_BEFORE, SESSION_AFTER]],
    cost: 0.31,
    blocks: [
      { type: 'hero', title: 'Session-expiry test no longer flakes', summary: 'The test slept 50 ms and raced the token TTL. SessionStore now takes an injectable clock, so the test sets the time instead of waiting for it.', status: 'done' },
      { type: 'stats', items: [{ label: 'runs in a row', value: 200, tone: 'good' }, { label: 'failures', value: 0, delta: '-7', tone: 'good' }, { label: 'test time', value: 0.4, unit: 's', delta: '-1.1s', tone: 'good' }] },
      { type: 'diff', file: 'src/auth/session.ts', caption: 'The clock is a constructor option; expiry is inclusive' },
      { type: 'tests', command: 'npx vitest run', passed: 214, failed: 0, skipped: 0, durationMs: 6100 },
      { type: 'files', items: [{ path: 'src/auth/session.ts', change: 'modified', note: 'injectable clock' }, { path: 'test/session.test.ts', change: 'modified', note: 'fake clock instead of sleep(50)' }] },
      { type: 'callout', tone: 'info', title: 'Expiry is now inclusive', text: 'A token is expired at its TTL, not 1 ms after. Nothing else relied on the old edge.' },
      { type: 'next', items: ['Use the same clock in RefreshStore', 'Commit and open a PR'] },
    ],
  })],
  [/zod 4/i, 'claude', () => ({
    tools: [['Bash', { command: 'npm i zod@4', description: 'Install zod 4' }, 'ok'], ['Bash', { command: 'npm test', description: 'Run the tests' }, '341 passing']],
    edits: [['src/validate.ts', "import { z } from 'zod';\nexport const format = (e) => e.format();\n", "import { z } from 'zod/v4';\n// Same error body as zod 3: clients parse it.\nexport const format = (e) => z.treeifyError(e);\n"], ['src/schemas/user.ts', "email: z.string().email(),\n", "email: z.email(),\n"]],
    cost: 0.94,
    blocks: [
      { type: 'hero', title: 'zod 4 everywhere, error messages unchanged', summary: 'Migrated 31 schemas. Wrapped .format() so API error bodies stay byte-for-byte the same.', status: 'done' },
      { type: 'tests', command: 'npm test', passed: 341, failed: 0, skipped: 0, durationMs: 6200 },
    ],
  })],
  [/zod 4/i, 'codex', () => ({
    tools: [['shell', 'npm i zod@4'], ['shell', 'npm test', '2 failing']],
    edits: [['src/validate.ts', "import { z } from 'zod';\nexport const format = (e) => e.format();\n", "import { z } from 'zod';\nexport const format = (e) => z.treeifyError(e);\n"]],
    blocks: [
      { type: 'hero', title: 'zod 4 migrated, 2 snapshot tests changed', summary: 'All schemas compile on zod 4. Error format moved to the new issue shape, so two API snapshot tests were updated.', status: 'partial' },
      { type: 'tests', command: 'npm test', passed: 339, failed: 2, skipped: 0, durationMs: 6400 },
    ],
  })],
  // The goal task: two rounds that fall short, then round 3 keeps working for the shot.
  [/login on phones|login form fits a 390px/i, 'claude', () => ({
    tools: [['Read', { file_path: 'src/auth/login.css' }], ['Bash', { command: 'npm test -- auth', description: 'Run the auth tests' }, '38 passing']],
    edits: [['src/auth/login.css', '.login { width: 412px; }\n', '.login { width: min(412px, 100%); }\n']],
    hang: /round 3 of/.test(stdin), // no report: a hero would rename the task
  })],
  [/Board spell|task board/i, 'claude', () => ({
    tools: [['mcp__wisp__wisp_spell_schema', {}], ['mcp__wisp__wisp_sessions', { limit: 50 }], ['mcp__wisp__wisp_spell_check', { spell: BOARD_SPELL }, 'ok']],
    blocks: [{ type: 'spell', spell: BOARD_SPELL }],
  })],
  [/Stripe/i, 'claude', () => ({ ask: ['Stripe still sends v1 events for 30 days. Keep a v1 handler alongside v2?', ['Keep both for 30 days', 'v2 only']] })],
  [/Node 22/i, 'codex', () => ({ tools: [['shell', 'nvm use 22'], ['shell', 'npm test', '3 failing in date-fns adapter']], hang: true })],
  [/onboarding/i, 'claude', () => ({ tools: [['Read', { file_path: 'src/onboarding/Welcome.tsx' }]], hang: true })],
  [/invoices endpoint/i, 'codex', () => ({
    tools: [['shell', 'npm test -- invoices', '22 passing']],
    edits: [['src/routes/invoices.ts', 'const rows = await db.invoices.all();\n', 'const rows = await db.invoices.page({ cursor, limit });\n']],
    blocks: [{ type: 'hero', title: '/invoices is paginated', summary: 'Added ?cursor and ?limit (default 50, max 200). Responses carry next_cursor.', status: 'done' }, { type: 'tests', command: 'npm test', passed: 22, failed: 0 }],
  })],
  [/camera permission/i, 'claude', () => ({
    tools: [['Grep', { pattern: 'requestPermissions', path: 'android' }, 'PermissionGate.kt']],
    blocks: [{ type: 'hero', title: 'Camera crash fixed, no device test yet', summary: 'PermissionGate assumed the result array was non-empty. Guarded it and added a unit test.', status: 'partial' }],
  })],
  [/auth SDK/i, 'claude', () => ({ limit: true })],
];

// wisp's own prompts (a goal check) quote the task's, so they never match a scene.
const internal = stdin.includes('You check whether a coding agent reached its goal');
const scene = !internal && SCENES.find(([re, who]) => who === name && re.test(stdin))?.[2]?.();
if (!scene) fallback();
else await play(scene);

async function askUser(question, options) {
  const cfg = flag('--mcp-config') ? JSON.parse(flag('--mcp-config')).mcpServers?.wisp : null;
  if (!cfg) return options[0];
  const child = spawn(cfg.command, cfg.args || [], { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (l) => pending.get(JSON.parse(l).id)?.(JSON.parse(l)));
  let id = 0;
  const rpc = (method, params) => new Promise((r) => (pending.set(++id, r), child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')));
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'director', version: '0' } });
  const res = await rpc('tools/call', { name: 'ask_user', arguments: { question, options } });
  child.kill();
  return res.result?.content?.[0]?.text || '';
}

async function play(s) {
  const cwd = process.cwd();
  const abs = (f) => path.join(cwd, f);
  const text = s.blocks ? 'Done.\n```wisp\n' + JSON.stringify({ blocks: s.blocks }) + '\n```' : 'Done.';
  // Files start as "before", so the edit is a real change in the worktree.
  for (const [f, before] of s.edits || []) {
    fs.mkdirSync(path.dirname(abs(f)), { recursive: true });
    if (!fs.existsSync(abs(f))) fs.writeFileSync(abs(f), before);
  }
  if (name === 'claude') {
    const session = flag('--resume') || `director-${process.pid}`;
    out({ type: 'system', subtype: 'init', session_id: session });
    if (s.limit) {
      process.stderr.write("You've hit your session limit · resets 9pm (Europe/Zurich)\n");
      process.exit(1);
    }
    let n = 0;
    const tool = async (kind, input, result = 'ok') => {
      const id = `t${++n}`;
      out({ type: 'assistant', session_id: session, message: { content: [{ type: 'tool_use', id, name: kind, input }] } });
      await sleep(500);
      out({ type: 'user', session_id: session, message: { content: [{ type: 'tool_result', tool_use_id: id, content: result }] } });
    };
    for (const [kind, input, result] of s.tools || []) await tool(kind, input, result);
    if (s.ask) await askUser(...s.ask);
    for (const [f, before, after] of s.edits || []) {
      fs.writeFileSync(abs(f), after);
      await tool('Edit', { file_path: abs(f), old_string: before, new_string: after });
    }
    if (s.hang) await new Promise(() => setInterval(() => {}, 1 << 30));
    out({ type: 'assistant', session_id: session, message: { content: [{ type: 'text', text }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session, duration_ms: 60000, num_turns: 6, total_cost_usd: s.cost ?? 0.12, usage: { input_tokens: 42000, output_tokens: 3100 } });
  } else {
    out({ type: 'thread.started', thread_id: `codex-${process.pid}` });
    out({ type: 'turn.started' });
    let n = 0;
    for (const [, command, result = 'ok'] of s.tools || []) {
      const id = `i${++n}`;
      out({ type: 'item.started', item: { id, type: 'command_execution', command: `/bin/bash -lc '${command}'`, status: 'in_progress' } });
      await sleep(500);
      out({ type: 'item.completed', item: { id, type: 'command_execution', command: `/bin/bash -lc '${command}'`, exit_code: /fail/.test(result) ? 1 : 0, aggregated_output: result, status: /fail/.test(result) ? 'failed' : 'completed' } });
    }
    for (const [f, , after] of s.edits || []) fs.writeFileSync(abs(f), after);
    if (s.edits?.length) out({ type: 'item.completed', item: { id: `i${++n}`, type: 'file_change', changes: s.edits.map(([f]) => ({ path: abs(f), kind: 'update' })), status: 'completed' } });
    if (s.hang) await new Promise(() => setInterval(() => {}, 1 << 30));
    out({ type: 'item.completed', item: { id: `i${++n}`, type: 'agent_message', text } });
    out({ type: 'turn.completed', usage: { input_tokens: 38000, cached_input_tokens: 12000, output_tokens: 2600 } });
  }
  process.exit(0);
}
