// @wisp-plugin/git-api: the contract of git.service@1 (plan §6.11.1). Worktrees, ship, review, issues,
// the workspace panel and the runtime's checkpoints all reach git through this one handle; none of them
// spawns git itself. Requested by contract, not by provider: a jj or remote-git plugin may provide it.
//
// Every method maps to a permission (`permissions` below, checked by the kernel's proxy and by
// tools/check). Everything is async and runs through the kernel's proc service: v1's nine
// execFileSync calls of git (up to 15 s each, on the event loop) have no equivalent here.

import type { Disposable, ServiceRef } from '@wisp/kernel';

export { parseRepo, repoKey, sameRepo, slug, generatedPath } from './pure.ts';
export type { ParsedRepo } from './pure.ts';
export { hunksOf, hunkKey, revertHunk, hunkable } from './hunks.ts';
export type { Hunk } from './hunks.ts';
export type { DiffRow, DiffFile } from './rows.ts';
import type { DiffFile } from './rows.ts';

/** A large result kept in the blob store (diffs): its hash, read through the `blob` service. */
export interface BlobRef {
  hash: string;
  size: number;
}

/** One session's worktree, as v1 kept it on `session.worktree` (the importer maps it 1:1). */
export interface Worktree {
  path: string;
  /** where the task works: `path`, or the same subfolder of it the task was launched from */
  cwd: string;
  branch: string;
  /** the base branch's name ('main'), what Ship it opens the PR against */
  base: string;
  /** what it branched from: 'origin/main', or a sha when there's no remote */
  baseRef: string;
  /** the base commit it started at */
  head: string | null;
  remote: string | null;
  /** the main checkout */
  root: string;
  createdAt: number;
  /** a worktree wisp didn't make (brought in): never removed, recreated or tidied */
  foreign?: string | boolean;
  /** a moved or delegated task: the commit its work stood at */
  snap?: string;
}

export interface BaseRef {
  ref: string;
  branch: string;
  remote: string | null;
  sha?: string | null;
}

export interface WorktreeSource {
  root: string;
  base: BaseRef;
}

export interface Status {
  /** the checkout's branch, '' when detached */
  branch: string;
  head: string | null;
  /** porcelain v1 lines: XY and the path (renames: the new path) */
  files: { x: string; y: string; path: string; from?: string }[];
  dirty: number;
}

export interface WorktreeStatus {
  exists: boolean;
  /** changed paths (git status --porcelain lines) */
  dirty: number;
  /** commits past the base */
  ahead: number;
  /** commits not on the remote branch (or since the merged PR's head) */
  unpushed: number;
}

export interface RemoveOptions {
  /** drop uncommitted work too */
  force?: boolean;
  /** delete the branch as well: true when nothing would be lost, 'force' always */
  branch?: boolean | 'force';
  /** anything folderOnly finds (or can't tell) keeps it */
  strict?: boolean;
  /** asked last thing before the folder goes: a cleanup a follow-up may have overtaken */
  still?: () => boolean;
}

export interface RemoveResult {
  removed: boolean;
  dirty?: number;
  foreign?: true;
  branchDeleted?: boolean;
}

/** What a task changed since its branch left the base (v1 taskChanges). */
export interface Changes {
  base: string;
  /** the merge-base commit */
  at: string;
  files: DiffFile[];
  /** untracked files past the cap */
  untracked: number;
}

export interface StagedFile extends DiffFile {
  staged?: boolean;
  unstaged?: boolean;
  hunkStage?: { staged: boolean; unstaged: boolean }[];
}
export interface StagedChanges extends Changes {
  files: StagedFile[];
  staged?: number;
}

/** A diff split per file (v1 judge.js diffSections): for reviewers and judges with a budget. */
export interface DiffSections {
  sections: { path: string; text: string; cut?: true }[];
  files: string[];
  failed?: true;
}

export interface Touched {
  files: string[];
  /** a commit of the work as it stands (stash create, else HEAD) */
  head: string;
  base: string;
}

export interface Branch {
  name: string;
  sha: string;
  upstream: string;
  current: boolean;
}

export interface Checkpoint {
  commit: string;
  head: string;
  dirty: boolean;
  branch: string;
  untracked: string[];
  untrackedCut?: true;
  at: number;
}

export interface RepoChange {
  root: string;
  /** what moved: HEAD (a commit, a checkout), the index (add, stage), refs (fetch, push, branch) */
  kind: 'head' | 'index' | 'refs';
}

export interface PackInfo {
  ref: string;
  branch: string;
  base: string;
  baseRef: string;
  head: string | null;
  remote: string | null;
  prereq: boolean;
}

export type ApplyResult = { applied: true; merged?: true; conflicts?: string[] } | { applied: false; empty?: true; error?: string };

export interface PrChecks {
  pass: number;
  fail: number;
  pending: number;
}

