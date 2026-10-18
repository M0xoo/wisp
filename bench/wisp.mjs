// wisp-replay tasks: real merged wisp PRs that came with tests. Same CLI shape as swe.py:
//   node wisp.mjs prepare ID DEST | validate ID | hidden ID DIR | gate ID DIR [BASE.json]

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.WISP_BENCH_REPO || path.resolve(HERE, '..'); // source of history only; never written to
const TASKS = JSON.parse(fs.readFileSync(path.join(HERE, 'wisp-tasks.json'), 'utf8'));
const VALID = path.join(HERE, 'out', 'wisp-valid.json');
const task = (id) => TASKS.find((t) => t.id === id) || (() => { throw new Error(`no task ${id}`); })();
const git = (args, opts = {}) => execFileSync('git', args, { cwd: REPO, maxBuffer: 64 << 20, ...opts });

export function prepare(id, dest) {
  const t = task(id);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  // History-free snapshot of the parent commit.
  execFileSync('sh', ['-c', `git -C ${REPO} archive ${t.commit}^ | tar -x -C ${dest}`]);
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=bench', '-c', 'user.email=bench@wisp', 'commit', '-qm', 'base']]) execFileSync('git', args, { cwd: dest });
  return t;
}

const hiddenFiles = (t) => git(['show', '--name-only', '--format=', t.commit]).toString().split('\n').filter((f) => f.startsWith('test/'));
const scriptFiles = (dir) => {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts.test;
    return [...s.matchAll(/test\/[\w.-]+\.test\.js/g)].map((m) => m[0]);
  } catch {
    return [];
  }
};

// One test file, alone: name -> 'pass' | 'fail' | 'skip'. node --test top-level tests sit at indent 0.
function runFile(dir, file) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('WISP_') && !k.startsWith('FAKE_')));
  const p = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=180000', file], { cwd: dir, env, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 << 20 });
  const out = {};
  for (const line of (p.stdout || '').split('\n')) {
    const m = line.match(/^(not )?ok \d+ - (.*?)(?: # (SKIP|TODO).*)?$/);
    if (m) out[`${file}::${m[2]}`] = m[3] ? 'skip' : m[1] ? 'fail' : 'pass';
  }
  if (!Object.keys(out).length) out[`${file}::<load>`] = 'fail'; // didn't even load
  return { status: out, log: `${p.stdout || ''}\n${p.stderr || ''}` };
}

// Run files one by one; a file with failures runs once more and a test that passes either time counts
// as passing (the suite has known ECONNRESET/timeout flakiness under load).
export function runFiles(dir, files) {
  const status = {};
  let log = '';
  for (const f of files) {
    if (!fs.existsSync(path.join(dir, f))) continue;
    let r = runFile(dir, f);
    if (Object.values(r.status).includes('fail')) {
      const again = runFile(dir, f);
      for (const [k, v] of Object.entries(again.status)) if (v === 'pass' || !(k in r.status)) r.status[k] = v;
      if (Object.values(r.status).includes('fail')) log += again.log.split('\n').filter((l) => /not ok|Error|expected|actual|assert/i.test(l)).slice(0, 60).join('\n') + '\n';
    }
    Object.assign(status, r.status);
  }
  return { status, log };
}

function withHidden(t, dir, fn) {
  const files = hiddenFiles(t);
  const saved = Object.fromEntries(files.map((f) => [f, fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f)) : null]));
  try {
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), git(['show', `${t.commit}:${f}`]));
    }
    return fn(files);
  } finally {
    for (const [f, b] of Object.entries(saved)) b === null ? fs.rmSync(path.join(dir, f), { force: true }) : fs.writeFileSync(path.join(dir, f), b);
  }
}

const runTargets = (t, files, dir) => {
  const direct = files.filter((f) => f.endsWith('.test.js'));
  return direct.length ? direct : scriptFiles(dir); // fixture-only change: the whole suite judges
};

