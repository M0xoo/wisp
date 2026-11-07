// Done asks about the worktree: which folders a task and what ran under it hold, what Remove and
// Keep do with them, and what a Done nobody is asked about (phone, channels, Ship it, crew) removes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeRepo, tmp } from './helpers.js';
import { createWorktree } from '../server/git.js';
import { createDoneFolders } from '../server/services/done-folders.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function setup({ defaults = {} } = {}) {
  const home = tmp('done-folders-');
  const repo = makeRepo();
  const sessions = new Map();
  const live = new Map();
  const changed = [];
  const store = { home, config: { defaults }, all: () => [...sessions.values()], get: (id) => sessions.get(id) };
  const app = { store, runner: { live, working: (s) => live.has(s.id) }, sessionChanged: (s) => changed.push(s.id) };
  const tree = (id) => createWorktree({ cwd: repo, home, id, title: id });
  const add = async (id, fields = {}, { worktree = true } = {}) => {
    const s = { id, title: `Task ${id}`, cwd: repo, state: 'done', queue: [], turns: [], ...(worktree && { worktree: await tree(id) }), ...fields };
    sessions.set(id, s);
    return s;
  };
  return { app, add, tree, repo, store, changed, done: createDoneFolders(app) };
}
const there = (wt) => fs.existsSync(wt.path);
const byTask = (out) => Object.fromEntries(out.folders.map((f) => [f.task, f]));

test('lists the task’s folders and everything under it, once each, without the ones in use', async () => {
  const { add, tree, done, app } = setup();
  const lead = await add('lead');
  lead.also = [{ cwd: lead.cwd, worktree: await tree('lead-also') }];
  // A subagent in the lead's folder is the lead's row; one with its own folder has its own.
  const sub = await add('sub', { parentId: lead.id, worktree: lead.worktree, state: 'review' });
  const own = await add('own-sub', { parentId: lead.id, state: 'review' });
  lead.children = { reviewer: sub.id, other: own.id };
  const job = await add('job', { crew: { id: 'm1' }, state: 'review' });
  lead.turns = [{ id: 't1', delegations: [{ crew: 'm1', sessionId: job.id }] }];
  const nested = await add('nested', { parentId: job.id, state: 'review' });
  const busy = await add('busy', { parentId: lead.id });
  app.runner.live.set(busy.id, {});
  lead.groupId = 'g';
  const doneRun = await add('run-b', { groupId: 'g' });
  const reviewRun = await add('run-c', { groupId: 'g', state: 'review' });
  const foreign = await add('foreign', { parentId: lead.id });
  foreign.worktree.foreign = 'conductor';
  const gone = await add('gone', { parentId: lead.id });
  fs.rmSync(gone.worktree.path, { recursive: true, force: true });
  const out = await done.list(lead);
  assert.equal(out.onDone, 'ask');
  const paths = out.folders.map((f) => f.path);
  assert.equal(new Set(paths).size, paths.length, 'each folder once');
  assert.deepEqual(out.folders.map((f) => f.task).sort(), ['job', 'lead', 'lead', 'nested', 'own-sub', 'run-b'].sort());
  assert.ok(out.folders.find((f) => f.path === lead.also[0].worktree.path), 'its other folder');
  for (const x of [busy, reviewRun, foreign, gone]) assert.ok(!paths.includes(x.worktree.path), x.id);
  assert.equal(byTask(out)['own-sub'].own, false);
  assert.equal(out.folders.find((f) => f.path === lead.worktree.path).own, true);
  assert.ok(out.folders.every((f) => f.size === null || f.size > 0));
  assert.ok(nested && sub);
});

test('each folder says what only it holds, what isn’t pushed and its PR', async () => {
  const { add, done } = setup();
  const lead = await add('lead');
  fs.writeFileSync(path.join(lead.worktree.path, 'a.txt'), 'x');
  fs.writeFileSync(path.join(lead.worktree.path, 'b.txt'), 'y');
  const committed = await add('committed', { parentId: lead.id, pr: { number: 7, url: 'u', state: 'OPEN' } });
  git(committed.worktree.path, 'commit', '--allow-empty', '-q', '-m', 'work');
  const merged = await add('merged', { parentId: lead.id, pr: { number: 8, url: 'u', state: 'MERGED' } });
  const f = byTask(await done.list(lead, { sizes: false }));
  assert.equal(f.lead.only, 2);
  assert.equal(f.lead.uncommitted, 2);
  assert.equal(f.lead.size, null, 'sizes: false answers without du');
  assert.equal(f.committed.only, 0);
  assert.equal(f.committed.unpushed, 1);
  assert.deepEqual(f.committed.pr, { number: 7, url: 'u', state: 'OPEN' });
  assert.equal(f.merged.pr.state, 'MERGED');
  assert.ok(merged);
});

