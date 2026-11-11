import { expect, test } from 'vitest';
import type { Json } from '@wisp/client';
import { BOOL_KEYS, onOff } from '../src/source.ts';

test('a_switch_on_a_bool_setting_writes_true_or_false_not_v1s_on_and_off', () => {
  const wrote: Json[] = [];
  const row = (v: Json) => ({ value: () => v, set: (x: Json) => void wrote.push(x) });
  // channels.acceptChannels is `bool` in its manifest: 'on' was refused ("must be true or false")
  onOff(row(null), false, 'channels.acceptChannels').set(true);
  onOff(row(true), false, 'channels.acceptChannels').set(false);
  // a v1-style word setting keeps its words
  onOff(row('off'), true, 'settings.notify').set(true);
  expect(wrote).toEqual([true, false, 'on']);
  expect((onOff(row('on'), false).value as () => boolean)()).toBe(true);
  expect((onOff(row(true), false).value as () => boolean)()).toBe(true);
  expect([...BOOL_KEYS].sort()).toEqual(['channels.acceptChannels', 'crew.tint', 'runtime.apps', 'runtime.blocks', 'runtime.watch', 'ship.fixConflicts']);
});
