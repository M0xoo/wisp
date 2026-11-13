// No coding agent on this computer (v1 setup.js, F-comp-40): the strip shows once the harness list is in and none
// is set up, offers Install opencode, says Installing… while it goes, and Try again with the reason after a failure.
import { expect, test } from 'vitest';
import { needsSetup, setupWords } from '../src/frame/setup.ts';
import { SHELL_STRINGS as en } from '../src/i18n/en.ts';

const t = (k: string, v: Record<string, unknown> = {}): string => String((en as Record<string, string>)[k] ?? k).replace(/\{(\w+)\}/g, (_, n: string) => String(v[n] ?? ''));

test('no harness here offers to install opencode and says how it went_v1_setup_strip', () => {
  expect(needsSetup(undefined)).toBe(false); // not known yet: no flash
  expect(needsSetup([])).toBe(false);
  expect(needsSetup([{ available: false }, { available: false }])).toBe(true);
  expect(needsSetup([{ available: false }, { available: true }])).toBe(false);
  expect(setupWords(t, false, '')).toEqual({ line: 'No coding agent here yet. opencode runs free models, no account needed.', cta: 'Install opencode', bad: false });
  expect(setupWords(t, true, 'x').cta).toBe('Installing…');
  expect(setupWords(t, false, 'npm isn’t on PATH')).toEqual({ line: 'Couldn’t install it: npm isn’t on PATH', cta: 'Try again', bad: true });
});
