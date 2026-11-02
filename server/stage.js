// Staging and committing from the side panel's Changes (design/side-panel.md), as VS Code's Source
// Control and the Codex app's review pane do it: a file, or one hunk of it, into the index or out
// again, then a commit of what's staged. Changes shows the task's diff from the merge-base; git's
// own diffs (index → folder, HEAD → index) say which of those hunks are staged, and a one-hunk
// patch cut from them is what `git apply --cached` takes.

import { execFile } from 'node:child_process';
import { gitBin } from './git.js';
import { hunksOf } from './hunks.js';

// Never a prompt nobody sees; no optional locks, so a poll never holds index.lock against a write.
const ENV = { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_OPTIONAL_LOCKS: '0' };
// Patches come out as git wrote them: git.js run() trims, and a hunk that ends on a blank context
// line (" ") would lose it.
export function raw(dir, args, { input, timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(gitBin(), args, { cwd: dir, timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...ENV } }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout));
      const lines = String(stderr || '').trim().split('\n').filter(Boolean);
      const why = lines.find((l) => /^(fatal|error)\b/i.test(l)) || lines.slice(-3).join(' ') || err.message;
      reject(Object.assign(new Error(why.replace(/^(fatal|error):\s*/i, '')), { code: err.code }));
    });
    if (input != null) child.stdin.end(input);
  });
}

// A diff exactly as git apply reads it, whatever the user's config says about prefixes, colour,
// renames, external tools or text conversion.
const DIFF = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', '-U3'];

// `git diff` output, split per file: { path, head (its lines before the first @@), hunks }. A hunk:
// { text (its @@ line and rows), os, oc, ns, nc, newAt, oldAt }. newAt / oldAt are the lines it
// changes, on each side: an added line by its number, a removed run by the line that follows it.
export function splitDiff(out) {
  const files = [];
  let f = null;
  let h = null;
  let o = 0;
  let n = 0;
  for (const line of String(out || '').split('\n')) {
    const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (m) {
      files.push((f = { path: m[2], head: [line], hunks: [] }));
      h = null;
      continue;
    }
    if (!f) continue;
    const at = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (at) {
      const [os, oc, ns, nc] = [at[1], at[2] ?? 1, at[3], at[4] ?? 1].map(Number);
      f.hunks.push((h = { lines: [line], os, oc, ns, nc, newAt: [], oldAt: [] }));
      o = oc ? os : os + 1;
      n = nc ? ns : ns + 1;
      continue;
    }
    if (!h) {
      if (line) f.head.push(line);
      continue;
    }
    if (line[0] === '+') (h.newAt.push(n++), h.lines.push(line), h.oldAt.push(o));
    else if (line[0] === '-') (h.oldAt.push(o++), h.lines.push(line), h.newAt.push(n));
    else if (line[0] === ' ') (o++, n++, h.lines.push(line));
    else if (line[0] === '\\') h.lines.push(line); // \ No newline at end of file
  }
  for (const x of files) for (const k of x.hunks) k.text = k.lines.join('\n');
  return files;
}

// A patch of one file with only the hunks picked, for git apply.
export const patchOf = (file, hunks) => `${[...file.head, ...hunks.map((h) => h.text)].join('\n')}\n`;

// A line of the folder (the new side of index → folder) as the index numbers it, through that
// diff's hunks; inside one, its old side at the same offset.
export function toIndex(w, hunks = []) {
  let delta = 0;
  for (const h of hunks) {
    if (w < h.ns) break;
    const endNew = h.nc ? h.ns + h.nc : h.ns + 1;
    const endOld = h.oc ? h.os + h.oc : h.os + 1;
    if (w < endNew) return h.os + Math.min(w - h.ns, Math.max(0, h.oc - 1));
    delta = endOld - endNew;
  }
  return w + delta;
}

// The git hunks whose changes fall in lines [from, to] (on their new side): the ones that make up a
// hunk of Changes.
export const pick = (hunks = [], from, to) => hunks.filter((h) => h.newAt.some((x) => x >= from && x <= to));

// A hunk of Changes (hunksOf: start, after) in the folder's lines, inclusive of the line after it so
// a removal at its end counts.
const spanOf = (h) => [h.start, h.start + Math.max(h.after.length, 1)];

