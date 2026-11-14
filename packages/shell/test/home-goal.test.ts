import { expect, test } from 'vitest';
import { goalOf, goalSent, isBareGoal } from '../src/frame/goal-gate.ts';

// v1 launcherGoal / goalTaken (F-goal-6): Goal lights while on, every new prompt starts without one
test('home_goal_is_sent_while_on_then_starts_off_with_done_when_empty_and_a_refusal_puts_it_back', () => {
  const on = { on: true, text: 'the tests pass' };
  expect(goalOf(on)).toBe('the tests pass');
  expect(goalOf({ on: false, text: 'the tests pass' })).toBeUndefined();
  const { next, back } = goalSent(on);
  expect(next).toEqual({ on: false, text: '' });
  expect(goalOf(next)).toBeUndefined();
  expect(back).toEqual(on);
  // Goal off: Done when's draft stays for when it's turned on again
  expect(goalSent({ on: false, text: 'kept' }).next).toEqual({ on: false, text: 'kept' });
  expect(isBareGoal(' /Goal ')).toBe(true);
  expect(isBareGoal('/goal tests pass')).toBe(false);
});