export function hidden(id, dir) {
  const t = task(id);
  const v = JSON.parse(fs.readFileSync(VALID, 'utf8'))[id];
  const { status } = withHidden(t, dir, (files) => runFiles(dir, v?.targets || runTargets(t, files, dir)));
  const f2p = v.f2p.filter((n) => status[n] === 'pass');
  const p2p = v.p2p.filter((n) => status[n] === 'pass');
  return { resolved: f2p.length === v.f2p.length && p2p.length === v.p2p.length, f2p: [f2p.length, v.f2p.length], p2p: [p2p.length, v.p2p.length], f2p_failed: v.f2p.filter((n) => status[n] !== 'pass').slice(0, 10), p2p_failed: v.p2p.filter((n) => status[n] !== 'pass').slice(0, 10) };
}

// wisp's own visible check: the project's test script, file by file. Fails on a test that passed
// before the agent started (base) and fails now, or on a new test that fails.
export function gate(id, dir, base = {}) {
  const files = [...new Set([...scriptFiles(dir), ...changedTests(dir)])];
  const { status, log } = runFiles(dir, files);
  const regressions = Object.keys(status).filter((n) => status[n] === 'fail' && base[n] === 'pass');
  const newFailures = Object.keys(status).filter((n) => status[n] === 'fail' && !(n in base));
  const pass = Object.keys(status).length > 0 && !regressions.length && !newFailures.length;
  return { pass, ran: Object.keys(status).length, regressions: regressions.slice(0, 10), new_failures: newFailures.slice(0, 10), agent_tests: changedTests(dir), output: pass ? '' : log.slice(-3000) };
}

function changedTests(dir) {
  spawnSync('git', ['add', '-A', '-N'], { cwd: dir });
  return spawnSync('git', ['diff', '--name-only', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.split('\n').filter((f) => /^test\/.*\.test\.js$/.test(f) && fs.existsSync(path.join(dir, f)));
}

// F2P: fail at C^ with the hidden tests, pass at C (checked twice). P2P: pass at both, every time.
export function validate(id) {
  const t = task(id);
  const dir = `/tmp/wb/validate/${id}`;
  prepare(id, dir);
  const files = hiddenFiles(t);
  const targets = runTargets(t, files, dir);
  const base = runFiles(dir, scriptFiles(dir)).status; // visible statuses before any change: the gate's reference
  const before = [withHidden(t, dir, () => runFiles(dir, targets).status), withHidden(t, dir, () => runFiles(dir, targets).status)];
  // The real fix: check out C's tree over the snapshot.
  execFileSync('sh', ['-c', `git -C ${REPO} archive ${t.commit} | tar -x -C ${dir}`]);
  const after = [runFiles(dir, targets).status, runFiles(dir, targets).status];
  const names = Object.keys(after[0]);
  const f2p = names.filter((n) => after.every((a) => a[n] === 'pass') && before.every((b) => b[n] !== 'pass'));
  const p2p = names.filter((n) => after.every((a) => a[n] === 'pass') && before.every((b) => b[n] === 'pass'));
  const flaky = names.filter((n) => !f2p.includes(n) && !p2p.includes(n) && after.some((a) => a[n] === 'pass'));
  fs.rmSync(dir, { recursive: true, force: true });
  return { id, ok: f2p.length > 0, targets, f2p, p2p, flaky, base_status: base };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, id, a, b] = process.argv.slice(2);
  const out = cmd === 'prepare' ? (prepare(id, a), { ok: true })
    : cmd === 'validate' ? validate(id)
    : cmd === 'hidden' ? hidden(id, a)
    : cmd === 'gate' ? gate(id, a, b ? JSON.parse(fs.readFileSync(b, 'utf8')) : {})
    : cmd === 'problem' ? task(id).prompt
    : null;
  console.log(typeof out === 'string' ? out : JSON.stringify(out));
}
