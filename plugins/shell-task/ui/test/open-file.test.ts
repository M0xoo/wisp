import { expect, test } from 'vitest';
import { fileItems, hitItems } from '../src/side/file-items.ts';

test('F-page-26: open_file_lists_every_file_by_name_the_tasks_changed_ones_first_and_opens_the_pick_v1_open_file_finder', () => {
  const opened: [string, number | undefined][] = [];
  const open = (p: string, l?: number): void => void opened.push([p, l]);
  const rows = fileItems(['README.md', 'src/a.ts', 'src/deep/b.ts', 'web/c.css'], new Set(['web/c.css', 'src/a.ts']), open);
  // changed first (git's order kept inside each heading), then the rest
  expect(rows.map((r) => [r.group, r.label, r.sub ?? ''])).toEqual([
    ['shell-task.files.changed', 'a.ts', 'src'],
    ['shell-task.files.changed', 'c.css', 'web'],
    ['shell-task.files.all', 'README.md', ''],
    ['shell-task.files.all', 'b.ts', 'src/deep'],
  ]);
  // the whole path matches too (a folder's name finds its files)
  expect(rows.every((r) => r.keywords !== undefined && r.keywords.endsWith(r.label))).toBe(true);
  rows[3]?.run?.();
  expect(opened).toEqual([['src/deep/b.ts', undefined]]);
  expect(fileItems([], new Set(), open)).toEqual([]);
});

test('F-page-26: a_text_hit_opens_its_file_at_the_line_v1_grep_in', () => {
  const opened: [string, number | undefined][] = [];
  const rows = hitItems([{ path: 'src/auth.js', line: 40, text: 'const ttl = 60' }], (p, l) => void opened.push([p, l]));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ group: 'shell-task.files.inFiles', label: 'auth.js:40', sub: 'const ttl = 60', icon: 'search' });
  rows[0]?.run?.();
  expect(opened).toEqual([['src/auth.js', 40]]);
});
