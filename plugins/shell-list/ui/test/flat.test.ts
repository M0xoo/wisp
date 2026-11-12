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
