// wisp Auto, end to end, against the same hidden tests as bench/run.mjs: a real wisp server (the
// code under test, WISP_SRC) gets each task as a launch with agent "auto", runs its whole pipeline
// (route → agent → check → repair → hand over / best of two), and the run wisp would show you as
// the answer is graded: the best-of-two pick, else the last hand-over, else the first run.
//
//   WISP_SRC=../wisp-pipeline node bench/auto.mjs --tasks a,b --trials 2 --jobs 4 [--goal balanced]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const RUNS_ARG = process.argv.indexOf('--out');
const RUNS = RUNS_ARG > 0 ? path.resolve(process.argv[RUNS_ARG + 1]) : path.join(OUT, 'auto.jsonl');
const SRC = path.resolve(process.env.WISP_SRC || path.join(HERE, '..', '..', 'wisp-pipeline'));
const PY = '/tmp/wb/swe3/bin/python';
const HBPY = path.join(os.homedir(), '.wisp-bench-private', 'hbv', 'bin', 'python');
const TASK_TIMEOUT = 60 * 60_000;

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const JOBS = Number(args.jobs || 4);
const TRIALS = Number(args.trials || 1);
const GOAL = args.goal || 'balanced';
const ARM = `wisp-auto-${GOAL}`;

function loadTasks() {
  const tasks = [];
  const wv = JSON.parse(fs.readFileSync(path.join(OUT, 'wisp-valid.json'), 'utf8'));
  for (const t of JSON.parse(fs.readFileSync(path.join(HERE, 'wisp-tasks.json'), 'utf8'))) if (wv[t.id]?.ok) tasks.push({ id: t.id, kind: 'wisp', difficulty: t.difficulty, prompt: t.prompt });
  for (const l of fs.readFileSync(path.join(OUT, 'hb-valid.jsonl'), 'utf8').trim().split('\n')) {
    const v = JSON.parse(l);
    if (v.ok) tasks.push({ id: v.id, kind: 'hb', difficulty: v.difficulty, category: v.category, prompt: null });
  }
  return args.tasks ? tasks.filter((t) => args.tasks.split(',').includes(t.id)) : tasks;
}

const grader = (task, cmd, ...rest) =>
  new Promise((resolve) => {
    const bin = { swe: PY, hb: HBPY, wisp: process.execPath }[task.kind];
    const script = path.join(HERE, { swe: 'swe.py', hb: 'hb.py', wisp: 'wisp.mjs' }[task.kind]);
    execFile(bin, [script, cmd, task.id, ...rest], { cwd: HERE, maxBuffer: 64 << 20, timeout: 45 * 60_000 }, (err, so, se) => {
      if (cmd === 'problem') return resolve(so);
      try {
        resolve(JSON.parse(so.trim().split('\n').at(-1)));
      } catch {
        resolve({ error: (se || err?.message || '').slice(-1500) });
      }
    });
  });

