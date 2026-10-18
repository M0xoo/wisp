// wisp-bench runner: every (task × arm) through wisp's own adapters, then wisp's visible gate, a hidden-test
// grade, and — when the gate fails — one repair round (resume with the failures) graded again.
// Every attempt is a line in out/runs.jsonl, so strategies (best-of-N, repair, escalate, routers) can be
// simulated afterwards from the same runs. Resumable: finished (task, arm, trial) are skipped.
//
//   node bench/run.mjs [--arms a,b] [--tasks x,y] [--trials 1] [--jobs 8]

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { adapters } from '../server/adapters/index.js';
import { systemPrompt, parsePresentation } from '../server/protocol.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const RUNS = path.join(OUT, 'runs.jsonl');
const WORK = '/tmp/wbj'; // one random dir per job: no sibling attempts or answer files next to the agent
const LEAK = /\/tmp\/wb\b|wisp-bench-private|harness-bench|verified\.jsonl|\/tmp\/wbj\/(?!JOB)/;
const PY = '/tmp/wb/swe3/bin/python';
const HBPY = path.join(process.env.HOME, '.wisp-bench-private', 'hbv', 'bin', 'python');
process.env.PATH = `/tmp/wbpy/bin:${process.env.PATH}`; // python3 = 3.12 + pytest for the agents
const RUN_TIMEOUT = 30 * 60_000;
const REPAIR_TIMEOUT = 20 * 60_000;

export const ARMS = {
  'claude-opus': { agent: 'claude', model: 'opus' },
  'claude-sonnet': { agent: 'claude', model: 'sonnet' },
  'claude-haiku': { agent: 'claude', model: 'haiku' },
  codex: { agent: 'codex', model: '' },
  'grok-4.7': { agent: 'grok', model: 'grok-4.7' },
  'gemini-argon': { agent: 'antigravity', model: 'gemini-4-argon-medium' },
  'gemini-flash': { agent: 'antigravity', model: 'gemini-3.8-flash-medium' },
  'deepseek-free': { agent: 'opencode', model: 'opencode/deepseek-v4.1-flash-free' },
};
const PER_HARNESS = { claude: 4, codex: 3, grok: 3, antigravity: 3, opencode: 3 };

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const JOBS = Number(args.jobs || 8);
const TRIALS = Number(args.trials || 1);
const armIds = args.arms ? args.arms.split(',') : Object.keys(ARMS);

