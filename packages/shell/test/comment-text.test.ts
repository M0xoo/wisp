import { expect, test } from 'vitest';
import { readComments } from '../src/frame/comment-text.ts';

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
