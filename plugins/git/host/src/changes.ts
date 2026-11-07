// What a task changed: the Changes panel's files with their hunks, the raw diff for a reviewer, the
// files it touched for overlap checks, and whether two tasks' work would clash. All read-only and
// without refreshing the index (--no-optional-locks), one git after another in a folder, so an
// agent's own git there never finds it locked.

import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs/promises';
import path from 'node:path';
import { generatedPath } from '@wisp-plugin/git-api';
import type { Changes, DiffFile, DiffSections, Touched, Worktree } from '@wisp-plugin/git-api';
import { DIFF_LINES, DiffParser, sectionPath, splitAt } from './diff.ts';
import { QUIET_ENV, type Tools, quiet } from './exec.ts';
import { exists } from './worktree.ts';

const UNTRACKED_MAX = 200;
const READS = 16; // untracked files read side by side
const UNTRACKED_SHOWN = 30; // diffSections: new files a reviewer sees
const UNTRACKED_CHARS = 4000;

/** Run git and hand its stdout to `onText` chunk by chunk. Resolves with the exit code. */
export async function stream(t: Tools, cwd: string, args: readonly string[], onText: (s: string) => void, timeoutMs = 30_000): Promise<number | null> {
  const child = t.proc.spawn(await t.gitBin(), args, { cwd, env: { ...QUIET_ENV }, timeoutMs, stdin: 'ignore' });
  const dec = new StringDecoder('utf8');
  const sub = child.onStdout((c) => onText(dec.write(Buffer.from(c.buffer, c.byteOffset, c.byteLength))));
  const done = await child.exited;
  sub.dispose();
  const tail = dec.end();
  if (tail) onText(tail);
  return done.code;
}

export const mergeBaseOf = (wt: Pick<Worktree, 'remote' | 'base'>): string => (wt.remote ? `refs/remotes/${wt.remote}/${wt.base}` : wt.base);

async function pool<T>(items: readonly T[], size: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const x = items[i++];
      if (x !== undefined) await fn(x);
    }
  }));
}

/** An untracked file, whole, as added; null when it's gone since ls-files or is a folder (a nested repo). */
async function untrackedFile(dir: string, p: string): Promise<DiffFile | null> {
  const f: DiffFile = { path: p, status: 'A', add: 0, del: 0, binary: false, rows: [], more: 0 };
  let buf: Buffer;
  try {
    buf = await fs.readFile(path.join(dir, p));
  } catch {
    return null;
  }
  if (buf.subarray(0, 8000).includes(0)) f.binary = true;
  else {
    const lines = buf.toString('utf8').replace(/\n$/, '').split('\n');
    f.add = buf.length ? lines.length : 0;
    f.rows = lines.slice(0, DIFF_LINES).map((text, i) => ({ op: '+' as const, text, b: i + 1 }));
    f.more = Math.max(0, lines.length - DIFF_LINES);
  }
  return f;
}

/**
 * Every file the task changed since its branch left the base, committed or not, with its hunks. From
 * the merge-base, so what lands on the base later is never the task's. Untracked files come in whole,
 * as added. null when git can't tell.
 */
export async function changes(t: Tools, wt: Worktree | null | undefined): Promise<Changes | null> {
  if (!wt || !(await exists(wt.path))) return null;
  const dir = wt.path;
  const pre = ['--no-optional-locks', '-c', 'core.quotePath=false'];
  const at = await quiet(t.git(dir, [...pre, 'merge-base', 'HEAD', mergeBaseOf(wt)], { timeoutMs: 30_000 }));
  if (!at) return null;
  const parser = new DiffParser();
  await stream(t, dir, [...pre, 'diff', '--no-color', '--no-ext-diff', '-M', '-U3', at], (s) => parser.push(s));
  const files = parser.end();
  const untracked = (await quiet(t.git(dir, [...pre, 'ls-files', '--others', '--exclude-standard', '-z'], { timeoutMs: 30_000 }))).split('\0').filter(Boolean);
  const shown: (DiffFile | null)[] = [];
  const list = untracked.slice(0, UNTRACKED_MAX);
  await pool(list.map((p, i) => [p, i] as const), READS, async ([p, i]) => {
    shown[i] = await untrackedFile(dir, p);
  });
  for (const f of shown) if (f) files.push(f);
  for (const f of files) if (generatedPath(f.path)) f.generated = true;
  files.sort((x, y) => x.path.localeCompare(y.path));
  return { base: wt.base, at, files, untracked: Math.max(0, untracked.length - UNTRACKED_MAX) };
}

