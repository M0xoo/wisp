import { expect, test } from 'vitest';
import { added, lineKey, lineLabel, placeOf, removed, waiting, withComments } from '../src/comments.ts';

test('comments_on_diff_lines_go_out_at_the_top_of_the_next_follow_up_in_v1_words', () => {
  const add = placeOf('src/math.js', { op: '+', a: undefined, b: 2, text: '  return a + b;' });
  const del = placeOf('src/math.js', { op: '-', a: 2, b: undefined, text: '  return a - b;' });
  expect(placeOf('src/math.js', { op: '…' })).toBeUndefined();
  expect(add).toEqual({ file: 'src/math.js', side: 'new', line: 2, code: '  return a + b;' });
  expect(lineKey('old', 2)).toBe('o2');
  expect(lineLabel({ ...(del as NonNullable<typeof del>) })).toBe('math.js:2 (removed)');
  const list = [
    { ...(add as NonNullable<typeof add>), note: 'Why plus?' },
    { ...(del as NonNullable<typeof del>), note: '' },
  ];
  expect(withComments(list, '  Also run the tests. ')).toBe(
    '<comments>\n1. On "src/math.js", line 2:\n>   return a + b;\nWhy plus?\n\n2. On "src/math.js", removed line 2 (numbered as before the change):\n>   return a - b;\n</comments>\n\nAlso run the tests.',
  );
  expect(withComments([], 'just text')).toBe('just text');
  // per task; a second comment on the same line replaces the first; removing the last forgets the task
  let all = added({}, 't1', list[0] as never);
  all = added(all, 't1', { ...(list[0] as never), note: 'Better: why plus?' });
  expect(waiting(all, 't1').map((c) => c.note)).toEqual(['Better: why plus?']);
  expect(waiting(all, 't2')).toEqual([]);
  expect(removed(all, 't1', 0)).toEqual({});
});
