import { expect, test } from 'vitest';
import { added, isLine, lineKey, lineLabel, marksOn, placeOf, removed, waiting, whereOf, withComments, type AnswerComment, type LineComment } from '../src/comments.ts';

/** the value, or the test fails here: a place the test expects to exist */
function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('expected a value');
  return v;
}

test('comments_on_diff_lines_go_out_at_the_top_of_the_next_follow_up_in_v1_words', () => {
  const add = placeOf('src/math.js', { op: '+', a: undefined, b: 2, text: '  return a + b;' });
  const del = placeOf('src/math.js', { op: '-', a: 2, b: undefined, text: '  return a - b;' });
  expect(placeOf('src/math.js', { op: '…' })).toBeUndefined();
  expect(add).toEqual({ file: 'src/math.js', side: 'new', line: 2, code: '  return a + b;' });
  expect(lineKey('old', 2)).toBe('o2');
  expect(lineLabel(must(del))).toBe('math.js:2 (removed)');
  const first: LineComment = { ...must(add), note: 'Why plus?' };
  const list: LineComment[] = [first, { ...must(del), note: '' }];
  expect(withComments(list, '  Also run the tests. ')).toBe(
    '<comments>\n1. On "src/math.js", line 2:\n>   return a + b;\nWhy plus?\n\n2. On "src/math.js", removed line 2 (numbered as before the change):\n>   return a - b;\n</comments>\n\nAlso run the tests.',
  );
  expect(withComments([], 'just text')).toBe('just text');
  // per task; a second comment on the same line replaces the first; removing the last forgets the task
  let all = added({}, 't1', first);
  all = added(all, 't1', { ...first, note: 'Better: why plus?' });
  expect(waiting(all, 't1').map((c) => c.note)).toEqual(['Better: why plus?']);
  expect(waiting(all, 't2')).toEqual([]);
  expect(removed(all, 't1', 0)).toEqual({});
});

test('F-page-10: comments_on_an_answer_go_out_in_v1_words_numbered_with_the_line_ones_v1_with_comments', () => {
  const words: AnswerComment = { turn: 't2', i: 0, label: 'Text', kind: 'text', quote: 'one\ntwo', note: ' Shorter ' };
  const block: AnswerComment = { turn: 't1', i: 3, label: 'Diff · "a".js', kind: 'block', note: 'Why?', of: 'Fix  "the" login bug, and then make sure every test passes again' };
  // the same text packages/shell's readComments reads back into cards (packages/shell/test/comment-text.test.ts)
  expect(withComments([words, block], ' Go ')).toBe(
    '<comments>\n1. On "Text", where it says:\n> one\n> two\nShorter\n\n2. On "Diff · \'a\'.js" in your answer to "Fix \'the\' login bug, and then make sure every t…":\nWhy?\n</comments>\n\nGo',
  );
  // kept with the line comments of Changes: one list, one numbering; an answer's are never merged (v1)
  let all: unknown = {};
  const line: LineComment = { file: 'src/math.js', side: 'new', line: 2, code: 'x', note: 'n' };
  all = added(all, 'p:task', line);
  all = added(all, 'p:task', words);
  all = added(all, 'p:task', words);
  all = added(all, 'p:task', block);
  const list = waiting(all, 'p:task');
  expect(list).toHaveLength(4);
  expect(list.map(isLine)).toEqual([true, false, false, false]);
  expect(marksOn(list, 't2')).toEqual([
    { n: 2, i: 0, quote: 'one\ntwo', note: ' Shorter ' },
    { n: 3, i: 0, quote: 'one\ntwo', note: ' Shorter ' },
  ]);
  expect(marksOn(list, 't1')).toEqual([{ n: 4, i: 3, note: 'Why?' }]);
  expect(list.map(whereOf)).toEqual(['math.js:2', '“one two”', '“one two”', 'Diff · "a".js']);
  // a line comment saved before answers took comments (no `kind`) is still a line's
  expect(isLine({ file: 'a', side: 'old', line: 1, code: '', note: '' })).toBe(true);
});
