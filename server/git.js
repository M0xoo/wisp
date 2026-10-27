// Git and GitHub plumbing for worktree sessions and Ship it. Everything shells out to `git` and
// `gh`. The user's own checkout is only read, except for the fast-forward after a merge.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { execFile } from './proc.js';
import { bad } from './util.js';

const GIT = () => process.env.WISP_GIT_BIN || 'git';
const GH = () => process.env.WISP_GH_BIN || 'gh';
// Never wait on a credential or confirmation prompt nobody can see. No optional locks: a `git status`
// polled for a card would otherwise take index.lock to refresh the index, and Ship it's `git add`
// in the same worktree fails with "index.lock: File exists".
const QUIET_ENV = { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GIT_EDITOR: 'true', GIT_OPTIONAL_LOCKS: '0' };

export function run(bin, args, { cwd, timeout = 60_000, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...QUIET_ENV, ...env } }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout).trim());
      // git and gh lead with "fatal:" / "error:"; otherwise the tail is the useful part.
      const lines = String(stderr || '').trim().split('\n').filter(Boolean);
      const why = lines.find((l) => /^(fatal|error)\b/i.test(l)) || lines.slice(-3).join(' ') || err.message;
      reject(Object.assign(new Error(why), { code: err.code }));
    });
  });
}
export const git = (cwd, args, opts) => run(GIT(), args, { cwd, ...opts });
// Synchronous, for the few places that must not yield (checkpoints taken right before a turn
// starts, file snapshots while a harness streams). Returns a Buffer; throws on failure.
export const gitSync = (cwd, args, opts = {}) => execFileSync(GIT(), args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, env: { ...process.env, ...QUIET_ENV }, ...opts });
export const gh = (cwd, args, opts) => run(GH(), args, { cwd, timeout: 120_000, ...opts });
const quiet = (p) => p.catch(() => '');

// `git worktree add` reads every other worktree's files under .git/worktrees; two at once in one
// repo can catch the other half-made ("failed to read .git/worktrees/…/commondir", on Windows).
// So adds into the same repo take turns.
const adding = new Map(); // repo -> the last add queued there
export function addWorktree(root, args) {
  const key = realpath(root);
  const next = (adding.get(key) || Promise.resolve()).catch(() => {}).then(() => git(root, ['worktree', 'add', '--quiet', ...args]));
  adding.set(key, next);
  const clear = () => adding.get(key) === next && adding.delete(key);
  next.then(clear, clear);
  return next;
}

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
// git prints C:/Users/runneradmin/…, the folder may be C:\Users\RUNNER~1\…: same folder.
const samePath = (a, b) => !!a && (process.platform === 'win32' ? realpath(a).toLowerCase() === realpath(b).toLowerCase() : realpath(a) === realpath(b));

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
  await addWorktree(root, ['--no-track', '-b', branch, dir, base.ref]);
  // Launched from a subfolder of the repo: keep working in that subfolder.
  const sub = path.relative(realpath(root), realpath(cwd));
  return { path: dir, cwd: sub && !sub.startsWith('..') ? path.join(dir, sub) : dir, branch, base: base.branch, baseRef: base.ref, head: base.sha || null, remote: base.remote, root, createdAt: Date.now() };
}

// Archiving removes a clean worktree; a follow-up brings it back from its branch.
export async function ensureWorktree(wt) {
  if (!wt || fs.existsSync(wt.path)) return;
  await quiet(git(wt.root, ['worktree', 'prune']));
  await addWorktree(wt.root, [wt.path, wt.branch]);
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

const PR_FIELDS = 'number,url,title,state,isDraft,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,headRefOid,baseRefName,mergedAt';
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
    // GitHub can't merge it into its base: both sides changed the same lines (UNKNOWN while it computes).
    conflict: j.mergeable === 'CONFLICTING' || j.mergeStateStatus === 'DIRTY',
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
// `onStep` hears each stage as it starts ('commit', 'push', 'pr'), so the card can follow along.
export async function ship(wt, { title, body = '', draft = false, pr, onStep = () => {} }) {
  await ensureWorktree(wt);
  const dir = wt.path;
  if (await quiet(git(dir, ['status', '--porcelain']))) {
    if (!String(title || '').trim()) throw bad('A commit message is required.');
    onStep('commit');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '--quiet', '--no-verify', '-m', title.trim(), ...(body.trim() ? ['-m', body.trim()] : [])]);
  }
  const { ahead } = await worktreeStatus(wt);
  if (!ahead) throw bad('Nothing to ship: this branch has no changes.');
  if (!wt.remote) throw bad('This repo has no origin remote to push to.');
  onStep('push');
  await git(dir, ['push', '--quiet', '-u', wt.remote, `HEAD:refs/heads/${wt.branch}`], { timeout: 120_000 });
  onStep('pr');
  if (pr?.state === 'OPEN') return prView(dir, pr.number);
  const url = (await gh(dir, ['pr', 'create', '--base', wt.base, '--head', wt.branch, '--title', title.trim(), '--body', body.trim() || ' ', ...(draft ? ['--draft'] : [])])).split('\n').pop();
  return prView(dir, url);
}

