// Changes' Stage / Unstage and Commit (server/stage.js): git's diffs split per file and hunk, a hunk
// of Changes matched to git's hunks (index → folder to stage, HEAD → index to unstage), the one-hunk
// patch git apply takes, and the whole round trip in a real repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { commitStaged, hunkStates, patchOf, pick, raw, splitDiff, stageFile, stageHunk, stageState, toIndex } from '../server/stage.js';
import { hunksOf } from '../server/hunks.js';
import { parseDiff } from '../server/git.js';
import { tmp } from './helpers.js';

const DIFF = `diff --git a/f.txt b/f.txt
index 1..2 100644
--- a/f.txt
+++ b/f.txt
@@ -1,5 +1,5 @@
 l1
-l2
+L2
 l3
 l4
 l5
@@ -15,6 +15,8 @@
 l15
 l16
 l17
-l18
+L18
+new
${' '}
 l20
\\ No newline at end of file
diff --git a/g.txt b/g.txt
new file mode 100644
--- /dev/null
+++ b/g.txt
@@ -0,0 +1,2 @@
+one
+two
`;

test('splitDiff: per file, its head and hunks, where each hunk changes on both sides', () => {
  const [f, g] = splitDiff(DIFF);
  assert.equal(f.path, 'f.txt');
  assert.deepEqual(f.head, ['diff --git a/f.txt b/f.txt', 'index 1..2 100644', '--- a/f.txt', '+++ b/f.txt']);
  assert.equal(f.hunks.length, 2);
  assert.deepEqual(f.hunks.map((h) => [h.os, h.oc, h.ns, h.nc]), [[1, 5, 1, 5], [15, 6, 15, 8]]);
  assert.deepEqual(f.hunks[0].newAt, [2, 2], 'a removed line counts where the next new line is');
  assert.deepEqual(f.hunks[1].newAt, [18, 18, 19]);
  assert.deepEqual(f.hunks[1].oldAt, [18, 19, 19]);
  // A blank context line and the no-newline marker stay in the hunk as git wrote them.
  assert.ok(f.hunks[1].text.endsWith('\n \n l20\n\\ No newline at end of file'));
  assert.equal(g.path, 'g.txt');
  assert.deepEqual(g.hunks[0].newAt, [1, 2]);
});

test('patchOf: the file head and only the hunks picked, ending in a newline', () => {
  const [f] = splitDiff(DIFF);
  const p = patchOf(f, [f.hunks[1]]);
  assert.ok(p.startsWith('diff --git a/f.txt b/f.txt\nindex 1..2 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -15,6 +15,8 @@\n'));
  assert.ok(!p.includes('+L2'));
  assert.ok(p.endsWith('No newline at end of file\n'));
});

test('pick and toIndex: a hunk of Changes finds its git hunks, through lines the index numbers differently', () => {
  const [f] = splitDiff(DIFF);
  assert.deepEqual(pick(f.hunks, 1, 6), [f.hunks[0]]);
  assert.deepEqual(pick(f.hunks, 14, 22), [f.hunks[1]]);
  assert.deepEqual(pick(f.hunks, 7, 13), [], 'context alone is no change');
  // Index → folder added one line in its second hunk: past it, the folder's lines are one further on.
  assert.equal(toIndex(3, f.hunks), 3);
  assert.equal(toIndex(10, f.hunks), 10);
  assert.equal(toIndex(30, f.hunks), 28);
  assert.equal(toIndex(16, f.hunks), 16, 'inside a hunk: its old side at the same offset');
});

test('hunkStates: which hunks of Changes have something to stage, and which are staged', () => {
  // Changes (from the merge-base) has the two hunks of DIFF; L2 is staged, L18 is not.
  const rows = parseDiff(DIFF)[0].rows;
  assert.equal(hunksOf(rows).length, 2);
  const unstaged = splitDiff(DIFF.split('diff --git a/g.txt')[0].replace(/@@ -1,5 \+1,5 @@\n l1\n-l2\n\+L2\n l3\n l4\n l5\n/, ''))[0];
  const staged = { hunks: [splitDiff(DIFF)[0].hunks[0]] };
  assert.deepEqual(hunkStates(rows, unstaged, staged), [{ unstaged: false, staged: true }, { unstaged: true, staged: false }]);
  assert.deepEqual(hunkStates(rows, undefined, undefined), [{ unstaged: false, staged: false }, { unstaged: false, staged: false }], 'committed: neither');
});

