// Picking between two runs of the same task (best-of-2): a cheap model reads both diffs, and if
// that isn't available, the run that changed something and then the smaller diff win.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { askJson } from './quick.js';
import { gitBin } from './git.js';

const MAX_DIFF = 24_000;

const UNTRACKED_SHOWN = 30;
const UNTRACKED_CHARS = 4000;

// text in pieces, each starting at a line that begins with `mark`; what comes before the first is
// the first piece. Not a /^/m regex: that also matches after a bare \r inside a line of code.
export function splitAt(text, mark) {
  const at = [0];
  for (let i = text.indexOf(`\n${mark}`); i !== -1; i = text.indexOf(`\n${mark}`, i + 1)) at.push(i + 1);
  return at.map((from, n) => text.slice(from, at[n + 1]));
}

// The path a section of `git diff` is about: the new name of a rename or copy, else its header.
// Diff lines all start with +, - or a space, so neither can match inside the code. The prefixes are
// optional for diff.noprefix and diff.mnemonicPrefix. A path git still quotes (a tab, a quote)
// keeps its escapes: it won't match `files`, so it reads as not reviewed, the safe way round.
const unquote = (p) => p.replace(/^"(.*)"$/, '$1');
function sectionPath(text) {
  const to = text.match(/(?:^|\n)(?:rename|copy) to (.+)/);
  if (to) return unquote(to[1]);
  const m = text.match(/^diff --git "?(?:[a-z]\/)?(.*?)"? "?(?:[a-z]\/)?\1"?(?:\n|$)/);
  return m ? m[1] : text.split('\n')[0].replace(/^diff --git /, '');
}

// The run's changes against its base, per file: { sections: [{ path, text, cut? }], files } with
// every changed path in `files`, so a file with no section (past the untracked cap, or the diff
// failed) can be told from one that didn't change. failed: git answered neither, so an empty list
// says nothing. A linked node_modules is an untracked file to git, not a change.
export function diffSections(dir, base = 'HEAD') {
  const run = (args) => {
    try {
      return execFileSync(gitBin(), args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20, timeout: 15_000 }).toString();
    } catch {
      return null;
    }
  };
  const list = (out) => (out || '').split('\0').filter(Boolean);
  const paths = ['--', '.', ':(exclude)node_modules'];
  const tracked = run(['-c', 'core.quotepath=off', 'diff', base, ...paths]);
  const listed = run(['diff', '--name-only', '-z', base, ...paths]);
  const untracked = list(run(['ls-files', '-z', '--others', '--exclude-standard']));
  const sections = tracked ? splitAt(tracked, 'diff --git ').map((text) => ({ path: sectionPath(text), text })) : [];
  for (const f of untracked.slice(0, UNTRACKED_SHOWN)) {
    try {
      const body = fs.readFileSync(path.join(dir, f), 'utf8');
      const text = `\n--- /dev/null\n+++ b/${f}\n${body.slice(0, UNTRACKED_CHARS).split('\n').map((l) => `+${l}`).join('\n')}`;
      sections.push({ path: f, text, ...(body.length > UNTRACKED_CHARS && { cut: true }) });
    } catch {}
  }
  const files = [...new Set([...list(listed), ...untracked.filter((f) => !/^node_modules(\/|$)/.test(f)), ...sections.map((s) => s.path)])];
  return { sections, files, ...(tracked === null && listed === null && { failed: true }) };
}

// The same as one string: tracked diff plus new files.
export const diffOf = (dir, base = 'HEAD') => diffSections(dir, base).sections.map((s) => s.text).join('');

const changed = (d) => d.split('\n').filter((l) => /^[+-](?![+-])/.test(l)).length;

// candidates: [{ id, label, diff }]. Resolves with { winner, why, by }.
export async function judge({ prompt, candidates, agents }) {
  const [a, b] = candidates;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-judge-'));
  try {
    const ask = `Two coding agents did the same task. Judge which change is better: correct, complete, minimal, and in the style of the code around it.

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
  const empty = (c) => !c.diff.trim();
  if (empty(a) !== empty(b)) {
    const w = empty(a) ? b : a;
    return { winner: w.id, by: 'rule', why: `${w.label} changed something; the other run didn't.` };
  }
  const w = changed(a.diff) <= changed(b.diff) ? a : b;
  return { winner: w.id, by: 'rule', why: `${w.label} made the smaller change.` };
}
