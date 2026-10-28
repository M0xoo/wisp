// Comments on an answer: the text they go out as at the top of a follow-up, and reading them back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockLabel, readComments, withComments } from '../web/js/comment-text.js';

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
