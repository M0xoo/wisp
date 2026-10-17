// Git and GitHub plumbing for worktree sessions and Ship it. Everything shells out to `git` and
// `gh`. The user's own checkout is only read, except for the fast-forward after a merge.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from './proc.js';

const GIT = () => process.env.WISP_GIT_BIN || 'git';
const GH = () => process.env.WISP_GH_BIN || 'gh';
// Never wait on a credential or confirmation prompt nobody can see.
const QUIET_ENV = { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GIT_EDITOR: 'true' };

export function run(bin, args, { cwd, timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...QUIET_ENV } }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout).trim());
      // git and gh lead with "fatal:" / "error:"; otherwise the tail is the useful part.
      const lines = String(stderr || '').trim().split('\n').filter(Boolean);
      const why = lines.find((l) => /^(fatal|error)\b/i.test(l)) || lines.slice(-3).join(' ') || err.message;
      reject(Object.assign(new Error(why), { code: err.code }));
    });
  });
}
export const git = (cwd, args, opts) => run(GIT(), args, { cwd, ...opts });
export const gh = (cwd, args, opts) => run(GH(), args, { cwd, timeout: 120_000, ...opts });
const quiet = (p) => p.catch(() => '');

export async function repoRoot(cwd) {
  const top = await quiet(git(cwd, ['rev-parse', '--show-toplevel']));
  return top ? path.resolve(top) : null;
}

// What a worktree session branches from: the remote's default branch, freshly fetched, else HEAD.
export async function baseRef(root) {
  const remotes = (await quiet(git(root, ['remote']))).split('\n');
  if (remotes.includes('origin')) {
    await quiet(git(root, ['fetch', '--quiet', 'origin'], { timeout: 20_000 })); // offline: use what we have
    const head = await quiet(git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']));
    for (const ref of [head, 'origin/main', 'origin/master']) {
      if (ref && (await quiet(git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])))) return { ref, branch: ref.replace(/^origin\//, ''), remote: 'origin' };
    }
  }
  const sha = await quiet(git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']));
  if (!sha) return null; // a repo without commits has nothing to branch from
  return { ref: sha, branch: await quiet(git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])), remote: null };
}

export const slug = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');

const realpath = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};

// A fresh worktree + branch for one session, under <home>/worktrees. Returns null outside a repo.
// Where a launch's worktrees come from: { root, base }, or null outside a repo with commits.
// Resolved once per launch, so compare runs share one fetch.
export async function worktreeSource(cwd) {
  const root = await repoRoot(cwd);
  const base = root && (await baseRef(root));
  if (!base) return null;
  base.sha = await quiet(git(root, ['rev-parse', '--verify', '--quiet', `${base.ref}^{commit}`]));
  return { root, base };
}