/** What a task has changed so far, and a commit of the work as it stands. null when it can't tell. */
export async function touched(t: Tools, wt: Worktree | null | undefined): Promise<Touched | null> {
  if (!wt || !(await exists(wt.path))) return null;
  const read = (...args: string[]): Promise<string> => quiet(t.git(wt.path, ['--no-optional-locks', ...args]));
  const base = await read('merge-base', 'HEAD', mergeBaseOf(wt));
  if (!base) return null;
  const lines = (out: string): string[] => (out ? out.split('\n').filter(Boolean) : []);
  const committed = lines(await read('diff', '--name-only', base, 'HEAD'));
  const edited = lines(await read('diff', '--name-only', 'HEAD'));
  const added = lines(await read('ls-files', '--others', '--exclude-standard'));
  const head = (await read('stash', 'create')) || (await read('rev-parse', 'HEAD'));
  return { files: [...new Set([...committed, ...edited, ...added])].sort(), head, base };
}

/**
 * Would merging two heads conflict? The conflicted files ([] when it merges cleanly), or null when
 * this git can't tell (< 2.38). Runs in any worktree of the repo without touching it.
 */
export async function clash(t: Tools, dir: string, a: string, b: string): Promise<string[] | null> {
  const r = await t.gitResult(dir, ['merge-tree', '--write-tree', '--name-only', '--no-messages', a, b], { timeoutMs: 30_000 });
  if (r.code === 0) return [];
  // Exit 1: the merged tree's id, then one conflicted path per line.
  return r.code === 1 ? [...new Set(r.stdout.trim().split('\n').slice(1).filter(Boolean))] : null;
}

/**
 * The work's changes against `base`, per file, for a reviewer with a budget (v1 judge.js, which ran
 * these three gits with execFileSync). files: every changed path, so a file with no section can be
 * told from one that didn't change. failed: git answered neither.
 */
export async function diffSections(t: Tools, dir: string, base = 'HEAD'): Promise<DiffSections> {
  const run = (args: string[]): Promise<string | null> => t.git(dir, args, { timeoutMs: 30_000, raw: true }).catch(() => null);
  const list = (out: string | null): string[] => (out ?? '').split('\0').filter(Boolean);
  const paths = ['--', '.', ':(exclude)node_modules'];
  const [tracked, listed, others] = await Promise.all([run(['-c', 'core.quotepath=off', 'diff', base, ...paths]), run(['diff', '--name-only', '-z', base, ...paths]), run(['ls-files', '-z', '--others', '--exclude-standard'])]);
  const untracked = list(others);
  const sections: DiffSections['sections'] = tracked ? splitAt(tracked, 'diff --git ').map((text) => ({ path: sectionPath(text), text })) : [];
  for (const f of untracked.slice(0, UNTRACKED_SHOWN)) {
    try {
      const body = await fs.readFile(path.join(dir, f), 'utf8');
      const text = `\n--- /dev/null\n+++ b/${f}\n${body.slice(0, UNTRACKED_CHARS).split('\n').map((l) => `+${l}`).join('\n')}`;
      sections.push({ path: f, text, ...(body.length > UNTRACKED_CHARS && { cut: true as const }) });
    } catch {}
  }
  const files = [...new Set([...list(listed), ...untracked.filter((f) => !/^node_modules(\/|$)/.test(f)), ...sections.map((s) => s.path)])];
  return { sections, files, ...(tracked === null && listed === null && { failed: true as const }) };
}

/** The raw unified diff of the folder against `base`, streamed into one string (for the blob store). */
export async function rawDiff(t: Tools, dir: string, base: string, mergeBase: boolean): Promise<string> {
  const pre = ['--no-optional-locks', '-c', 'core.quotePath=false'];
  const from = mergeBase ? (await quiet(t.git(dir, [...pre, 'merge-base', 'HEAD', base]))) || base : base;
  const parts: string[] = [];
  await stream(t, dir, [...pre, 'diff', '--no-color', '--no-ext-diff', '-M', from], (s) => parts.push(s), 120_000);
  return parts.join('');
}
