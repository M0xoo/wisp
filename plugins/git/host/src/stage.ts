// Staging and committing from the side panel's Changes (v1 server/stage.js), as VS Code's Source
// Control does it: a file, or one hunk of it, into the index or out again, then a commit of what's
// staged. git's own diffs (index → folder, HEAD → index) say which hunks are staged, and a one-hunk
// patch cut from them is what `git apply --cached` takes.

import { hunkable, hunksOf } from '@wisp-plugin/git-api';
import type { Changes, DiffFile, DiffRow, StagedChanges } from '@wisp-plugin/git-api';
import { ToolError, type Tools } from './exec.ts';

interface GitHunk {
  lines: string[];
  text: string;
  os: number;
  oc: number;
  ns: number;
  nc: number;
  newAt: number[];
  oldAt: number[];
}
interface GitFile {
  path: string;
  head: string[];
  hunks: GitHunk[];
}

// A diff exactly as git apply reads it, whatever the user's config says about prefixes, colour,
// renames, external tools or text conversion.
const DIFF = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', '-U3'];

const strip = (e: unknown): Error => (e instanceof Error ? Object.assign(e, { message: e.message.replace(/^(fatal|error):\s*/i, '') }) : new Error(String(e)));
// Patches come out as git wrote them: a hunk that ends on a blank context line (" ") keeps it.
const raw = (t: Tools, dir: string, args: readonly string[], o: { input?: string; timeoutMs?: number } = {}): Promise<string> =>
  t.git(dir, args, { raw: true, timeoutMs: o.timeoutMs ?? 30_000, ...(o.input !== undefined && { input: o.input }) }).catch((e: unknown) => Promise.reject(strip(e)));
const read = (t: Tools, dir: string, args: readonly string[]): Promise<string> => raw(t, dir, ['--no-optional-locks', ...args]).catch(() => '');

/** `git diff` output split per file: its head lines and hunks with the lines each side changes. */
export function splitDiff(out: string): GitFile[] {
  const files: GitFile[] = [];
  let f: GitFile | null = null;
  let h: GitHunk | null = null;
  let o = 0;
  let n = 0;
  for (const line of out.split('\n')) {
    const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (m?.[2] !== undefined) {
      f = { path: m[2], head: [line], hunks: [] };
      files.push(f);
      h = null;
      continue;
    }
    if (!f) continue;
    const at = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (at) {
      const [os, oc, ns, nc] = [at[1], at[2] ?? 1, at[3], at[4] ?? 1].map(Number) as [number, number, number, number];
      h = { lines: [line], text: '', os, oc, ns, nc, newAt: [], oldAt: [] };
      f.hunks.push(h);
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

export const patchOf = (file: GitFile, hunks: readonly GitHunk[]): string => `${[...file.head, ...hunks.map((h) => h.text)].join('\n')}\n`;

/** A line of the folder (the new side of index → folder) as the index numbers it. */
export function toIndex(w: number, hunks: readonly GitHunk[] = []): number {
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

/** The git hunks whose changes fall in lines [from, to] of their new side. */
export const pick = (hunks: readonly GitHunk[] = [], from: number, to: number): GitHunk[] => hunks.filter((h) => h.newAt.some((x) => x >= from && x <= to));

// A hunk of Changes in the folder's lines, inclusive of the line after it so a removal at its end counts.
const spanOf = (h: { start: number; after: string[] }): [number, number] => [h.start, h.start + Math.max(h.after.length, 1)];

export function hunkStates(rows: readonly DiffRow[], unstaged: GitFile | undefined, staged: GitFile | undefined): { staged: boolean; unstaged: boolean }[] {
  return hunksOf(rows).map((h) => {
    const [a, b] = spanOf(h);
    return {
      unstaged: pick(unstaged?.hunks, a, b).length > 0,
      staged: pick(staged?.hunks, toIndex(a, unstaged?.hunks), toIndex(b, unstaged?.hunks)).length > 0,
    };
  });
}

/** Each file says whether it has staged changes and changes still to stage (untracked counts). */
export async function stageState(t: Tools, dir: string, changes: Changes | null): Promise<StagedChanges | null> {
  if (!changes?.files) return changes;
  const [unstaged, staged, others] = await Promise.all([read(t, dir, DIFF), read(t, dir, [...DIFF, '--cached']), read(t, dir, ['ls-files', '--others', '--exclude-standard', '-z'])]);
  const by = (list: GitFile[]): Map<string, GitFile> => new Map(list.map((x) => [x.path, x]));
  const u = by(splitDiff(unstaged));
  const s = by(splitDiff(staged));
  const untracked = new Set(others.split('\0').filter(Boolean));
  const out: StagedChanges = changes;
  for (const f of out.files) {
    const names = [f.path, ...(f.from ? [f.from] : [])];
    f.staged = names.some((p) => s.has(p));
    f.unstaged = names.some((p) => u.has(p) || untracked.has(p));
    if (hunkable(f) && (f.staged || f.unstaged)) f.hunkStage = hunkStates(f.rows, u.get(f.path), s.get(f.path));
  }
  out.staged = out.files.filter((f) => f.staged).length;
  return out;
}

export async function stageFile(t: Tools, dir: string, paths: readonly (string | undefined)[], { unstage = false } = {}): Promise<boolean> {
  const list = paths.filter((p): p is string => !!p);
  if (unstage) {
    const staged = new Set((await read(t, dir, ['diff', '--cached', '--name-only', '--no-renames', '-z'])).split('\0').filter(Boolean));
    const go = list.filter((p) => staged.has(p));
    if (go.length) await raw(t, dir, ['restore', '--staged', '--', ...go]);
    return go.length > 0;
  }
  const [changed, others] = await Promise.all([read(t, dir, ['diff', '--name-only', '--no-renames', '-z']), read(t, dir, ['ls-files', '--others', '--exclude-standard', '-z'])]);
  const has = new Set([...changed.split('\0'), ...others.split('\0')]);
  const go = list.filter((p) => has.has(p));
  if (go.length) await raw(t, dir, ['add', '-A', '--', ...go]);
  return go.length > 0;
}

export async function stageHunk(t: Tools, dir: string, f: DiffFile, i: number, { unstage = false } = {}): Promise<boolean> {
  const h = hunksOf(f.rows)[i];
  if (!h) return false;
  const [a, b] = spanOf(h);
  const un = splitDiff(await read(t, dir, [...DIFF, '--', f.path]))[0];
  let file = un;
  let picked: GitHunk[];
  if (unstage) {
    file = splitDiff(await read(t, dir, [...DIFF, '--cached', '--', f.path]))[0];
    picked = pick(file?.hunks, toIndex(a, un?.hunks), toIndex(b, un?.hunks));
  } else picked = pick(un?.hunks, a, b);
  if (!file || !picked.length) return false;
  await raw(t, dir, ['apply', '--cached', '--whitespace=nowarn', ...(unstage ? ['-R'] : []), '-'], { input: patchOf(file, picked) });
  return true;
}

export async function commitStaged(t: Tools, dir: string, message: string, { all = false } = {}): Promise<string | null> {
  if (all) await raw(t, dir, ['add', '-A']);
  const r = await t.gitResult(dir, ['diff', '--cached', '--quiet']);
  if (r.code === 0) return null;
  if (r.code !== 1) throw new ToolError(r.stderr.trim() || 'git diff failed', r.code, r.stdout);
  await raw(t, dir, ['commit', '-q', '-m', message], { timeoutMs: 120_000 });
  return (await raw(t, dir, ['rev-parse', '--short', 'HEAD'])).trim();
}