// Tasks: validated ones only, with the visible-test statuses at base for the gate.
function loadTasks() {
  const tasks = [];
  const wv = fs.existsSync(path.join(OUT, 'wisp-valid.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'wisp-valid.json'), 'utf8')) : {};
  const wt = JSON.parse(fs.readFileSync(path.join(HERE, 'wisp-tasks.json'), 'utf8'));
  for (const t of wt) if (wv[t.id]?.ok) tasks.push({ id: t.id, kind: 'wisp', difficulty: t.difficulty, base: wv[t.id].base_status, prompt: t.prompt });
  const sv = fs.existsSync(path.join(OUT, 'swe-valid.jsonl')) ? fs.readFileSync(path.join(OUT, 'swe-valid.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const meta = Object.fromEntries(fs.readFileSync(path.join(process.env.HOME, '.wisp-bench-private', 'verified.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((r) => [r.instance_id, r]));
  for (const v of sv) if (v.ok) tasks.push({ id: v.id, kind: 'swe', difficulty: meta[v.id].difficulty, base: v.base_status, prompt: meta[v.id].problem_statement, repo: meta[v.id].repo });
  const hv = fs.existsSync(path.join(OUT, 'hb-valid.jsonl')) ? fs.readFileSync(path.join(OUT, 'hb-valid.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  for (const v of hv) if (v.ok) tasks.push({ id: v.id, kind: 'hb', difficulty: v.difficulty, category: v.category, base: {}, prompt: null });
  return args.tasks ? tasks.filter((t) => args.tasks.split(',').includes(t.id)) : tasks;
}

function grader(task, cmd, ...rest) {
  const bin = { swe: PY, hb: HBPY, wisp: process.execPath }[task.kind];
  const script = path.join(HERE, { swe: 'swe.py', hb: 'hb.py', wisp: 'wisp.mjs' }[task.kind]);
  return new Promise((resolve) => {
    execFile(bin, [script, cmd, task.id, ...rest], { cwd: HERE, maxBuffer: 64 << 20, timeout: 45 * 60_000 }, (err, stdout, stderr) => {
      try {
        resolve(JSON.parse(stdout.trim().split('\n').at(-1)));
      } catch {
        resolve({ error: (stderr || err?.message || 'no output').slice(-1500) });
      }
    });
  });
}

const ENV_NOTE = {
  swe: 'A Python virtualenv with the project installed in editable mode is ready at `.venv` (run tests with `.venv/bin/python -m pytest …`, or for django `.venv/bin/python tests/runtests.py <module>`, for sympy `.venv/bin/python bin/test <file>`).',
  hb: 'Tools: `python3` is Python 3.12 with pytest; git and sqlite3 are available. There is no network access you should rely on.',
  wisp: 'This is a Node project with no dependencies to install. Run tests with `node --test test/<file>.test.js` (the full suite is `npm test`).',
};
const taskPrompt = (t) =>
  t.kind === 'hb'
    ? `${t.prompt}\n\n${ENV_NOTE.hb}\n\nYou are working autonomously: nobody will answer questions, so make reasonable assumptions and finish the task completely.`
    : `${t.kind === 'swe' ? `Resolve this issue in the repository in the current directory.\n\n<issue>\n${t.prompt}\n</issue>` : t.prompt}\n\n${ENV_NOTE[t.kind]}\n\nYou are working autonomously: nobody will answer questions, so make reasonable assumptions. Change the source to fix the issue and add or update tests that cover it. Do not commit.`;

function runAgent(arm, { prompt, cwd, resumeId, timeout }) {
  const ad = adapters[arm.agent];
  const rec = { leaks: [], sessionId: resumeId || null, tools: 0, toolErrors: 0, changes: new Set(), text: '', isError: false, stats: {}, timedOut: false };
  const t0 = Date.now();
  return new Promise((resolve) => {
    let h;
    try {
      h = ad.run({ prompt, cwd, resumeId, mode: 'auto', model: arm.model, effort: arm.effort || '', systemPrompt: systemPrompt({ askTool: null }), attachments: [], onEvent: (e) => {
        if (e.type === 'session') rec.sessionId = e.id;
        else if (e.type === 'tool') {
          rec.tools++;
          const s = `${e.label || ''} ${e.detail || ''} ${e.file || ''}`.split(cwd).join('');
          if (LEAK.test(s.replace(/\/tmp\/wbj\/JOB/g, ''))) rec.leaks.push(s.slice(0, 200));
        }
        else if (e.type === 'tool_error') rec.toolErrors++;
        else if (e.type === 'change') rec.changes.add(e.file);
        else if (e.type === 'result') Object.assign(rec, { text: e.text || '', isError: !!e.isError, stats: e.stats || {} });
      } });
    } catch (err) {
      return resolve({ ...rec, isError: true, text: String(err.message), wallMs: 0, changes: [] });
    }
    const timer = setTimeout(() => ((rec.timedOut = true), h.stop()), timeout);
    h.done.then(() => {
      clearTimeout(timer);
      resolve({ ...rec, changes: [...rec.changes], wallMs: Date.now() - t0 });
    });
  });
}

// What the agent says about its own work, from the wisp presentation.
function claims(text) {
  const p = parsePresentation(text || '');
  const hero = p.blocks.find((b) => b.type === 'hero');
  const tests = p.blocks.filter((b) => b.type === 'tests');
  const failed = tests.reduce((n, b) => n + (Number(b.failed) || 0), 0);
  const passed = tests.reduce((n, b) => n + (Number(b.passed) || 0), 0);
  return { presentation: !p.fallback, hero: hero?.status || null, tests: tests.length ? (failed ? 'fail' : passed ? 'pass' : 'none') : 'none', blocks: p.blocks.map((b) => b.type) };
}

function diffStat(dir) {
  return new Promise((resolve) => {
    execFile('sh', ['-c', 'git add -A -N . >/dev/null 2>&1; git diff --numstat HEAD -- . ":(exclude).venv"'], { cwd: dir, maxBuffer: 64 << 20 }, (e, so) => {
      const files = so.trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
      resolve({ files: files.length, added: files.reduce((n, f) => n + (+f[0] || 0), 0), removed: files.reduce((n, f) => n + (+f[1] || 0), 0), paths: files.map((f) => f[2]).slice(0, 40) });
    });
  });
}

function repairPrompt(g) {
  const lines = [
    'wisp ran the project tests on your change and they do not pass:',
    g.regressions?.length ? `Tests that passed before your change and fail now:\n${g.regressions.map((x) => `- ${x}`).join('\n')}` : '',
    g.new_failures?.length ? `New failing tests:\n${g.new_failures.map((x) => `- ${x}`).join('\n')}` : '',
    g.ran === 0 ? 'No tests ran at all (the test files may fail to load).' : '',
    g.output ? `Output:\n\`\`\`\n${g.output.slice(-2500)}\n\`\`\`` : '',
    'Fix the code (not by deleting or weakening tests), re-run the tests, and finish with an updated presentation.',
  ];
  return lines.filter(Boolean).join('\n\n');
}

async function job(task, armId, trial) {
  const arm = ARMS[armId];
  const dir = path.join(WORK, randomUUID().slice(0, 12), 'work');
  const prep = await grader(task, 'prepare', dir);
  if (task.kind === 'hb' && !task.prompt) task.prompt = await new Promise((res) => execFile(HBPY, [path.join(HERE, 'hb.py'), 'problem', task.id], (e, so) => res(so)));
  if (prep.error) return { task: task.id, arm: armId, trial, error: `prepare: ${prep.error}` };
  const baseFile = path.join(path.dirname(dir), '..', `base-${randomUUID().slice(0, 8)}.json`);
  fs.writeFileSync(baseFile, JSON.stringify(task.base || {}));

  const attempts = [];
  let resumeId = null;
  for (let round = 0; round < 2; round++) {
    const run = await runAgent(arm, { prompt: round ? repairPrompt(attempts.at(-1).gate) : taskPrompt(task), cwd: dir, resumeId, timeout: round ? REPAIR_TIMEOUT : RUN_TIMEOUT });
    resumeId = run.sessionId;
    const [diff, gate] = await Promise.all([diffStat(dir), grader(task, 'gate', dir, baseFile)]);
    const hidden = await grader(task, 'hidden', dir);
    attempts.push({ round, leaks: run.leaks, wallMs: run.wallMs, timedOut: run.timedOut, isError: run.isError, tools: run.tools, toolErrors: run.toolErrors, stats: run.stats, claims: claims(run.text), diff, gate: { ...gate, output: gate.output?.slice(-3000) }, hidden, text: run.text.slice(-4000) });
    if (gate.pass || gate.pass === null || gate.error || !resumeId || run.timedOut && !diff.files) break;
  }
  return { task: task.id, kind: task.kind, repo: task.repo || task.category || 'wisp', difficulty: task.difficulty, arm: armId, agent: arm.agent, model: arm.model, trial, at: new Date().toISOString(), dir, attempts };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const done = new Set(fs.existsSync(RUNS) ? fs.readFileSync(RUNS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.error).map((r) => `${r.task}|${r.arm}|${r.trial}`) : []);
  // Interleave sources (stable order by a hash of the id) so partial results cover every benchmark.
  const h = (x) => [...x].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const tasks = loadTasks().sort((a, b) => h(a.id) - h(b.id));
  const queue = [];
  for (let trial = 1; trial <= TRIALS; trial++) for (const t of tasks) for (const a of armIds) if (!done.has(`${t.id}|${a}|${trial}`)) queue.push([t, a, trial]);
  console.log(`${tasks.length} tasks × ${armIds.length} arms × ${TRIALS} → ${queue.length} jobs to run (${done.size} done)`);
  const busy = Object.fromEntries(Object.keys(PER_HARNESS).map((k) => [k, 0]));
  let running = 0;
  let finished = 0;
  await new Promise((resolveAll) => {
    const pump = () => {
      if (!queue.length && !running) return resolveAll();
      for (let i = 0; i < queue.length && running < JOBS; i++) {
        const [t, a, trial] = queue[i];
        const h = ARMS[a].agent;
        if (busy[h] >= PER_HARNESS[h]) continue;
        queue.splice(i--, 1);
        busy[h]++;
        running++;
        job(t, a, trial)
          .catch((err) => ({ task: t.id, arm: a, trial, error: String(err?.stack || err) }))
          .then((r) => {
            fs.appendFileSync(RUNS, JSON.stringify(r) + '\n');
            busy[h]--;
            running--;
            finished++;
            const last = r.attempts?.at(-1);
            console.log(`[${new Date().toISOString().slice(11, 19)}] ${finished}/${finished + queue.length + running} ${t.id} ${a}: ${r.error ? `ERROR ${r.error.slice(0, 120)}` : `hidden=${r.attempts.map((x) => (x.hidden.resolved ? 'Y' : 'n')).join('→')} gate=${r.attempts.map((x) => (x.gate.pass ? 'Y' : 'n')).join('→')} ${Math.round((last.wallMs || 0) / 1000)}s $${r.attempts.reduce((s, x) => s + (x.stats.costUsd || 0), 0).toFixed(2)}`}`);
            pump();
          });
      }
    };
    pump();
  });
}

main();
