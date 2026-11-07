// git.service@1, assembled: the repo cache and every operation, over one Tools (git and gh through
// the proc service). createGitService is what the plugin provides and what tests and benches drive.

import type { Disposable, ProcService, Scope } from '@wisp/kernel';
import type { GitService, Repo, Worktree } from '@wisp-plugin/git-api';
import { changes, clash, touched } from './changes.ts';
import { cloneRepo } from './clone.ts';
import { createTools, type Tools } from './exec.ts';
import { GitHub } from './github.ts';
import { type MoveDeps, applyPatch, fork, pack, unpack, workPatch } from './move.ts';
import { baseMerged, commitAll, conflictsWithBase, deleteRemoteBranch, push, restore, syncBase } from './ops.ts';
import { type BlobPut, RepoImpl } from './repo.ts';
import { commitStaged, stageFile, stageHunk, stageState } from './stage.ts';
import { Adds, Removals, Sources, exists, folderOnly, isForeign, realpath, repoRoot, worktreeStatus } from './worktree.ts';

export interface GitDeps {
  proc: ProcService;
  /** the blob service: large diffs go there (read lazily: a plugin that never diffs needs none) */
  blob: () => BlobPut;
  scope: Scope;
  now?: () => number;
  env?: Readonly<Record<string, string | undefined>>;
  /** a worktree folder was added (the cleanup's cap listens) */
  onWorktreeAdded?: (root: string, path: string) => void;
}

export interface GitServiceImpl extends GitService, Disposable {
  /** git and gh as this service runs them (benches time through it) */
  readonly exec: Tools;
  /** repos with a live handle (tests and the leak check) */
  readonly open: number;
}

export function createGitService(d: GitDeps): GitServiceImpl {
  const now = d.now ?? Date.now;
  const t = createTools(d.proc, d.env);
  const sources = new Sources(t, now);
  const adds = new Adds(t, (root, at) => d.onWorktreeAdded?.(root, at));
  const removals = new Removals(t);
  const gh = new GitHub(t, now);
  const move: MoveDeps = { t, adds, sources, now };
  const repos = new Map<string, RepoImpl>(); // root → its handle's state
  const roots = new Map<string, Promise<string | null>>(); // asked-for path → its root

  const rootOf = (p: string): Promise<string | null> => {
    let r = roots.get(p);
    if (!r) {
      r = repoRoot(t, p).then(async (top) => (top ? realpath(top) : null));
      roots.set(p, r);
      // a folder that isn't a repo yet may become one: don't remember the miss
      void r.then((top) => void (top || roots.delete(p)));
    }
    return r;
  };

  async function repo(p: string): Promise<Repo> {
    const root = await rootOf(p);
    if (!root) throw Object.assign(new Error(`${p} isn’t in a git repo`), { code: 'not_found' });
    let r = repos.get(root);
    if (!r) {
      const made = new RepoImpl(root, { t, adds, sources, blob: d.blob, now, scope: d.scope }, () => {
        if (made.refs > 0) return;
        made.close();
        repos.delete(root);
      });
      r = made;
      repos.set(root, r);
    }
    return r.handle();
  }

  const service: GitServiceImpl = {
    exec: t,
    get open() {
      return repos.size;
    },
    repo,
    root: (cwd) => repoRoot(t, cwd),
    source: (cwd) => sources.source(cwd),
    exists: (wt: Worktree) => exists(wt.path),
    isForeign: (wt) => isForeign(wt),
    worktreeStatus: (wt, o = {}) => worktreeStatus(t, wt, o.merged),
    folderOnly: (wt) => folderOnly(t, wt),
    worktreeRemove: (wt, o) => removals.remove(wt, o),
    removing: (p) => removals.wait(p),
    changes: (wt) => changes(t, wt),
    touched: (wt) => touched(t, wt),
    clash: (dir, a, b) => clash(t, dir, a, b),
    commitAll: (dir, title, body) => commitAll(t, dir, title, body),
    push: (wt) => push(t, wt),
    conflictsWithBase: (wt) => conflictsWithBase(t, wt),
    baseMerged: (wt) => baseMerged(t, wt),
    syncBase: (root, base) => syncBase(t, root, base),
    deleteRemoteBranch: async (wt) => void (await deleteRemoteBranch(t, wt)),
    stageState: (dir, ch) => stageState(t, dir, ch),
    stageFile: (dir, paths, o) => stageFile(t, dir, paths, o),
    stageHunk: (dir, f, i, o) => stageHunk(t, dir, f, i, o),
    commitStaged: (dir, msg, o) => commitStaged(t, dir, msg, o),
    restore: (dir, source, p) => restore(t, dir, source, p),
    pack: (dir, wt, file) => pack(move, dir, wt, file),
    unpack: (o) => unpack(move, o),
    fork: (o) => fork(move, o),
    workPatch: (dir, base) => workPatch(move, dir, base),
    applyPatch: (dir, patch) => applyPatch(move, dir, patch),
    clone: (url, parent, o) => cloneRepo(t, url, parent, o),
    prView: (cwd, ref) => gh.prView(cwd, ref),
    prDetail: (cwd, ref) => gh.prDetail(cwd, ref),
    prCreate: (cwd, o) => gh.prCreate(cwd, o),
    prReady: (cwd, ref) => gh.prReady(cwd, ref),
    prMerge: (cwd, ref, head) => gh.prMerge(cwd, ref, head),
    issues: (repoName, q, limit) => gh.issues(repoName, q, limit),
    runLog: (cwd, repoName, job) => gh.runLog(cwd, repoName, job),
    tools: (platform) => gh.tools(platform),
    dispose() {
      for (const r of repos.values()) r.close();
      repos.clear();
      roots.clear();
    },
  };
  return service;
}
