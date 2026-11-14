import { expect, test } from 'vitest';
import { crewItems, slashItems, stuffItems, taskItems } from '../src/prompt.ts';
import { HOME_SLASH, SLASH } from '../src/text/slash.ts';

test('the_at_menu_names_tasks_crew_and_stuff_by_what_is_typed_and_the_slash_menu_its_commands', () => {
  const tasks = [
    { id: 'laptop:a', title: 'Fix the login bug', updated_at: 1 },
    { id: 'laptop:b', title: 'Fix the flaky test', updated_at: 5 },
    { id: 'laptop:c', title: 'Fix old thing', updated_at: 9, archived: true },
    { id: 'laptop:d', title: 'Write docs', updated_at: 3 },
  ];
  // by the words, newest first, never archived, never the open task
  expect(taskItems(tasks, 'fix').map((x) => x.label)).toEqual(['Fix the flaky test', 'Fix the login bug']);
  expect(taskItems(tasks, 'fix', 'laptop:b').map((x) => x.label)).toEqual(['Fix the login bug']);
  expect(taskItems(tasks, 'login')[0]).toMatchObject({ insert: '@Fix the login bug ', mention: { scheme: 'wisp', id: 'a', title: 'Fix the login bug' } });
  expect(crewItems([{ id: 'ada', name: 'Ada', role: 'Reviews every PR' }], 'ad')[0]).toMatchObject({ label: 'Ada', detail: 'Reviews every PR', mention: { scheme: 'crew', id: 'ada' } });
  expect(stuffItems([{ id: 's1', title: 'Release checklist', kind: 'app' }], 'release')[0]).toMatchObject({ insert: '@Release checklist ', mention: { scheme: 'stuff', id: 's1' } });
  // commands: the reply box's own, New task's own; a bare command inserts no space
  const t = (k: string): string => k;
  expect(slashItems(SLASH, 'g', t).map((x) => x.label)).toEqual(['/goal']);
  expect(slashItems(SLASH, 'g', t)[0]?.insert).toBe('/goal');
  expect(slashItems(SLASH, 'bt', t)[0]?.insert).toBe('/btw ');
  expect(slashItems(HOME_SLASH, 'bt', t)).toEqual([]);
  expect(slashItems(HOME_SLASH, 'te', t).map((x) => x.label)).toEqual(['/terminal']);
});

test('a_tasks_files_in_the_at_menu_insert_their_path_and_open_in_the_file_view', async () => {
  const { fileItems } = await import('../src/prompt.ts');
  const opened: string[] = [];
  const items = fileItems(['src/auth/login.ts', 'src/app.ts', 'docs/login-flow.md', 'README.md'], 'login', (f) => opened.push(f));
  expect(items.map((i) => i.value)).toEqual(['file:src/auth/login.ts', 'file:docs/login-flow.md']);
  expect(items[0]).toMatchObject({ label: 'login.ts', detail: 'src/auth', insert: '@src/auth/login.ts ', icon: 'file' });
  items[0]?.open?.();
  expect(opened).toEqual(['src/auth/login.ts']);
  expect(fileItems(['a.ts'], 'zzz', () => undefined)).toEqual([]);
});