test('Remove takes clean folders and a ticked dirty one; the branch stays; an unticked dirty one is kept', async () => {
  const { add, done, repo } = setup();
  const lead = await add('lead');
  git(lead.worktree.path, 'commit', '--allow-empty', '-q', '-m', 'mine');
  const tip = git(lead.worktree.path, 'rev-parse', 'HEAD');
  const dirty = await add('dirty', { parentId: lead.id });
  fs.writeFileSync(path.join(dirty.worktree.path, 'new.txt'), 'x');
  const forced = await add('forced', { parentId: lead.id });
  fs.writeFileSync(path.join(forced.worktree.path, 'new.txt'), 'x');
  const out = await done.apply(lead, { remove: [lead.worktree.path, dirty.worktree.path, forced.worktree.path], force: [forced.worktree.path] });
  assert.deepEqual(out.removed.sort(), [lead.worktree.path, forced.worktree.path].sort());
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].path, dirty.worktree.path);
  assert.match(out.failed[0].error, /holds work of its own \(1 change\)/);
  assert.equal(there(lead.worktree), false);
  assert.equal(there(forced.worktree), false);
  assert.equal(there(dirty.worktree), true);
  assert.equal(dirty.keepWorktree, true, 'a removal that fails is kept');
  assert.equal(git(repo, 'rev-parse', lead.worktree.branch), tip, 'commits stay on the branch');
});

test('Keep pins every folder; a path that isn’t the task’s is refused', async () => {
  const { add, done } = setup();
  const lead = await add('lead');
  const sub = await add('sub', { parentId: lead.id });
  const other = await add('other');
  const out = await done.apply(lead, { keep: [lead.worktree.path, sub.worktree.path] });
  assert.equal(out.kept.length, 2);
  assert.equal(lead.keepWorktree, true);
  assert.equal(sub.keepWorktree, true);
  await assert.rejects(done.apply(lead, { remove: [other.worktree.path] }), /Not a folder of this task/);
  await assert.rejects(done.apply(lead, { remove: '/x' }), /must be lists/);
  assert.equal(there(other.worktree), true);
});

test('Done with nobody to ask removes only clean folders with no open PR, and nothing when set to keep', async () => {
  const { add, done, store } = setup();
  const lead = await add('lead');
  const dirty = await add('dirty', { parentId: lead.id });
  fs.writeFileSync(path.join(dirty.worktree.path, 'new.txt'), 'x');
  const detached = await add('detached', { parentId: lead.id });
  git(detached.worktree.path, 'checkout', '-q', '--detach');
  git(detached.worktree.path, 'commit', '--allow-empty', '-q', '-m', 'only here');
  const pr = await add('pr', { parentId: lead.id, pr: { number: 3, state: 'OPEN' } });
  const kept = await add('kept', { parentId: lead.id, keepWorktree: true });
  const merged = await add('merged', { parentId: lead.id, pr: { number: 4, state: 'MERGED' } });
  const busy = await add('busy', { parentId: lead.id, queue: ['more'] });
  store.config.defaults.worktreeOnDone = 'keep';
  assert.deepEqual(await done.tidy(lead), []);
  assert.equal(there(lead.worktree), true);
  store.config.defaults.worktreeOnDone = 'remove'; // never more than what's clean, whatever it says
  const gone = await done.tidy(lead);
  assert.deepEqual(gone.sort(), [lead.worktree.path, merged.worktree.path].sort());
  for (const x of [dirty, detached, pr, kept, busy]) assert.equal(there(x.worktree), true, x.id);
});

