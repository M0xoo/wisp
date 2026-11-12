// A task's menu (src/task-menu.ts, v1 #786 actions.js taskMenuHtml): sections with a line between them, View, Goal,
// Copy and Files submenus, a submenu of one inline, Delete alone, v2's Pin and Mark read after it.
import { expect, test } from 'vitest';
import type { MenuEntry } from '@wisp/ui';
import { menuEntryOf, taskMenu, type TaskMenuEntry } from '../src/task-menu.ts';
import type { ResolvedExtension } from '../src/contract.ts';

const t = (k: string): string => k;
const it = (value: string, at: Omit<TaskMenuEntry, 'entry'>): TaskMenuEntry => ({ entry: { value, label: value }, ...at });
/** the menu as text: separators as '|', a submenu as 'name[items]' */
const shape = (m: readonly MenuEntry[]): string[] =>
  m.map((e) => (e.kind === 'separator' ? '|' : e.kind === 'submenu' ? `${e.label}[${e.items.map((x) => ('value' in x ? x.value : x.kind)).join(',')}]` : e.kind === 'group' ? `(${e.id})` : e.value));

test('v1 #786 groups: open, the task, waiting, View/Goal/crew, Copy/recipe/Files, where it sits, Delete_v1_786_task_menu_groups', () => {
  const entries = [
    it('open', { section: 'open', order: -10 }),
    it('rerun', { section: 'open', order: 10 }),
    it('rename', { section: 'task', order: -10 }),
    it('fork', { section: 'task', order: 20 }),
    it('side', { section: 'task', order: 30 }),
    it('share', { section: 'task', order: 40 }),
    it('ship', { section: 'waiting', order: 50 }),
    it('merge', { section: 'waiting', order: 52 }),
    it('changes', { sub: 'view', order: 60 }),
    it('shell', { sub: 'view', order: 70 }),
    it('review', { sub: 'view', order: 75 }),
    it('run-app', { sub: 'view', order: 80 }),
    it('watch', { sub: 'view', order: 84 }),
    it('compare', { sub: 'view', order: 86 }),
    it('goal-set', { sub: 'goal', order: 110 }),
    it('goal-checks', { sub: 'goal', order: 111 }),
    it('crew', { section: 'look', order: 100 }),
    it('copy-id', { sub: 'copy', order: -20 }),
    it('copy-resume', { sub: 'copy', order: -10 }),
    it('recipe', { section: 'keep', order: 90 }),
    it('editor', { sub: 'files', order: 110 }),
    it('keep', { sub: 'files', order: 120 }),
    it('rollback', { sub: 'files', order: 130 }),
    it('done', { section: 'place', order: -30 }),
    it('later', { section: 'place', order: -20 }),
    it('archive', { section: 'place', order: -10 }),
    it('spell', { order: 5 }), // a plugin with no section: where it sits, after Archive
  ];
  const m = taskMenu({ entries, danger: [{ value: 'delete', label: 'delete', danger: true }], after: [{ value: 'pin', label: 'pin' }], t });
  expect(shape(m)).toEqual([
    'open',
    'rerun',
    '|',
    'rename',
    'fork',
    'side',
    'share',
    '|',
    'ship',
    'merge',
    '|',
    'shell.menu.view[changes,shell,review,run-app,watch,compare]',
    'shell.menu.goal[goal-set,goal-checks]',
    'crew',
    '|',
    'shell.menu.copy[copy-id,copy-resume]',
    'recipe',
    'shell.menu.files[editor,keep,rollback]',
    '|',
    'done',
    'later',
    'archive',
    'spell',
    '|',
    'delete',
    '|',
    'pin',
  ]);
});

test('a submenu of one item stays inline; an empty section leaves no double line_v1_786_task_menu_one_inline', () => {
  const m = taskMenu({ entries: [it('rename', { section: 'task', order: 0 }), it('copy-id', { sub: 'copy', order: 0 }), it('changes', { sub: 'view', order: 60 })], danger: [{ value: 'delete', label: 'delete' }], t });
  expect(shape(m)).toEqual(['rename', '|', 'changes', '|', 'copy-id', '|', 'delete']);
});

test('menuEntryOf: section and sub from bar; legacy place end sits after Save for later_v1_786_task_menu_entry_of', () => {
  const ext = (bar: Record<string, unknown>, order = 50): ResolvedExtension => ({ id: 'p.x', plugin: 'p', config: {}, order, def: { id: 'p.x', attachTo: { id: 'shell.row:menu' }, component: () => null, bar: { icon: 'x', label: 'p.label', priority: order, ...bar } } as never });
  expect(menuEntryOf(ext({ sub: 'files' }, 120), {} as never, t)).toMatchObject({ sub: 'files', order: 120, entry: { value: 'x:p.x', label: 'p.label' } });
  expect(menuEntryOf(ext({ section: 'task', keys: 'K' }), {} as never, t, false).entry).not.toHaveProperty('keys');
  expect(menuEntryOf(ext({ place: 'end' }, 120), {} as never, t)).toMatchObject({ section: 'place', order: -15 });
  expect(menuEntryOf(ext({}), {} as never, t)).not.toHaveProperty('section');
});
