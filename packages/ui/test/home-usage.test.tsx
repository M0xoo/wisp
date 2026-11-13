// Usage at a glance under Home's prompt box (app/HomeUsage.tsx, v1 #790 .sh-usage): hidden with nothing reported, one
// button that opens Settings → Usage, a meter per window with its tone.
import { expect, test } from 'vitest';
import { mount } from './helpers.tsx';
import { HomeUsage, type HomeUsageGroup } from '../src/app/HomeUsage.tsx';

const group: HomeUsageGroup = {
  key: 'claude:a',
  who: 'Claude Code (Work)',
  account: 'Work',
  windows: [
    { key: 'five_hour', short: '5h', used: 0.4, pct: '40%', tip: 'Claude Code (Work), 5-hour window: 40% used. Resets 17:00', aria: 'Claude Code (Work), 5-hour window used' },
    { key: 'seven_day', short: 'Week', used: 1, pct: '100%', tone: 'full', tip: 't', aria: 'a' },
  ],
};

test('home usage: nothing at all until a plan is reported_v1_790', () => {
  const host = mount(() => <HomeUsage groups={[]} title="Usage" onOpen={() => {}} />);
  expect(host.querySelector('[data-kit="home-usage"]')).toBeNull();
});

test('home usage: one button opens Settings → Usage; meters carry their value and tone_v1_790', () => {
  let opened = 0;
  const host = mount(() => <HomeUsage groups={[group]} title="Usage: open Settings → Usage" onOpen={() => opened++} />);
  const row = host.querySelector<HTMLButtonElement>('[data-part="home.usage.row"] [data-kit="hu-row"]');
  expect(row?.title).toBe('Usage: open Settings → Usage');
  expect(host.querySelector('[data-kit="hu-acc"]')?.textContent).toBe('Work');
  const meters = [...host.querySelectorAll('[role="meter"]')];
  expect(meters.map((m) => m.getAttribute('aria-valuenow'))).toEqual(['40', '100']);
  expect([...host.querySelectorAll('[data-kit="hu-win"]')].map((w) => w.getAttribute('data-tone'))).toEqual([null, 'full']);
  expect([...host.querySelectorAll('[data-kit="hu-p"]')].map((p) => p.textContent)).toEqual(['40%', '100%']);
  row?.click();
  expect(opened).toBe(1);
});
