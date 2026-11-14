// Pick several projects (docs/v2-queue.md GUI item 7): click = only, + / ⌘-Enter = add or remove, ⌘1–⌘9 = only,
// All clears, the pick saved in the one device setting and restored, New task's folders (`dirs`, F-comp-47).
import { expect, test } from 'vitest';
import { alsoToggle, dirsOf, launchOf, middle, parsePick, pickHas, pickLabel, pickOnly, pickRemove, pickToggle, pickValue, startAt, taskPlaces } from '../src/frame/project-pick.ts';
import { projectItems, projectShortcuts, togglePick } from '../src/frame/project-switch.ts';
import type { PaletteItem, ShellContext } from '../src/contract.ts';
import type { ProjectView } from '../src/frame/rows-view.ts';

const P = (id: string, name: string, path = `/code/${name}`): ProjectView => ({ id, name, path, color: 'teal' });
const projects = [P('a', 'api'), P('b', 'web'), P('c', 'docs'), P('d', 'infra')];
const t = (k: string, v?: Readonly<Record<string, string | number>>): string => (v ? `${k}:${Object.values(v).join(',')}` : k);

/** A shell with the one device setting, as shell.tsx wires it (set is synchronous for device settings). */
function shellWith(start = 'all'): { ctx: ShellContext; value: () => string } {
  let value = start;
  const rows = projects.map((p) => ({ id: p.id, name: p.name, path: p.path, color: p.color }));
  const ctx = {
    client: { entities: { list: (kind: string) => () => (kind === 'project' ? rows : []) } },
    projectFilter: { value: () => value, set: (v: string) => (value = v || 'all') },
    navigate: () => undefined,
    t,
    platform: { apple: true },
  } as unknown as ShellContext;
  return { ctx, value: () => value };
}
const row = (items: PaletteItem[], id: string): PaletteItem | undefined => items.find((i) => i.id === `project:${id}`);

test('pick_clicking_a_project_shows_only_that_one', () => {
  const s = shellWith('a,b');
  row(projectItems(s.ctx), 'c')?.run?.();
  expect(s.value()).toBe('c');
  expect(pickOnly('c')).toEqual(['c']);
});

test('add_the_plus_adds_a_project_and_its_row_then_shows_a_check_and_a_minus', () => {
  const s = shellWith('a');
  const before = row(projectItems(s.ctx), 'b');
  expect(before?.toggle?.on).toBe(false);
  before?.toggle?.run();
  expect(s.value()).toBe('a,b');
  const after = projectItems(s.ctx);
  expect(row(after, 'b')?.toggle?.on).toBe(true);
  expect(row(after, 'a')?.toggle?.on).toBe(true);
  expect(row(after, 'b')?.toggle?.label).toContain('shell.pick.remove');
  // from All, + starts a pick of one
  expect(pickToggle([], 'c')).toEqual(['c']);
});

test('remove_the_minus_or_a_chips_x_takes_one_out_and_the_last_one_out_is_all', () => {
  const s = shellWith('a,b,c');
  togglePick(s.ctx, 'b');
  expect(s.value()).toBe('a,c');
  expect(pickValue(pickRemove(['a', 'c'], 'a'))).toBe('c');
  expect(pickValue(pickToggle(['c'], 'c'))).toBe('all');
});

test('only_from_several_back_to_one', () => {
  const s = shellWith('a,b');
  row(projectItems(s.ctx), 'a')?.run?.();
  expect(s.value()).toBe('a');
  expect(parsePick(s.value())).toEqual(['a']);
});

test('all_clears_the_pick', () => {
  const s = shellWith('a,b,c');
  projectItems(s.ctx)
    .find((i) => i.id === 'project:all')
    ?.run?.();
  expect(s.value()).toBe('all');
  expect(parsePick('all')).toEqual([]);
  expect(pickHas([], 'anything')).toBe(true);
  expect(pickToggle(['a'], 'all')).toEqual([]);
});

test('restore_the_saved_pick_reads_back_in_order_without_repeats_or_removed_projects', () => {
  // the setting holds 'b,a' after a reload: the same pick, in the order added
  expect(parsePick('b,a')).toEqual(['b', 'a']);
  expect(parsePick(pickValue(['b', 'a']))).toEqual(['b', 'a']);
  expect(parsePick(' b, a ,b,,all')).toEqual(['b', 'a']);
  // a project removed since: it drops out (once the projects are known)
  expect(parsePick('b,gone,a', ['a', 'b'])).toEqual(['b', 'a']);
  expect(parsePick(undefined)).toEqual([]);
  // a reader that knows one project still reads one id when one is picked (v1 wisp.filter)
  expect(pickValue(['a'])).toBe('a');
});

