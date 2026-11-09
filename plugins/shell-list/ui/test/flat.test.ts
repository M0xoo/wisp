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