// Same wording as bench/run.mjs, so both arms get the same task.
const ENV_NOTE = {
  hb: 'Tools: `python3` is Python 3.12 with pytest; git and sqlite3 are available. There is no network access you should rely on.',
  wisp: 'This is a Node project with no dependencies to install. Run tests with `node --test test/<file>.test.js` (the full suite is `npm test`).',
};
const taskPrompt = (t) =>
  t.kind === 'hb'
    ? `${t.prompt}\n\n${ENV_NOTE.hb}\n\nYou are working autonomously: nobody will answer questions, so make reasonable assumptions and finish the task completely.`
    : `${t.prompt}\n\n${ENV_NOTE[t.kind]}\n\nYou are working autonomously: nobody will answer questions, so make reasonable assumptions. Change the source to fix the issue and add or update tests that cover it. Do not commit.`;

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function startWisp() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-auto-home-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(SRC, 'bin', 'wisp.js'), '--browser', '--no-open', '--port', String(port)], {
    env: { ...process.env, WISP_HOME: home, WISP_UPDATE_CHECK: '0', WISP_TELEMETRY: '0', WISP_FEEDBACK: '0', PATH: `/tmp/wbpy/bin:${process.env.PATH}` },
    stdio: ['ignore', fs.openSync(path.join(OUT, 'auto-server.log'), 'a'), fs.openSync(path.join(OUT, 'auto-server.log'), 'a')],
  });
  const base = `http://127.0.0.1:${port}/api`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/config`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const api = async (p, body, method) => {
    const r = await fetch(`${base}${p}`, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) throw new Error(`${p}: ${j.error}`);
    return j;
  };
  // Cursor's free plan can only run its Auto model, so it can't be one of Auto's picks.
  await api('/router', { goal: GOAL, allowed: ['claude', 'codex', 'grok', 'antigravity', 'opencode'] }, 'PATCH');
  return { api, home, stop: () => child.kill() };
}

async function job(w, task, trial) {
  const dir = path.join('/tmp/wbj', randomUUID().slice(0, 12), 'work');
  const prep = await grader(task, 'prepare', dir);
  if (prep.error) return { task: task.id, arm: ARM, trial, error: `prepare: ${prep.error}` };
  if (task.kind === 'hb' && !task.prompt) task.prompt = await grader(task, 'problem');
  const t0 = Date.now();
  const s = await w.api('/sessions', { prompt: taskPrompt(task), cwd: dir, agent: 'auto', model: GOAL, mode: 'auto' });
  const ids = new Set([s.id, ...(s.group || []).map((x) => x.id)]);
  // Settled: every run of the task is done and none is about to hand over.
  let runs;
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    runs = await Promise.all([...ids].map((id) => w.api(`/sessions/${id}`)));
    for (const r of runs) if (r.auto?.escalatedTo) ids.add(r.auto.escalatedTo);
    if (ids.size > runs.length) continue;
    const best2 = runs.filter((r) => r.auto?.strategy === 'best2');
    const settled = runs.every((r) => r.state !== 'running' && !r.auto?.busy) && (best2.length < 2 || best2.every((r) => typeof r.auto.pick?.winner === 'boolean'));
    if (settled || Date.now() - t0 > TASK_TIMEOUT) break;
  }
  const final = runs.find((r) => r.auto?.pick?.winner) || runs.find((r) => r.auto?.escalatedFrom && !r.auto?.escalatedTo) || runs.find((r) => r.id === s.id);
  const where = final.worktree?.cwd || final.cwd;
  const hidden = await grader(task, 'hidden', where);
  const firstRun = runs.find((r) => r.id === s.id);
  const firstHidden = firstRun !== final && firstRun.worktree ? await grader(task, 'hidden', firstRun.worktree.cwd) : null;
  const turns = runs.flatMap((r) => r.turns);
  const hero = final.turns.at(-1)?.presentation?.blocks?.find((b) => b.type === 'hero');
  return {
    task: task.id,
    kind: task.kind,
    difficulty: task.difficulty,
    arm: ARM,
    trial,
    at: new Date().toISOString(),
    wallMs: Date.now() - t0,
    timedOut: Date.now() - t0 > TASK_TIMEOUT,
    runs: runs.map((r) => ({ id: r.id, agent: r.agent, model: r.model, route: r.route && { key: r.route.key, type: r.route.type, chance: r.route.chance, explored: r.route.explored }, strategy: r.auto?.strategy, repairs: r.auto?.repairs, checks: r.auto?.checks?.map((c) => ({ verdict: c.verdict, failed: c.failed, newFailures: c.newFailures?.length, ms: c.durationMs })), pick: r.auto?.pick, escalatedTo: r.auto?.escalatedTo, turns: r.turns.length, wispTurns: r.turns.filter((t) => t.by === 'wisp').length })),
    final: { id: final.id, agent: final.agent, model: final.model, hero: hero?.status || null, check: final.auto?.checks?.at(-1)?.verdict || null },
    costUsd: turns.reduce((n, t) => n + (t.stats?.costUsd || 0), 0),
    tokens: turns.reduce((n, t) => n + (t.stats?.inputTokens || 0) + (t.stats?.outputTokens || 0), 0),
    agentMs: turns.reduce((n, t) => n + ((t.endedAt || 0) - (t.startedAt || 0)), 0),
    hidden,
    firstHidden,
  };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const done = new Set(fs.existsSync(RUNS) ? fs.readFileSync(RUNS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.error).map((r) => `${r.task}|${r.arm}|${r.trial}`) : []);
  const tasks = loadTasks();
  const queue = [];
  for (let trial = 1; trial <= TRIALS; trial++) for (const t of tasks) if (!done.has(`${t.id}|${ARM}|${trial}`)) queue.push([t, trial]);
  console.log(`${queue.length} Auto (${GOAL}) jobs, wisp from ${SRC}`);
  const w = await startWisp();
  let finished = 0;
  const worker = async () => {
    for (let item; (item = queue.shift()); ) {
      const [t, trial] = item;
      // Another runner may have done it meanwhile.
      const now = fs.existsSync(RUNS) ? fs.readFileSync(RUNS, 'utf8') : '';
      if (now.split('\n').some((l) => l.includes(`"task":"${t.id}"`) && l.includes(`"trial":${trial},`) && !l.includes('"error"'))) continue;
      const r = await job(w, t, trial).catch((err) => ({ task: t.id, arm: ARM, trial, error: String(err?.stack || err) }));
      fs.appendFileSync(RUNS, JSON.stringify(r) + '\n');
      finished++;
      console.log(`[${new Date().toISOString().slice(11, 19)}] ${finished} ${t.id}#${trial}: ${r.error ? `ERROR ${r.error.slice(0, 160)}` : `hidden=${r.hidden.resolved ? 'Y' : 'n'} runs=${r.runs.map((x) => `${x.agent}:${x.model || '-'}${x.repairs ? `+${x.repairs}r` : ''}${x.checks?.length ? `(${x.checks.map((c) => c.verdict[0]).join('')})` : ''}`).join(' → ')} ${Math.round(r.wallMs / 1000)}s $${r.costUsd.toFixed(2)}`}`);
    }
  };
  await Promise.all(Array.from({ length: JOBS }, worker));
  w.stop();
}

main();
