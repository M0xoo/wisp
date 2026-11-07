// Old worktrees: what the cleanup may remove, what it never touches, and that the work comes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeRepo, tmp, until } from './helpers.js';
import { createWorktree, ensureWorktree, folderOnly } from '../server/git.js';
import { createWorktrees } from '../server/services/worktrees.js';

const DAY = 86_400_000;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// A wisp's worth of stubs around real repos and real worktrees.
function setup({ defaults = { worktreeCleanup: '7' }, config = {}, opts } = {}) {
  const home = tmp('wt-clean-');
  const repo = makeRepo();
  const sessions = new Map();
  const live = new Map();
  const store = { home, config: { defaults, ...config }, all: () => [...sessions.values()], get: (id) => sessions.get(id), saveConfig: () => {} };
  const app = { store, runner: { live, working: (s) => live.has(s.id) } };
  const add = async (id, fields = {}) => {
    const worktree = await createWorktree({ cwd: repo, home, id, title: id });
    const s = { id, title: id, cwd: repo, state: 'done', queue: [], turns: [], worktree, createdAt: 0, updatedAt: 0, ...fields };
    sessions.set(id, s);
    fs.utimesSync(worktree.path, 0, 0); // long untouched
    return s;
  };
  // The machine's free disk stays out of it: under 10 GB a real sweep takes idle folders before their days.
  const worktrees = createWorktrees(app, opts);
  return { app, add, home, repo, store, worktrees: { ...worktrees, sweep: (opts) => worktrees.sweep({ low: 0, ...opts }) } };
}
const there = (s) => fs.existsSync(s.worktree.path);
const now = () => Date.now();

test('an idle, clean worktree goes after the days set; its branch stays and a follow-up brings it back', async () => {
  const { add, repo, worktrees, store } = setup();
  const old = await add('old');
  git(old.worktree.path, 'commit', '--allow-empty', '-q', '-m', 'work');
  const tip = git(old.worktree.path, 'rev-parse', 'HEAD');
  const recent = await add('recent', { state: 'review', updatedAt: now() - 2 * DAY }); // Done would go after a day
  await worktrees.sweep();
  assert.equal(there(old), false);
  assert.equal(there(recent), true);
  assert.equal(git(repo, 'rev-parse', old.worktree.branch), tip, 'commits are on the branch');
  assert.equal(store.config.worktreeCleaned.count, 1);
  await ensureWorktree(old.worktree);
  assert.equal(git(old.worktree.path, 'rev-parse', 'HEAD'), tip);
});

test('a folder brought back for a look is not removed under the user the next hour', async () => {
  const { add, worktrees } = setup();
  const s = await add('back');
  await worktrees.sweep();
  assert.equal(there(s), false);
  await ensureWorktree(s.worktree); // Changes opened on the finished task
  await worktrees.sweep();
  assert.equal(there(s), true);
});

test('restoring brings the ignored files a new worktree gets', async () => {
  const { add, repo, worktrees } = setup();
  fs.appendFileSync(path.join(repo, '.git/info/exclude'), '.env\n');
  fs.writeFileSync(path.join(repo, '.env'), 'A=1\n');
  const s = await add('env');
  await worktrees.sweep();
  assert.equal(there(s), false);
  await ensureWorktree(s.worktree);
  assert.equal(fs.readFileSync(path.join(s.worktree.path, '.env'), 'utf8'), 'A=1\n');
});

