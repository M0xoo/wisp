// Comments on an answer: the text they go out as at the top of a follow-up, and reading them back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockLabel, lineComment, readComments, withComments } from '../web/js/comment-text.js';

test('a block is named by its kind and which one', () => {
  assert.equal(blockLabel({ type: 'diff', file: 'server/auth.js' }), 'Diff · server/auth.js');
  assert.equal(blockLabel({ type: 'image', path: 'shots/after.png' }), 'Image · after.png');
  assert.equal(blockLabel({ type: 'image', path: 'x/65c8-3.png', caption: 'Login page' }), 'Image · Login page');
  assert.equal(blockLabel({ type: 'tests', command: 'npm test' }), 'Tests · npm test');
  assert.equal(blockLabel({ type: 'markdown', text: 'x' }), 'Text');
  assert.equal(blockLabel({ type: 'callout', title: 'Say "hi"' }), "Callout · Say 'hi'"); // no quotes inside its quotes
  assert.ok(blockLabel({ type: 'code', file: 'a/'.repeat(80) + 'b.js' }).length <= 72);
});

test('comments lead the follow-up, in words the agent reads', () => {
  const text = withComments(
    [
      { label: 'Diff · server/auth.js', kind: 'text', quote: 'const ttl = 60', note: 'Make this configurable.' },
      { label: 'Image · after.png', kind: 'point', x: 42.4, y: 61.2, note: 'The button is cut off here.' },
      { label: 'Video · demo.mp4', kind: 'point', x: 10, y: 90, at: 72, note: '' },
      { label: 'Tests · npm test', kind: 'block', note: 'Why is one skipped?', of: 'fix the "login" bug' },
    ],
    'Also run the tests.',
  );
  assert.equal(
    text,
    [
      '<comments>',
      '1. On "Diff · server/auth.js", where it says:',
      '> const ttl = 60',
      'Make this configurable.',
      '',
      '2. On "Image · after.png", at the spot 42% across and 61% down:',
      'The button is cut off here.',
      '',
      '3. On "Video · demo.mp4", at 1:12, the spot 10% across and 90% down:',
      '',
      `4. On "Tests · npm test" in your answer to "fix the 'login' bug":`,
      'Why is one skipped?',
      '</comments>',
      '',
      'Also run the tests.',
    ].join('\n'),
  );
});

test('a sent prompt reads back into its comments and what was typed', () => {
  const sent = withComments(
    [
      { label: 'Text', kind: 'text', quote: 'line one\nline two', note: 'Shorter,\nplease.' },
      { label: 'Video · demo.mp4', kind: 'point', x: 10, y: 90, at: 72, note: 'Flicker' },
      { label: 'Tests · npm test', kind: 'block', note: '', of: 'earlier' },
    ],
    'And the docs.',
  );
  const { notes, rest } = readComments(sent);
  assert.equal(rest, 'And the docs.');
  assert.deepEqual(
    notes.map(({ n, label, kind, quote, note, at, x, y, earlier }) => ({ n, label, kind, quote, note, at, x, y, earlier })),
    [
      { n: 1, label: 'Text', kind: 'text', quote: 'line one\nline two', note: 'Shorter,\nplease.', at: '', x: null, y: null, earlier: false },
      { n: 2, label: 'Video · demo.mp4', kind: 'point', quote: '', note: 'Flicker', at: '1:12', x: 10, y: 90, earlier: false },
      { n: 3, label: 'Tests · npm test', kind: 'block', quote: '', note: '', at: '', x: null, y: null, earlier: true },
    ],
  );
  // Comments alone: nothing typed after them.
  assert.equal(readComments(withComments([{ label: 'Text', kind: 'block', note: 'ok' }])).rest, '');
});

test('a prompt that only looks like comments shows as it was typed', () => {
  assert.deepEqual(readComments('fix the bug'), { notes: [], rest: 'fix the bug' });
  const odd = '<comments>\nnot a numbered comment\n</comments>\n\nhi';
  assert.deepEqual(readComments(odd), { notes: [], rest: odd });
});

// Rows as the side panel's Changes has them: { op, text, a: old number, b: new number }.
const ROWS = [
  { op: ' ', text: 'function login(user) {', a: 40, b: 40 },
  { op: '-', text: '  if (!user) return', a: 41 },
  { op: '+', text: '  if (!user) return deny()', b: 41 },
  { op: '+', text: '', b: 42 },
  { op: ' ', text: '  const ttl = 60', a: 42, b: 43 },
];

