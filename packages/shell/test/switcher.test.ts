import { expect, test } from 'vitest';
import { pick, startSwitch, step } from '../src/switcher/model.ts';

const all = (): boolean => true;

test('a tap goes back to the task before; held Tabs step through, wrapping', () => {
  const s = startSwitch('a', ['a', 'b', 'c'], all, false);
  expect(s && pick(s)).toBe('b');
  expect(s && pick(step(s, 1))).toBe('c');
  expect(s && pick(step(step(s, 1), 1))).toBeUndefined(); // back on the open one: stay
  const back = startSwitch('a', ['a', 'b', 'c'], all, true);
  expect(back && pick(back)).toBe('c');
});

test('nowhere to go: nothing starts; tasks that no longer fit are skipped', () => {
  expect(startSwitch('a', ['a'], all, false)).toBeUndefined();
  expect(startSwitch(undefined, [], all, false)).toBeUndefined();
  const s = startSwitch('a', ['a', 'gone', 'c'], (id) => id !== 'gone', false);
  expect(s?.ids).toEqual(['a', 'c']);
  const fromHome = startSwitch(undefined, ['b', 'c'], all, false);
  expect(fromHome && pick(fromHome)).toBe('b');
});
