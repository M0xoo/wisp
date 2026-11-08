import { expect, test } from 'vitest';
import def, { HARNESS } from '../src/index.ts';

test('Claude Code is described to the screens by its plugin, with its mark', () => {
  expect(def.harnesses).toEqual([HARNESS]);
  expect(HARNESS.id).toBe('claude');
  expect(HARNESS.logo.startsWith('data:image/svg+xml,')).toBe(true);
});
