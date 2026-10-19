// Picking between two runs of the same task (best-of-2). Tests decide when they can: a run whose
// check passed beats one whose check failed. Otherwise a cheap model reads both diffs, and if
// that isn't available either, fewer new failures and then the smaller diff win.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { askJson } from './quick.js';

const MAX_DIFF = 24_000;

// The run's changes against its base: tracked diff plus new files.
export function diffOf(dir, base = 'HEAD') {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20, timeout: 15_000 }).toString();
    } catch {
      return '';
    }
  };
  let out = run(['diff', base, '--', '.', ':(exclude)node_modules']);
  for (const f of run(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean).slice(0, 30)) {
    try {
      out += `\n--- /dev/null\n+++ b/${f}\n${fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 4000).split('\n').map((l) => `+${l}`).join('\n')}`;
    } catch {}
  }
  return out;
}

const changed = (d) => d.split('\n').filter((l) => /^[+-](?![+-])/.test(l)).length;
const SCORE = { pass: 3, unknown: 2, skip: 2, fail: 0 };

// candidates: [{ id, label, check, diff }]. Resolves with { winner, why, by }.
export async function judge({ prompt, candidates, agents }) {
  const [a, b] = candidates;
  const sa = SCORE[a.check?.verdict] ?? 1;
  const sb = SCORE[b.check?.verdict] ?? 1;
  if (sa !== sb) {
    const w = sa > sb ? a : b;
    return { winner: w.id, by: 'tests', why: `${w.label}'s changes pass the tests; the other run's don't.` };
  }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-judge-'));
  try {
    const ask = `Two coding agents did the same task. Judge which change is better: correct, complete, minimal, and in the style of the code around it. Tests: run A ${a.check?.verdict || 'not checked'}, run B ${b.check?.verdict || 'not checked'}.

<task>
${String(prompt).slice(0, 4000)}
</task>

<run id="A" label="${a.label}">
${a.diff.slice(0, MAX_DIFF) || '(no changes)'}
</run>

<run id="B" label="${b.label}">
${b.diff.slice(0, MAX_DIFF) || '(no changes)'}
</run>

Reply with one JSON object: {"winner": "A" | "B", "why": "one sentence"}`;
    const j = await askJson({ agents, prompt: ask, cwd, timeoutMs: 120_000 });
    if (j && (j.winner === 'A' || j.winner === 'B')) return { winner: (j.winner === 'A' ? a : b).id, by: 'model', why: String(j.why || '').slice(0, 300) };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  const fa = a.check?.newFailures?.length ?? 0;
  const fb = b.check?.newFailures?.length ?? 0;
  if (fa !== fb) {
    const w = fa < fb ? a : b;
    return { winner: w.id, by: 'rule', why: `${w.label} leaves fewer new failing tests.` };
  }
  const empty = (c) => !c.diff.trim();
  if (empty(a) !== empty(b)) {
    const w = empty(a) ? b : a;
    return { winner: w.id, by: 'rule', why: `${w.label} changed something; the other run didn't.` };
  }
  const w = changed(a.diff) <= changed(b.diff) ? a : b;
  return { winner: w.id, by: 'rule', why: `${w.label} made the smaller change.` };
}