test('a diff line is named by its file and number, as the file is now', () => {
  const one = lineComment('server/auth.js', [ROWS[4]]);
  assert.deepEqual(one, { kind: 'line', file: 'server/auth.js', side: 'new', from: 43, to: 43, mixed: false, quote: '  const ttl = 60', label: 'server/auth.js:43' });
  const added = lineComment('server/auth.js', ROWS.slice(2, 4));
  assert.equal(added.label, 'server/auth.js:41–42');
  assert.equal(added.quote, '  if (!user) return deny()\n');
  // Only removed: its old number, and it says so.
  const gone = lineComment('server/auth.js', [ROWS[1]]);
  assert.equal(gone.side, 'old');
  assert.equal(gone.label, 'server/auth.js:41');
  // Removed and added together: numbered by the new lines, each line marked.
  const mixed = lineComment('server/auth.js', ROWS);
  assert.equal(mixed.label, 'server/auth.js:40–43');
  assert.equal(mixed.quote, '  function login(user) {\n-   if (!user) return\n+   if (!user) return deny()\n+ \n    const ttl = 60');
  // A long range is cut; its numbers say the rest.
  const long = lineComment('a.js', Array.from({ length: 60 }, (_, i) => ({ op: '+', text: `x${i}`, b: i + 1 })));
  assert.equal(long.label, 'a.js:1–60');
  assert.equal(long.quote.split('\n').length, 40);
  assert.equal(long.quote.split('\n').at(-1), '…');
});

test('comments on diff lines go out with the file, the lines and the code', () => {
  const text = withComments(
    [
      { ...lineComment('server/auth.js', [ROWS[4]]), note: 'Make this configurable.' },
      { ...lineComment('server/auth.js', [ROWS[1]]), note: 'Why drop this?' },
      { ...lineComment('server/auth.js', ROWS.slice(1, 3)), note: '' },
      { ...lineComment('web/"odd".js', ROWS.slice(2, 4)), note: 'Two lines' },
    ],
    'Then run the tests.',
  );
  assert.equal(
    text,
    [
      '<comments>',
      '1. On "server/auth.js", line 43:',
      '>   const ttl = 60',
      'Make this configurable.',
      '',
      '2. On "server/auth.js", removed line 41 (numbered as before the change):',
      '>   if (!user) return',
      'Why drop this?',
      '',
      '3. On "server/auth.js", line 41 (removed lines marked -, added +):',
      '> -   if (!user) return',
      '> +   if (!user) return deny()',
      '',
      `4. On "web/'odd'.js", lines 41–42:`,
      '>   if (!user) return deny()',
      '> ',
      'Two lines',
      '</comments>',
      '',
      'Then run the tests.',
    ].join('\n'),
  );
});

test('a sent prompt reads diff-line comments back, next to the others', () => {
  const sent = withComments(
    [
      { ...lineComment('server/auth.js', ROWS.slice(2, 4)), note: 'Shorter,\nplease.' },
      { ...lineComment('server/auth.js', [ROWS[1]]), note: 'Keep it' },
      { label: 'Text', kind: 'text', quote: 'line one', note: 'ok' },
    ],
    'And the docs.',
  );
  const { notes, rest } = readComments(sent);
  assert.equal(rest, 'And the docs.');
  assert.deepEqual(
    notes.map(({ n, label, file, kind, side, from, to, quote, note }) => ({ n, label, file, kind, side, from, to, quote, note })),
    [
      { n: 1, label: 'server/auth.js:41–42', file: 'server/auth.js', kind: 'line', side: 'new', from: 41, to: 42, quote: '  if (!user) return deny()\n', note: 'Shorter,\nplease.' },
      { n: 2, label: 'server/auth.js:41', file: 'server/auth.js', kind: 'line', side: 'old', from: 41, to: 41, quote: '  if (!user) return', note: 'Keep it' },
      { n: 3, label: 'Text', file: undefined, kind: 'text', side: undefined, from: undefined, to: undefined, quote: 'line one', note: 'ok' },
    ],
  );
  // A blank line of code whose trailing space was trimmed on the way still reads as code.
  const trimmed = sent.replace(/^> $/m, '>');
  assert.equal(readComments(trimmed).notes[0].quote, '  if (!user) return deny()\n');
});
