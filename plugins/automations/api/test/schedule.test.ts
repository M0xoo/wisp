// The schedule helpers (v1 test/ship.test.js "cron: …" and test/web-pure.test.js "toCron …"),
// plus readSchedule and a property check that every cron toCron makes parses and fires.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock24, cronMatches, cronWords, nextRun, parseCron, readSchedule, toCron, MEMBER_KINDS, HOOK_KINDS, TASK_KINDS } from '../src/index.ts';

const at = (s: string): Date => new Date(s);

test('cron: fields, ranges, steps, day-of-week/month OR rule, next run', () => {
  const weekdays9 = parseCron('0 9 * * 1-5');
  assert.equal(cronMatches(weekdays9, at('2026-10-19T09:00:00')), true); // Monday
  assert.equal(cronMatches(weekdays9, at('2026-10-18T09:00:00')), false); // Sunday
  assert.equal(new Date(nextRun(weekdays9, at('2026-10-17T10:00:00').getTime()) ?? 0).toString(), at('2026-10-19T09:00:00').toString());
  assert.equal(new Date(nextRun(parseCron('*/15 * * * *'), at('2026-10-17T10:07:30').getTime()) ?? 0).getMinutes(), 15);
  const either = parseCron('0 0 1 * 0'); // the 1st, or any Sunday
  assert.equal(cronMatches(either, at('2026-10-18T00:00:00')), true);
  assert.equal(cronMatches(either, at('2026-11-01T00:00:00')), true);
  assert.equal(cronMatches(parseCron('@weekly'), at('2026-10-18T00:00:00')), true);
  assert.equal(cronMatches(parseCron('0 0 * * 7'), at('2026-10-18T00:00:00')), true, '7 is Sunday');
  assert.throws(() => parseCron('61 * * * *'), /minute/);
  assert.throws(() => parseCron('* * *'), /5 fields/);
});

test('cron: a schedule that never matches has no next run; errors carry code invalid', () => {
  assert.equal(nextRun(parseCron('0 0 31 2 *'), at('2026-01-01T00:00:00').getTime()), null);
  assert.throws(() => parseCron('0 0 0 * *'), (e: unknown) => e instanceof Error && (e as Error & { code?: string }).code === 'invalid');
});

test('toCron reads a schedule in words, and cronWords reads it back', () => {
  const cases: Record<string, [string, string]> = {
    'every monday': ['0 9 * * 1', 'Mondays at 9:00'],
    '8am every weekday': ['0 8 * * 1-5', 'Weekdays at 8:00'],
    'Every weekday at 8 AM': ['0 8 * * 1-5', 'Weekdays at 8:00'],
    'every 15 minutes': ['*/15 * * * *', 'Every 15 min'],
    'every 15 min between 9 and 6 on weekdays': ['*/15 9-17 * * 1-5', 'Every 15 min, 9:00 to 18:00, weekdays'],
    hourly: ['0 * * * *', 'Hourly'],
    'every 2 hours': ['0 */2 * * *', 'Every 2 hours'],
    'every half hour': ['*/30 * * * *', 'Every 30 min'],
    'every day at 6pm': ['0 18 * * *', 'Every day at 18:00'],
    'weekdays at 9:30': ['30 9 * * 1-5', 'Weekdays at 9:30'],
    'mondays and fridays at 10am': ['0 10 * * 1,5', 'Mondays and Fridays at 10:00'],
    'tue-thu at 9': ['0 9 * * 2-4', 'Tuesday to Thursday at 9:00'],
    'sat and sun at 10am': ['0 10 * * 0,6', 'Weekends at 10:00'],
    'at 9am and 5pm': ['0 9,17 * * *', 'Every day at 9:00 and 17:00'],
    'on the 15th of each month at noon': ['0 12 15 * *', 'On the 15th of each month at 12:00'],
    'every friday at 5pm': ['0 17 * * 5', 'Fridays at 17:00'],
    '*/15 9-18 * * 1-5': ['*/15 9-18 * * 1-5', 'Every 15 min, 9:00 to 19:00, weekdays'],
  };
  for (const [words, [cron, back]] of Object.entries(cases)) {
    assert.equal(toCron(words), cron, words);
    assert.equal(cronWords(cron, clock24), back, cron);
  }
  // Nothing is guessed: a word it doesn't know, or what one cron line can't say, is refused.
  for (const t of ['', 'banana', 'monday standup', 'every 2 weeks', 'last day of the month', 'every 90 minutes', 'at 25', 'at 9am and 5:30pm', 'every 15 min at 9am']) assert.equal(toCron(t), null, t);
  assert.equal(cronWords('0 9 1 6 *'), null, 'months stay as cron');
});

test('readSchedule: words or cron → a checked cron; empty stays empty; nonsense is refused', () => {
  assert.equal(readSchedule('every monday'), '0 9 * * 1');
  assert.equal(readSchedule('  '), '');
  assert.equal(readSchedule(null), '');
  assert.equal(readSchedule('@daily'), '@daily');
  assert.throws(() => readSchedule('banana'), /Couldn’t read “banana”/);
  assert.throws(() => readSchedule('99 * * * *'), /minute/);
});

test('property: every phrase toCron reads parses, and fires within a year', () => {
  const days = ['', ' every monday', ' on weekdays', ' on weekends', ' every friday', ' tue-thu', ' on the 3rd of each month'];
  const times = ['', ' at 9am', ' at 17:30', ' at noon', ' in the evening'];
  const every = ['', 'every 10 minutes', 'every 3 hours', 'hourly'];
  const from = at('2026-03-01T12:00:00').getTime();
  let read = 0;
  for (const e of every) {
    for (const d of days) {
      for (const t of times) {
        const cron = toCron(`${e}${d}${t}`);
        if (!cron) continue;
        read++;
        const c = parseCron(cron);
        const next = nextRun(c, from);
        assert.ok(next !== null && next > from, `${e}${d}${t} → ${cron}`);
        assert.ok(cronMatches(c, new Date(next)), cron);
      }
    }
  }
  assert.ok(read >= 50, `read ${read}`);
});

test('kinds: the crew editor offers finished, done and ci; hooks and task kinds', () => {
  assert.deepEqual([...MEMBER_KINDS], ['finished', 'done', 'ci']);
  assert.deepEqual([...HOOK_KINDS], ['webhook', 'slack', 'linear']);
  assert.deepEqual([...TASK_KINDS], ['finished', 'done']);
});