// Does the branch really conflict with its freshly fetched base? Checked before spending an agent
// run on GitHub's word, which can lag a push. true / false, or null when this git can't tell (< 2.38).
export async function conflictsWithBase(wt) {
  if (!wt?.remote || !fs.existsSync(wt.path)) return null;
  await quiet(git(wt.path, ['fetch', '--quiet', wt.remote, wt.base], { timeout: 30_000 }));
  return new Promise((resolve) => {
    execFile(GIT(), ['merge-tree', '--write-tree', '--name-only', '--no-messages', `refs/remotes/${wt.remote}/${wt.base}`, 'HEAD'], { cwd: wt.path, timeout: 30_000, env: { ...process.env, ...QUIET_ENV } }, (err) =>
      resolve(!err ? false : err.code === 1 ? true : null),
    );
  });
}

// What a task has changed so far: files changed on its branch since it left the base, plus
// uncommitted edits and new files. head is a commit of the work as it stands (`git stash create`
// when there are uncommitted edits, so a merge-tree sees them; HEAD otherwise). null when it can't tell.
export async function touchedFiles(wt) {
  if (!wt || !fs.existsSync(wt.path)) return null;
  const dir = wt.path;
  // Read-only, and without refreshing the index, so an agent's own git in that worktree never
  // finds it locked. One after another for the same reason.
  const read = (...args) => quiet(git(dir, ['--no-optional-locks', ...args]));
  const base = await read('merge-base', 'HEAD', wt.remote ? `refs/remotes/${wt.remote}/${wt.base}` : wt.base);
  if (!base) return null;
  const lines = (out) => (out ? out.split('\n').filter(Boolean) : []);
  const committed = lines(await read('diff', '--name-only', base, 'HEAD'));
  const edited = lines(await read('diff', '--name-only', 'HEAD'));
  const added = lines(await read('ls-files', '--others', '--exclude-standard'));
  const head = (await read('stash', 'create')) || (await read('rev-parse', 'HEAD'));
  return { files: [...new Set([...committed, ...edited, ...added])].sort(), head, base };
}

// Would merging two tasks' work conflict? Their heads (from touchedFiles) share the repo's objects,
// so this runs in either worktree without touching it. The conflicted files ([] when it merges
// cleanly), or null when this git can't tell (< 2.38).
export function clashFiles(dir, a, b) {
  return new Promise((resolve) => {
    execFile(GIT(), ['merge-tree', '--write-tree', '--name-only', '--no-messages', a, b], { cwd: dir, timeout: 30_000, env: { ...process.env, ...QUIET_ENV } }, (err, stdout) => {
      if (!err) return resolve([]);
      // Exit 1: the merged tree's id, then one conflicted path per line.
      resolve(err.code === 1 ? [...new Set(String(stdout).trim().split('\n').slice(1).filter(Boolean))] : null);
    });
  });
}

