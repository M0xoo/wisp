// A task's row menu (model/menu.ts, v1 actions.js taskMenu): the list's own entries in v1's order and words, the
// ones plugins attach to `shell.row:menu` after Copy task ID, `place: 'end'` ones after Save for later, no separators;
// v2's own Pin and Mark read after every v1 entry (the owner, round 30).
import { expect, test } from 'vitest';
import type { MenuEntry } from '@wisp/ui';
import { rowMenu } from '../src/model/menu.ts';
import type { SessionRow } from '../src/types.ts';

const t = (k: string): string => k.replace('shell-list.menu.', '');
const row = (o: Partial<SessionRow> = {}): SessionRow => ({ id: 's1', title: 'Write docs', agent: 'claude', state: 'review', createdAt: 0, updatedAt: 0, ...o }) as SessionRow;
const values = (m: readonly MenuEntry[]): string[] => m.map((e) => ('value' in e ? String(e.value) : `(${e.kind})`));

test('plugin entries sit between Copy task ID and the triage, Keep worktree after Save for later, no separators_v1_task_menu', () => {
  const plugins: MenuEntry[] = ['rerun', 'fork', 'side', 'share', 'ship', 'changes', 'shell', 'run', 'recipe', 'crew', 'goal'].map((v) => ({ value: `x:${v}`, label: v }));
  const end: MenuEntry[] = [{ value: 'x:keep', label: 'Keep worktree' }];
  const m = rowMenu({ s: row(), t, plugins, end, keys: true });
  expect(values(m)).toEqual([
    'open',
    'rename',
    'copy-id',
    'x:rerun',
    'x:fork',
    'x:side',
    'x:share',
    'x:ship',
    'x:changes',
    'x:shell',
    'x:run',
    'x:recipe',
    'x:crew',
    'x:goal',
    'later',
    'x:keep',
    'done',
    'archive',
    'delete',
    'pin',
    'read',
  ]);
  expect(m.some((e) => 'kind' in e && e.kind === 'separator')).toBe(false);
  // a busy task: no Mark done, no Archive (v1)
  expect(values(rowMenu({ s: row({ state: 'running' }), t, plugins: [], keys: true }))).toEqual(['open', 'rename', 'copy-id', 'delete', 'pin']);
});
