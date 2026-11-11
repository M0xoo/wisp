// v1 #772: one stored project order used wherever projects show; a task belongs to the project that holds its folder.
import { expect, test } from 'vitest';
import { movedOrder, projectList, projectOf } from '../src/frame/rows-view.ts';

test('projects_read_from_their_rows_in_your_order_and_a_task_is_in_the_project_holding_its_folder', () => {
  const rows = [
    { id: 'web', body: { path: '/w/web', color: 'teal' } },
    { id: 'api', body: { path: '/w/api' } },
    { id: 'api-docs', body: { path: '/w/api/docs' } },
  ];
  // never placed: by name
  expect(projectList(rows, undefined).map((p) => p.id)).toEqual(['api', 'api-docs', 'web']);
  // your order first, the rest after by name; a stale name in the order is ignored
  const list = projectList(rows, ['web', 'gone', 'api-docs']);
  expect(list.map((p) => p.id)).toEqual(['web', 'api-docs', 'api']);
  expect(list[0]).toEqual({ id: 'web', name: 'web', path: '/w/web', color: 'teal' });
  // the deepest project that holds the folder; a sibling with the same prefix doesn't
  expect(projectOf('/w/api/docs/src', list)?.id).toBe('api-docs');
  expect(projectOf('/w/api', list)?.id).toBe('api');
  expect(projectOf('/w/apiary', list)).toBeUndefined();
  expect(projectOf(undefined, list)).toBeUndefined();
  // drag: before the one dropped on, or to the end
  expect(movedOrder(list, 'api', 'web')).toEqual(['api', 'web', 'api-docs']);
  expect(movedOrder(list, 'web', undefined)).toEqual(['api-docs', 'api', 'web']);
});

test('a_new_projects_name_comes_from_its_folder_or_url_and_never_takes_one_in_use', async () => {
  const { nameFor } = await import('../src/frame/Projects.tsx');
  expect(nameFor('/Users/me/code/web-app/', [])).toBe('web-app');
  expect(nameFor('https://github.com/acme/api.git', [])).toBe('api');
  expect(nameFor('git@github.com:acme/api.git', ['api', 'api-2'])).toBe('api-3');
  expect(nameFor('/w/My App', [])).toBe('My-App');
});

test('a_found_repo_shows_where_it_is_as_v1_did', async () => {
  const { whereIs } = await import('../src/frame/Projects.tsx');
  expect(whereIs('/Users/me/code/web')).toBe('~/code');
  expect(whereIs('/home/me/src/api/')).toBe('~/src');
  expect(whereIs('/opt/repos/x')).toBe('/opt/repos');
});
