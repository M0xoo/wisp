// The diff parsers: v1's parseDiff cases (test/workspace.test.js), the streaming parser against the
// whole-text one for any chunking, splitAt / sectionPath (v1 judge.js) and git status -z parsing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DIFF_LINES, DiffParser, parseDiff, sectionPath, splitAt } from '../src/diff.ts';
import { parseStatus } from '../src/repo.ts';

const OUT = [
  'diff --git a/a.js b/a.js',
  'index 1..2 100644',
  '--- a/a.js',
  '+++ b/a.js',
  '@@ -3,2 +3,2 @@ x',
  ' keep',
  '-old',
  '+new',
  '@@ -20,1 +20,2 @@',
  ' tail',
  '+more',
  'diff --git a/old.js b/new.js',
  'similarity index 100%',
  'rename from old.js',
  'rename to new.js',
  'diff --git a/gone.js b/gone.js',
  'deleted file mode 100644',
  '--- a/gone.js',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  'diff --git a/logo.png b/logo.png',
  'Binary files a/logo.png and b/logo.png differ',
  'diff --git a/n.txt b/n.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/n.txt',
  '@@ -0,0 +1,2 @@',
  '+one',
  '+two',
  '\\ No newline at end of file',
].join('\n');

test('parseDiff: hunks with the unchanged gaps between them, renames, deletions, binaries, new files', () => {
  const [a, r, d, b, n] = parseDiff(OUT);
  assert.deepEqual(a?.rows, [{ op: '…', count: 2 }, { op: ' ', text: 'keep', a: 3, b: 3 }, { op: '-', text: 'old', a: 4 }, { op: '+', text: 'new', b: 4 }, { op: '…', count: 15 }, { op: ' ', text: 'tail', a: 20, b: 20 }, { op: '+', text: 'more', b: 21 }]);
  assert.deepEqual([a?.add, a?.del], [2, 1]);
  assert.deepEqual([r?.path, r?.from, r?.status, r?.rows.length], ['new.js', 'old.js', 'R', 0]);
  assert.deepEqual([d?.status, d?.del, d?.rows], ['D', 1, [{ op: '-', text: 'bye', a: 1 }]]);
  assert.equal(b?.binary, true);
  assert.deepEqual([n?.status, n?.add, n?.rows.map((x) => 'text' in x && x.text)], ['A', 2, ['one', 'two']]);
  assert.deepEqual(parseDiff(''), []);
  assert.deepEqual(parseDiff('garbage\nmore'), [], 'nothing before the first header');
});

test('a file past the row cap counts the rest in `more`', () => {
  const body = Array.from({ length: DIFF_LINES + 7 }, (_, i) => `+l${i}`).join('\n');
  const [f] = parseDiff(`diff --git a/big b/big\n@@ -0,0 +1,${DIFF_LINES + 7} @@\n${body}\n`);
  assert.equal(f?.rows.length, DIFF_LINES);
  assert.equal(f?.more, 7);
  assert.equal(f?.add, DIFF_LINES + 7);
});

test('streaming: any chunking gives what parsing the whole text gives (property)', () => {
  const big = Array.from({ length: 40 }, (_, k) => OUT.replaceAll('a.js', `f${k}.js`)).join('\n');
  const whole = parseDiff(big);
  for (let run = 0; run < 300; run++) {
    const p = new DiffParser();
    for (let at = 0; at < big.length; ) {
      const n = 1 + Math.floor(Math.random() * (run % 3 === 0 ? 5 : 400));
      p.push(big.slice(at, at + n));
      at += n;
    }
    assert.deepEqual(p.end(), whole);
  }
  // one character at a time, too
  const p = new DiffParser();
  for (const c of OUT) p.push(c);
  assert.deepEqual(p.end(), parseDiff(OUT));
});

test('splitAt: pieces at lines starting with the mark, never inside a line or after a bare \\r', () => {
  assert.deepEqual(splitAt('head\ndiff --git a\nx\ndiff --git b\n', 'diff --git '), ['head\n', 'diff --git a\nx\n', 'diff --git b\n']);
  assert.deepEqual(splitAt('diff --git a\ndiff --git b', 'diff --git '), ['diff --git a\n', 'diff --git b'], 'a text that starts with the mark: its first piece is the first section');
  assert.deepEqual(splitAt('x\rdiff --git a', 'diff --git '), ['x\rdiff --git a']);
  // property: the pieces join back to the text
  for (let i = 0; i < 200; i++) {
    const t = Array.from({ length: 30 }, () => ['diff --git a/x b/x', '+a', ' b', '\r', 'diff'][Math.floor(Math.random() * 5)]).join(Math.random() < 0.5 ? '\n' : '\r\n');
    assert.equal(splitAt(t, 'diff --git ').join(''), t);
  }
});

test('sectionPath: the header path, a rename or copy target, prefixes optional', () => {
  assert.equal(sectionPath('diff --git a/src/x.js b/src/x.js\nindex 1..2\n'), 'src/x.js');
  assert.equal(sectionPath('diff --git a/old.js b/new.js\nsimilarity index 90%\nrename from old.js\nrename to new.js\n'), 'new.js');
  assert.equal(sectionPath('diff --git x.js x.js\n'), 'x.js', 'diff.noprefix');
  assert.equal(sectionPath('diff --git i/x.js w/x.js\n'), 'x.js', 'mnemonic prefixes');
  assert.equal(sectionPath('diff --git "a/t\\tb" "b/t\\tb"\n'), 't\\tb', 'a quoted path keeps its escapes');
});

test('parseStatus: the branch line, XY and paths, renames with their old name', () => {
  const out = '## wisp/x...origin/wisp/x [ahead 1]\0 M math.js\0?? new.txt\0R  b.js\0a.js\0';
  assert.deepEqual(parseStatus(out), {
    branch: 'wisp/x',
    files: [{ x: ' ', y: 'M', path: 'math.js' }, { x: '?', y: '?', path: 'new.txt' }, { x: 'R', y: ' ', path: 'b.js', from: 'a.js' }],
  });
  assert.equal(parseStatus('## HEAD (no branch)\0').branch, '');
  assert.equal(parseStatus('## No commits yet on main\0').branch, 'main');
  assert.equal(parseStatus('## main\0').branch, 'main');
  assert.deepEqual(parseStatus(''), { branch: '', files: [] });
});
