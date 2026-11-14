// No output for 12 min (src/frame/no-output.ts, v1 no-output.js): a fact line on a quiet run, cleared by any sign of life.
import { expect, test } from 'vitest';
import { NO_OUTPUT_MS, lastOutputAt, noOutputLine } from '../src/frame/no-output.ts';
import { SHELL_STRINGS } from '../src/i18n/en.ts';

const t = (key: string, p: Readonly<Record<string, string | number>> = {}): string =>
  String((SHELL_STRINGS as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(p[k] ?? ''));
const MIN = 60_000;
const run = (steps: { kind?: string; t?: number; outAt?: number; call?: string }[] = [], o: Partial<{ running: boolean; waiting: boolean; delegating: boolean }> = {}) => ({
  running: true,
  waiting: false,
  startedAt: 0,
  steps,
  ...o,
});

test('a run quiet for 12 min says so and keeps counting; anything new, a question or a working subagent clears it_v1_no_output', () => {
  expect(noOutputLine(run(), NO_OUTPUT_MS - 1, t)).toBe('');
  expect(noOutputLine(run(), 12 * MIN, t)).toBe('No output for 12 min');
  expect(noOutputLine(run(), 47 * MIN, t)).toBe('No output for 47 min');
  expect(noOutputLine(run(), 60 * MIN, t)).toBe('No output for 1 h');
  expect(noOutputLine(run(), 125 * MIN, t)).toBe('No output for 2 h 5 min');
  // a call's result that came in late counts as life
  expect(lastOutputAt(0, [{ t: 2 * MIN, outAt: 9 * MIN }, { t: 5 * MIN }])).toBe(9 * MIN);
  expect(noOutputLine(run([{ t: 2 * MIN, outAt: 9 * MIN }]), 20 * MIN, t)).toBe('');
  expect(noOutputLine(run([], { waiting: true }), 30 * MIN, t)).toBe('');
  expect(noOutputLine(run([], { running: false }), 30 * MIN, t)).toBe('');
  expect(noOutputLine(run([], { delegating: true }), 30 * MIN, t)).toBe('');
  expect(noOutputLine(run([{ kind: 'agent', call: 'c1', t: 1 }]), 30 * MIN, t)).toBe(''); // Claude's Task still working
  // its result came in long ago: quiet again
  expect(
    noOutputLine(
      run([
        { kind: 'agent', call: 'c1', t: 1 },
        { kind: 'tool_output', call: 'c1', t: 2 * MIN },
      ]),
      30 * MIN,
      t,
    ),
  ).toBe('No output for 28 min');
});
