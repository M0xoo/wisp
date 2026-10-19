// wisp's own test check: after an Auto turn, wisp runs the project's tests itself instead of taking
// the agent's word for it (in the wisp-bench pilot, 19 of 20 failed runs still said "done").
//
// detectTests(dir, project) finds the command; runCheck(dir, command) runs it and reads which tests
// failed from the usual reporters (node --test, jest/vitest, pytest, go, cargo, rspec). A failure
// only counts against the agent when it's new: check() compares with the same command on the
// task's base commit (a throwaway worktree, cached per base and command), and runs a failing
// command twice so a flaky test doesn't send the agent off to fix nothing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { git } from './git.js';
import { killTree } from './proc.js';

const MAX_OUTPUT = 400 * 1024;
export const CHECK_TIMEOUT_MS = Number(process.env.WISP_CHECK_TIMEOUT_MS || 10 * 60_000);

const read = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
const has = (dir, f) => fs.existsSync(path.join(dir, f));

// { command, kind, why } | { skip: reason } | null (nothing that looks like tests).
// project.testCommand overrides it; 'off' turns the check off for that project.
export function detectTests(dir, project = null) {
  const custom = String(project?.testCommand || '').trim();
  if (custom === 'off') return { skip: 'Turned off for this project' };
  if (custom) return { command: custom, kind: 'custom', why: 'Set for this project' };

  const pkg = JSON.parse(read(path.join(dir, 'package.json')) || 'null');
  const script = pkg?.scripts?.test;
  if (script && !/no test specified/.test(script)) {
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    if (deps.length && !has(dir, 'node_modules')) return { skip: 'Dependencies are not installed in this worktree (no node_modules)' };
    const pm = has(dir, 'pnpm-lock.yaml') ? 'pnpm' : has(dir, 'yarn.lock') ? 'yarn' : has(dir, 'bun.lockb') || has(dir, 'bun.lock') ? 'bun' : 'npm';
    return { command: `${pm} test`, kind: 'node', why: 'package.json "test" script' };
  }
  const py = ['pytest.ini', 'tox.ini', 'conftest.py'].some((f) => has(dir, f)) || /\[tool\.pytest/.test(read(path.join(dir, 'pyproject.toml')) || '') || /\[tool:pytest\]/.test(read(path.join(dir, 'setup.cfg')) || '') || (has(dir, 'tests') && fs.readdirSync(path.join(dir, 'tests')).some((f) => /^test_.*\.py$|_test\.py$/.test(f)));
  if (py) {
    const python = ['.venv/bin/python', 'venv/bin/python', '.venv/Scripts/python.exe'].find((p) => has(dir, p)) || 'python3';
    return { command: `${python} -m pytest -q -rA`, kind: 'pytest', why: 'pytest configuration' };
  }
  if (has(dir, 'go.mod')) return { command: 'go test ./...', kind: 'go', why: 'go.mod' };
  if (has(dir, 'Cargo.toml')) return { command: 'cargo test', kind: 'cargo', why: 'Cargo.toml' };
  if (has(dir, 'Gemfile') && has(dir, 'spec')) return { command: 'bundle exec rspec', kind: 'rspec', why: 'Gemfile and spec/' };
  if (/^test:/m.test(read(path.join(dir, 'Makefile')) || '')) return { command: 'make test', kind: 'make', why: 'Makefile test target' };
  return null;
}

// Failing test names and pass/fail counts from whatever reporter printed `out`.
export function parseResults(out) {
  const failed = new Set();
  let passed = null;
  let failedN = null;
  let skipped = null;
  const add = (x) => x && failed.add(x.trim().replace(/\s+\(\d+(\.\d+)?m?s\)$/, ''));
  for (const line of out.split('\n')) {
    let m;
    if ((m = line.match(/^\s*✖ (.+?)(?: \([\d.]+m?s\))?$/)) && !/^failing tests:$/.test(m[1])) add(m[1]); // node --test spec
    else if ((m = line.match(/^not ok \d+ - (.+?)(?: # .*)?$/))) add(m[1]); // TAP, top level
    else if ((m = line.match(/^(?:FAILED|ERROR) (\S+)/))) add(m[1]); // pytest -rA
    else if ((m = line.match(/^\s+[✕×] (.+?)(?: \(\d+ ?ms\))?$/))) add(m[1]); // jest / vitest
    else if ((m = line.match(/^--- FAIL: (\S+)/))) add(m[1]); // go
    else if ((m = line.match(/^test (\S+) \.\.\. FAILED/))) add(m[1]); // cargo
    else if ((m = line.match(/^rspec (\.\/\S+)/))) add(m[1]); // rspec
    if ((m = line.match(/^ℹ pass (\d+)/))) passed = +m[1];
    if ((m = line.match(/^ℹ fail (\d+)/))) failedN = +m[1];
    if ((m = line.match(/^ℹ skipped (\d+)/))) skipped = +m[1];
    if ((m = line.match(/^# pass (\d+)/))) passed = +m[1];
    if ((m = line.match(/^# fail (\d+)/))) failedN = +m[1];
    if ((m = line.match(/^=+ (.*) in [\d.]+s/))) {
      // pytest summary: "== 3 failed, 41 passed, 2 skipped in 1.2s =="
      passed = +(m[1].match(/(\d+) passed/)?.[1] || 0);
      failedN = +(m[1].match(/(\d+) failed/)?.[1] || 0) + +(m[1].match(/(\d+) errors?/)?.[1] || 0);
      skipped = +(m[1].match(/(\d+) skipped/)?.[1] || 0) || null;
    }
    if ((m = line.match(/^Tests:\s+(.*)$/))) {
      // jest / vitest: "Tests: 1 failed, 12 passed, 13 total"
      passed = +(m[1].match(/(\d+) passed/)?.[1] || 0);
      failedN = +(m[1].match(/(\d+) failed/)?.[1] || 0);
      skipped = +(m[1].match(/(\d+) skipped/)?.[1] || 0) || null;
    }
    if ((m = line.match(/^test result: \w+\. (\d+) passed; (\d+) failed/))) {
      passed = (passed || 0) + +m[1];
      failedN = (failedN || 0) + +m[2];
    }
  }
  return { failed: [...failed].slice(0, 200), passed, failedCount: failedN ?? failed.size, skipped };
}

// Run `command` in dir: { exitCode, output, durationMs, timedOut, ...parseResults }.
export function runCheck(dir, command, { timeout = CHECK_TIMEOUT_MS, env = {} } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    let timedOut = false;
    // Not inherited: a test runner's own markers (wisp under `node --test` would make the project's
    // `node --test` report to it and exit 0) and wisp's.
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NODE_TEST_CONTEXT|NODE_UNIQUE_ID|WISP_|FAKE_)/.test(k)));
    const child = spawn(process.platform === 'win32' ? 'cmd.exe' : 'sh', process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command], {
      cwd: dir,
      env: { ...base, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const take = (d) => {
      output += d;
      if (output.length > MAX_OUTPUT * 2) output = output.slice(-MAX_OUTPUT);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeout);
    const done = (exitCode) => {
      clearTimeout(timer);
      output = output.replace(/\x1b\[[0-9;]*m/g, '').slice(-MAX_OUTPUT);
      resolve({ exitCode, output, durationMs: Date.now() - started, timedOut, ...parseResults(output) });
    };
    child.on('error', (err) => ((output += `\n${err.message}`), done(127)));
    child.on('close', (code) => done(timedOut ? 124 : code ?? 1));
  });
}

// The same command at the base commit, once per (repo, base, command).
const baselines = new Map();
export async function baseline(wt, command) {
  if (!wt?.root || !wt.head) return null;
  const key = `${wt.root}\0${wt.head}\0${command}`;
  if (!baselines.has(key)) {
    baselines.set(
      key,
      (async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-base-'));
        try {
          await git(wt.root, ['worktree', 'add', '--quiet', '--detach', dir, wt.head]);
          // node_modules and virtualenvs aren't in git: borrow the task's, so the base can run too.
          for (const d of ['node_modules', '.venv', 'venv']) {
            const from = path.join(wt.path, d);
            if (fs.existsSync(from) && !fs.existsSync(path.join(dir, d))) fs.symlinkSync(from, path.join(dir, d), 'dir');
          }
          const sub = path.relative(wt.path, wt.cwd || wt.path);
          return await runCheck(path.join(dir, sub), command);
        } catch {
          return null;
        } finally {
          await git(wt.root, ['worktree', 'remove', '--force', dir]).catch(() => {});
          fs.rmSync(dir, { recursive: true, force: true });
        }
      })(),
    );
  }
  return baselines.get(key);
}

// The verdict wisp acts on. pass: exit 0, or every failure was failing on the base already.
// fail: tests that passed on the base fail now (twice). unknown: it failed and we can't tell why
// (no base to compare with, or a reporter we can't read). skip: nothing to run.
export async function check({ dir, project, worktree, timeout } = {}) {
  const found = detectTests(dir, project);
  if (!found) return { verdict: 'skip', reason: 'No test command found', command: null };
  if (found.skip) return { verdict: 'skip', reason: found.skip, command: null };
  const { command } = found;
  let run = await runCheck(dir, command, { timeout });
  if (run.exitCode === 0 && !run.timedOut) return summary('pass', command, run, [], []);
  // Flaky? Only failures that happen twice count.
  const again = await runCheck(dir, command, { timeout });
  if (again.exitCode === 0 && !again.timedOut) return summary('pass', command, again, [], [], 'Passed on a second run (a flaky test)');
  const twice = run.failed.filter((t) => again.failed.includes(t));
  run = { ...again, failed: twice.length || !again.failed.length ? twice : again.failed };
  const base = await baseline(worktree, command);
  if (!base) return summary(run.failed.length || run.timedOut ? 'fail' : 'unknown', command, run, run.failed, [], 'No base to compare with');
  if (base.exitCode === 0) return summary('fail', command, run, run.failed, []);
  const before = new Set(base.failed);
  const fresh = run.failed.filter((t) => !before.has(t));
  const old = run.failed.filter((t) => before.has(t));
  if (!run.failed.length || !base.failed.length) return summary('unknown', command, run, [], [], 'Fails on the base commit too, and the failures could not be read');
  return summary(fresh.length ? 'fail' : 'pass', command, run, fresh, old, fresh.length ? '' : `${old.length} failing on the base commit too`);
}

function summary(verdict, command, run, fresh, old, note = '') {
  const tail = run.output.split('\n').filter((l) => l.trim()).slice(-60).join('\n');
  return {
    verdict,
    command,
    exitCode: run.exitCode,
    passed: run.passed,
    failed: run.failedCount || run.failed.length || (run.exitCode ? 1 : 0),
    skipped: run.skipped,
    newFailures: fresh.slice(0, 50),
    preexisting: old.slice(0, 50),
    timedOut: run.timedOut,
    durationMs: run.durationMs,
    note,
    output: verdict === 'pass' ? '' : tail.slice(-6000),
    at: Date.now(),
  };
}