// After an agent was asked to merge the base into its branch: is it in, with nothing left half
// done? A merge it resolved but left uncommitted is committed here. { ok } or { ok: false, why }.
export async function baseMerged(wt) {
  const dir = wt.path;
  const unmerged = await quiet(git(dir, ['diff', '--name-only', '--diff-filter=U']));
  if (unmerged) return { ok: false, why: `Still conflicted: ${unmerged.split('\n').join(', ')}` };
  if (await quiet(git(dir, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']))) {
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '--quiet', '--no-verify', '--no-edit']);
  }
  const base = `refs/remotes/${wt.remote}/${wt.base}`;
  const merged = await git(dir, ['merge-base', '--is-ancestor', base, 'HEAD']).then(() => true, () => false);
  if (!merged) return { ok: false, why: `${wt.remote}/${wt.base} is not merged into the branch.` };
  // Conflict markers staged as if resolved: git no longer sees them, so look in the PR's diff.
  const marked = await quiet(git(dir, ['diff', '--name-only', '-G^<<<<<<< ', `${base}...HEAD`]));
  if (marked) return { ok: false, why: `Conflict markers left in ${marked.split('\n').join(', ')}` };
  return { ok: true };
}

// Squash-merge the exact head that was reviewed, then tidy up and catch the user's checkout up.
export async function merge(wt, number) {
  const dir = fs.existsSync(wt.path) ? wt.path : wt.root;
  let pr = await prView(dir, number);
  if (pr.state !== 'OPEN') throw bad(`PR #${number} is ${pr.state.toLowerCase()}.`);
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

// --- cloning: "add a project" from a repo URL instead of a folder ---

// A repo the user pasted: https://github.com/o/r(/tree/…), github.com/o/r, git@host:o/r.git,
// ssh:// git:// file:// URLs, and (shorthand) o/r for GitHub. Null when it's not a repo, e.g. a path.
export function parseRepo(input, { shorthand = false } = {}) {
  const s = String(input || '').trim();
  const strip = (p) => p.replace(/\/+$/, '').replace(/\.git$/i, '');
  const of = (url, host, repoPath) => {
    const parts = strip(repoPath).split('/').filter(Boolean);
    if (!parts.length) return null;
    const gh = host === 'github.com' && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
    return { url, host, name: gh ? parts[1] : parts.at(-1), gh, path: parts.join('/') };
  };
  let m;
  if (/^(https?|ssh|git|file):\/\//i.test(s) || /^(www\.)?github\.com\//i.test(s)) {
    let u;
    try {
      u = new URL(/^\w+:\/\//.test(s) ? s : `https://${s}`);
    } catch {
      return null;
    }
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (u.protocol === 'file:') return of(u.href, '', u.pathname);
    if (!host) return null;
    // A GitHub page inside the repo (/tree/main, /pull/3) still means the repo.
    if (host === 'github.com') {
      const [o, r] = u.pathname.split('/').filter(Boolean);
      return o && r ? of(`https://github.com/${o}/${strip(r)}.git`, host, `${o}/${r}`) : null;
    }
    return u.pathname.split('/').filter(Boolean).length >= 2 || u.protocol !== 'https:' ? of(s, host, u.pathname) : null;
  }
  if ((m = s.match(/^[\w.-]+@([\w.-]+):(?!\/\/)(.+)$/))) return of(s, m[1].toLowerCase(), m[2]);
  if (shorthand && (m = s.match(/^([\w-]+)\/([\w.-]+)$/))) return of(`https://github.com/${m[1]}/${strip(m[2])}.git`, 'github.com', `${m[1]}/${m[2]}`);
  return null;
}

// parseRepo, plus a plain path to a repo on disk (an origin can be one).
export const repoOf = (u) => parseRepo(u) || (path.isAbsolute(String(u || '')) ? parseRepo(pathToFileURL(String(u)).href) : null);

// The same repo, however it was spelled (https vs ssh, .git or not, case of the host).
export const sameRepo = (a, b) => {
  const key = (u) => {
    const r = repoOf(u);
    return r && (r.gh ? `github.com/${r.gh.toLowerCase()}` : `${r.host}/${r.path}`);
  };
  return !!key(a) && key(a) === key(b);
};

// Clone `repo` (from parseRepo) into `parent`/<name>. A folder there that already is this repo is
// reused; any other one gets a -2, -3… suffix. GitHub repos go through `gh repo clone` when gh is
// there, so private repos work with the user's gh login; otherwise (or if gh fails) plain git.
export async function cloneRepo(repo, parent, { timeout = 10 * 60_000 } = {}) {
  fs.mkdirSync(parent, { recursive: true });
  let dir = path.join(parent, repo.name);
  for (let n = 2; fs.existsSync(dir); n++) {
    const origin = await quiet(git(dir, ['remote', 'get-url', 'origin']));
    if (origin && samePath(await repoRoot(dir), dir) && sameRepo(origin, repo.url)) return { dir, existed: true };
    dir = path.join(parent, `${repo.name}-${n}`);
  }
  const attempts = [];
  if (repo.gh) attempts.push(() => gh(parent, ['repo', 'clone', repo.gh, dir], { timeout }));
  attempts.push(() => run(GIT(), ['clone', '--quiet', repo.url, dir], { cwd: parent, timeout }));
  let last;
  for (const attempt of attempts) {
    try {
      await attempt();
      return { dir, existed: false };
    } catch (err) {
      last = err;
      fs.rmSync(dir, { recursive: true, force: true }); // a half clone would block the next try
    }
  }
  const what = repo.gh || repo.url;
  if (/not found|does not exist|could not read username|authentication|permission denied|403/i.test(last.message))
    throw bad(`Couldn’t clone ${what}: it doesn’t exist, or this login can’t see it.${repo.gh ? ' Private repo? Check `gh auth status`.' : ''}`);
  throw bad(`Couldn’t clone ${what}: ${last.message}`);
}

// --- moving a task to another place: its work travels as a git bundle ---

// Who the snapshot commit is by, so packing works where git has no user.name.
const MOVER = { GIT_AUTHOR_NAME: 'wisp', GIT_AUTHOR_EMAIL: 'wisp@localhost', GIT_COMMITTER_NAME: 'wisp', GIT_COMMITTER_EMAIL: 'wisp@localhost' };

// Pack the work in `dir` into `file`: the branch's commits plus one snapshot commit on top that
// holds what isn't committed (untracked files too, ignored ones not). The user's index and
// working tree are only read. Commits the remote already has (from wt.head down) stay out.
// Resolves the pack's description for unpackWork(), or null outside a repo with commits.
export async function packWork(dir, wt, file) {
  const root = await repoRoot(dir);
  const head = root && (await quiet(git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])));
  if (!head) return null;
  const index = `${file}.index`;
  const env = { ...MOVER, GIT_INDEX_FILE: index };
  const ref = `refs/wisp/move/${path.basename(file).replace(/\W+/g, '-')}`;
  try {
    await git(root, ['read-tree', 'HEAD'], { env });
    await git(root, ['add', '-A'], { env, timeout: 120_000 });
    const tree = await git(root, ['write-tree'], { env });
    const snap = await git(root, ['commit-tree', tree, '-p', head, '-m', 'wisp: work in progress, moved'], { env });
    await git(root, ['update-ref', ref, snap]);
    const published = wt?.head && (await quiet(git(root, ['branch', '-r', '--contains', wt.head])));
    await git(root, ['bundle', 'create', file, ref, ...(published ? [`^${wt.head}`] : [])], { timeout: 300_000 });
    const branch = wt?.branch || '';
    return { ref, branch, base: wt?.base || '', baseRef: wt?.baseRef || '', head: wt?.head || null, remote: wt?.remote ?? null, prereq: !!published };
  } finally {
    fs.rmSync(index, { force: true });
    await quiet(git(root, ['update-ref', '-d', ref]));
  }
}