/** A PR as the card keeps it (v1 prSummary). */
export interface PrSummary {
  number: number;
  url: string;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED' | (string & {});
  draft: boolean;
  review: string;
  mergeState: string;
  conflict: boolean;
  head: string;
  branch: string;
  base: string;
  mergedAt: string | null;
  checks: PrChecks;
  checkedAt: number;
}

export interface PrCheck {
  name: string;
  workflow: string;
  state: 'pass' | 'fail' | 'pending' | 'skip';
  url: string;
  ms: number | null;
  startedAt: number | null;
}

export interface PrNote {
  kind?: 'comment' | 'review';
  state?: string;
  author: string;
  bot: boolean;
  body: string;
  at: number | null;
  url: string;
}

export interface PrThread {
  path: string;
  line: number | null;
  outdated: boolean;
  notes: PrNote[];
}

/** The PR panel's full view (v1 prDetailOf). */
export interface PrDetail extends PrSummary {
  summary: PrSummary;
  author: string;
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: { path: string; additions: number; deletions: number }[];
  checkList: PrCheck[];
  reviewers: { author: string; state: string }[];
  notes: PrNote[];
  threads: PrThread[];
  updatedAt: number | null;
}

export interface ToolsStatus {
  git: { installed: boolean; setup?: ToolSetup };
  gh: { installed: boolean; signedIn: boolean | null; setup?: ToolSetup };
}
export interface ToolSetup {
  tip: string;
  command: string;
  url: string;
}

export interface GitIssue {
  number: number;
  title: string;
  url: string;
  labels: (string | { name: string })[];
  assignees: { login?: string; name?: string }[];
  updatedAt: string | null;
  body: string;
}

/**
 * A repo handle: one checkout (the folder `repo(path)` found), cached per path and released with
 * `dispose()` (put it in your scope: `scope.add(repo)`). Methods that name a Worktree run in that
 * worktree's folder and its main checkout, as v1's git.js did.
 */
export interface Repo extends Disposable {
  /** the checkout's top folder */
  readonly root: string;
  status(): Promise<Status>;
  branches(): Promise<Branch[]>;
  branchExists(name: string): Promise<boolean>;
  /** rev-parse --verify --quiet `<rev>^{commit}`, or null */
  resolve(rev: string): Promise<string | null>;
  remoteUrl(remote?: string): Promise<string>;
  baseRef(): Promise<BaseRef | null>;
  /** the raw unified diff of the work against `base` (merge-base when `mergeBase`), as a blob */
  diff(base: string, opts?: { mergeBase?: boolean; untracked?: boolean }): Promise<BlobRef>;
  diffSections(base: string): Promise<DiffSections>;
  lsFiles(opts?: { others?: boolean; ignored?: boolean; directory?: boolean; cached?: boolean }): Promise<string[] | null>;
  grep(args: readonly string[]): Promise<string | null>;
  show(rev: string, file: string, maxBytes?: number): Promise<string | null>;
  /** `git stash create`, else HEAD: what the folder holds right now as a commit */
  pin(): Promise<string | null>;
  checkpoint(sessionId?: string, turnId?: string): Promise<Checkpoint | null>;
  dropCheckpoints(sessionId: string): Promise<void>;
  /** a worktree of this repo: `--no-track -b branch at from` (or an existing branch); adds take turns per repo */
  worktreeAdd(o: { at: string; branch: string; from?: string; newBranch?: boolean }): Promise<void>;
  worktreePrune(): Promise<void>;
  onChange(cb: (e: RepoChange) => void): Disposable;
}

