// Usage at a glance on Home (v1 #790 test/home-usage.test.js): which windows, which accounts, how many, which tone.
import { expect, test } from 'vitest';
import { holdLine, homeTone, homeUsage, type HomeHarness } from '../src/home-usage.ts';

const H = 3_600_000;
const win = (id: string, label: string, used: number, more: { hitAt?: number } = {}) => ({ id, label, used, resetsAt: 10 * H, ...more });
const claude = (accounts: HomeHarness['accounts'], more: Partial<HomeHarness> = {}): HomeHarness => ({ agent: 'claude', name: 'Claude Code', accounts, names: [], ...more });

test('home usage: the 5-hour window and the fullest weekly one, short labels', () => {
  const [r] = homeUsage([claude([{ account: 'default', windows: [win('five_hour', '5-hour', 0.4), win('seven_day', 'Weekly', 0.2), win('seven_day_opus', 'Weekly Opus', 0.7)] }])]);
  expect(r?.windows.map((w) => [w.short, w.used])).toEqual([
    ['5h', 0.4],
    ['Opus week', 0.7],
  ]);
});

test('home usage: nothing reported, a harness not set up, or a removed account shows nothing', () => {
  expect(homeUsage([claude([])])).toEqual([]);
  expect(homeUsage([claude([{ account: 'default', windows: [] }])])).toEqual([]);
  expect(homeUsage([claude([{ account: 'default', windows: [win('five_hour', '5-hour', 0.4)] }], { available: false })])).toEqual([]);
  expect(homeUsage([claude([{ account: 'gone', windows: [win('five_hour', '5-hour', 0.4)] }])])).toEqual([]);
  // still detecting which harnesses are set up: shown
  expect(homeUsage([claude([{ account: 'default', windows: [win('five_hour', '5-hour', 0.4)] }], { available: undefined })])).toHaveLength(1);
});

test('home usage: several accounts each get a group with their name, three at most', () => {
  const names = [
    { id: 'a', label: 'Work' },
    { id: 'b', label: 'Home' },
  ];
  const rows = homeUsage([claude([{ account: 'a', windows: [win('five_hour', '5-hour', 0.1)] }, { account: 'b', windows: [win('seven_day', 'Weekly', 0.5)] }, { account: 'gone', windows: [win('five_hour', '5-hour', 0.1)] }], { names })]);
  expect(rows.map((r) => [r.accountLabel, r.windows[0]?.short])).toEqual([
    ['Work', '5h'],
    ['Home', 'Week'],
  ]);
  const many = Array.from({ length: 5 }, (_, i) => claude([{ account: 'default', windows: [win('five_hour', '5-hour', 0.1)] }], { agent: `h${i}` }));
  expect(homeUsage(many)).toHaveLength(3);
});

test('home usage: a window it does not know keeps its own label', () => {
  const [r] = homeUsage([claude([{ account: 'default', windows: [win('primary', 'Daily', 0.3)] }])]);
  expect(r?.windows.map((w) => w.short)).toEqual(['Daily']);
});

test('home usage tone: red used up, amber at the Ask-near-the-limit line, past the stop line or on pace to run out', () => {
  const hold = holdLine('90');
  expect(homeTone({ used: 1 }, null, hold)).toBe('full');
  expect(homeTone({ used: 0.9 }, null, hold)).toBe('warn');
  expect(homeTone({ used: 0.89 }, null, hold)).toBeUndefined();
  expect(homeTone({ used: 0.81 }, null, holdLine('80'))).toBe('warn');
  expect(homeTone({ used: 0.6 }, 0.5, hold)).toBe('warn');
  expect(homeTone({ used: 0.2, hitAt: 5 * H }, null, hold)).toBe('warn');
  // Ask near the limit off: amber from 90% still (v1 `holdLine(...) ?? 0.9`)
  expect(holdLine('off')).toBeNull();
  expect(homeTone({ used: 0.92 }, null, holdLine('off'))).toBe('warn');
  expect(holdLine(undefined)).toBe(0.9);
});