test('never touched: uncommitted work, a commit off the branch, kept, For later, open PR, in use', async () => {
  const { add, app, worktrees } = setup();
  const dirty = await add('dirty');
  fs.writeFileSync(path.join(dirty.worktree.path, 'new.txt'), 'x');
  fs.utimesSync(dirty.worktree.path, 0, 0);
  const detached = await add('detached');
  git(detached.worktree.path, 'checkout', '-q', '--detach');
  git(detached.worktree.path, 'commit', '--allow-empty', '-q', '-m', 'only here');
  fs.utimesSync(detached.worktree.path, 0, 0);
  const kept = await add('kept', { keepWorktree: true });
  const later = await add('later', { forLater: { at: 1, by: 'user' } });
  const pr = await add('pr', { pr: { state: 'OPEN' } });
  const running = await add('running', { state: 'running' });
  const queued = await add('queued', { queue: ['more'] });
  const live = await add('live');
  app.runner.live.set(live.id, {});
  const lead = await add('lead', { state: 'waiting' });
  const child = await add('child', { parentId: lead.id });
  const shell = await add('shell');
  app.shells = { get: (id) => (id === shell.id ? {} : undefined) };
  await worktrees.sweep();
  for (const s of [dirty, detached, kept, later, pr, running, queued, live, lead, child, shell]) assert.equal(there(s), true, s.id);
  const status = Object.fromEntries(worktrees.view().items.map((x) => [x.id, x.status]));
  assert.deepEqual(status, { dirty: 'dirty', detached: 'dirty', kept: 'kept', later: 'parked', pr: 'pr', running: 'busy', queued: 'busy', live: 'busy', lead: 'busy', child: 'busy', shell: 'busy' });
});

test('a worktree git can’t read is not taken for a clean one', async () => {
  const { add, worktrees } = setup();
  const s = await add('moved');
  fs.writeFileSync(path.join(s.worktree.path, 'work.txt'), 'x');
  // Its repo moved. Replaced, not overwritten: git hides a worktree's .git file on Windows, and
  // opening a hidden file with 'w' is refused (EPERM) there.
  const link = path.join(s.worktree.path, '.git');
  fs.rmSync(link);
  fs.writeFileSync(link, 'gitdir: /nowhere/.git/worktrees/x\n');
  fs.utimesSync(s.worktree.path, 0, 0);
  await assert.rejects(folderOnly(s.worktree));
  await worktrees.sweep();
  assert.equal(there(s), true);
  assert.equal(worktrees.view().items[0].status, 'unreadable');
});

test('off never removes; the default waits its days from the upgrade, not the task’s age', async () => {
  const off = setup({ defaults: { worktreeCleanup: 'off' } });
  const a = await off.add('a');
  await off.worktrees.sweep();
  assert.equal(there(a), true);

  const fresh = setup({ defaults: {}, config: { worktreeCleanupFrom: now() } });
  const b = await fresh.add('b', { state: 'review' });
  await fresh.worktrees.sweep();
  assert.equal(there(b), true, 'nothing goes the day wisp is updated');
  await fresh.worktrees.sweep({ now: now() + 6 * DAY });
  assert.equal(there(b), true, '6 days on');
  await fresh.worktrees.sweep({ now: now() + 8 * DAY });
  assert.equal(there(b), false, '7 days on');
});

test('a low disk takes the oldest idle first, before the days, and stops at enough', async () => {
  const { add, worktrees } = setup({ defaults: { worktreeCleanup: '30' } });
  const oldest = await add('oldest', { updatedAt: now() - 5 * DAY });
  const today = await add('today', { updatedAt: now() - 3_600_000 });
  fs.utimesSync(today.worktree.path, new Date(now() - 3_600_000), new Date(now() - 3_600_000));
  await worktrees.sweep({ low: Infinity, enough: Infinity });
  assert.equal(there(oldest), false);
  assert.equal(there(today), true, 'less than a day idle stays, however low the disk');
});

test('by hand: Clean up now, one with uncommitted work only with force, nothing in use', async () => {
  const { add, worktrees } = setup({ defaults: { worktreeCleanup: 'off' } });
  const idle = await add('idle');
  const dirty = await add('dirty');
  fs.writeFileSync(path.join(dirty.worktree.path, 'new.txt'), 'x');
  const running = await add('running', { state: 'running' });
  await worktrees.scan();
  assert.equal(worktrees.view().ready, 1);
  assert.deepEqual(await worktrees.clean({}), { queued: 1, skipped: [] });
  await until(() => !there(idle) && !worktrees.view().cleaning);
  await assert.rejects(worktrees.clean({ ids: ['dirty'] }), /uncommitted/);
  await assert.rejects(worktrees.clean({ ids: ['running'], force: true }), /in use/);
  assert.equal(there(running), true);
  await worktrees.clean({ ids: ['dirty'], force: true });
  await until(() => !there(dirty) && !worktrees.view().cleaning);
  assert.equal(worktrees.view().last.count, 1);
});