export interface GitService {
  repo(path: string): Promise<Repo>;
  /** the checkout `cwd` is in, or null */
  root(cwd: string): Promise<string | null>;
  source(cwd: string): Promise<WorktreeSource | null>;
  exists(wt: Worktree): Promise<boolean>;
  isForeign(wt: Worktree): boolean;
  worktreeStatus(wt: Worktree, opts?: { merged?: string | false | null }): Promise<WorktreeStatus>;
  folderOnly(wt: Worktree): Promise<number>;
  worktreeRemove(wt: Worktree, opts?: RemoveOptions): Promise<RemoveResult>;
  /** resolves once a removal under way at that path is over */
  removing(path: string): Promise<void>;
  changes(wt: Worktree): Promise<Changes | null>;
  touched(wt: Worktree): Promise<Touched | null>;
  clash(dir: string, a: string, b: string): Promise<string[] | null>;
  commitAll(dir: string, title: string, body?: string): Promise<boolean>;
  push(wt: Worktree): Promise<void>;
  conflictsWithBase(wt: Worktree): Promise<boolean | null>;
  baseMerged(wt: Worktree): Promise<{ ok: true } | { ok: false; why: string }>;
  syncBase(root: string, base: string): Promise<{ ok: boolean; text: string }>;
  deleteRemoteBranch(wt: Worktree): Promise<void>;
  /** Changes with what's staged: each file's staged/unstaged and, per hunk, the same (v1 stage.js) */
  stageState(dir: string, changes: Changes | null): Promise<StagedChanges | null>;
  /** a file (and a rename's old name) into the index or out; false when git had nothing there */
  stageFile(dir: string, paths: readonly (string | undefined)[], opts?: { unstage?: boolean }): Promise<boolean>;
  /** hunk i of Changes' file into the index or out; false when there's nothing there to move */
  stageHunk(dir: string, file: DiffFile, i: number, opts?: { unstage?: boolean }): Promise<boolean>;
  /** a commit of what's staged (all: everything first): its short sha, or null when nothing was */
  commitStaged(dir: string, message: string, opts?: { all?: boolean }): Promise<string | null>;
  restore(dir: string, source: string, path: string): Promise<void>;
  pack(dir: string, wt: Worktree | null, file: string): Promise<PackInfo | null>;
  unpack(o: { cwd: string; home: string; id: string; title: string; pack: PackInfo; file: string }): Promise<Worktree>;
  fork(o: { dir: string; wt: Worktree | null; at?: { commit: string; head: string; dirty: boolean } | null; home: string; id: string; title: string }): Promise<Worktree | null>;
  workPatch(dir: string, base: string): Promise<string>;
  applyPatch(dir: string, patch: string): Promise<ApplyResult>;
  clone(url: string, parent: string, opts?: { timeoutMs?: number }): Promise<{ dir: string; existed: boolean }>;
  prView(cwd: string, ref: string | number): Promise<PrSummary>;
  prDetail(cwd: string, ref: string | number): Promise<PrDetail>;
  prCreate(cwd: string, o: { base: string; head: string; title: string; body: string; draft?: boolean }): Promise<string>;
  prReady(cwd: string, ref: string | number): Promise<void>;
  prMerge(cwd: string, ref: string | number, head: string): Promise<void>;
  issues(repo: string, q?: string, limit?: number): Promise<GitIssue[]>;
  runLog(cwd: string, repo: string, job: string): Promise<string>;
  tools(platform?: string): Promise<ToolsStatus>;
}

/** git.service@1. Reads are `git:read`; anything that writes a repo names what it does. */
export const gitService = {
  id: 'git.service',
  major: 1,
  permissions: {
    repo: 'git:read',
    root: 'git:read',
    source: 'git:read',
    exists: 'git:read',
    isForeign: 'git:read',
    worktreeStatus: 'git:read',
    folderOnly: 'git:read',
    worktreeRemove: 'git:worktree.remove',
    removing: 'git:read',
    changes: 'git:read',
    touched: 'git:read',
    clash: 'git:read',
    commitAll: 'git:commit',
    push: 'git:push',
    conflictsWithBase: 'git:fetch',
    baseMerged: 'git:commit',
    syncBase: 'git:fetch',
    deleteRemoteBranch: 'git:push',
    stageState: 'git:read',
    stageFile: 'git:stage',
    stageHunk: 'git:stage',
    commitStaged: 'git:commit',
    restore: 'git:restore',
    pack: 'git:read',
    unpack: 'git:worktree.add',
    fork: 'git:worktree.add',
    workPatch: 'git:read',
    applyPatch: 'git:apply',
    clone: 'git:clone',
    prView: 'prs:read',
    prDetail: 'prs:read',
    prCreate: 'prs:create',
    prReady: 'prs:merge',
    prMerge: 'prs:merge',
    issues: 'git:issues',
    runLog: 'prs:read',
    tools: 'git:read',
  },
  readOnly: ['repo', 'root', 'exists', 'isForeign', 'worktreeStatus', 'folderOnly', 'removing', 'changes', 'touched', 'clash', 'stageState', 'prView', 'tools'],
} as const satisfies ServiceRef<GitService>;

/** The Repo handle's methods, checked by the same proxy as the service's. */
export const repoHandle = {
  id: 'git.repo',
  major: 1,
  permissions: {
    status: 'git:read',
    branches: 'git:read',
    branchExists: 'git:read',
    resolve: 'git:read',
    remoteUrl: 'git:read',
    baseRef: 'git:fetch',
    diff: 'git:read',
    diffSections: 'git:read',
    lsFiles: 'git:read',
    grep: 'git:read',
    show: 'git:read',
    pin: 'git:read',
    checkpoint: 'git:checkpoint',
    dropCheckpoints: 'git:checkpoint',
    worktreeAdd: 'git:worktree.add',
    worktreePrune: 'git:worktree.prune',
    onChange: 'git:read',
    dispose: 'git:read',
  },
  readOnly: ['status', 'branches', 'branchExists', 'resolve', 'remoteUrl', 'diff', 'diffSections', 'lsFiles', 'grep', 'show', 'pin', 'onChange', 'dispose'],
} as const satisfies ServiceRef<Repo>;

/** Open a repo whose lifetime is `scope`'s: released when the caller's plugin goes off. */
export async function repoIn(git: GitService, scope: { add(d: Disposable): void }, path: string): Promise<Repo> {
  const r = await git.repo(path);
  scope.add(r);
  return r;
}

export const EVENTS = {
  /** a worktree folder was added: { root, path } (the cleanup's cap listens) */
  worktreeAdded: 'git.worktree.added',
} as const;
