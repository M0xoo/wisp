// A task's work travelling: packed into a bundle for another place, unpacked into a new worktree,
// forked onto a fresh branch, or sent as a binary patch from a delegate and applied back. The user's
// index and working tree are only read: snapshots go through a temporary index (GIT_INDEX_FILE).

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { slug } from '@wisp-plugin/git-api';
import type { ApplyResult, PackInfo, Worktree } from '@wisp-plugin/git-api';
import { type Tools, quiet } from './exec.ts';
import { type Adds, type Sources, realpath, repoRoot } from './worktree.ts';

// Who the snapshot commit is by, so packing works where git has no user.name.
const MOVER = { GIT_AUTHOR_NAME: 'wisp', GIT_AUTHOR_EMAIL: 'wisp@localhost', GIT_COMMITTER_NAME: 'wisp', GIT_COMMITTER_EMAIL: 'wisp@localhost' };
const tmpName = (what: string): string => path.join(os.tmpdir(), `wisp-${what}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

export interface MoveDeps {
  t: Tools;
  adds: Adds;
  sources: Sources;
  now: () => number;
}

/** The folder as a tree on top of HEAD (untracked files too, ignored ones not), via a scratch index. */
async function snapshotTree(t: Tools, root: string, index: string): Promise<string> {
  const env = { ...MOVER, GIT_INDEX_FILE: index };
  await t.git(root, ['read-tree', 'HEAD'], { env });
  await t.git(root, ['add', '-A'], { env, timeoutMs: 120_000 });
  return t.git(root, ['write-tree'], { env });
}

// A launch from a subfolder of the repo keeps working in that subfolder.
async function subOf(root: string, cwd: string, dir: string): Promise<string> {
  const sub = path.relative(await realpath(root), await realpath(cwd));
  return sub && !sub.startsWith('..') ? path.join(dir, sub) : dir;
}

async function freeBranch(t: Tools, root: string, title: string, id: string, wanted?: string): Promise<string> {
  const taken = async (b: string): Promise<boolean> => !!(await quiet(t.git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])));
  let branch = wanted && /^[\w./-]{1,120}$/.test(wanted) && !(await taken(wanted)) ? wanted : `wisp/${slug(title) || 'task'}-${id.slice(0, 6)}`;
  if (await taken(branch)) branch = `wisp/${slug(title) || 'task'}-${id}`;
  return branch;
}

/** Pack the work in `dir` into `file`: the branch's commits plus one snapshot commit of what isn't committed. */
export async function pack({ t }: MoveDeps, dir: string, wt: Worktree | null, file: string): Promise<PackInfo | null> {
  const root = await repoRoot(t, dir);
  const head = root ? await quiet(t.git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])) : '';
  if (!root || !head) return null;
  const index = `${file}.index`;
  const ref = `refs/wisp/move/${path.basename(file).replace(/\W+/g, '-')}`;
  try {
    const tree = await snapshotTree(t, root, index);
    const snap = await t.git(root, ['commit-tree', tree, '-p', head, '-m', 'wisp: work in progress, moved'], { env: { ...MOVER, GIT_INDEX_FILE: index } });
    await t.git(root, ['update-ref', ref, snap]);
    // Commits the remote already has (from wt.head down) stay out.
    const published = wt?.head ? await quiet(t.git(root, ['branch', '-r', '--contains', wt.head])) : '';
    await t.git(root, ['bundle', 'create', file, ref, ...(published && wt?.head ? [`^${wt.head}`] : [])], { timeoutMs: 300_000 });
    return { ref, branch: wt?.branch ?? '', base: wt?.base ?? '', baseRef: wt?.baseRef ?? '', head: wt?.head ?? null, remote: wt?.remote ?? null, prereq: !!published };
  } finally {
    await fs.rm(index, { force: true });
    await quiet(t.git(root, ['update-ref', '-d', ref]));
  }
}

/** Unpack a pack() bundle into a new worktree of the repo at `cwd`: commits as commits, the snapshot uncommitted. */
export async function unpack(d: MoveDeps, o: { cwd: string; home: string; id: string; title: string; pack: PackInfo; file: string }): Promise<Worktree> {
  const { t } = d;
  const root = await repoRoot(t, o.cwd);
  if (!root) throw Object.assign(new Error(`${o.cwd} isn’t a git repo here, so the work has nowhere to go.`), { code: 'invalid' });
  if (o.pack.prereq) await quiet(t.git(root, ['fetch', '--quiet', 'origin'], { timeoutMs: 60_000 })); // the commits the bundle leaves out
  const local = `refs/wisp/moved/${o.id}`;
  try {
    await t.git(root, ['fetch', '--quiet', '--no-tags', o.file, `+${o.pack.ref}:${local}`], { timeoutMs: 300_000 });
  } catch (err) {
    throw Object.assign(new Error(`Couldn’t bring the work over: ${err instanceof Error ? err.message : String(err)}`), { code: 'invalid' });
  }
  const snap = await quiet(t.git(root, ['rev-parse', '--verify', '--quiet', `${local}^{commit}`])); // where the work stood
  const branch = await freeBranch(t, root, o.title, o.id, o.pack.branch);
  const dir = path.join(o.home, 'worktrees', `${path.basename(root)}-${o.id}`);
  await fs.mkdir(path.dirname(dir), { recursive: true });
  try {
    await d.adds.add(root, ['--no-track', '-b', branch, dir, `${local}^`], dir);
    await t.git(dir, ['read-tree', '-u', '--reset', local]);
    await t.git(dir, ['reset', '--quiet']);
  } finally {
    await quiet(t.git(root, ['update-ref', '-d', local]));
  }
  // A task that ran in the folder itself (no worktree) branches from what's here.
  const base = o.pack.baseRef ? null : await d.sources.baseRef(root);
  return {
    path: dir,
    cwd: await subOf(root, o.cwd, dir),
    branch,
    base: o.pack.base || base?.branch || '',
    baseRef: o.pack.baseRef || base?.ref || '',
    head: o.pack.head || (await quiet(t.git(dir, ['rev-parse', 'HEAD']))) || null,
    remote: o.pack.baseRef ? o.pack.remote : (base?.remote ?? null),
    root,
    ...(snap && { snap }),
    createdAt: d.now(),
  };
}

/**
 * Fork a task's work: a new worktree of the repo at `dir` on a fresh branch, with the work at `at` (a
 * turn's checkpoint) or as the folder is now. It comes back uncommitted. null outside a repo with commits.
 */
export async function fork(d: MoveDeps, o: { dir: string; wt: Worktree | null; at?: { commit: string; head: string; dirty: boolean } | null; home: string; id: string; title: string }): Promise<Worktree | null> {
  const { t } = d;
  const root = await repoRoot(t, o.dir);
  const now = root ? await quiet(t.git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])) : '';
  if (!root || !now) return null;
  let head = now;
  let snap: string | null = null;
  if (o.at?.head) {
    head = o.at.head;
    snap = o.at.dirty && o.at.commit !== o.at.head ? o.at.commit : null;
    for (const c of [head, snap]) if (c && !(await quiet(t.git(root, ['rev-parse', '--verify', '--quiet', `${c}^{commit}`])))) throw Object.assign(new Error('The work at that turn is gone from git, so it can’t be forked from there.'), { code: 'invalid' });
  } else {
    const index = tmpName('fork');
    try {
      const tree = await snapshotTree(t, root, index);
      if (tree !== (await t.git(root, ['rev-parse', 'HEAD^{tree}']))) snap = await t.git(root, ['commit-tree', tree, '-p', head, '-m', 'wisp: work in progress, forked'], { env: { ...MOVER, GIT_INDEX_FILE: index } });
    } finally {
      await fs.rm(index, { force: true });
    }
  }
  const branch = await freeBranch(t, root, o.title, o.id);
  const repo = o.wt?.root || root; // the main checkout: a task's worktree may go before its fork's
  const wtDir = path.join(o.home, 'worktrees', `${path.basename(repo)}-${o.id}`);
  await fs.mkdir(path.dirname(wtDir), { recursive: true });
  await d.adds.add(repo, ['--no-track', '-b', branch, wtDir, head], wtDir);
  if (snap) {
    await t.git(wtDir, ['read-tree', '-u', '--reset', snap]);
    await t.git(wtDir, ['reset', '--quiet']);
  }
  // A task that ran in the folder itself ships against what the folder branches from.
  const base = o.wt?.baseRef ? null : await d.sources.baseRef(root);
  return {
    path: wtDir,
    cwd: await subOf(root, o.dir, wtDir),
    branch,
    base: o.wt?.base || base?.branch || '',
    baseRef: o.wt?.baseRef || base?.ref || '',
    head: o.wt?.head || head,
    remote: o.wt?.baseRef ? (o.wt.remote ?? null) : (base?.remote ?? null),
    root: repo,
    createdAt: d.now(),
  };
}

/** A delegate's work since `base` as a binary patch from the repo root, untracked files included. */
export async function workPatch({ t }: MoveDeps, dir: string, base: string): Promise<string> {
  const root = await repoRoot(t, dir);
  if (!root || !base) return '';
  const index = tmpName('patch');
  try {
    const tree = await snapshotTree(t, root, index);
    const out = await t.git(root, ['diff', '--binary', '--no-color', '--no-ext-diff', '--full-index', base, tree], { timeoutMs: 120_000 });
    return out ? `${out}\n` : ''; // git apply wants the last newline
  } finally {
    await fs.rm(index, { force: true });
  }
}

/** That patch, applied: as it is, else with a three-way merge against the blobs it came from. */
export async function applyPatch({ t }: MoveDeps, dir: string, patch: string): Promise<ApplyResult> {
  if (!patch.trim()) return { applied: false, empty: true };
  const root = await repoRoot(t, dir);
  if (!root) return { applied: false, error: `${dir} isn’t a git repo, so the changes had nowhere to go.` };
  const file = `${tmpName('apply')}.patch`;
  await fs.writeFile(file, patch);
  try {
    try {
      await t.git(root, ['apply', '--binary', '--whitespace=nowarn', file], { timeoutMs: 120_000 });
      return { applied: true };
    } catch {}
    try {
      await t.git(root, ['apply', '--binary', '--3way', '--whitespace=nowarn', file], { timeoutMs: 120_000 });
      return { applied: true, merged: true };
    } catch (err) {
      const conflicts = (await quiet(t.git(root, ['diff', '--name-only', '--diff-filter=U']))).split('\n').filter(Boolean);
      return conflicts.length ? { applied: true, conflicts } : { applied: false, error: err instanceof Error ? err.message : String(err) };
    }
  } finally {
    await fs.rm(file, { force: true });
  }
}
