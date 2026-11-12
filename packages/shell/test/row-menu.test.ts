// The shell's entries in a task's row menu (frame/row-menu.ts, v1 actions.js forkable, side.js sideable).
import { expect, test } from 'vitest';
import { forkable, sideable } from '../src/frame/row-menu.ts';

test('fork and side discussion only on a task of yours, as v1_v1_forkable_sideable', () => {
  const mine = { id: 'local:s1', agent: 'claude' };
  expect([forkable(mine), sideable(mine)]).toEqual([true, true]);
  for (const odd of [{ agent: 'wisp' }, { parentId: 's0' }, { pending: true }, { delegated: true }, { sideOf: { id: 's0' } }]) {
    expect(forkable({ ...mine, ...odd })).toBe(false);
    expect(sideable({ ...mine, ...odd })).toBe(false);
  }
  // a reminder can't fork; a task on another computer has no side discussion, but forks
  expect(forkable({ ...mine, kind: 'reminder' })).toBe(false);
  expect(sideable({ ...mine, machine: { id: 'box' } })).toBe(false);
  expect(forkable({ ...mine, machine: { id: 'box' } })).toBe(true);
  expect(forkable(undefined)).toBe(false);
});

test('the shell row entries sit in v1 #786 groups; Copy resume needs a resume id, the editor a desktop_v1_786_row_entries', async () => {
  const { rowMenuItems } = await import('../src/frame/row-menu.ts');
  const at = (mobile: boolean) => Object.fromEntries(rowMenuItems({ platform: { mobile } } as never).map((d) => [d.id, d]));
  const xs = at(false);
  const place = (id: string): string | undefined => xs[id]?.bar?.sub ?? xs[id]?.bar?.section;
  expect(['shell.row.rerun', 'shell.row.fork', 'shell.row.side', 'shell.row.changes', 'shell.row.shell', 'shell.row.compare', 'shell.row.copyResume', 'shell.row.editor'].map(place)).toEqual([
    'open',
    'task',
    'task',
    'view',
    'view',
    'view',
    'copy',
    'files',
  ]);
  const p = (s: object) => ({ session: () => ({ id: 'local:s1', agent: 'claude', ...s }) }) as never;
  expect(xs['shell.row.copyResume']?.if?.(p({}))).toBe(false);
  expect(xs['shell.row.copyResume']?.if?.(p({ resumeId: 'abc' }))).toBe(true);
  expect(xs['shell.row.editor']?.if?.(p({}))).toBe(true);
  expect(at(true)['shell.row.editor']?.if?.(p({}))).toBe(false);
});