test('leftovers: listed, removed only when named, and only folders in worktrees/', async () => {
  const { add, home, repo, worktrees } = setup();
  await add('task', { updatedAt: now() });
  const left = path.join(home, 'worktrees', 'by-hand');
  git(repo, 'worktree', 'add', '-q', '-b', 'by-hand', left);
  fs.writeFileSync(path.join(home, 'worktrees', 'shot.png'), 'x');
  await worktrees.sweep();
  assert.equal(fs.existsSync(left), true, 'the cleanup leaves them');
  assert.deepEqual(worktrees.view().leftovers.map((x) => x.name), ['by-hand']);
  await assert.rejects(worktrees.clean({ leftovers: ['../sessions'] }), /Not a leftover/);
  await assert.rejects(worktrees.clean({ leftovers: ['shot.png'] }), /Not a leftover/);
  await worktrees.clean({ leftovers: ['by-hand'] });
  await until(() => !fs.existsSync(left));
  assert.equal(git(repo, 'branch', '--list', 'by-hand').includes('by-hand'), true, 'its branch stays');
  assert.equal(git(repo, 'worktree', 'list').includes('by-hand'), false, 'git forgot it');
});

test('sizes and free disk come with the list', { skip: process.platform === 'win32' }, async () => {
  const { add, worktrees } = setup();
  await add('sized', { updatedAt: now() });
  await worktrees.scan();
  const v = worktrees.view();
  assert.ok(v.items[0].size > 0);
  assert.equal(v.size, v.items[0].size);
  assert.ok(v.disk.free > 0);
});

test('a merged or closed PR goes at the next sweep, without the idle wait; never while busy or dirty', async () => {
  const { add, worktrees } = setup({ defaults: { worktreeCleanup: '30' } });
  const fresh = { updatedAt: now(), state: 'review' };
  const merged = await add('merged', { ...fresh, pr: { state: 'MERGED' } });
  const closed = await add('closed', { ...fresh, also: [{ pr: { state: 'CLOSED' } }] });
  const busy = await add('busy', { ...fresh, state: 'running', pr: { state: 'MERGED' } });
  const dirty = await add('dirty', { ...fresh, pr: { state: 'MERGED' } });
  fs.writeFileSync(path.join(dirty.worktree.path, 'new.txt'), 'x');
  const plain = await add('plain', fresh);
  await worktrees.sweep();
  assert.equal(there(merged), false);
  assert.equal(there(closed), false);
  for (const s of [busy, dirty, plain]) assert.equal(there(s), true, s.id);
});

test('a Done task goes after a day idle; one in review waits for the days set', async () => {
  const { add, worktrees } = setup({ defaults: { worktreeCleanup: '30' } });
  const old = await add('old', { updatedAt: now() - 25 * 3_600_000 });
  const recent = await add('recent', { updatedAt: now() - 3_600_000 });
  const review = await add('review', { state: 'review', updatedAt: now() - 3 * DAY });
  await worktrees.sweep();
  assert.equal(there(old), false);
  assert.equal(there(recent), true, 'less than a day');
  assert.equal(there(review), true, 'not Done');
  assert.equal(worktrees.view().items.find((x) => x.id === 'recent').cleanAt <= now() + DAY, true);
});

test('over the cap the oldest idle go until it fits; kept, dirty and open PRs stay even over it', async () => {
  const { add, worktrees } = setup({ defaults: { worktreeCleanup: 'off', worktreeMax: '20' } });
  const hours = (h) => ({ state: 'review', updatedAt: now() - h * 3_600_000 });
  const idle = [];
  for (let i = 0; i < 20; i++) idle.push(await add(`idle${i}`, hours(100 - i)));
  const kept = await add('kept', { ...hours(500), keepWorktree: true });
  const pr = await add('pr', { ...hours(400), pr: { state: 'OPEN' } });
  const dirty = await add('dirty', hours(300));
  fs.writeFileSync(path.join(dirty.worktree.path, 'new.txt'), 'x');
  fs.utimesSync(dirty.worktree.path, 0, 0);
  // 23 folders, 20 allowed: the three oldest idle go.
  await worktrees.sweep();
  assert.deepEqual(idle.filter((s) => !there(s)).map((s) => s.id), ['idle0', 'idle1', 'idle2']);
  for (const s of [kept, pr, dirty]) assert.equal(there(s), true, s.id);
  assert.equal(worktrees.view().max, '20');
});

