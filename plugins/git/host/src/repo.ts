// The Repo handle: one checkout, opened once per folder and shared by everyone who asks for it
// (worktrees, ship, the panel, the runtime's checkpoints). Refcounted: each repo() is one reference,
// each dispose() gives it back, and the last one stops the handle's watcher.

import fs from 'node:fs';
import path from 'node:path';
import type { BaseRef, BlobRef, Branch, Checkpoint, DiffSections, Repo, RepoChange, Status } from '@wisp-plugin/git-api';
import type { Disposable, Scope } from '@wisp/kernel';
import { diffSections, rawDiff } from './changes.ts';
import { type Tools, quiet } from './exec.ts';
import type { Adds, Sources } from './worktree.ts';

export interface BlobPut {
  put(data: Uint8Array | string): { hash: string; size: number } | Promise<{ hash: string; size: number }>;
}

export interface RepoDeps {
  t: Tools;
  adds: Adds;
  sources: Sources;
  blob: () => BlobPut;
  now: () => number;
  /** the git plugin's scope: each watched repo's watchers and timers live in a child of it */
  scope: Scope;
}

const UNTRACKED_KEPT = 500;
const DEBOUNCE_MS = 50;

/** porcelain v1 -z with --branch: "## main...origin/main", then "XY path\0" (renames: "XY new\0old\0"). */
export function parseStatus(out: string): Pick<Status, 'branch' | 'files'> {
  const parts = out.split('\0');
  let branch = '';
  const files: Status['files'] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? '';
    if (!p) continue;
    if (p.startsWith('## ')) {
      const head = p.slice(3);
      branch = head.startsWith('HEAD (no branch)') ? '' : (head.split('...')[0] ?? '').replace(/^No commits yet on /, '');
      continue;
    }
    const x = p[0] ?? ' ';
    const y = p[1] ?? ' ';
    const f: Status['files'][number] = { x, y, path: p.slice(3) };
    if (x === 'R' || x === 'C') {
      const from = parts[++i];
      if (from) f.from = from;
    }
    files.push(f);
  }
  return { branch, files };
}

export class RepoImpl {
  readonly root: string;
  refs = 0;
  readonly #d: RepoDeps;
  readonly #subs = new Set<(e: RepoChange) => void>();
  #watching: Scope | null = null;
  readonly #pending = new Set<RepoChange['kind']>();
  readonly #onIdle: () => void;

  constructor(root: string, d: RepoDeps, onIdle: () => void) {
    this.root = root;
    this.#d = d;
    this.#onIdle = onIdle;
  }