export async function createWorktree({ cwd, home, id, title, source }) {
  const { root, base } = source || (await worktreeSource(cwd)) || {};
  if (!base) return null;
  // Short and readable; the full id only if that name is taken (a leftover branch, a prefix clash).
  let branch = `wisp/${slug(title) || 'task'}-${id.slice(0, 6)}`;
  if (await quiet(git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]))) branch = `wisp/${slug(title) || 'task'}-${id}`;
  const dir = path.join(home, 'worktrees', `${path.basename(root)}-${id}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(root, ['worktree', 'add', '--quiet', '--no-track', '-b', branch, dir, base.ref]);
  // Launched from a subfolder of the repo: keep working in that subfolder.
  const sub = path.relative(realpath(root), realpath(cwd));
  return { path: dir, cwd: sub && !sub.startsWith('..') ? path.join(dir, sub) : dir, branch, base: base.branch, baseRef: base.ref, head: base.sha || null, remote: base.remote, root, createdAt: Date.now() };
}

// Archiving removes a clean worktree; a follow-up brings it back from its branch.
export async function ensureWorktree(wt) {
  if (!wt || fs.existsSync(wt.path)) return;
  await quiet(git(wt.root, ['worktree', 'prune']));
  await git(wt.root, ['worktree', 'add', '--quiet', wt.path, wt.branch]);
}

// { dirty: changed paths, ahead: commits past the base, unpushed: commits not on the remote branch, exists }
export async function worktreeStatus(wt) {
  if (!wt || !fs.existsSync(wt.path)) return { exists: false, dirty: 0, ahead: 0, unpushed: 0 };
  const porcelain = await quiet(git(wt.path, ['status', '--porcelain']));
  const ahead = Number(await quiet(git(wt.path, ['rev-list', '--count', `${wt.baseRef}..HEAD`]))) || 0;
  const pushed = wt.remote && `refs/remotes/${wt.remote}/${wt.branch}`;
  const tracked = pushed && (await quiet(git(wt.path, ['rev-parse', '--verify', '--quiet', pushed])));
  const unpushed = tracked ? Number(await quiet(git(wt.path, ['rev-list', '--count', `${pushed}..HEAD`]))) || 0 : ahead;
  return { exists: true, dirty: porcelain ? porcelain.split('\n').length : 0, ahead, unpushed };
}

// force: drop uncommitted work too. The branch goes only when nothing would be lost with it.
export async function removeWorktree(wt, { force = false, branch = false } = {}) {
  if (!wt) return { removed: false };
  if (fs.existsSync(wt.path)) {
    const st = await worktreeStatus(wt);
    if (st.dirty && !force) return { removed: false, dirty: st.dirty };
    await quiet(git(wt.root, ['worktree', 'remove', '--force', wt.path]));
    fs.rmSync(wt.path, { recursive: true, force: true });
    await quiet(git(wt.root, ['worktree', 'prune']));
  }
  let branchDeleted = false;
  if (branch) {
    const unique = Number(await quiet(git(wt.root, ['rev-list', '--count', `${wt.baseRef}..${wt.branch}`]))) || 0;
    if (!unique || branch === 'force') branchDeleted = !!(await quiet(git(wt.root, ['branch', '-D', wt.branch]).then(() => 'ok')));
  }
  return { removed: true, branchDeleted };
}

// --- Ship it: commit, push, open a PR, follow it, merge it -----------------------------------

const PR_FIELDS = 'number,url,title,state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,headRefOid,baseRefName,mergedAt';
const PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAIL = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']);

export function prSummary(j) {
  const checks = { pass: 0, fail: 0, pending: 0 };
  for (const c of j.statusCheckRollup || []) {
    const v = String(c.conclusion || c.state || '').toUpperCase();
    if (PASS.has(v)) checks.pass++;
    else if (FAIL.has(v)) checks.fail++;
    else checks.pending++;
  }
  return {
    number: j.number,
    url: j.url,
    title: j.title,
    state: j.state, // OPEN | CLOSED | MERGED
    draft: !!j.isDraft,
    review: j.reviewDecision || '', // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ''
    mergeState: j.mergeStateStatus || '',
    head: j.headRefOid,
    base: j.baseRefName,
    mergedAt: j.mergedAt || null,
    checks,
    checkedAt: Date.now(),
  };
}

export async function prView(cwd, ref) {
  return prSummary(JSON.parse(await gh(cwd, ['pr', 'view', String(ref), '--json', PR_FIELDS])));
}

// Commit whatever the session left uncommitted, push its branch and open (or update) its PR.
export async function ship(wt, { title, body = '', draft = false, pr }) {
  await ensureWorktree(wt);
  const dir = wt.path;
  if (await quiet(git(dir, ['status', '--porcelain']))) {
    if (!String(title || '').trim()) throw Object.assign(new Error('A commit message is required.'), { status: 400 });
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '--quiet', '--no-verify', '-m', title.trim(), ...(body.trim() ? ['-m', body.trim()] : [])]);
  }
  const { ahead } = await worktreeStatus(wt);
  if (!ahead) throw Object.assign(new Error('Nothing to ship: this branch has no changes.'), { status: 400 });
  if (!wt.remote) throw Object.assign(new Error('This repo has no origin remote to push to.'), { status: 400 });
  await git(dir, ['push', '--quiet', '-u', wt.remote, `HEAD:refs/heads/${wt.branch}`], { timeout: 120_000 });
  if (pr?.state === 'OPEN') return prView(dir, pr.number);
  const url = (await gh(dir, ['pr', 'create', '--base', wt.base, '--head', wt.branch, '--title', title.trim(), '--body', body.trim() || ' ', ...(draft ? ['--draft'] : [])])).split('\n').pop();
  return prView(dir, url);
}

// Squash-merge the exact head that was reviewed, then tidy up and catch the user's checkout up.
export async function merge(wt, number) {
  const dir = fs.existsSync(wt.path) ? wt.path : wt.root;
  let pr = await prView(dir, number);
  if (pr.state !== 'OPEN') throw Object.assign(new Error(`PR #${number} is ${pr.state.toLowerCase()}.`), { status: 400 });
  if (pr.draft) await gh(dir, ['pr', 'ready', String(number)]);
  await gh(dir, ['pr', 'merge', String(number), '--squash', '--match-head-commit', pr.head]);
  pr = await prView(dir, number);
  const sync = await syncBase(wt.root, wt.base);
  await removeWorktree(wt, { force: true, branch: 'force' });
  await quiet(git(wt.root, ['push', '--quiet', wt.remote || 'origin', '--delete', wt.branch]));
  return { pr, sync };
}

// Fast-forward the user's base branch to the remote, never anything more invasive.
export async function syncBase(root, base) {
  try {
    await git(root, ['fetch', '--quiet', 'origin']);
    const current = await quiet(git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']));
    if (current === base) await git(root, ['merge', '--ff-only', '--quiet', `origin/${base}`]);
    else await git(root, ['fetch', '--quiet', 'origin', `${base}:${base}`]); // not checked out: move the ref (ff only)
    return { ok: true, text: `Local ${base} is up to date with origin/${base}.` };
  } catch (err) {
    return { ok: false, text: `Local ${base} was not updated: ${err.message}` };
  }
}
