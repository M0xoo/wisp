// Changes' Revert (server/hunks.js): a file's diff rows split into hunks, and one put back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hunkKey, hunksOf, revertHunk } from '../server/hunks.js';
import { parseDiff } from '../server/git.js';

// Base: 1..20 as "l1".."l20". Now: l2 fixed, l18 changed, a line added after l20, no newline lost.
const base = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
const now = [...base];
now[1] = 'L2';
now[17] = 'L18';
now.push('l21');
const text = `${now.join('\n')}\n`;
const diff = `diff --git a/f.txt b/f.txt
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
@@ -15,6 +15,7 @@
 l15
 l16
 l17
-l18
+L18
 l19
 l20
+l21
`;
const rows = parseDiff(diff)[0].rows;

test('hunksOf: runs between the gaps, each with where it starts now and its two sides', () => {
  const hs = hunksOf(rows);
  assert.equal(hs.length, 2);
  assert.deepEqual([hs[0].start, hs[1].start], [1, 15]);
  assert.deepEqual(hs[0].after, ['l1', 'L2', 'l3', 'l4', 'l5']);
  assert.deepEqual(hs[0].before, ['l1', 'l2', 'l3', 'l4', 'l5']);
  assert.deepEqual(hs[1].after, ['l15', 'l16', 'l17', 'L18', 'l19', 'l20', 'l21']);
  assert.deepEqual(hunksOf([]), []);
  // A hunk with nothing left on the new side still knows where it goes.
  const cut = hunksOf([{ op: '…', count: 4 }, { op: '-', text: 'x', a: 5 }]);
  assert.equal(cut[0].start, 5);
});

test('revertHunk: puts one hunk back and leaves the rest, keeping the last newline', () => {
  const second = revertHunk(text, rows, 1);
  assert.equal(second, `${[...base.slice(0, 1), 'L2', ...base.slice(2)].join('\n')}\n`);
  const first = revertHunk(text, rows, 0);
  assert.equal(first.split('\n')[1], 'l2');
  assert.match(first, /L18\nl19\nl20\nl21\n$/);
  // Both, one after the other (the second read from the file as the first left it).
  assert.equal(revertHunk(first, parseDiff(diff.replace(/@@ -1,5 \+1,5 @@\n l1\n-l2\n\+L2\n l3\n l4\n l5\n/, ''))[0].rows, 0), `${base.join('\n')}\n`);
  assert.equal(revertHunk(text.slice(0, -1), rows, 0).endsWith('l21'), true, 'no newline at the end stays so');
  // CRLF lines compare and come back with their \r.
  const crlf = parseDiff('diff --git a/w.txt b/w.txt\n@@ -1,2 +1,2 @@\n a\r\n-b\r\n+B\r\n')[0].rows;
  assert.equal(revertHunk('a\r\nB\r\n', crlf, 0), 'a\r\nb\r\n');
});

test('revertHunk: refuses when the file there is not the hunk any more, or there is no such hunk', () => {
  assert.equal(revertHunk(text.replace('L18', 'L18!'), rows, 1), null);
  assert.equal(revertHunk(text.replace('l17\n', ''), rows, 1), null, 'lines moved up');
  assert.equal(revertHunk('l1\n', rows, 1), null, 'shorter than the hunk');
  assert.equal(revertHunk(text, rows, 2), null);
  assert.equal(revertHunk(null, rows, 0), null);
});

test('hunkKey: the same rows give the same key, a changed row another', () => {
  const [a, b] = hunksOf(rows);
  assert.equal(hunkKey(a.rows), hunkKey(hunksOf(parseDiff(diff)[0].rows)[0].rows));
  assert.notEqual(hunkKey(a.rows), hunkKey(b.rows));
  assert.match(hunkKey(a.rows), /^[0-9a-z]+$/);
});