// Through a real server: the routes, Done from outside the page, and a crew job's end.
test('the routes, markDone and a crew job ending, on a real server', async (t) => {
  const { installFakeBins, isolateAgentConfigs, makeClone, until } = await import('./helpers.js');
  const net = await import('node:net');
  process.env.WISP_HOME = tmp('done-folders-home');
  process.env.WISP_UPDATE_CHECK = '0';
  process.env.FAKE_RECORD = tmp('done-folders-rec');
  installFakeBins();
  isolateAgentConfigs();
  const { startServer } = await import('../server/index.js');
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port: p } = s.address();
      s.close(() => resolve(p));
    });
  });
  const srv = await startServer({ port, handleSignals: false });
  t.after(() => {
    srv.shutdown();
    srv.server.closeAllConnections?.();
    srv.server.close();
  });
  const base = `http://127.0.0.1:${port}/api`;
  const api = async (p, { method, body } = {}) => {
    const r = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) throw Object.assign(new Error(`${p}: ${j.error}`), { status: r.status });
    return j;
  };
  const settled = (id) => until(async () => ((await api(`/sessions/${id}`)).state === 'review' ? api(`/sessions/${id}`) : null));
  const launch = async (prompt) => {
    const repo = makeClone();
    const s = await api('/sessions', { body: { prompt, cwd: repo.dir, agent: 'claude' } });
    const full = await settled(s.id);
    await until(() => !srv.runner.live.has(s.id)); // the CLI let go
    return { repo, s: srv.store.get(s.id), wt: full.worktree };
  };

  // The page: Done, then the folder list and the answer.
  const a = await launch('Fix add() in math.js');
  await api(`/sessions/${a.s.id}`, { method: 'PATCH', body: { state: 'done' } });
  assert.equal(fs.existsSync(a.wt.path), true, 'Done from the page removes nothing by itself');
  const list = await api(`/sessions/${a.s.id}/folders?sizes=0`);
  assert.equal(list.folders.length, 1);
  assert.ok(list.folders[0].only > 0, 'the fake agent left math.js changed');
  const refused = await api(`/sessions/${a.s.id}/folders`, { body: { remove: [a.wt.path] } });
  assert.equal(refused.failed.length, 1);
  assert.equal((await api(`/sessions/${a.s.id}`)).keepWorktree, true);
  const forced = await api(`/sessions/${a.s.id}/folders`, { body: { remove: [a.wt.path], force: [a.wt.path] } });
  assert.deepEqual(forced.removed, [a.wt.path]);
  assert.equal(fs.existsSync(a.wt.path), false);
  assert.ok(a.repo.git('branch', '--list', a.wt.branch), 'the branch stays');
  await assert.rejects(api(`/sessions/${a.s.id}/folders`, { body: { keep: ['/elsewhere'] } }), /Not a folder/);

  // The setting is validated like the others.
  await assert.rejects(api('/config', { method: 'PATCH', body: { defaults: { worktreeOnDone: 'sometimes' } } }), /worktreeOnDone must be one of ask, remove, keep/);
  await api('/config', { method: 'PATCH', body: { defaults: { worktreeOnDone: 'remove' } } });

  // Done from outside the page (Ship it, wisp_task, a channel): a clean folder goes, a dirty one stays.
  const b = await launch('Fix add() again');
  git(b.wt.path, 'add', '-A');
  git(b.wt.path, 'commit', '-qm', 'the fix');
  const c = await launch('Fix add() once more'); // left dirty
  assert.equal(srv.launcher.markDone(b.s), true);
  assert.equal(srv.launcher.markDone(c.s), true);
  await until(() => !fs.existsSync(b.wt.path));
  assert.equal(fs.existsSync(c.wt.path), true);
  assert.ok(b.repo.git('branch', '--list', b.wt.branch));

  // A crew job that ends for review with a clean folder loses it once its CLI lets go.
  const d = await launch('A crew job');
  git(d.wt.path, 'add', '-A');
  git(d.wt.path, 'commit', '-qm', 'job done');
  d.s.crew = { id: 'nobody' };
  srv.runner.emit('ended', { session: d.s, turn: d.s.turns.at(-1) });
  await until(() => !fs.existsSync(d.wt.path), { timeout: 15_000 });
  // One with an open PR keeps it.
  const e = await launch('Another crew job');
  git(e.wt.path, 'add', '-A');
  git(e.wt.path, 'commit', '-qm', 'job done');
  Object.assign(e.s, { crew: { id: 'nobody' }, pr: { number: 9, state: 'OPEN' } });
  srv.runner.emit('ended', { session: e.s, turn: e.s.turns.at(-1) });
  await new Promise((r) => setTimeout(r, 6000));
  assert.equal(fs.existsSync(e.wt.path), true);
});
