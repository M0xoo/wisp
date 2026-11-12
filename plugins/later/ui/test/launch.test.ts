// New task's Send, later (src/launch.ts, v1 launcher.js go → planAsk, when.js): the clock, a time in the prompt, /draft, /after.
import { expect, test } from 'vitest';
import { launchPlan } from '../src/launch.ts';

const now = new Date(2026, 10, 12, 10, 0, 0);
const o = { now, title: (id: string) => (id === '0192f3a4-aaaa-7bbb-8ccc-1234567890ab' || id === 'local:s0001' ? 'Fix login' : undefined) };

test('a time the prompt starts with holds it until then; "remind me" makes a reminder_v1_prompt_time', () => {
  const p = launchPlan('in 5 min run the e2e suite', o);
  expect(p).toMatchObject({ kind: 'task', rest: 'run the e2e suite' });
  expect(p && 'at' in p ? p.at - now.getTime() : 0).toBe(5 * 60_000);
  expect(launchPlan('remind me to review the PR in 1 hour', o)).toMatchObject({ kind: 'reminder', rest: 'review the PR' });
  // a time mid-prompt is just words: nothing is delayed on a guess
  expect(launchPlan('make the cron run at 2pm', o)).toBeNull();
});

test('a time picked on the clock holds the prompt as it is_v1_clock_pick', () => {
  const at = now.getTime() + 3_600_000;
  expect(launchPlan('bump the deps', { ...o, at })).toEqual({ kind: 'task', at, rest: 'bump the deps' });
  expect(launchPlan('bump the deps', { ...o, at: now.getTime() - 1 })).toBeNull(); // gone by while typing: starts now
});

test('/draft keeps it in Drafts; /after a task starts it once that one is done_v1_draft_after', () => {
  expect(launchPlan('/draft fix the login bug', o)).toEqual({ kind: 'task', draft: true, rest: 'fix the login bug' });
  expect(launchPlan('/draft', o)).toBeNull();
  expect(launchPlan('/after @[Fix login](wisp:local:s0001) write the release notes', o)).toEqual({ kind: 'task', after: { id: 'local:s0001', title: 'Fix login' }, rest: 'write the release notes' });
  expect(launchPlan('/after 0192f3a4-aaaa-7bbb-8ccc-1234567890ab write the notes', o)).toMatchObject({ after: { id: '0192f3a4-aaaa-7bbb-8ccc-1234567890ab', title: 'Fix login' } });
  expect(launchPlan('/after wisp:nope123 write the notes', o)).toBeNull(); // no such task here
});