// Unpack a packWork() bundle into a new worktree of the repo at `cwd`, on the same branch name
// when it's free: its commits as commits, the snapshot as uncommitted changes again.
export async function unpackWork({ cwd, home, id, title, pack, file }) {
  const root = await repoRoot(cwd);
  if (!root) throw bad(`${cwd} isn’t a git repo here, so the work has nowhere to go.`);
  if (pack.prereq) await quiet(git(root, ['fetch', '--quiet', 'origin'], { timeout: 60_000 })); // the commits the bundle leaves out
  const local = `refs/wisp/moved/${id}`;
  try {
    await git(root, ['fetch', '--quiet', '--no-tags', file, `+${pack.ref}:${local}`], { timeout: 300_000 });
  } catch (err) {
    throw bad(`Couldn’t bring the work over: ${err.message}`);
  }
  const snap = await quiet(git(root, ['rev-parse', '--verify', '--quiet', `${local}^{commit}`])); // where the work stood: a delegate's patch starts here
  const taken = async (b) => !!(await quiet(git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])));
  let branch = /^[\w./-]{1,120}$/.test(pack.branch || '') && !(await taken(pack.branch)) ? pack.branch : `wisp/${slug(title) || 'task'}-${id.slice(0, 6)}`;
  if (await taken(branch)) branch = `wisp/${slug(title) || 'task'}-${id}`;
  const dir = path.join(home, 'worktrees', `${path.basename(root)}-${id}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    await addWorktree(root, ['--no-track', '-b', branch, dir, `${local}^`]);
    await git(dir, ['read-tree', '-u', '--reset', local]);
    await git(dir, ['reset', '--quiet']);
  } finally {
    await quiet(git(root, ['update-ref', '-d', local]));
  }
  // A task that ran in the folder itself (no worktree) branches from what's here.
  const base = pack.baseRef ? null : await baseRef(root);
  const sub = path.relative(realpath(root), realpath(cwd));
  return {
    path: dir,
    cwd: sub && !sub.startsWith('..') ? path.join(dir, sub) : dir,
    branch,
    base: pack.base || base?.branch || '',
    baseRef: pack.baseRef || base?.ref || '',
    head: pack.head || (await quiet(git(dir, ['rev-parse', 'HEAD']))) || null,
    remote: pack.baseRef ? pack.remote : base?.remote || null,
    root,
    ...(snap && { snap }),
    createdAt: Date.now(),
  };
}

// Fork a task's work (services/fork.js): a new worktree of the repo at `dir` on a fresh branch,
// with the work as it stood: at `at` (a later turn's checkpoint: { commit, head, dirty }), else as
// the folder is now, uncommitted and untracked files included. They come back uncommitted. wt: the
// task's worktree, whose base the fork keeps so it ships the same way. null outside a repo with commits.
export async function forkWork({ dir, wt, at, home, id, title }) {
  const root = await repoRoot(dir);
  const now = root && (await quiet(git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])));
  if (!now) return null;
  let head = now;
  let snap = null;
  if (at?.head) {
    head = at.head;
    snap = at.dirty && at.commit !== at.head ? at.commit : null;
    for (const c of [head, snap].filter(Boolean)) if (!(await quiet(git(root, ['rev-parse', '--verify', '--quiet', `${c}^{commit}`])))) throw bad('The work at that turn is gone from git, so it can’t be forked from there.');
  } else {
    // The folder now, as a commit on top of HEAD that no branch points at (like packWork's).
    const index = path.join(os.tmpdir(), `wisp-fork-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    const env = { ...MOVER, GIT_INDEX_FILE: index };
    try {
      await git(root, ['read-tree', 'HEAD'], { env });
      await git(root, ['add', '-A'], { env, timeout: 120_000 });
      const tree = await git(root, ['write-tree'], { env });
      if (tree !== (await git(root, ['rev-parse', 'HEAD^{tree}']))) snap = await git(root, ['commit-tree', tree, '-p', head, '-m', 'wisp: work in progress, forked'], { env });
    } finally {
      fs.rmSync(index, { force: true });
    }
  }
  let branch = `wisp/${slug(title) || 'task'}-${id.slice(0, 6)}`;
  if (await quiet(git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]))) branch = `wisp/${slug(title) || 'task'}-${id}`;
  const repo = wt?.root || root; // the main checkout: a task's worktree may go before its fork's
  const wtDir = path.join(home, 'worktrees', `${path.basename(repo)}-${id}`);
  fs.mkdirSync(path.dirname(wtDir), { recursive: true });
  await addWorktree(repo, ['--no-track', '-b', branch, wtDir, head]);
  if (snap) {
    await git(wtDir, ['read-tree', '-u', '--reset', snap]);
    await git(wtDir, ['reset', '--quiet']);
  }
  // A task that ran in the folder itself (no worktree) ships against what the folder branches from.
  const base = wt?.baseRef ? null : await baseRef(root);
  const sub = path.relative(realpath(root), realpath(dir));
  return {
    path: wtDir,
    cwd: sub && !sub.startsWith('..') ? path.join(wtDir, sub) : wtDir,
    branch,
    base: wt?.base || base?.branch || '',
    baseRef: wt?.baseRef || base?.ref || '',
    head: wt?.head || head,
    remote: wt?.baseRef ? (wt.remote ?? null) : base?.remote || null,
    root: repo,
    createdAt: Date.now(),
  };
}

