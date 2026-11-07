// Worktrees as git sees them: where a new one branches from, how far it has moved, what only its folder
// holds, and adding or removing one. The folder layout, setup and cleanup rules are wisp.worktrees'.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BaseRef, RemoveOptions, RemoveResult, Worktree, WorktreeSource, WorktreeStatus } from '@wisp-plugin/git-api';
import { type Tools, quiet } from './exec.ts';

export const exists = (p: string | undefined): Promise<boolean> => (p ? fs.access(p).then(() => true, () => false) : Promise.resolve(false));

export async function realpath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

export async function repoRoot(t: Tools, cwd: string): Promise<string | null> {
  if (!(await exists(cwd))) return null;
  const top = await quiet(t.git(cwd, ['rev-parse', '--show-toplevel']));
  return top ? path.resolve(top) : null;
}

// Anywhere that looks like Conductor's (v1 conductor.js inConductor): the second lock on a worktree
// that isn't wisp's to remove.
export function inConductor(p: string, home: string = os.homedir()): boolean {
  if (!p) return false;
  if (p.split(/[\\/]/).includes('.conductor')) return true;
  const rel = path.relative(path.join(home, 'conductor'), path.resolve(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** A worktree wisp didn't make: the user's, in place, never ours to remove, recreate or tidy. */
export const isForeign = (wt: Partial<Worktree> | null | undefined): boolean => !!(wt?.foreign || (wt?.path && inConductor(wt.path)));

/** What a worktree session branches from: the remote's default branch, freshly fetched, else HEAD. */
export class Sources {
  // A fetch is good for a minute: tasks launched back to back share one (about half a second to GitHub).
  static readonly FETCH_FRESH_MS = 60_000;
  readonly #fetches = new Map<string, { at: number; done: Promise<string> }>();
  readonly #t: Tools;
  readonly #now: () => number;
  constructor(t: Tools, now: () => number) {
    this.#t = t;
    this.#now = now;
  }

  #fetch(root: string): Promise<string> {
    const last = this.#fetches.get(root);
    if (last && this.#now() - last.at < Sources.FETCH_FRESH_MS) return last.done;
    const done = quiet(this.#t.git(root, ['fetch', '--quiet', 'origin'], { timeoutMs: 20_000 })); // offline: use what we have
    this.#fetches.set(root, { at: this.#now(), done });
    return done;
  }

  async baseRef(root: string): Promise<BaseRef | null> {
    const g = (args: string[]): Promise<string> => quiet(this.#t.git(root, args));
    if ((await g(['remote'])).split('\n').includes('origin')) {
      await this.#fetch(root);
      const head = await g(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
      for (const ref of [head, 'origin/main', 'origin/master']) {
        if (ref && (await g(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]))) return { ref, branch: ref.replace(/^origin\//, ''), remote: 'origin' };
      }
    }
    const sha = await g(['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (!sha) return null; // a repo without commits has nothing to branch from
    return { ref: sha, branch: await g(['symbolic-ref', '--quiet', '--short', 'HEAD']), remote: null };
  }

  /** Where a launch's worktrees come from, resolved once per launch so compare runs share one fetch. */
  async source(cwd: string): Promise<WorktreeSource | null> {
    const root = await repoRoot(this.#t, cwd);
    const base = root ? await this.baseRef(root) : null;
    if (!root || !base) return null;
    base.sha = await quiet(this.#t.git(root, ['rev-parse', '--verify', '--quiet', `${base.ref}^{commit}`]));
    return { root, base };
  }
}

/**
 * { dirty, ahead (past the base), unpushed (not on the remote branch), exists }. merged: the head of
 * the branch's merged PR: a squash merge leaves the branch ahead of the base for good, so only
 * commits after that one are new. As few gits as possible, side by side: hundreds run after a restart.
 */
export async function worktreeStatus(t: Tools, wt: Worktree | null | undefined, merged?: string | false | null): Promise<WorktreeStatus> {
  if (!wt || !(await exists(wt.path))) return { exists: false, dirty: 0, ahead: 0, unpushed: 0 };
  const count = (ref: string): Promise<number | null> => t.git(wt.path, ['rev-list', '--count', `${ref}..HEAD`]).then((n) => Number(n) || 0, () => null);
  const since = async (refs: (string | false | null | undefined)[]): Promise<number | null> => {
    for (const ref of refs) {
      if (!ref) continue;
      const n = await count(ref);
      if (n !== null) return n;
    }
    return null;
  };
  const [porcelain, base, pushed] = await Promise.all([quiet(t.git(wt.path, ['status', '--porcelain'])), count(wt.baseRef), since([merged, wt.remote && `refs/remotes/${wt.remote}/${wt.branch}`])]);
  const ahead = base ?? 0;
  return { exists: true, dirty: porcelain ? porcelain.split('\n').length : 0, ahead, unpushed: pushed ?? ahead };
}

/**
 * What only this folder holds, for a cleanup that must not guess: changed paths, plus one if HEAD has
 * left the task's branch. Throws when git can't tell (a repo that moved, where status reads clean).
 */
export async function folderOnly(t: Tools, wt: Worktree): Promise<number> {
  const [porcelain, head, tip] = await Promise.all([t.git(wt.path, ['status', '--porcelain']), t.git(wt.path, ['rev-parse', 'HEAD']), wt.branch ? t.git(wt.root, ['rev-parse', `refs/heads/${wt.branch}`]) : null]);
  return (porcelain ? porcelain.split('\n').length : 0) + (wt.branch && head !== tip ? 1 : 0);
}

/**
 * `git worktree add` reads every other worktree's files under .git/worktrees; two at once in one repo
 * can catch the other half-made. So adds into the same repo take turns.
 */
export class Adds {
  readonly #queue = new Map<string, Promise<unknown>>();
  readonly #t: Tools;
  readonly #added: (root: string, at: string) => void;
  constructor(t: Tools, added: (root: string, at: string) => void) {
    this.#t = t;
    this.#added = added;
  }

  async add(root: string, args: readonly string[], at: string): Promise<void> {
    const key = await realpath(root);
    const prev = this.#queue.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.#t.git(root, ['worktree', 'add', '--quiet', ...args]));
    this.#queue.set(key, next);
    const clear = (): void => void (this.#queue.get(key) === next && this.#queue.delete(key));
    next.then(clear, clear);
    await next;
    this.#added(root, at);
  }
}

export class Removals {
  readonly #running = new Map<string, Promise<unknown>>();
  readonly #t: Tools;
  constructor(t: Tools) {
    this.#t = t;
  }

  /** resolves once a removal under way at that path is over */
  async wait(p: string): Promise<void> {
    await this.#running.get(p);
  }

  remove(wt: Worktree | null | undefined, opts: RemoveOptions = {}): Promise<RemoveResult> {
    const key = wt?.path ?? '';
    const job = this.#drop(wt, opts).finally(() => this.#running.delete(key));
    this.#running.set(key, job.catch(() => {}));
    return job;
  }

  // force: drop uncommitted work too. The branch goes only when nothing would be lost with it.
  async #drop(wt: Worktree | null | undefined, { force = false, branch = false, strict = false, still }: RemoveOptions): Promise<RemoveResult> {
    if (!wt) return { removed: false };
    if (isForeign(wt)) return { removed: false, foreign: true }; // whatever force and branch say
    const t = this.#t;
    if (await exists(wt.path)) {
      const dirty = strict ? await folderOnly(t, wt).catch(() => 1) : (await worktreeStatus(t, wt)).dirty;
      if (dirty && !force) return { removed: false, dirty };
      if (still && !still()) return { removed: false };
      await quiet(t.git(wt.root, ['worktree', 'remove', '--force', wt.path], { timeoutMs: 5 * 60_000 })); // a large node_modules takes a while
      await fs.rm(wt.path, { recursive: true, force: true });
      await quiet(t.git(wt.root, ['worktree', 'prune']));
    }
    let branchDeleted = false;
    if (branch) {
      const unique = Number(await quiet(t.git(wt.root, ['rev-list', '--count', `${wt.baseRef}..${wt.branch}`]))) || 0;
      if (!unique || branch === 'force') branchDeleted = !!(await quiet(t.git(wt.root, ['branch', '-D', wt.branch]).then(() => 'ok')));
    }
    return { removed: true, branchDeleted };
  }
}
