// A task's mode cap on its page (F-chan-10, src/frame/cap.ts): the row's `capped` is the pill, and the user's mode
// switch above it (Lift, or the mode menu) takes it off in the same frame; a switch within it keeps it.
import { expect, test } from 'vitest';
import { capOf, lifts } from '../src/frame/cap.ts';
import { setMode } from '../src/frame/commands.ts';
import { optimisticOf, patchOps, peekReader } from './command.ts';

test('a_capped_rows_cap_reads_from_its_summary_and_only_a_mode_above_it_lifts_it', () => {
  expect(capOf({ capped: 'edits' })).toBe('edits');
  expect(capOf({ capped: 'plan' })).toBe('plan');
  expect(capOf({ capped: 'auto' }), 'Full auto is no cap').toBeUndefined();
  expect(capOf({})).toBeUndefined();
  expect(capOf(undefined)).toBeUndefined();
  expect(lifts('auto', 'edits')).toBe(true);
  expect(lifts('edits', 'plan')).toBe(true);
  expect(lifts('edits', 'edits')).toBe(false);
  expect(lifts('plan', 'edits')).toBe(false);
  expect(lifts('auto', undefined)).toBe(false);
});

test('lift_is_the_users_mode_switch_its_optimistic_patch_drops_the_cap_with_the_mode', () => {
  const opt = optimisticOf(setMode);
  const capped = peekReader({ id: 's1', summary: { mode: 'edits', capped: 'edits' } });
  expect(patchOps(opt(capped, { id: 'home:s1', mode: 'auto' }))).toEqual([
    { op: 'replace', path: '/summary/mode', value: 'auto' },
    { op: 'remove', path: '/summary/capped' },
  ]);
  // within the cap: the pill stays
  expect(patchOps(opt(capped, { id: 'home:s1', mode: 'plan' }))).toEqual([{ op: 'replace', path: '/summary/mode', value: 'plan' }]);
  // an uncapped task: just the mode (no remove of a path that isn't there, which would fail the patch)
  expect(patchOps(opt(peekReader({ id: 's2', summary: { mode: 'edits' } }), { id: 'home:s2', mode: 'auto' }))).toEqual([{ op: 'replace', path: '/summary/mode', value: 'auto' }]);
});