// A delegate on another machine (services/relay.js): what it changed since `base` (the snapshot it
// started from) as a binary patch, from the repo root, untracked files included. '' if nothing.
export async function workPatch(dir, base) {
  const root = await repoRoot(dir);
  if (!root || !base) return '';
  const index = path.join(os.tmpdir(), `wisp-patch-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const env = { ...MOVER, GIT_INDEX_FILE: index };
  try {
    await git(root, ['read-tree', 'HEAD'], { env });
    await git(root, ['add', '-A'], { env, timeout: 120_000 });
    const tree = await git(root, ['write-tree'], { env });
    const out = await git(root, ['diff', '--binary', '--no-color', '--no-ext-diff', '--full-index', base, tree], { timeout: 120_000 });
    return out ? `${out}\n` : ''; // run() trims, and git apply wants the last newline
  } finally {
    fs.rmSync(index, { force: true });
  }
}

// That patch, applied to the lead's folder: as it is, else with a three-way merge against the
// blobs it came from (they're the lead's own). conflicts: files left with conflict markers.
export async function applyPatch(dir, patch) {
  if (!String(patch || '').trim()) return { applied: false, empty: true };
  const root = await repoRoot(dir);
  if (!root) return { applied: false, error: `${dir} isn’t a git repo, so the changes had nowhere to go.` };
  const file = path.join(os.tmpdir(), `wisp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.patch`);
  fs.writeFileSync(file, patch);
  try {
    try {
      await git(root, ['apply', '--binary', '--whitespace=nowarn', file], { timeout: 120_000 });
      return { applied: true };
    } catch {}
    try {
      await git(root, ['apply', '--binary', '--3way', '--whitespace=nowarn', file], { timeout: 120_000 });
      return { applied: true, merged: true };
    } catch (err) {
      const conflicts = (await quiet(git(root, ['diff', '--name-only', '--diff-filter=U']))).split('\n').filter(Boolean);
      return conflicts.length ? { applied: true, conflicts } : { applied: false, error: err.message };
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// What Ship it needs on this computer: git (worktrees, commits) and gh signed in to GitHub (push,
// pull requests). For the pinned tips and Settings → Agents, with how to get what's missing on this
// OS. gh: signedIn is null when its answer isn't one we know (offline, say), so nothing nags.
const TOOL_SETUP = {
  git: {
    darwin: { tip: 'Install Apple’s command line tools: they include git', command: 'xcode-select --install', url: 'https://git-scm.com/downloads/mac' },
    win32: { tip: 'Install Git for Windows, then restart wisp', command: 'winget install --id Git.Git -e --source winget', url: 'https://git-scm.com/downloads/win' },
    linux: { tip: 'Install git with your package manager (apt, dnf, pacman…)', command: 'sudo apt install -y git', url: 'https://git-scm.com/downloads/linux' },
  },
  gh: {
    darwin: { tip: 'Install the GitHub CLI, then sign in here', command: 'brew install gh', url: 'https://cli.github.com' },
    win32: { tip: 'Install the GitHub CLI, then restart wisp and sign in here', command: 'winget install --id GitHub.cli -e --source winget', url: 'https://cli.github.com' },
    linux: { tip: 'Install the GitHub CLI with your package manager, then sign in here', command: 'sudo apt install -y gh', url: 'https://github.com/cli/cli/blob/trunk/docs/install_linux.md' },
  },
};
export const toolSetup = (id, platform = process.platform) => TOOL_SETUP[id][platform] || TOOL_SETUP[id].linux;

function probe(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 8000, env: { ...process.env, ...QUIET_ENV } }, (err, stdout, stderr) => resolve({ missing: err?.code === 'ENOENT', ok: !err, out: `${stdout}${stderr}` }));
  });
}

export async function tools(platform = process.platform) {
  const [g, h] = await Promise.all([probe(GIT(), ['--version']), probe(GH(), ['auth', 'status', '--hostname', 'github.com'])]);
  // macOS ships a git that only offers to install the command line tools: it fails, not ENOENT.
  const gitOk = g.ok && /git version/.test(g.out);
  const signedIn = h.missing ? null : h.ok ? true : /not logged in|no longer valid|invalid|gh auth login/i.test(h.out) ? false : null;
  return {
    git: { installed: gitOk, ...(!gitOk && { setup: toolSetup('git', platform) }) },
    gh: { installed: !h.missing, signedIn, ...(h.missing && { setup: toolSetup('gh', platform) }) },
  };
}
