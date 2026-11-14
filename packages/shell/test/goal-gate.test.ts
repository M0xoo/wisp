import { expect, test } from 'vitest';
import { goalGate } from '../src/frame/goal-gate.ts';

test('send_with_goal_on_and_done_when_empty_asks_first_instead_of_starting_a_one_shot_task', () => {
  // Goal on, Done when empty: ask (v1 sent it without a goal, with only a toast)
  expect(goalGate('fix the login', '')).toBe('askGoal');
  expect(goalGate('fix the login', '   ')).toBe('askGoal');
  // Goal off, or filled: send
  expect(goalGate('fix the login', undefined)).toBe('send');
  expect(goalGate('fix the login', 'the tests pass')).toBe('send');
  // a goal with nothing to do says so; an empty box with no goal just takes the caret
  expect(goalGate('  ', 'the tests pass')).toBe('sayWhat');
  expect(goalGate('', undefined)).toBe('nothing');
  expect(goalGate('', '')).toBe('nothing');
});