// The hunks of Changes' file f that have something to stage (index → folder) and that are staged
// (HEAD → index), cut from those two diffs of that file.
export function hunkStates(rows, unstaged, staged) {
  return hunksOf(rows).map((h) => {
    const [a, b] = spanOf(h);
    return {
      unstaged: pick(unstaged?.hunks, a, b).length > 0,
      staged: pick(staged?.hunks, toIndex(a, unstaged?.hunks), toIndex(b, unstaged?.hunks)).length > 0,
    };
  });
}

// Hunk staging is for a file Changes shows hunk by hunk and git tracks: changed, not new or binary.
export const hunkable = (f) => (f.status === 'M' || f.status === 'R') && !f.binary && f.rows?.length > 0;

const read = (dir, args) => raw(dir, ['--no-optional-locks', ...args]).catch(() => '');

// GET /changes: each file says whether it has staged changes and changes still to stage (untracked
// counts), and each of its hunks the same. Committed-only files are neither.
export async function stageState(dir, changes) {
  if (!changes?.files) return changes;
  const unstaged = splitDiff(await read(dir, DIFF));
  const staged = splitDiff(await read(dir, [...DIFF, '--cached']));
  const untracked = new Set((await read(dir, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean));
  const by = (list) => new Map(list.map((x) => [x.path, x]));
  const u = by(unstaged);
  const s = by(staged);
  for (const f of changes.files) {
    const names = [f.path, ...(f.from ? [f.from] : [])];
    f.staged = names.some((p) => s.has(p));
    f.unstaged = names.some((p) => u.has(p) || untracked.has(p));
    if (hunkable(f) && (f.staged || f.unstaged)) f.hunkStage = hunkStates(f.rows, u.get(f.path), s.get(f.path));
  }
  changes.staged = changes.files.filter((f) => f.staged).length;
  return changes;
}

// A file in or out of the index: `git add -A` (a deletion too) or `git restore --staged`. paths:
// the file and, for a rename, its old name; only the ones git has something for.
export async function stageFile(dir, paths, { unstage = false } = {}) {
  const list = paths.filter(Boolean);
  if (unstage) {
    const staged = new Set((await read(dir, ['diff', '--cached', '--name-only', '--no-renames', '-z'])).split('\0').filter(Boolean));
    const go = list.filter((p) => staged.has(p));
    if (go.length) await raw(dir, ['restore', '--staged', '--', ...go]);
    return go.length > 0;
  }
  const changed = new Set([
    ...(await read(dir, ['diff', '--name-only', '--no-renames', '-z'])).split('\0'),
    ...(await read(dir, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0'),
  ]);
  const go = list.filter((p) => changed.has(p));
  if (go.length) await raw(dir, ['add', '-A', '--', ...go]);
  return go.length > 0;
}

// Hunk i of Changes' file f into the index (the matching hunks of index → folder, applied to the
// index) or out of it (the matching hunks of HEAD → index, applied backwards). false when there's
// nothing there to move any more.
export async function stageHunk(dir, f, i, { unstage = false } = {}) {
  const h = hunksOf(f.rows)[i];
  if (!h) return false;
  const [a, b] = spanOf(h);
  const un = splitDiff(await read(dir, [...DIFF, '--', f.path]))[0];
  let file = un;
  let picked;
  if (unstage) {
    file = splitDiff(await read(dir, [...DIFF, '--cached', '--', f.path]))[0];
    picked = pick(file?.hunks, toIndex(a, un?.hunks), toIndex(b, un?.hunks));
  } else picked = pick(un?.hunks, a, b);
  if (!file || !picked.length) return false;
  await raw(dir, ['apply', '--cached', '--whitespace=nowarn', ...(unstage ? ['-R'] : []), '-'], { input: patchOf(file, picked) });
  return true;
}

// A commit of what's staged (all: everything first). The new commit's short sha, or null when
// nothing was staged.
export async function commitStaged(dir, message, { all = false } = {}) {
  if (all) await raw(dir, ['add', '-A']);
  const has = await raw(dir, ['diff', '--cached', '--quiet']).then(
    () => false,
    (err) => (err.code === 1 ? true : Promise.reject(err)),
  );
  if (!has) return null;
  await raw(dir, ['commit', '-q', '-m', message], { timeout: 120_000 });
  return (await raw(dir, ['rev-parse', '--short', 'HEAD'])).trim();
}
