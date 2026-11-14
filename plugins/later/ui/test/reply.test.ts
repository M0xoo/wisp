// A task's reply box, later (src/reply.ts, v1 composer.js readWhen → scheduleReply, F-auto-5).
import { expect, test } from 'vitest';
import { replyPlan } from '../src/reply.ts';

const now = new Date(2026, 10, 12, 10, 0, 0);
const task = { agent: 'claude' };
const o = { now, task, readTimes: true };

test('F-auto-5: "in 10 min check again" in the reply box goes into the same task then, the time phrase taken off_v1_read_when', () => {
  expect(replyPlan('in 10 min check again', o)).toEqual({ at: now.getTime() + 10 * 60_000, text: 'check again', remind: false });
  expect(replyPlan('tomorrow at 9 look at the nightly run', o)).toEqual({ at: new Date(2026, 10, 13, 9, 0).getTime(), text: 'look at the nightly run', remind: false });
  expect(replyPlan('remind me to review the PR in 1 hour', o)).toEqual({ at: now.getTime() + 3_600_000, text: 'review the PR', remind: true });
  // a time mid-reply is just words, and a reply that's only a time has nothing to send
  expect(replyPlan('make the cron run at 2pm', o)).toBeNull();
  expect(replyPlan('in 10 min', o)).toBeNull();
  expect(replyPlan('  ', o)).toBeNull();
});

test('F-auto-5: v1\'s exceptions send it now: Read times off, the wisp agent, a reminder, a subtask, an open question, /btw, @a member', () => {
  const said = 'in 10 min check again';
  expect(replyPlan(said, { ...o, readTimes: false })).toBeNull();
  expect(replyPlan(said, { ...o, task: undefined })).toBeNull();
  for (const t of [{ agent: 'wisp' }, { kind: 'reminder' }, { parentId: 's1' }, { ask: { q: 'which one?' } }]) expect(replyPlan(said, { ...o, task: { ...task, ...t } })).toBeNull();
  expect(replyPlan('/btw in 10 min check again', o)).toBeNull();
  expect(replyPlan('@ada in 10 min check again', o)).toBeNull();
});
