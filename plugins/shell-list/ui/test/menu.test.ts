// A task's row menu (model/menu.ts, v1 #786 actions.js taskMenuHtml): the list's own entries in v1's sections, the
// ones plugins attach to `shell.row:menu` placed by their section / submenu (View ›, Goal ›, Copy ›, Files ›), a line
// between sections, Delete alone; v2's own Pin and Mark read after every v1 entry (the owner, round 30).
import { expect, test } from 'vitest';
import type { TaskMenuEntry } from '@wisp/shell';
import type { MenuEntry } from '@wisp/ui';
import { rowMenu } from '../src/model/menu.ts';
import type { SessionRow } from '../src/types.ts';

const t = (k: string): string => k.replace('shell-list.menu.', '').replace('shell.menu.', '');
const row = (o: Partial<SessionRow> = {}): SessionRow => ({ id: 's1', title: 'Write docs', agent: 'claude', state: 'review', createdAt: 0, updatedAt: 0, ...o }) as SessionRow;
const values = (m: readonly MenuEntry[]): string[] =>
  m.map((e) => (e.kind === 'separator' ? '|' : e.kind === 'submenu' ? `${e.label}[${e.items.map((x) => ('value' in x ? x.value : x.kind)).join(',')}]` : 'value' in e ? e.value : e.kind));
const x = (v: string, at: Omit<TaskMenuEntry, 'entry'>): TaskMenuEntry => ({ entry: { value: `x:${v}`, label: v }, ...at });

// what the built-ins attach, with their bar.section / bar.sub and order (row-menu.ts, ship, goal, crew, worktrees…)
const plugins: TaskMenuEntry[] = [
  x('rerun', { section: 'open', order: 10 }),
  x('fork', { section: 'task', order: 20 }),
  x('side', { section: 'task', order: 30 }),
  x('share', { section: 'task', order: 40 }),
  x('ship', { section: 'waiting', order: 50 }),
  x('merge', { section: 'waiting', order: 52 }),
  x('changes', { sub: 'view', order: 60 }),
  x('shell', { sub: 'view', order: 70 }),
  x('review', { sub: 'view', order: 75 }),
  x('run', { sub: 'view', order: 80 }),
  x('recipe', { section: 'keep', order: 90 }),
  x('crew', { section: 'look', order: 100 }),
  x('goal-set', { sub: 'goal', order: 110 }),
  x('goal-checks', { sub: 'goal', order: 111 }),
  x('keep', { sub: 'files', order: 120 }),
];

test('v1 #786: sections, View/Goal/Copy/Files submenus, Delete alone, Pin and Mark read last_v1_786_row_menu_groups', () => {
  expect(values(rowMenu({ s: row(), t, plugins, keys: true }))).toEqual([
    'open',
    'x:rerun',
    '|',
    'rename',
    'x:fork',
    'x:side',
    'x:share',
    '|',
    'x:ship',
    'x:merge',
    '|',
    'view[x:changes,x:shell,x:review,x:run]',
    'goal[x:goal-set,x:goal-checks]',
    'x:crew',
    '|',
    'copy-id',
    'x:recipe',
    'x:keep',
    '|',
    'done',
    'later',
    'archive',
    '|',
    'delete',
    '|',
    'pin',
    'read',
  ]);
});

test('a busy task: no Mark done, no Archive, no Mark read; one-item submenus stay inline_v1_786_row_menu_busy', () => {
  expect(values(rowMenu({ s: row({ state: 'running' }), t, plugins: [], keys: true }))).toEqual(['open', '|', 'rename', '|', 'copy-id', '|', 'delete', '|', 'pin']);
});

test('no key hints on touch screens_v1_786_row_menu_keys', () => {
  const m = rowMenu({ s: row(), t, plugins: [], keys: false });
  expect(m.some((e) => 'keys' in e && e.keys)).toBe(false);
});
