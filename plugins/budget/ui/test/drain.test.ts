import { expect, test } from 'vitest';
import { drainLines, drainReport, noticeWords, pct } from '../src/drain.ts';

const when = (at: number): string => `T${at}`;

test('drain_watch_and_window_changes_say_what_v1_said', () => {
  const d = { id: 'seven_day', label: 'Weekly', ratio: 2.4, since: 5, runs: 6, units: 3, du: 0.12, usual: 0.016, failed: { runs: 2, du: 0.03 } };
  expect(drainLines(d, when)).toEqual({ title: 'Using your plan 2.4× faster than usual', text: 'Since T5, 6 runs took 12% of the weekly window for 3 units of work. That much work usually takes 5%. 2 of them ended in an error and still took 3%.' });
  expect(drainReport('Claude Code', 'work', d, when).split('\n')).toHaveLength(4);
  expect(pct(0.001)).toBe('<1%');
  expect(noticeWords({ window: 'w', kind: 'new', at: 1, resetsAt: 9, label: 'Weekly Opus' }, 'Claude Code', when)).toBe('Claude Code has a new weekly Opus window, resets T9');
  expect(noticeWords({ window: 'w', kind: 'reset', at: 1, resetsAt: 9, wasResetsAt: 3, label: 'Weekly' }, 'Codex', when)).toBe('Codex’s weekly window now resets T9 (was T3)');
  expect(noticeWords({ window: 'w', kind: 'gone', at: 1, label: '5-hour' }, 'Codex', when)).toBe('Codex’s 5-hour window is gone: it no longer reports one');
});