  #git(args: readonly string[], o: { timeoutMs?: number; raw?: boolean } = {}): Promise<string> {
    return this.#d.t.git(this.root, args, o);
  }

  /** A handle on this repo: one reference until disposed. */
  handle(): Repo {
    this.refs++;
    let open = true;
    const self = this;
    return {
      root: this.root,
      status: () => this.status(),
      branches: () => this.branches(),
      branchExists: async (name) => !!(await quiet(this.#git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]))),
      resolve: async (rev) => (await quiet(this.#git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]))) || null,
      remoteUrl: (remote = 'origin') => quiet(this.#git(['remote', 'get-url', remote], { timeoutMs: 10_000 })),
      baseRef: (): Promise<BaseRef | null> => this.#d.sources.baseRef(this.root),
      diff: (base, opts = {}) => this.diff(base, !!opts.mergeBase),
      diffSections: (base): Promise<DiffSections> => diffSections(this.#d.t, this.root, base),
      lsFiles: (opts = {}) => this.lsFiles(opts),
      grep: (args) => this.#d.t.gitResult(this.root, ['grep', ...args], { timeoutMs: 15_000 }).then((r) => (r.code === 0 ? r.stdout : r.code === 1 ? '' : null)),
      show: (rev, file, max) => this.show(rev, file, max),
      pin: async () => (await quiet(this.#git(['stash', 'create']))) || (await quiet(this.#git(['rev-parse', '--verify', 'HEAD']))) || null,
      checkpoint: (sid, tid) => this.checkpoint(sid, tid),
      dropCheckpoints: (sid) => this.dropCheckpoints(sid),
      worktreeAdd: async (o) => {
        const args = o.newBranch === false ? [o.at, o.branch] : ['--no-track', '-b', o.branch, o.at, ...(o.from ? [o.from] : [])];
        await this.#d.adds.add(this.root, args, o.at);
      },
      worktreePrune: async () => void (await quiet(this.#git(['worktree', 'prune'], { timeoutMs: 60_000 }))),
      onChange: (cb) => this.subscribe(cb),
      dispose() {
        if (!open) return;
        open = false;
        self.refs--;
        if (self.refs <= 0) self.#onIdle();
      },
    };
  }

  async status(): Promise<Status> {
    const [out, head] = await Promise.all([quiet(this.#git(['--no-optional-locks', 'status', '--porcelain=v1', '--branch', '-z'], { raw: true })), quiet(this.#git(['rev-parse', '--verify', '--quiet', 'HEAD']))]);
    const { branch, files } = parseStatus(out);
    return { branch, head: head || null, files, dirty: files.length };
  }

  async branches(): Promise<Branch[]> {
    const out = await quiet(this.#git(['for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(upstream:short)%00%(HEAD)', 'refs/heads']));
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name = '', sha = '', upstream = '', head = ''] = l.split('\0');
        return { name, sha, upstream, current: head === '*' };
      });
  }

  async diff(base: string, mergeBase: boolean): Promise<BlobRef> {
    const text = await rawDiff(this.#d.t, this.root, base, mergeBase);
    const info = await this.#d.blob().put(text);
    return { hash: info.hash, size: info.size };
  }

  async lsFiles(o: { others?: boolean; ignored?: boolean; directory?: boolean; cached?: boolean }): Promise<string[] | null> {
    const args = ['ls-files', ...(o.cached ? ['--cached'] : []), ...(o.others ? ['--others'] : []), ...(o.ignored ? ['--ignored'] : []), '--exclude-standard', ...(o.directory ? ['--directory'] : []), '-z'];
    const out = await this.#git(args, { timeoutMs: 30_000, raw: true }).catch(() => null);
    return out === null ? null : [...new Set(out.split('\0').filter(Boolean))];
  }

  /** A file at a commit; '' when it's bigger than maxBytes, null when it isn't there. git wants / even on Windows. */
  async show(rev: string, file: string, max = 4 * 1024 * 1024): Promise<string | null> {
    const out = await this.#git(['show', `${rev}:./${file.split(path.sep).join('/')}`], { raw: true }).catch(() => null);
    if (out === null) return null;
    return Buffer.byteLength(out) <= max ? out : '';
  }

  /**
   * Snapshot the working tree before a turn: `git stash create` writes a commit of tracked changes
   * without touching HEAD, the index or the stash; clean, HEAD is the snapshot. Pinned under
   * refs/wisp/checkpoints/<session>/<turn> so gc keeps it. v1 did this with six execFileSync calls.
   */
  async checkpoint(sessionId?: string, turnId?: string): Promise<Checkpoint | null> {
    const g = (args: string[]): Promise<string | null> => this.#git(args).catch(() => null);
    const head = await g(['rev-parse', '--verify', 'HEAD']);
    if (!head) return null;
    const stash = await g(['stash', 'create']);
    const commit = stash || head;
    if (sessionId && turnId) await g(['update-ref', `refs/wisp/checkpoints/${sessionId}/${turnId}`, commit]);
    const [branch, untrackedRaw] = await Promise.all([g(['symbolic-ref', '--quiet', '--short', 'HEAD']), g(['ls-files', '--others', '--exclude-standard'])]);
    const listed = untrackedRaw ? untrackedRaw.split('\n').filter(Boolean) : [];
    return {
      commit,
      head,
      dirty: !!stash,
      branch: branch ?? '',
      untracked: listed.slice(0, UNTRACKED_KEPT),
      // A list that failed or was cut can't tell what's new from what was already there.
      ...((untrackedRaw === null || listed.length > UNTRACKED_KEPT) && { untrackedCut: true as const }),
      at: this.#d.now(),
    };
  }

  async dropCheckpoints(sessionId: string): Promise<void> {
    const refs = await quiet(this.#git(['for-each-ref', '--format=%(refname)', `refs/wisp/checkpoints/${sessionId}/`]));
    for (const ref of refs.split('\n').filter(Boolean)) await quiet(this.#git(['update-ref', '-d', ref]));
  }

  subscribe(cb: (e: RepoChange) => void): Disposable {
    this.#subs.add(cb);
    if (this.#subs.size === 1 && !this.#watching) {
      this.#watching = this.#d.scope.child(`watch:${this.root}`);
      void this.#watch(this.#watching);
    }
    return {
      dispose: () => {
        this.#subs.delete(cb);
        if (!this.#subs.size) this.#unwatch();
      },
    };
  }

  // HEAD and the index live in the worktree's own git dir; refs in the common one.
  async #watch(scope: Scope): Promise<void> {
    const out = await quiet(this.#git(['rev-parse', '--absolute-git-dir', '--git-common-dir']));
    const [gitDir, common = gitDir] = out.split('\n').map((p) => path.resolve(this.root, p));
    if (!gitDir || !scope.alive) return;
    const watch = (dir: string, kindOf: (f: string) => RepoChange['kind'] | null, recursive = false): void => {
      try {
        const w = fs.watch(dir, { persistent: false, recursive }, (_e, f) => {
          const kind = kindOf(String(f ?? ''));
          if (kind) this.#fire(kind);
        });
        w.on('error', () => w.close());
        scope.add(() => w.close());
      } catch {} // gone, or a platform without it: no events, nothing breaks
    };
    watch(gitDir, (f) => (f === 'HEAD' || f === 'ORIG_HEAD' || f === 'MERGE_HEAD' ? 'head' : f === 'index' ? 'index' : null));
    if (common) {
      watch(path.join(common, 'refs'), () => 'refs', true);
      watch(common, (f) => (f === 'packed-refs' || f === 'FETCH_HEAD' ? 'refs' : null));
    }
  }

  // A commit touches HEAD, the index and a ref within milliseconds: one event per kind.
  #fire(kind: RepoChange['kind']): void {
    const scope = this.#watching;
    if (!scope || this.#pending.has(kind)) return;
    this.#pending.add(kind);
    scope.timeout(DEBOUNCE_MS, () => {
      this.#pending.delete(kind);
      for (const cb of [...this.#subs]) cb({ root: this.root, kind });
    });
  }

  #unwatch(): void {
    this.#watching?.dispose();
    this.#watching = null;
    this.#pending.clear();
  }

  close(): void {
    this.#subs.clear();
    this.#unwatch();
  }
}
