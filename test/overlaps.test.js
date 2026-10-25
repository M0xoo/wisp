// Cross-task overlaps: two open tasks in one repo changing the same files. Real git worktrees;
// the service runs on a stub store, so the git and the bookkeeping are tested without a server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeClone, tmp, until } from './helpers.js';
import { touchedFiles, clashFiles } from '../server/git.js';
import { createOverlaps } from '../server/services/overlaps.js';

const MATH = 'export function add(a, b) {\n  return a - b;\n}\n';

// A clone of a repo with origin/main, and a worktree per task: { wt, write(file, text), commit() }.
function repo() {
  const { dir } = makeClone();
  fs.writeFileSync(path.join(dir, 'util.js'), 'export const id = (x) => x;\n\n\n\n\nexport const two = 2;\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'util'], { cwd: dir });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: dir });
  const task = (name) => {
    const at = path.join(tmp('wt'), name);
    execFileSync('git', ['worktree', 'add', '-q', '-b', `wisp/${name}`, at, 'origin/main'], { cwd: dir });
    const g = (...a) => execFileSync('git', a, { cwd: at });
    g('config', 'user.email', 'test@example.com');
    g('config', 'user.name', 'wisp test');
    return {
      wt: { path: at, root: dir, base: 'main', remote: 'origin', branch: `wisp/${name}` },
      write: (f, text) => fs.writeFileSync(path.join(at, f), text),
      commit: () => (g('add', '-A'), g('commit', '-qm', 'work')),
    };
  };
  return { dir, task };
}

test('touchedFiles: committed changes since the base, uncommitted edits and new files', async () => {
  const { task } = repo();
  const t = task('a');
  t.write('math.js', MATH.replace('a - b', 'a + b'));
  t.commit();
  t.write('util.js', 'export const id = (x) => x;\n');
  t.write('notes.md', 'new\n');
  const got = await touchedFiles(t.wt);
  assert.deepEqual(got.files, ['math.js', 'notes.md', 'util.js']);
  assert.match(got.head, /^[0-9a-f]{40}$/);
  assert.equal(await touchedFiles({ ...t.wt, path: path.join(t.wt.path, 'gone') }), null);
});

test('clashFiles: the same lines changed both ways conflict; the same file at different lines merges', async () => {
  const { task } = repo();
  const a = task('a'), b = task('b'), c = task('c');
  a.write('math.js', MATH.replace('a - b', 'a + b'));
  b.write('math.js', MATH.replace('a - b', 'b + a'));
  c.write('util.js', 'export const id = (x) => x;\n\n\n\n\nexport const two = 2; // two\n');
  a.write('util.js', 'export const id = (y) => y;\n\n\n\n\nexport const two = 2;\n');
  const [A, B, C] = await Promise.all([a, b, c].map((t) => touchedFiles(t.wt)));
  assert.deepEqual(await clashFiles(a.wt.path, A.head, B.head), ['math.js']); // uncommitted edits count
  assert.deepEqual(await clashFiles(a.wt.path, A.head, C.head), []); // util.js, but different lines
});

// A store of plain sessions and a recorder for sessionChanged.
function app(sessions) {
  const changed = [];
  return { changed, store: { get: (id) => sessions.find((s) => s.id === id), all: () => sessions }, sessionChanged: (s) => changed.push(s.id) };
}

test('the service marks both tasks, names the conflicting files, and clears when one is merged', async () => {
  const { task } = repo();
  const a = task('a'), b = task('b'), c = task('c');
  a.write('math.js', MATH.replace('a - b', 'a + b'));
  b.write('math.js', MATH.replace('a - b', 'b + a'));
  c.write('other.js', 'x\n');
  const sessions = [
    { id: 'a', title: 'Fix add', state: 'review', worktree: a.wt },
    { id: 'b', title: 'Swap add', state: 'running', worktree: b.wt },
    { id: 'c', title: 'Unrelated', state: 'review', worktree: c.wt },
  ];
  const ctx = app(sessions);
  const ov = createOverlaps(ctx);
  try {
    sessions.forEach((s) => ov.touch(s));
    await until(() => sessions[0].overlaps && sessions[1].overlaps, { what: 'overlaps' });
    assert.deepEqual(sessions[0].overlaps, [{ id: 'b', title: 'Swap add', files: ['math.js'], more: 0, conflicts: ['math.js'] }]);
    assert.equal(sessions[1].overlaps[0].id, 'a');
    assert.equal(sessions[2].overlaps, undefined, 'a task changing other files is left alone');
    // Merged: it drops out, and the other task's warning goes with it.
    sessions[1].pr = { state: 'MERGED' };
    ov.touch(sessions[1]);
    await until(() => !sessions[0].overlaps, { what: 'cleared' });
    assert.equal(sessions[1].overlaps, undefined);
  } finally {
    ov.stop();
  }
});

test('the same file at different lines is an overlap with nothing conflicting', async () => {
  const { task } = repo();
  const a = task('a'), b = task('b');
  a.write('util.js', 'export const id = (y) => y;\n\n\n\n\nexport const two = 2;\n');
  b.write('util.js', 'export const id = (x) => x;\n\n\n\n\nexport const two = 3;\n');
  const sessions = [
    { id: 'a', title: 'Rename', state: 'review', worktree: a.wt },
    { id: 'b', title: 'Bump two', state: 'waiting', worktree: b.wt },
  ];
  const ov = createOverlaps(app(sessions));
  try {
    sessions.forEach((s) => ov.touch(s));
    await until(() => sessions[0].overlaps, { what: 'overlap' });
    assert.deepEqual(sessions[0].overlaps[0].conflicts, []);
    assert.deepEqual(sessions[0].overlaps[0].files, ['util.js']);
  } finally {
    ov.stop();
  }
});

test('only active tasks count: done, stopped and archived ones never warn, and leaving clears the other at once', async () => {
  const { task } = repo();
  const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(task);
  for (const t of [a, b, c, d, e]) t.write('math.js', MATH.replace('a - b', `a + b // ${t.wt.branch}`));
  const sessions = [
    { id: 'a', title: 'Active', state: 'review', worktree: a.wt },
    { id: 'b', title: 'Working', state: 'running', worktree: b.wt },
    { id: 'c', title: 'Done', state: 'done', worktree: c.wt },
    { id: 'd', title: 'Stopped', state: 'review', turns: [{ status: 'stopped' }], worktree: d.wt },
    { id: 'e', title: 'Archived', state: 'review', archived: true, worktree: e.wt },
  ];
  const ov = createOverlaps(app(sessions));
  try {
    sessions.forEach((s) => ov.touch(s));
    await until(() => sessions[0].overlaps, { what: 'overlaps' });
    assert.deepEqual(sessions[0].overlaps.map((o) => o.id), ['b'], 'only the other active task');
    assert.deepEqual(sessions[1].overlaps.map((o) => o.id), ['a']);
    for (const s of sessions.slice(2)) assert.equal(s.overlaps, undefined, `${s.title} never warns`);
    // Marked done: it leaves play, and the other's warning clears without waiting for a sweep.
    sessions[1].state = 'done';
    ov.changed(sessions[1]);
    await until(() => !sessions[0].overlaps, { timeout: 3000, what: 'cleared at once' });
    assert.equal(sessions[1].overlaps, undefined);
    // Back in Needs you: compared again.
    sessions[1].state = 'review';
    ov.changed(sessions[1]);
    await until(() => sessions[0].overlaps, { what: 'back' });
    assert.deepEqual(sessions[0].overlaps.map((o) => o.id), ['b']);
  } finally {
    ov.stop();
  }
});

test('overlaps saved by an earlier wisp are dropped when it starts: they are worked out again', () => {
  const sessions = [{ id: 'old', state: 'done', worktree: { path: '/nowhere', root: '/r', base: 'main' }, overlaps: [{ id: 'x', title: 'X', files: ['a'], more: 0, conflicts: ['a'] }] }];
  const ov = createOverlaps(app(sessions));
  ov.stop();
  assert.equal(sessions[0].overlaps, undefined);
});