test('leftovers don’t count toward the cap, so they never push idle task folders out', async () => {
  const { add, home, repo, worktrees } = setup({ defaults: { worktreeCleanup: 'off', worktreeMax: '20' } });
  const tasks = [];
  for (let i = 0; i < 20; i++) tasks.push(await add(`t${i}`, { state: 'review', updatedAt: now() - (50 - i) * 3_600_000 }));
  const left = [];
  for (let i = 0; i < 3; i++) {
    const p = path.join(home, 'worktrees', `left${i}`);
    git(repo, 'worktree', 'add', '-q', '-b', `left${i}`, p);
    left.push(p);
  }
  await worktrees.sweep();
  assert.deepEqual(tasks.filter((s) => !there(s)).map((s) => s.id), [], '20 task folders, 20 allowed');
  assert.equal(left.every((p) => fs.existsSync(p)), true, 'leftovers stay too');
  assert.equal(worktrees.view().leftovers.length, 3);
});

test('the cap off, or not reached, removes nothing; a new folder past it sweeps a little later', async () => {
  const { add, store, worktrees } = setup({ defaults: { worktreeCleanup: 'off', worktreeMax: 'off' }, opts: { capDelay: 50 } });
  const a = await add('a', { state: 'review', updatedAt: now() - 5 * DAY });
  const b = await add('b', { state: 'review', updatedAt: now() - 4 * DAY });
  await worktrees.sweep();
  assert.equal(there(a), true);
  store.config.defaults.worktreeMax = '20';
  await worktrees.sweep();
  assert.equal(there(a), true, 'under the cap');
  worktrees.start();
  try {
    store.config.defaults.worktreeMax = '1';
    await worktrees.scan();
    await add('c', { state: 'review', updatedAt: now() - 3 * DAY }); // three folders, one allowed
    await until(() => !there(a) && !there(b));
  } finally {
    worktrees.stop();
  }
});

test('every sweep prunes what git still lists of folders that are gone', async () => {
  const { add, home, repo, worktrees } = setup();
  await add('task', { updatedAt: now() });
  const gone = path.join(home, 'gone');
  git(repo, 'worktree', 'add', '-q', '-b', 'gone', gone);
  fs.rmSync(gone, { recursive: true, force: true });
  assert.match(git(repo, 'worktree', 'list', '--porcelain'), /prunable/);
  await worktrees.sweep();
  assert.doesNotMatch(git(repo, 'worktree', 'list', '--porcelain'), /prunable/);
});

test('while the machine is busy the sweep does nothing, and the next one catches up', async () => {
  let short = true;
  const { add, home, repo, worktrees } = setup({ opts: { busy: () => short } });
  const s = await add('old');
  const gone = path.join(home, 'gone');
  git(repo, 'worktree', 'add', '-q', '-b', 'gone', gone);
  fs.rmSync(gone, { recursive: true, force: true });
  assert.deepEqual(await worktrees.sweep(), { skipped: 'busy' });
  assert.equal(there(s), true);
  assert.match(git(repo, 'worktree', 'list', '--porcelain'), /prunable/, 'no git either');
  short = false;
  await worktrees.sweep();
  assert.equal(there(s), false);
  worktrees.setBusy(() => true);
  assert.deepEqual(await worktrees.sweep(), { skipped: 'busy' });
});

test('a look runs git status again only in a folder that moved', async () => {
  const { add, worktrees } = setup({ defaults: { worktreeCleanup: 'off' } });
  const s = await add('s', { updatedAt: now() });
  await worktrees.scan();
  assert.equal(worktrees.view().items[0].status, 'idle');
  // Committed straight into the branch's folder: the task's updatedAt and the folder didn't move.
  fs.writeFileSync(path.join(s.worktree.path, 'deep.txt'), 'x');
  fs.utimesSync(s.worktree.path, 0, 0);
  await worktrees.scan();
  assert.equal(worktrees.view().items[0].status, 'idle', 'the last look stands');
  s.updatedAt = now() + 1; // the task ran
  await worktrees.scan();
  assert.equal(worktrees.view().items[0].status, 'dirty');
});
