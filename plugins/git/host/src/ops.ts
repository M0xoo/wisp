// The writes Ship it and the Changes panel make: commit, push, check a branch against its base, catch
// the user's base branch up (fast-forward only), and stage or commit from Changes.

import type { Worktree } from '@wisp-plugin/git-api';
import { type Tools, quiet } from './exec.ts';
import { exists } from './worktree.ts';

/** Commit whatever is uncommitted. false: nothing was. Throws without a message when there is. */
export async function commitAll(t: Tools, dir: string, title: string, body = ''): Promise<boolean> {
  if (!(await quiet(t.git(dir, ['status', '--porcelain'])))) return false;
  await t.git(dir, ['add', '-A']);
  await t.git(dir, ['commit', '--quiet', '--no-verify', '-m', title.trim(), ...(body.trim() ? ['-m', body.trim()] : [])]);
  return true;
}

export async function push(t: Tools, wt: Worktree): Promise<void> {
  if (!wt.remote) throw new Error('This repo has no origin remote to push to.');
  await t.git(wt.path, ['push', '--quiet', '-u', wt.remote, `HEAD:refs/heads/${wt.branch}`], { timeoutMs: 120_000 });
}

/**
 * Does the branch really conflict with its freshly fetched base? Checked before spending an agent run
 * on GitHub's word, which can lag a push. null when this git can't tell (< 2.38).
 */
export async function conflictsWithBase(t: Tools, wt: Worktree | null | undefined): Promise<boolean | null> {
  if (!wt?.remote || !(await exists(wt.path))) return null;
  await quiet(t.git(wt.path, ['fetch', '--quiet', wt.remote, wt.base], { timeoutMs: 30_000 }));
  const r = await t.gitResult(wt.path, ['merge-tree', '--write-tree', '--name-only', '--no-messages', `refs/remotes/${wt.remote}/${wt.base}`, 'HEAD'], { timeoutMs: 30_000 });
  return r.code === 0 ? false : r.code === 1 ? true : null;
}

/**
 * After an agent was asked to merge the base into its branch: is it in, with nothing left half done?
 * A merge it resolved but left uncommitted is committed here.
 */
export async function baseMerged(t: Tools, wt: Worktree): Promise<{ ok: true } | { ok: false; why: string }> {
  const dir = wt.path;
  const unmerged = await quiet(t.git(dir, ['diff', '--name-only', '--diff-filter=U']));
  if (unmerged) return { ok: false, why: `Still conflicted: ${unmerged.split('\n').join(', ')}` };
  if (await quiet(t.git(dir, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']))) {
    await t.git(dir, ['add', '-A']);
    await t.git(dir, ['commit', '--quiet', '--no-verify', '--no-edit']);
  }
  const base = `refs/remotes/${String(wt.remote)}/${wt.base}`;
  const merged = await t.git(dir, ['merge-base', '--is-ancestor', base, 'HEAD']).then(() => true, () => false);
  if (!merged) return { ok: false, why: `${String(wt.remote)}/${wt.base} is not merged into the branch.` };
  // Conflict markers staged as if resolved: git no longer sees them, so look in the PR's diff.
  const marked = await quiet(t.git(dir, ['diff', '--name-only', '-G^<<<<<<< ', `${base}...HEAD`]));
  if (marked) return { ok: false, why: `Conflict markers left in ${marked.split('\n').join(', ')}` };
  return { ok: true };
}

/** Fast-forward the user's base branch to the remote, never anything more invasive. */
export async function syncBase(t: Tools, root: string, base: string): Promise<{ ok: boolean; text: string }> {
  try {
    await t.git(root, ['fetch', '--quiet', 'origin']);
    const current = await quiet(t.git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']));
    if (current === base) await t.git(root, ['merge', '--ff-only', '--quiet', `origin/${base}`]);
    else await t.git(root, ['fetch', '--quiet', 'origin', `${base}:${base}`]); // not checked out: move the ref (ff only)
    return { ok: true, text: `Local ${base} is up to date with origin/${base}.` };
  } catch (err) {
    return { ok: false, text: `Local ${base} was not updated: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export const deleteRemoteBranch = (t: Tools, wt: Worktree): Promise<string> => quiet(t.git(wt.root, ['push', '--quiet', wt.remote ?? 'origin', '--delete', wt.branch]));

/** The working tree's file back as `source` had it (Changes' Revert of a whole file). */
export async function restore(t: Tools, dir: string, source: string, rel: string): Promise<void> {
  await t.git(dir, ['restore', `--source=${source}`, '--worktree', '--', rel]);
}
