// The api's pure helpers: repo URLs (v1 test/clone.test.js), slugs, generated paths, and Changes'
// hunks (v1 test/hunks.test.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generatedPath, hunkKey, hunkable, hunksOf, parseRepo, repoKey, revertHunk, sameRepo, slug } from '@wisp-plugin/git-api';
import type { DiffRow } from '@wisp-plugin/git-api';
import { parseDiff } from '../src/diff.ts';

test('parseRepo reads GitHub URLs, ssh and scp forms, and leaves paths alone', () => {
  const gh = (s: string, o?: { shorthand?: boolean }): string | null | undefined => parseRepo(s, o)?.gh;
  assert.equal(gh('https://github.com/M0xoo/wisp'), 'M0xoo/wisp');
  assert.equal(gh('https://github.com/M0xoo/wisp.git'), 'M0xoo/wisp');
  assert.equal(gh('https://github.com/M0xoo/wisp/tree/main/server'), 'M0xoo/wisp');
  assert.equal(gh('github.com/M0xoo/wisp/'), 'M0xoo/wisp');
  assert.equal(gh('git@github.com:M0xoo/wisp.git'), 'M0xoo/wisp');
  assert.equal(gh('M0xoo/wisp', { shorthand: true }), 'M0xoo/wisp');
  assert.equal(parseRepo('https://github.com/M0xoo/wisp/pull/3')?.url, 'https://github.com/M0xoo/wisp.git');
  const lab = parseRepo('https://gitlab.com/group/sub/app.git');
  assert.deepEqual(lab && { host: lab.host, name: lab.name, gh: lab.gh }, { host: 'gitlab.com', name: 'app', gh: null });
  assert.equal(parseRepo('ssh://git@example.org:2222/team/tool.git')?.name, 'tool');
  for (const p of ['~/code/app', '/Users/me/app', './app', 'app', 'M0xoo/wisp', 'https://github.com/M0xoo', 'C:\\code\\app']) assert.equal(parseRepo(p), null, p);
});

test('sameRepo: however it is spelled; a folder path is a file URL', () => {
  assert.ok(sameRepo('https://github.com/M0xoo/Wisp.git', 'git@github.com:m0xoo/wisp'));
  assert.ok(sameRepo('/tmp/origin', 'file:///tmp/origin'));
  assert.ok(sameRepo('/tmp/a b/origin.git', 'file:///tmp/a%20b/origin'));
  assert.ok(!sameRepo('https://github.com/a/b', 'https://github.com/a/c'));
  assert.ok(!sameRepo('', ''));
  assert.equal(repoKey('git@gitlab.com:g/app.git'), 'gitlab.com/g/app');
});

test('slug: lowercase words, dashes, at most 32 characters, no dash at the end', () => {
  assert.equal(slug('Fix the flaky login test!'), 'fix-the-flaky-login-test');
  assert.equal(slug(''), '');
  assert.equal(slug(null), '');
  const long = slug('a'.repeat(31) + ' b c');
  assert.ok(long.length <= 32 && !long.endsWith('-'));
  // property: any input gives [a-z0-9-], ≤ 32, no leading or trailing dash
  for (let i = 0; i < 500; i++) {
    const s = slug(Array.from({ length: Math.floor(Math.random() * 60) }, () => String.fromCharCode(32 + Math.floor(Math.random() * 400))).join(''));
    assert.match(s, /^([a-z0-9]([a-z0-9-]*[a-z0-9])?)?$/);
    assert.ok(s.length <= 32);
  }
});

test('generatedPath: lockfiles, minified bundles and build output', () => {
  assert.ok(generatedPath('web/package-lock.json') && generatedPath('dist/app.js') && generatedPath('x.min.css') && generatedPath('Cargo.lock'));
  assert.ok(!generatedPath('server/git.js') && !generatedPath('distance.js'));
});

// v1 test/hunks.test.js
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
const rowsOf = (d: string): DiffRow[] => parseDiff(d)[0]?.rows ?? [];
const rows = rowsOf(diff);

test('hunksOf: runs between the gaps, each with where it starts now and its two sides', () => {
  const hs = hunksOf(rows);
  assert.equal(hs.length, 2);
  assert.deepEqual([hs[0]?.start, hs[1]?.start], [1, 15]);
  assert.deepEqual(hs[0]?.after, ['l1', 'L2', 'l3', 'l4', 'l5']);
  assert.deepEqual(hs[0]?.before, ['l1', 'l2', 'l3', 'l4', 'l5']);
  assert.deepEqual(hs[1]?.after, ['l15', 'l16', 'l17', 'L18', 'l19', 'l20', 'l21']);
  assert.deepEqual(hunksOf([]), []);
  // A hunk with nothing left on the new side still knows where it goes.
  const cut = hunksOf([{ op: '…', count: 4 }, { op: '-', text: 'x', a: 5 }]);
  assert.equal(cut[0]?.start, 5);
});

