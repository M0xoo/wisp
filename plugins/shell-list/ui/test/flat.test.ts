// The sections' folds (docs/v2-round-7.md: on a phone "Needs you" showed folded, its task hidden).
import { expect, test } from 'vitest';
import { isOpenSection } from '../src/model/flat.ts';

test('Needs you and Working start open, Done and Archived folded, and a toggle flips each', () => {
  const none = new Set<never>();
  expect(['needs', 'working', 'scheduled', 'drafts', 'forLater'].map((id) => isOpenSection(id as never, none))).toEqual([true, true, true, true, true]);
  expect(['done', 'archived'].map((id) => isOpenSection(id as never, none))).toEqual([false, false]);
  expect(isOpenSection('needs', new Set(['needs']))).toBe(false);
  expect(isOpenSection('done', new Set(['done']))).toBe(true);
});

test('the_crews_section_goes_right_after_needs_you_on_the_phone_and_first_when_nothing_needs_you', async () => {
  const { flatten, itemKey } = await import('../src/model/flat.ts');
  const task = (k: string) => ({ kind: 'task' as const, key: k as never, s: {} as never });
  const none = { needs: [], working: [], scheduled: [], drafts: [], forLater: [], done: [], archived: [] };
  const sec = { ...none, needs: [task('a')], working: [task('b')] };
  const keys = (o: { crew?: boolean }, s = sec): string[] => flatten(s, { toggled: new Set(), split: false, ...o }).map(itemKey);
  expect(keys({ crew: true })).toEqual(['h:needs', 'a', 'x:shell.list:crew', 'h:working', 'b']);
  // nothing attached (or a split window, where the rail has the crew): no slot
  expect(keys({})).toEqual(['h:needs', 'a', 'h:working', 'b']);
  // nothing needs you: the crew still comes first, as v1's section does
  expect(keys({ crew: true }, { ...none, working: [task('b')] })).toEqual(['x:shell.list:crew', 'h:working', 'b']);
});

test('a compare task is one card: its head and a row per run, inside its section_v1_compare_card', async () => {
  const { flatten, sectionGroups } = await import('../src/model/flat.ts');
  const task = (k: string) => ({ kind: 'task' as const, key: k as never, s: {} as never });
  const run = (k: string) => ({ key: k as never, s: {} as never });
  const group = { kind: 'group' as const, key: 'g:1', runs: [run('r1'), run('r2')], state: 'running' as const, updatedAt: 1 };
  const none = { needs: [], working: [], scheduled: [], drafts: [], forLater: [], done: [], archived: [] };
  const items = flatten({ ...none, working: [task('a'), group as never, task('b')] }, { toggled: new Set(), split: false });
  // h:working, a, g:1, r1, r2, b
  expect(sectionGroups(items)).toEqual([
    { part: 'section.working', from: 0, to: 5 },
    { part: 'list.compare', from: 2, to: 4 },
  ]);
});

test('an /after plan says what it waits for, as v1 did_v1_after_row', async () => {
  const { listPlan } = await import('../src/model/wire.ts');
  expect(listPlan({ id: 'p:1', body: { id: 'p:1', kind: 'task', setAt: 5, after: { id: 'p:s1', title: 'Fix login' }, body: { prompt: 'write the notes' } } })).toMatchObject({
    kind: 'task',
    title: 'write the notes',
    after: 'Fix login',
  });
  expect(listPlan({ id: 'p:2', body: { id: 'p:2', kind: 'task', setAt: 5, draft: true, body: { prompt: 'tidy' } } })).not.toHaveProperty('after');
});

test('done_counts_every_task_and_lists_the_older_ones_past_60_v1_0_24', async () => {
  // F-task-5 (v1 0.24.0: the heading said 60 and older tasks never showed). v2 keeps every row in one VirtualList (only
  // the rows on screen are in the DOM), so the count is the real total and scrolling reaches the oldest.
  const { flatten } = await import('../src/model/flat.ts');
  const task = (k: string) => ({ kind: 'task' as const, key: k as never, s: {} as never });
  const none = { needs: [], working: [], scheduled: [], drafts: [], forLater: [], done: [], archived: [] };
  const done = Array.from({ length: 250 }, (_, i) => task(`d${i}`));
  const items = flatten({ ...none, done, archived: done.slice(0, 70) }, { toggled: new Set(['done', 'archived']), split: false });
  expect(items.find((i) => i.t === 'head' && i.id === 'done')).toMatchObject({ count: 250, open: true });
  expect(items.find((i) => i.t === 'head' && i.id === 'archived')).toMatchObject({ count: 70 });
  const rows = items.filter((i) => i.t === 'entry' && i.section === 'done');
  expect(rows).toHaveLength(250);
  expect(rows.at(-1)).toMatchObject({ entry: { key: 'd249' } });
});

test('pick_several_the_list_holds_their_tasks_grouped_by_project_in_the_picks_order', async () => {
  const { flatten, itemKey } = await import('../src/model/flat.ts');
  const { inProject } = await import('../src/model/sections.ts');
  const task = (k: string, projectId: string, also: string[] = []) => ({
    kind: 'task' as const,
    key: k as never,
    s: { projectId, also: also.map((a) => ({ projectId: a, project: a, color: 'teal' })) } as never,
  });
  expect(inProject({ projectId: 'a' }, 'b,a')).toBe(true);
  expect(inProject({ projectId: 'c' }, 'b,a')).toBe(false);
  expect(inProject({ projectId: 'c', also: [{ projectId: 'a', project: 'api', color: 'teal' as never }] }, 'b,a')).toBe(true);
  expect(inProject({ projectId: 'c' }, 'all')).toBe(true);
  const none = { needs: [], working: [], scheduled: [], drafts: [], forLater: [], done: [], archived: [] };
  const sec = { ...none, needs: [task('1', 'a'), task('2', 'b'), task('3', 'a')], working: [task('4', 'c', ['b'])] };
  const keys = (byProject?: string[]): string[] => flatten(sec, { toggled: new Set(), split: false, byProject }).map(itemKey);
  expect(keys(['b', 'a'])).toEqual(['h:needs', 'j:needs:b', '2', 'j:needs:a', '1', '3', 'h:working', 'j:working:b', '4']);
  // one project, or All: no project lines
  expect(keys(['a'])).toEqual(['h:needs', '1', '2', '3', 'h:working', '4']);
  expect(keys()).toEqual(['h:needs', '1', '2', '3', 'h:working', '4']);
});
