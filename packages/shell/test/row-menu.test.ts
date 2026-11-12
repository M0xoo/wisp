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
