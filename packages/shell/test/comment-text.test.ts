import { expect, test } from 'vitest';
import { blockLabel, readComments } from '../src/frame/comment-text.ts';

// the exact envelope wisp.shell-task's withComments sends (plugins/shell-task/ui/test/comments.test.ts)
const SENT =
  '<comments>\n1. On "src/math.js", line 2:\n>   return a + b;\nWhy plus?\n\n2. On "src/math.js", removed line 2 (numbered as before the change):\n>   return a - b;\n</comments>\n\nAlso run the tests.';

test('a sent prompt with diff comments reads back as cards and the words typed with them_v1_comment_text', () => {
  const { notes, rest } = readComments(SENT);
  expect(rest).toBe('Also run the tests.');
  expect(notes).toEqual([
    { n: 1, label: 'src/math.js:2', kind: 'line', removed: false, quote: '  return a + b;', note: 'Why plus?' },
    { n: 2, label: 'src/math.js:2', kind: 'line', removed: true, quote: '  return a - b;', note: '' },
  ]);
  // comments alone (Send comments): no words after them
  expect(readComments('<comments>\n1. On "a.ts", lines 4–6:\n> x\n> y\nTidy\n</comments>').rest).toBe('');
  expect(readComments('<comments>\n1. On "a.ts", lines 4–6:\n> x\n> y\nTidy\n</comments>').notes[0]?.label).toBe('a.ts:4–6');
  // a prompt that only looks like it stays as typed
  expect(readComments('<comments>\nnot ours\n</comments>\nhi')).toEqual({ notes: [], rest: '<comments>\nnot ours\n</comments>\nhi' });
  expect(readComments('plain')).toEqual({ notes: [], rest: 'plain' });
});

test('F-page-10: a_comment_names_its_block_as_v1_did_v1_block_label', () => {
  expect(blockLabel({ type: 'diff', file: 'server/auth.js' })).toBe('Diff · server/auth.js');
  expect(blockLabel({ type: 'markdown', text: 'Hi' })).toBe('Text');
  // a picture by its caption (wisp's copy has a name the agent never chose), else its file's name
  expect(blockLabel({ type: 'image', path: '/Users/me/.wisp/shots/t/1-0.png', caption: 'After "the fix"' })).toBe("Image · After 'the fix'");
  expect(blockLabel({ type: 'doc', path: 'docs/plan.md' })).toBe('Doc · plan.md');
  expect(blockLabel({ type: 'terminal', command: 'npm test' })).toBe('Terminal · npm test');
  expect(blockLabel({ type: 'hologram' })).toBe('Hologram');
  expect(blockLabel({})).toBe('Answer');
  expect(blockLabel({ type: 'callout', title: 'x'.repeat(100) })).toHaveLength(72);
  expect(blockLabel({ type: 'callout', title: 'two\nlines' })).toBe('Callout · two lines');
});

test('F-page-10: what_shell_task_sends_reads_back_as_the_cards_over_the_prompt', () => {
  const prompt = '<comments>\n1. On "Text", where it says:\n> one two\nShorter\n\n2. On "Diff · a.js" in your answer to "Fix it":\nWhy?\n</comments>\n\nGo';
  const r = readComments(prompt);
  expect(r.rest).toBe('Go');
  expect(r.notes.map((n) => [n.kind, n.label, n.quote, n.note])).toEqual([
    ['text', 'Text', 'one two', 'Shorter'],
    ['block', 'Diff · a.js', '', 'Why?'],
  ]);
});
