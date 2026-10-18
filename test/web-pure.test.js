// The page's DOM-free modules: markdown and highlighting (web/js/md.js), line diffs
// (web/js/diff.js), display formatters (web/js/core/format.js) and the event bus (web/js/core/bus.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, md, inlineMd, highlight, langOf } from '../web/js/md.js';
import { diffLines, hunks, countChanges } from '../web/js/diff.js';
import { ago, fmtSize, money, pct } from '../web/js/core/format.js';
import * as bus from '../web/js/core/bus.js';

test('esc escapes HTML and treats null as empty', () => {
  assert.equal(esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(42), '42');
});

test('inline markdown: emphasis, code, links; code is not formatted inside', () => {
  assert.equal(inlineMd('**bold** and *it* and _it_ and ~~gone~~'), '<strong>bold</strong> and <em>it</em> and <em>it</em> and <del>gone</del>');
  assert.equal(inlineMd('`**not bold**`'), '<code>**not bold**</code>');
  assert.equal(inlineMd('[docs](https://x.dev/a)'), '<a href="https://x.dev/a" target="_blank" rel="noreferrer">docs</a>');
  assert.equal(inlineMd('see https://x.dev'), 'see <a href="https://x.dev" target="_blank" rel="noreferrer">https://x.dev</a>');
  // Only http(s) links become anchors.
  assert.equal(inlineMd('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
  assert.equal(inlineMd('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
});

test('block markdown: headings, lists, tasks, quotes, tables, fences, rules, paragraphs', () => {
  assert.equal(md('# Title'), '<h3>Title</h3>');
  assert.equal(md('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(md('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
  assert.equal(md('- [x] done\n- [ ] todo'), '<ul><li class="task done">done</li><li class="task ">todo</li></ul>');
  assert.equal(md('- a\n  continued'), '<ul><li>a continued</li></ul>');
  assert.equal(md('> quoted'), '<blockquote><p>quoted</p></blockquote>');
  assert.equal(md('---'), '<hr>');
  assert.equal(md('one\ntwo\n\nthree'), '<p>one two</p><p>three</p>');
  assert.equal(
    md('| a | b |\n|---|---|\n| 1 | 2 |'),
    '<div class="table-wrap"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>',
  );
  assert.equal(md('```\n<b>\n```'), '<pre class="code"><code>&lt;b&gt;</code></pre>');
  assert.equal(md('a\r\nb'), '<p>a b</p>');
  assert.equal(md(), '');
});

test('highlight marks keywords, strings, numbers, comments and types', () => {
  assert.equal(
    highlight('const x = "hi"; // note', 'js'),
    '<span class="tk-k">const</span> x = <span class="tk-s">&quot;hi&quot;</span>; <span class="tk-c">// note</span>',
  );
  assert.equal(highlight('return 42', 'ts'), '<span class="tk-k">return</span> <span class="tk-n">42</span>');
  assert.equal(highlight('new Map()', 'js'), '<span class="tk-k">new</span> <span class="tk-t">Map</span>()');
  // # is a comment only in shell-like languages.
  assert.equal(highlight('# hi', 'sh'), '<span class="tk-c"># hi</span>');
  assert.equal(highlight('#include', 'c'), '#include');
  // Plain text is only escaped.
  assert.equal(highlight('const <x>', 'text'), 'const &lt;x&gt;');
  assert.equal(highlight('const <x>'), 'const &lt;x&gt;');
});

test('langOf maps file extensions to highlighter languages', () => {
  assert.equal(langOf('a/b.mjs'), 'js');
  assert.equal(langOf('x.tsx'), 'ts');
  assert.equal(langOf('ci.yml'), 'yaml');
  assert.equal(langOf('main.go'), 'go');
});

test('diffLines: unchanged, added, removed and replaced lines with line numbers', () => {
  assert.deepEqual(diffLines('a\nb', 'a\nb'), [
    { op: ' ', text: 'a', a: 1, b: 1 },
    { op: ' ', text: 'b', a: 2, b: 2 },
  ]);
  assert.deepEqual(diffLines('', 'x'), [{ op: '+', text: 'x', b: 1 }]);
  assert.deepEqual(diffLines('x', ''), [{ op: '-', text: 'x', a: 1 }]);
  assert.deepEqual(diffLines('a\nold\nc', 'a\nnew\nc'), [
    { op: ' ', text: 'a', a: 1, b: 1 },
    { op: '-', text: 'old', a: 2 },
    { op: '+', text: 'new', b: 2 },
    { op: ' ', text: 'c', a: 3, b: 3 },
  ]);
});

test('hunks keeps context around changes and folds the rest', () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
  const after = before.replace('l10', 'L10');
  const h = hunks(diffLines(before, after), 2);
  assert.deepEqual(
    h.map((o) => (o.op === '…' ? `…${o.count}` : `${o.op}${o.text}`)),
    ['…8', ' l8', ' l9', '-l10', '+L10', ' l11', ' l12', '…7'],
  );
  assert.deepEqual(hunks(diffLines('same', 'same')), []);
});

test('countChanges sums added and removed lines over edits', () => {
  assert.deepEqual(countChanges([{ before: 'a\nb', after: 'a\nc\nd' }, { before: '', after: 'x' }]), { add: 3, del: 1 });
  assert.deepEqual(countChanges(), { add: 0, del: 0 });
});

test('format: relative times, sizes, money and percentages', () => {
  const now = Date.now();
  assert.equal(ago(now - 10_000), 'now');
  assert.equal(ago(now - 5 * 60_000), '5m');
  assert.equal(ago(now - 3 * 3_600_000), '3h');
  assert.equal(ago(now - 2 * 86_400_000), '2d');
  assert.equal(fmtSize(512), '512 B');
  assert.equal(fmtSize(2048), '2 KB');
  assert.equal(fmtSize(3.5 * 1024 * 1024), '3.5 MB');
  assert.equal(money(1.234), '$1.23');
  assert.equal(money(250.6), '$251');
  assert.equal(money(undefined), '$0.00');
  assert.equal(pct(0.456), '46%');
  assert.equal(pct(null), '—');
});

test('bus: subscribers get events; one tied to a node stops once the node is gone', () => {
  const seen = [];
  const node = { isConnected: true };
  const off = bus.on('qa', (d) => seen.push(['free', d]));
  bus.on('qa', (d) => seen.push(['node', d]), { node });
  bus.emit('qa', 1);
  node.isConnected = false;
  bus.emit('qa', 2);
  node.isConnected = true; // dropped for good, even if the node came back
  bus.emit('qa', 3);
  off();
  bus.emit('qa', 4);
  bus.emit('nobody-listens', 5);
  assert.deepEqual(seen, [['free', 1], ['node', 1], ['free', 2], ['free', 3]]);
});
