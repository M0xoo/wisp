// A task's reply box, when it means later (v1 composer.js readWhen, F-auto-5): "in 10 min check again" or "remind me
// to look in 1 h" goes into the same conversation then (`later.add`), not to the agent now. Only a time at the
// start, or a "remind me" with one at the end (parseWhen): "make the cron run at 2pm" is just a reply. v1's
// exceptions: Read times off (Settings), the wisp agent's own task, a reminder, a subtask, an open question, a /btw
// aside, a reply to @a member. DOM-free.
import { parseWhen } from './when.ts';

/** What the reply box knows of the task. */
export interface ReplyTask {
  readonly agent?: string | undefined;
  readonly kind?: string | undefined;
  readonly parentId?: string | null | undefined;
  readonly ask?: unknown;
}

export interface ReplyPlan {
  readonly at: number;
  readonly text: string;
  readonly remind: boolean;
}

/** The follow-up to schedule instead of sending now, or null (send it now). */
export function replyPlan(text: string, o: { readonly now: Date; readonly task: ReplyTask | undefined; readonly readTimes: boolean }): ReplyPlan | null {
  const t = text.trim();
  const s = o.task;
  if (!t || !o.readTimes || !s || s.agent === 'wisp' || s.kind === 'reminder' || s.parentId || s.ask) return null;
  if (/^\/btw\b/i.test(t) || t.startsWith('@')) return null;
  const w = parseWhen(t, o.now);
  return w && w.at > o.now.getTime() ? { at: w.at, text: w.rest, remind: w.reminder } : null;
}