test('cmd_keys_cmd_digits_pick_only_and_cmd_enter_toggles', () => {
  const s = shellWith('a,b');
  const keys = projectShortcuts(s.ctx);
  keys.find((k) => k.keys === 'mod+2')?.run({} as never); // by name: api, docs, infra, web
  expect(s.value()).toBe('c');
  keys.find((k) => k.keys === 'mod+0')?.run({} as never);
  expect(s.value()).toBe('all');
  // ⌘-Enter in the switcher runs the row's toggle (Palette.tsx): the label says the key
  const it = row(projectItems(s.ctx), 'd');
  expect(it?.toggle?.label).toContain('⌘↵');
  it?.toggle?.run();
  expect(s.value()).toBe('d');
});

test('the_top_bar_names_the_pick', () => {
  expect(pickLabel([], t)).toBe('shell.side.all');
  expect(pickLabel([projects[0] as ProjectView], t)).toBe('api');
  expect(pickLabel(projects.slice(0, 2), t)).toBe('api + web');
  expect(pickLabel(projects.slice(0, 3), t)).toBe('api + web + docs');
  expect(pickLabel(projects, t)).toBe('shell.pick.n:4');
  expect(middle('wisp-billing-service-api')).toBe('wisp-bi…ce-api');
  expect(middle('wisp-billing-service-api').length).toBe(14);
});

test('new_task_dirs_start_in_the_first_pick_and_work_in_the_others', () => {
  const l = launchOf(['b', 'gone', 'a', 'c'], projects);
  expect(l).toEqual({ start: 'b', also: ['a', 'c'] });
  const start = projects[1];
  expect(dirsOf(start, l.also, projects)).toEqual(['/code/api', '/code/docs']);
  // leaving one out with its ×, or adding one with + (⌘-click)
  expect(alsoToggle(l.also, 'a')).toEqual(['c']);
  expect(dirsOf(start, alsoToggle(['c'], 'd'), projects)).toEqual(['/code/docs', '/code/infra']);
  // never the folder it starts in, never twice, nothing for a pick of one
  expect(dirsOf(start, ['b', 'a', 'a'], projects)).toEqual(['/code/api']);
  expect(launchOf(['a'], projects)).toEqual({ start: 'a', also: [] });
  expect(launchOf([], projects)).toEqual({ start: undefined, also: [] });
});

test('making_another_chip_the_start_keeps_the_old_start_as_an_extra_folder', () => {
  // an added one made the start: the two swap, in place (round 133 dropped `a`)
  expect(startAt('a', ['b', 'c'], 'b')).toEqual(['a', 'c']);
  expect(startAt('a', ['b', 'c'], 'c')).toEqual(['b', 'a']);
  // one not added, in a task that works in several: the old start stays, first
  expect(startAt('a', ['b'], 'd')).toEqual(['a', 'b']);
  // a one-folder task switching folder: still one folder
  expect(startAt('a', [], 'b')).toEqual([]);
  // the one it starts in, or no folder before: nothing else changes
  expect(startAt('a', ['b'], 'a')).toEqual(['b']);
  expect(startAt(undefined, ['b'], 'c')).toEqual(['b']);
  // and what goes on the wire: the new start's folder, then the old one as a dir
  const next = startAt('a', ['b'], 'b');
  expect(dirsOf(projects[1], next, projects)).toEqual(['/code/api']);
});

test('a_task_page_shows_every_folder_it_works_in_its_own_first', () => {
  const own = { name: 'api', color: 'teal', cwd: '/code/api', projectId: 'a' };
  // own first, then each dir as its project, once each; a folder in no project by its last part, nothing to open
  const places = taskPlaces(own, ['/code/web/src', '/code/web', '/code/api', '/tmp/scratch/', 7], projects);
  expect(places.map((p) => [p.id, p.name, p.own])).toEqual([
    ['a', 'api', true],
    ['b', 'web', undefined],
    [undefined, 'scratch', undefined],
  ]);
  // a worktree checkout of its own project: found by projectId; no dirs: just its own
  expect(taskPlaces({ ...own, cwd: '/wt/api-1a2b3c' }, undefined, projects).map((p) => p.id)).toEqual(['a']);
  // no project named and none holds it: nothing to show; its dirs still show, none of them as where it started
  expect(taskPlaces({ name: '', color: '', cwd: '/elsewhere' }, [], projects)).toEqual([]);
  expect(taskPlaces({ name: '', color: '', cwd: '/elsewhere' }, ['/code/web'], projects).map((p) => [p.id, p.own])).toEqual([['b', undefined]]);
});
