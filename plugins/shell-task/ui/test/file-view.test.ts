// The why-gutter (ADR-0033): each line's task from the repo's agent history, labelled where a new task starts and
// threaded under it after; a line by hand has none. The status says Saved, Unsaved, Saving… or why it can't open.
import { expect, test } from 'vitest';
import { askText, gutterOf, placeOf, statusOf } from '../src/side/file-view.ts';

test('the_why_gutter_marks_where_each_task_starts_and_threads_its_lines', () => {
  const g = gutterOf(
    [
      { n: 1, task: 't1', title: 'Fix login', why: 'the session expired too soon' },
      { n: 2, task: 't1', title: 'Fix login' },
      { n: 3, task: null },
      { n: 4, task: 't1', title: 'Fix login' },
      { n: 5, task: 't2', title: '' },
      { n: 9, task: 't3', title: 'out of range' },
    ],
    5,
  );
  expect(g.map((m) => (m ? `${m.task}${m.first ? '*' : ''}` : '-'))).toEqual(['t1*', 't1', '-', 't1*', 't2*']);
  expect(g[0]?.title).toBe('Fix login: the session expired too soon');
  expect(g[4]?.label).toBe('t2');
  expect(statusOf({ loading: false, saving: false, dirty: true })).toBe('unsaved');
  expect(statusOf({ loading: false, saving: true, dirty: true })).toBe('saving');
  expect(statusOf({ loading: false, saving: false, dirty: false })).toBe('saved');
  expect(statusOf({ loading: false, saving: false, dirty: false, error: 'gone' })).toBe('error');
});

test('go_to_definitions_place_opens_at_its_line_and_the_spark_asks_about_the_file_or_its_lines', () => {
  expect(placeOf('src/text.rs#L12')).toEqual({ file: 'src/text.rs', line: 12 });
  expect(placeOf('src/text.rs')).toEqual({ file: 'src/text.rs' });
  expect(askText('src/a.ts', undefined)).toBe('@src/a.ts ');
  expect(askText('src/a.ts', { from: 3, to: 3 })).toBe('@src/a.ts:3 ');
  expect(askText('src/a.ts', { from: 3, to: 9 })).toBe('@src/a.ts:3-9 ');
});