test('revertHunk: puts one hunk back and leaves the rest, keeping the last newline', () => {
  assert.equal(revertHunk(text, rows, 1), `${[...base.slice(0, 1), 'L2', ...base.slice(2)].join('\n')}\n`);
  const first = revertHunk(text, rows, 0) ?? '';
  assert.equal(first.split('\n')[1], 'l2');
  assert.match(first, /L18\nl19\nl20\nl21\n$/);
  // Both, one after the other (the second read from the file as the first left it).
  assert.equal(revertHunk(first, rowsOf(diff.replace(/@@ -1,5 \+1,5 @@\n l1\n-l2\n\+L2\n l3\n l4\n l5\n/, '')), 0), `${base.join('\n')}\n`);
  assert.equal(revertHunk(text.slice(0, -1), rows, 0)?.endsWith('l21'), true, 'no newline at the end stays so');
  // CRLF lines compare and come back with their \r.
  const crlf = rowsOf('diff --git a/w.txt b/w.txt\n@@ -1,2 +1,2 @@\n a\r\n-b\r\n+B\r\n');
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
  assert.equal(hunkKey(a?.rows), hunkKey(hunksOf(rowsOf(diff))[0]?.rows));
  assert.notEqual(hunkKey(a?.rows), hunkKey(b?.rows));
  assert.match(hunkKey(a?.rows), /^[0-9a-z]+$/);
});

test('revertHunk, model: reverting every hunk of a random edit gives the base back', () => {
  for (let run = 0; run < 200; run++) {
    const lines = Array.from({ length: 5 + Math.floor(Math.random() * 40) }, (_, i) => `line ${i}`);
    const edited = lines.flatMap((l) => {
      const r = Math.random();
      return r < 0.08 ? [] : r < 0.16 ? [`${l}!`] : r < 0.22 ? [l, `new ${l}`] : [l];
    });
    // A minimal unified diff by LCS, as git would print it with -U3 (gaps as '…' rows).
    const d = lcsDiff(lines, edited);
    if (!d) continue;
    let cur = `${edited.join('\n')}\n`;
    const hs = hunksOf(rowsOf(d));
    for (let i = hs.length - 1; i >= 0; i--) cur = revertHunk(cur, rowsOf(d), i) ?? 'FAILED';
    assert.equal(cur, `${lines.join('\n')}\n`, d);
  }
});

test('hunkable: changed and renamed text files with rows only', () => {
  assert.equal(hunkable({ status: 'M', binary: false, rows }), true);
  assert.equal(hunkable({ status: 'A', binary: false, rows }), false);
  assert.equal(hunkable({ status: 'M', binary: true, rows }), false);
  assert.equal(hunkable({ status: 'R', binary: false, rows: [] }), false);
});

// A reference diff for the model test. Every `!` below indexes inside the bounds the loops keep.
function lcsDiff(a: string[], b: string[]): string | null {
  const n = a.length;
  const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const ops: { op: ' ' | '-' | '+'; text: string; a: number; b: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push({ op: ' ', text: a[i++]!, a: i, b: ++j });
    else if (j < m && (i >= n || L[i]![j + 1]! >= L[i + 1]![j]!)) ops.push({ op: '+', text: b[j++]!, a: i + 1, b: j });
    else ops.push({ op: '-', text: a[i++]!, a: i, b: j + 1 });
  }
  if (ops.every((o) => o.op === ' ')) return null;
  // hunks: changes with 3 lines of context, merged when they touch
  const keep = ops.map((o, k) => ops.slice(Math.max(0, k - 3), k + 4).some((x) => x.op !== ' '));
  let out = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n';
  for (let k = 0; k < ops.length; ) {
    if (!keep[k]) {
      k++;
      continue;
    }
    const start = k;
    while (k < ops.length && keep[k]) k++;
    const h = ops.slice(start, k);
    const oldN = h.filter((o) => o.op !== '+').length;
    const newN = h.filter((o) => o.op !== '-').length;
    const first = h[0]!;
    const os = first.op === '+' ? first.a - 1 + (oldN ? 1 : 0) : first.a;
    const ns = first.op === '-' ? first.b - 1 + (newN ? 1 : 0) : first.b;
    out += `@@ -${oldN ? os : os - 1},${oldN} +${newN ? ns : ns - 1},${newN} @@\n${h.map((o) => `${o.op}${o.text}`).join('\n')}\n`;
  }
  return out;
}
