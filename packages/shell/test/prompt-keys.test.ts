// The prompt boxes' keys (src/frame/prompt-keys.ts, v1 prompt-history.js and Shift+Tab): history and the mode.
import { expect, test } from 'vitest';
import { historyStep, nextMode, promptKeys, remember } from '../src/frame/prompt-keys.ts';

const key = (k: string, shift = false) =>
  ({ key: k, shiftKey: shift, altKey: false, metaKey: false, ctrlKey: false, isComposing: false, currentTarget: null, preventDefault: () => undefined }) as unknown as KeyboardEvent;

test('↑ in an empty box brings back what was sent, newest first; ↓ walks forward and past the newest empties it_v1_prompt_history', () => {
  const list = remember(remember(remember([], 'one'), 'two'), 'one'); // sent again: once, newest
  expect(list).toEqual(['two', 'one']);
  expect(
    remember(
      Array.from({ length: 60 }, (_, i) => `p${i}`),
      'x',
    ),
  ).toHaveLength(50);
  let box = '';
  const keys = promptKeys({ sent: () => list, value: () => box, set: (v) => (box = v) });
  expect(keys(key('ArrowUp'))).toBe(true);
  expect(box).toBe('one');
  keys(key('ArrowUp'));
  expect(box).toBe('two');
  expect(keys(key('ArrowUp'))).toBe(false); // the oldest: the key goes to the box
  keys(key('ArrowDown'));
  expect(box).toBe('one');
  keys(key('ArrowDown'));
  expect(box).toBe('');
  // a box with text in it isn't browsed; nor from a second line
  expect(historyStep({ key: 'ArrowUp', value: 'draft', list, at: null, firstLine: true, lastLine: true })).toBeNull();
  expect(historyStep({ key: 'ArrowUp', value: '', list, at: null, firstLine: false, lastLine: true })).toBeNull();
});

test('Shift+Tab cycles Plan, Edits, Full auto in the box that has a mode_v1_mode_cycle', () => {
  expect([nextMode('plan'), nextMode('edits'), nextMode('auto')]).toEqual(['edits', 'auto', 'plan']);
  let mode = 'auto';
  const keys = promptKeys({ sent: () => [], value: () => '', set: () => undefined, mode: { get: () => mode, set: (m) => (mode = m) } });
  expect(keys(key('Tab', true))).toBe(true);
  expect(mode).toBe('plan');
  expect(promptKeys({ sent: () => [], value: () => '', set: () => undefined })(key('Tab', true))).toBe(false); // no mode: Tab moves focus
});
