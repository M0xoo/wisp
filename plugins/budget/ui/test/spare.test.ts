import { expect, test } from 'vitest';
import { spareKey, spareOf, spareWhose } from '../src/spare.ts';

const H = 3_600_000;
const WEEK = 7 * 24 * H;
const now = 1_000 * H;
const win = (id: string, used: number, resetsIn: number, ms: number, more: { hitAt?: number } = {}) => ({
  id,
  label: id === 'weekly' ? 'Weekly' : '5-hour',
  used,
  resetsAt: now + resetsIn,
  ms,
  ...more,
});

test('spare_allowance_offers_a_long_window_resetting_within_a_day_with_a_fifth_left_v1_spare_js', () => {
  const codex = { agent: 'codex', name: 'Codex', accounts: [{ account: 'default', at: now - H, windows: [win('weekly', 0.62, 10 * H, WEEK), win('5h', 0.1, 2 * H, 5 * H)] }] };
  const [x, ...rest] = spareOf([codex], { now });
  expect(rest).toHaveLength(0); // the 5-hour window always resets soon: never spare
  expect(x).toMatchObject({ agent: 'codex', account: '', window: 'weekly', resetsAt: now + 10 * H });
  expect(x?.left).toBeCloseTo(0.38);
  expect(spareWhose(x as never)).toBe('Codex’s weekly window');
  // not within the day, too little left, out of pace, or used up elsewhere: nothing
  expect(spareOf([{ ...codex, accounts: [{ account: 'default', windows: [win('weekly', 0.62, 30 * H, WEEK)] }] }], { now })).toEqual([]);
  expect(spareOf([{ ...codex, accounts: [{ account: 'default', windows: [win('weekly', 0.85, 10 * H, WEEK)] }] }], { now })).toEqual([]);
  expect(spareOf([{ ...codex, accounts: [{ account: 'default', windows: [win('weekly', 0.62, 10 * H, WEEK, { hitAt: now + 5 * H })] }] }], { now })).toEqual([]);
  expect(spareOf([{ ...codex, accounts: [{ account: 'default', windows: [win('weekly', 0.62, 10 * H, WEEK), win('5h', 1, 2 * H, 5 * H)] }] }], { now })).toEqual([]);
  // hidden until the window resets: the same period (Codex drifts a few minutes) stays hidden, the next shows
  const seen = { [spareKey({ agent: 'codex', account: '', window: 'weekly' })]: now + 10 * H + 3 * 60_000 };
  expect(spareOf([codex], { now, seen })).toEqual([]);
  expect(spareOf([codex], { now, seen: { [spareKey({ agent: 'codex', account: '', window: 'weekly' })]: now - WEEK } })).toHaveLength(1);
  // a second account keeps its name
  expect(spareOf([{ ...codex, accounts: [{ account: 'work', windows: [win('weekly', 0.5, H, WEEK)] }] }], { now })[0]?.account).toBe('work');
});
