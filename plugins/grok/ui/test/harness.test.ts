import { expect, test } from 'vitest';
import def, { HARNESS } from '../src/index.ts';

test('grok_is_described_to_the_screens_by_its_plugin_with_its_mark', () => {
  expect(def.harnesses).toEqual([HARNESS]);
  expect(HARNESS.id).toBe('grok');
  expect(HARNESS.logo.startsWith('data:image/svg+xml,')).toBe(true);
});
