// Which section a task belongs in, and in what order (v1 web/js/core/state.js isScheduled,
// isForLater, needsYou; later.js plans, upcoming, laterActions). Pure.

import { t } from './i18n.ts';
import { aheadLabel, laterLine, planTitle } from './format.ts';
import type { LaterView, Plan, SessionRow } from './types.ts';
import type { IconName } from '@wisp/ui';

type Row = Readonly<SessionRow>;

/** Parked to look at again: finished, not archived, no due reminder (design/for-later.md). */
export const isForLater = (s: Row | undefined): boolean => !!s?.forLater && !s.archived && !s.reminder && !s.pending && (s.state === 'review' || s.state === 'done');

/**
 * Waiting on follow-ups: in Scheduled, out of Needs you. A done task with any follow-up or a run
 * held for the reset, or a finished one whose agent scheduled a check-in. Never one asking you, a
 * due reminder, a held run to decide on, an open terminal, or one with only your reminders ahead.
 */
export const isScheduled = (s: Row | undefined): boolean =>
  !!s &&
  !s.archived &&
  !s.forLater &&
  ((s.state === 'done' && (!!s.later?.length || !!s.held?.waiting)) ||
    (s.state === 'review' && !s.reminder && !s.held && !s.pending && !(s.tui && s.term) && !!s.later?.some((l) => !l.remind)));

/** What the tab title, the crew's dots and home count. */
export const needsYou = (s: Row): boolean => !isForLater(s) && !s.archived && !isScheduled(s) && (s.state === 'waiting' || (s.state === 'review' && !!s.unread));

/** When a scheduled task's next thing happens: its follow-up, or its held run's reset. */
export const nextAt = (s: Row): number => Math.min(s.later?.[0]?.at ?? Infinity, s.held?.waiting ? (s.held.until ?? Infinity) : Infinity);

/** Plans: timed first, soonest first; then /after and drafts, oldest first. */
export const byTime = (a: Plan, b: Plan): number => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER) || a.setAt - b.setAt;

/** A task's follow-ups, soonest first (the server keeps them so; an optimistic one may not be). */
export const sortLater = (list: readonly LaterView[]): LaterView[] => [...list].sort((a, b) => a.at - b.at);

/** One row of Scheduled: a plan or a task, and the time it sorts by. */
export type ScheduledItem = { kind: 'plan'; key: string; at: number; plan: Plan } | { kind: 'task'; key: string; at: number; row: SessionRow };

/** Scheduled: timed plans and tasks soonest first, then /after plans (oldest first). Drafts aren't here. */
export function scheduledItems(tasks: readonly { key: string; row: SessionRow }[], plans: readonly { key: string; plan: Plan }[]): ScheduledItem[] {
  const out: ScheduledItem[] = [];
  for (const p of plans) if (!p.plan.draft) out.push({ kind: 'plan', key: p.key, plan: p.plan, at: p.plan.at ?? 9e15 + p.plan.setAt });
  for (const s of tasks) if (isScheduled(s.row)) out.push({ kind: 'task', key: s.key, row: s.row, at: nextAt(s.row) });
  return out.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

/** For later: newest saved first. */
export function forLaterItems(tasks: readonly { key: string; row: SessionRow }[]): { key: string; row: SessionRow }[] {
  return tasks.filter((s) => isForLater(s.row)).sort((a, b) => (b.row.forLater?.at ?? 0) - (a.row.forLater?.at ?? 0));
}

/** Drafts: newest first. */
export const draftPlans = (plans: readonly { key: string; plan: Plan }[]): { key: string; plan: Plan }[] => plans.filter((p) => p.plan.draft).sort((a, b) => b.plan.setAt - a.plan.setAt);

export interface Upcoming {
  kind: 'task' | 'reminder' | 'followup';
  at: number;
  title: string;
  sub: string;
  key: string;
  held?: boolean;
  plan?: Plan;
}

/** Coming up: plans with a time and follow-ups on tasks, soonest first, nothing past a minute ago. */
export function upcoming(tasks: readonly { key: string; row: SessionRow }[], plans: readonly { key: string; plan: Plan }[], now: number): Upcoming[] {
  const out: Upcoming[] = [];
  for (const { key, plan: p } of plans) {
    if (p.at) out.push({ kind: p.kind === 'task' ? 'task' : 'reminder', at: p.at, title: planTitle(p), sub: t(p.kind === 'task' ? 'wisp.later.upcoming.task' : 'wisp.later.upcoming.reminder'), key, plan: p });
  }
  for (const { key, row: s } of tasks) {
    if (s.archived || !s.later?.length) continue;
    for (const l of s.later) out.push({ kind: l.remind ? 'reminder' : 'followup', at: l.at, title: s.title, sub: laterLine(l)[1], key, ...(l.held && { held: true }) });
  }
  return out.filter((x) => x.at > now - 60_000).sort((a, b) => a.at - b.at);
}

export type LaterAction = 'held-start' | 'held-without' | 'held-wait' | 'held-skip' | 'later-snooze' | 'later-now' | 'later-time' | 'later-cancel' | 'forLater';

/** What a task's menus offer for Later (the same everywhere: right-click, More, ⌘K). */
export function laterActions(s: Row | undefined, now: number): { a: LaterAction; label: string; icon: IconName }[] {
  if (!s) return [];
  const out: { a: LaterAction; label: string; icon: IconName }[] = [];
  if (s.held) {
    const trust = !!s.held.harness || !!s.held.project;
    out.push({ a: 'held-start', label: t(trust ? 'wisp.later.held.trust' : s.held.kind === 'followUp' ? 'wisp.later.held.sendNow' : 'wisp.later.held.startNow'), icon: 'play' });
    if (s.held.project) out.push({ a: 'held-without', label: t('wisp.later.held.without'), icon: 'skip' });
    if (!s.held.waiting && !trust) out.push({ a: 'held-wait', label: t('wisp.later.held.wait'), icon: 'clock' });
    out.push({ a: 'held-skip', label: t('wisp.later.held.skip'), icon: 'skip' });
  }
  if (s.reminder && s.state === 'review') out.push({ a: 'later-snooze', label: t('wisp.later.actions.snooze'), icon: 'bell' });
  const l = s.later?.[0];
  if (l) {
    const what = t(l.remind ? 'wisp.later.actions.reminder' : 'wisp.later.actions.followUp');
    const named = (s.later?.length ?? 0) > 1 ? t('wisp.later.actions.named', { time: aheadLabel(l.at, now), what }) : what;
    out.push({ a: 'later-now', label: t(l.remind ? 'wisp.later.actions.remindNow' : 'wisp.later.actions.sendFollowUpNow'), icon: l.remind ? 'bell' : 'send' });
    out.push({ a: 'later-time', label: t('wisp.later.actions.changeNamed', { named }), icon: 'clock' });
    out.push({ a: 'later-cancel', label: t('wisp.later.actions.cancelNamed', { named }), icon: 'x' });
  }
  if (canSave(s)) out.push({ a: 'forLater', label: t(s.forLater ? 'wisp.later.actions.unsave' : 'wisp.later.actions.save'), icon: 'bookmark' });
  return out;
}

/** Save for later is offered on a finished task only: it never hides what needs you. */
export const canSave = (s: Row): boolean => !s.archived && !s.pending && !s.parentId && s.kind !== 'reminder' && (s.state === 'review' || s.state === 'done');
