#!/usr/bin/env node
// A stand-in `claude` for the README demo: speaks claude's stream-json like test/fixtures/fake-agent.mjs,
// but with scripted, believable work per crew member (who it is comes from the crew note in the
// system prompt) and for the rate-limit task, which asks one question through wisp's ask_user.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
if (argv[0] === '--version' || argv[0] === '-v') {
  console.log('9.9.9 (Claude Code)');
  process.exit(0);
}
if (argv.join(' ') === 'auth status') process.exit(0);
if (argv[0] === '--help') {
  console.log('Usage: claude [options]\n\n  --effort <level>        Effort level for the current session\n                          (low, medium, high, xhigh, max)');
  process.exit(0);
}

const stdin = await new Promise((r) => {
  let s = '';
  process.stdin.on('data', (d) => (s += d));
  process.stdin.on('end', () => r(s));
  setTimeout(() => r(s), 400);
});
const all = argv.join(' ');
const who = all.match(/## You are ([\w-]+), on the user's crew/)?.[1] || '';
const checkin = stdin.startsWith('Check-in');
const flag = (f) => (argv.indexOf(f) >= 0 ? argv[argv.indexOf(f) + 1] : undefined);
const session = flag('--resume') || `director-${process.pid}`;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scale = Number(process.env.DIRECTOR_SCALE || 1);
let n = 0;
const tool = async (name, input, result, ms = 700) => {
  const id = `t${++n}`;
  out({ type: 'assistant', session_id: session, message: { content: [{ type: 'tool_use', id, name, input }] } });
  await sleep(ms * scale);
  out({ type: 'user', session_id: session, message: { content: [{ type: 'tool_result', tool_use_id: id, content: result }] } });
};
const say = (text) => out({ type: 'assistant', session_id: session, message: { content: [{ type: 'text', text }] } });

// wisp's MCP server (--mcp-config), called the way a real agent would.
async function askUser(question, options) {
  const cfg = argv.indexOf('--mcp-config') >= 0 ? JSON.parse(argv[argv.indexOf('--mcp-config') + 1]).mcpServers?.wisp : null;
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

const LOGIN_AFTER = `import { limiter } from './limiter.js';
import { verify } from './passwords.js';

const attempts = limiter({ max: 5, windowMs: 60_000 });

export async function login(req, res) {
  const gate = attempts(req.ip);
  if (!gate.ok) {
    res.setHeader('Retry-After', gate.retryAfter);
    return res.status(429).json({ error: 'Too many attempts, try again shortly.' });
  }
  const { email, password } = req.body;
  if (!(await verify(email, password))) return res.status(401).end();
  res.json({ ok: true });
}
`;
const LIMITER = `// Sliding window per key, with an injectable clock for tests.
export function limiter({ max, windowMs, now = Date.now }) {
  const hits = new Map();
  return (key) => {
    const t = now();
    const recent = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (recent.length >= max) return { ok: false, retryAfter: Math.ceil((windowMs - (t - recent[0])) / 1000) };
    hits.set(key, [...recent, t]);
    return { ok: true };
  };
}
`;
const loginTask = async () => {
  const dir = path.join(process.cwd(), 'src/auth');
  await tool('Read', { file_path: path.join(dir, 'login.js') }, '…', 900);
  await tool('Grep', { pattern: 'req.ip', path: 'src' }, 'src/auth/login.js', 700);
  const answer = await askUser('Is the API behind a proxy? If so, req.ip is the proxy and every user shares one limit.', ['Yes, behind nginx', 'No, direct']);
  fs.mkdirSync(dir, { recursive: true });
  await tool('Write', { file_path: path.join(dir, 'limiter.js'), content: LIMITER }, 'ok', 700); // wisp snapshots the file as the call starts
  fs.writeFileSync(path.join(dir, 'limiter.js'), LIMITER);
  // wisp builds the diff block from the edits it saw, so the Edit carries the whole before and after.
  const before = fs.readFileSync(path.join(dir, 'login.js'), 'utf8');
  fs.writeFileSync(path.join(dir, 'login.js'), LOGIN_AFTER);
  await tool('Edit', { file_path: path.join(dir, 'login.js'), old_string: before, new_string: LOGIN_AFTER }, 'ok', 700);
  await tool('Bash', { command: 'npm test', description: 'Run the tests' }, '14 passing', 1100);
  const proxy = /yes/i.test(answer);
  return {
    blocks: [
      { type: 'hero', title: 'Login is rate-limited', summary: `A sliding-window limiter caps /login at 5 attempts per minute per IP. The 6th gets a 429 with Retry-After.${proxy ? ' Set trust proxy so req.ip is the client, not nginx.' : ''}`, status: 'done' },
      { type: 'diff', file: 'src/auth/login.js', caption: 'The handler checks the limiter first' },
      { type: 'tests', command: 'npm test', passed: 14, failed: 0, skipped: 0, durationMs: 2100 },
      { type: 'files', items: [{ path: 'src/auth/limiter.js', change: 'added', note: 'sliding window, injectable clock' }, { path: 'src/auth/login.js', change: 'modified', note: '429 + Retry-After' }] },
      { type: 'actions', items: [{ label: 'Commit and open a PR', reply: 'Commit this and open a PR' }] },
      { type: 'next', items: ['Make the limit configurable', 'Add the same limiter to /reset-password'] },
    ],
  };
};

const scripts = {
  Scout: async () => {
    await tool('Bash', { command: 'gh run list --branch main --limit 5', description: 'Check CI on main' }, 'X  CI  main  #418  failed  2m', 900);
    await tool('Bash', { command: 'gh run view 418 --log-failed', description: 'Read the failed job' }, 'checkout.test.js › applies coupon › Timeout 5000ms', 900);
    const f = path.join(process.cwd(), 'src/checkout.js');
    if (fs.existsSync(f)) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('await fetchRates()', 'await fetchRates({ cache: true })'));
    await tool('Edit', { file_path: f, old_string: 'await fetchRates()', new_string: 'await fetchRates({ cache: true })' }, 'ok', 700);
    await tool('Bash', { command: 'npm test', description: 'Run the tests' }, '128 passing', 1000);
    return {
      blocks: [
        { type: 'hero', title: 'CI on main fixed on a branch', summary: 'Run #418 failed: checkout.test.js timed out on a live rates call. Cached the rates lookup; pushed to fix/checkout-timeout.', status: 'done' },
        { type: 'tests', command: 'npm test', passed: 128, failed: 0, skipped: 0, durationMs: 4200 },
        { type: 'files', items: [{ path: 'src/checkout.js', change: 'modified', note: 'cache fetchRates() in the coupon path' }] },
        { type: 'next', items: ['Open a PR for fix/checkout-timeout', 'Mark checkout.test.js as network-free'] },
        { type: 'crew', remember: ['main red at #418: checkout timeout, fix on fix/checkout-timeout'], wakeIn: 30 },
      ],
    };
  },
  Quill: async () => {
    await tool('Bash', { command: 'gh pr diff 142', description: 'Read PR #142' }, '+ export function applyCoupon(cart, code) {', 900);
    await tool('Read', { file_path: path.join(process.cwd(), 'src/checkout.js') }, '…', 600);
    return {
      blocks: [
        { type: 'hero', title: 'PR #142: two things before merging', summary: 'Coupons can stack past 100% and the new path has no test. Rest looks good.', status: 'done' },
        { type: 'markdown', text: '1. `applyCoupon` never clamps the total, so two coupons can go below zero.\n2. No test covers an expired code.' },
        { type: 'crew', remember: ['reviewed #142 at 3f9c2e1'] },
      ],
    };
  },
  Tinker: async () => {
    await tool('Bash', { command: 'npm outdated', description: 'Check dependencies' }, 'all up to date', 900);
    return { blocks: [{ type: 'hero', title: 'Dependencies up to date', summary: 'Nothing outdated or vulnerable.', status: 'info' }, { type: 'crew', quiet: true }] };
  },
  Echo: async () => {
    await tool('Bash', { command: 'git log --since=1.week --oneline', description: 'Read this week' }, '14 commits', 1200);
    await tool('Edit', { file_path: path.join(process.cwd(), 'CHANGELOG.md'), old_string: '## Unreleased', new_string: '## Unreleased\n- Coupons' }, 'ok', 900);
    return { blocks: [{ type: 'hero', title: 'Release notes drafted', summary: '6 entries for this week in CHANGELOG.md, uncommitted.', status: 'done' }, { type: 'crew', remember: ['drafted notes up to 3f9c2e1'] }] };
  },
  Sorter: async () => {
    await tool('Bash', { command: 'gh issue list --state open --limit 20', description: 'Read new issues' }, '3 new', 1400);
    return { blocks: [{ type: 'hero', title: '3 new issues, 1 duplicate', summary: '#88 duplicates #71. #90 is worth doing first.', status: 'done' }, { type: 'crew', remember: ['seen issues up to #90'] }] };
  },
};

out({ type: 'system', subtype: 'init', session_id: session });
await sleep(Number(process.env.DIRECTOR_START || 300));
let pres;
if (scripts[who]) pres = await scripts[who]({ checkin });
else if (/rate limiting to \/login/i.test(stdin)) pres = await loginTask();
else if (/Migrate billing/i.test(stdin)) {
  // Background work that stays busy for the whole take.
  for (const [d, c] of [['Find the old API calls', 'grep -rn "billing/v1" src'], ['Read the v2 migration guide', 'curl -s docs.pay.dev/v2/migrate'], ['Port the invoice client', 'node scripts/port.js'], ['Run the billing tests', 'npm test -- billing']])
    await tool('Bash', { command: c, description: d }, 'ok', 9000);
  pres = { blocks: [{ type: 'hero', title: 'Billing on the v2 API', summary: 'Invoices and refunds moved to v2; webhooks still on v1.', status: 'partial' }] };
}
else {
  await tool('Read', { file_path: path.join(process.cwd(), 'src/checkout.js') }, '…', 1500);
  await tool('Bash', { command: 'npm test', description: 'Run the tests' }, '128 passing', 4000);
  pres = { blocks: [{ type: 'hero', title: 'Done', summary: 'Changed what you asked.', status: 'done' }] };
}
const text = 'Done.\n```wisp\n' + JSON.stringify(pres) + '\n```';
say(text);
out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session, duration_ms: 5000, num_turns: 4, total_cost_usd: 0.04, usage: { input_tokens: 1200, output_tokens: 300 } });