// A real repo: stage a hunk, unstage it, stage a file, commit.
async function repo() {
  const dir = tmp('stage');
  const g = (...a) => raw(dir, a);
  await g('init', '-q', '-b', 'main');
  await g('config', 'user.email', 'qa@wisp.test');
  await g('config', 'user.name', 'QA');
  await g('config', 'commit.gpgsign', 'false');
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  fs.writeFileSync(path.join(dir, 'a.txt'), `${lines.join('\n')}\n`);
  await g('add', '-A');
  await g('commit', '-q', '-m', 'base', '--no-verify');
  lines[1] = 'LINE 2';
  lines[24] = 'LINE 25';
  lines.splice(25, 0, '');
  fs.writeFileSync(path.join(dir, 'a.txt'), `${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'new.txt'), 'hi\n');
  return { dir, g };
}
// Changes as GET /changes builds it, from HEAD (the merge-base here).
const changes = async (dir) => {
  const files = parseDiff(await raw(dir, ['diff', '--no-color', '-U3', 'HEAD']));
  files.push({ path: 'new.txt', status: 'A', add: 1, del: 0, binary: false, rows: [{ op: '+', text: 'hi', b: 1 }], more: 0 });
  return stageState(dir, { files });
};

test('stage a hunk, unstage it, stage a file and commit, in a real repo', async () => {
  const { dir, g } = await repo();
  let c = await changes(dir);
  let a = c.files.find((f) => f.path === 'a.txt');
  assert.equal(hunksOf(a.rows).length, 2);
  assert.deepEqual([a.staged, a.unstaged], [false, true]);
  assert.deepEqual(a.hunkStage, [{ staged: false, unstaged: true }, { staged: false, unstaged: true }]);
  assert.equal(c.files.find((f) => f.path === 'new.txt').unstaged, true, 'untracked counts as unstaged');

  // The second hunk (it ends on a blank line) into the index: only it.
  assert.equal(await stageHunk(dir, a, 1), true);
  assert.match(await g('diff', '--cached'), /\+LINE 25/);
  assert.doesNotMatch(await g('diff', '--cached'), /LINE 2\n/);
  c = await changes(dir);
  a = c.files.find((f) => f.path === 'a.txt');
  assert.deepEqual([a.staged, a.unstaged], [true, true]);
  assert.deepEqual(a.hunkStage, [{ staged: false, unstaged: true }, { staged: true, unstaged: false }]);
  assert.equal(c.staged, 1);
  // Staging it again finds nothing left there.
  assert.equal(await stageHunk(dir, a, 1), false);

  // The first hunk too, then the second back out: the index holds the first only.
  assert.equal(await stageHunk(dir, a, 0), true);
  a = (await changes(dir)).files.find((f) => f.path === 'a.txt');
  assert.deepEqual(a.hunkStage, [{ staged: true, unstaged: false }, { staged: true, unstaged: false }]);
  assert.equal(await stageHunk(dir, a, 1, { unstage: true }), true);
  const cached = await g('diff', '--cached');
  assert.match(cached, /\+LINE 2\n/);
  assert.doesNotMatch(cached, /LINE 25/);
  a = (await changes(dir)).files.find((f) => f.path === 'a.txt');
  assert.deepEqual(a.hunkStage, [{ staged: true, unstaged: false }, { staged: false, unstaged: true }]);

  // A file: in (a new one too), out, in again.
  assert.equal(await stageFile(dir, ['new.txt']), true);
  assert.match(await g('diff', '--cached', '--name-only'), /new\.txt/);
  assert.equal(await stageFile(dir, ['new.txt'], { unstage: true }), true);
  assert.doesNotMatch(await g('diff', '--cached', '--name-only'), /new\.txt/);
  assert.equal(await stageFile(dir, ['new.txt'], { unstage: true }), false, 'nothing staged there');
  assert.equal(await stageFile(dir, ['a.txt', undefined]), true);

  // Commit what's staged: a.txt, not the untracked file.
  const sha = await commitStaged(dir, 'Fix the lines');
  assert.match(sha, /^[0-9a-f]{7,}$/);
  assert.equal((await g('log', '-1', '--format=%s')).trim(), 'Fix the lines');
  assert.equal((await g('status', '--porcelain')).trim(), '?? new.txt');
  assert.equal(await commitStaged(dir, 'again'), null, 'nothing staged');
  assert.match(await commitStaged(dir, 'Add new.txt', { all: true }), /^[0-9a-f]{7,}$/);
  assert.equal((await g('status', '--porcelain')).trim(), '');
});
