// How Later says a time (design/later.md): times ahead are absolute (14:32, Tue 9:00, 2 Nov 9:00);
// "in 18 min" goes only in tooltips. Pure: `now` comes in. Formatting is en-GB (24-hour) like v1's
// screenshots; the shell's locale replaces it once i18n has one.

import { t } from './i18n.ts';
import type { Key } from './i18n.ts';
import type { LaterView, Plan } from './types.ts';
import type { IconName } from '@wisp/ui';

const LOCALE = 'en-GB';
const HM: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
const fmt = (at: number, o: Intl.DateTimeFormatOptions): string => new Date(at).toLocaleString(LOCALE, o);
const sameDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString();

/** A time ahead, short: 14:32 today, Mon 14:32 this week, 2 Nov 14:32 after. */
export function aheadLabel(at: number, now: number): string {
  const hm = fmt(at, HM);
  if (sameDay(at, now)) return hm;
  if (at - now < 6 * 86400_000) return `${fmt(at, { weekday: 'short' })} ${hm}`;
  return `${fmt(at, { day: 'numeric', month: 'short' })} ${hm}`;
}

/** "at 14:35" today, "Tue 10:00" another day: the launcher's Starts … */
export const startsAt = (at: number, now: number): string => `${sameDay(at, now) ? 'at ' : ''}${aheadLabel(at, now)}`;

/** "in 18 min", "in 2 h", "in 3 days": tooltips only. */
export function inWords(at: number, now: number): string {
  const m = Math.max(1, Math.round((at - now) / 60_000));
  if (m < 60) return t('wisp.later.inMin', { n: m });
  const h = Math.round(m / 60);
  return h < 48 ? t('wisp.later.inHours', { n: h }) : t('wisp.later.inDays', { n: Math.round(h / 24) });
}

export function fullDate(at: number): string {
  return fmt(at, { weekday: 'short', day: 'numeric', month: 'short', ...HM });
}

/** "In 18 min · Tue 4 Nov, 14:32" */
export function whenTip(at: number, now: number): string {
  const w = inWords(at, now);
  return t('wisp.later.tip', { in: w.charAt(0).toUpperCase() + w.slice(1), full: fullDate(at) });
}

/** A day's heading: Today, Tomorrow, Fri 31 Oct. */
export function dayLabel(at: number, now: number): string {
  const day = (x: number): number => new Date(x).setHours(0, 0, 0, 0);
  const days = Math.round((day(at) - day(now)) / 86400_000);
  if (days <= 0) return t('wisp.later.today');
  if (days === 1) return t('wisp.later.tomorrow');
  return fmt(at, { weekday: 'short', day: 'numeric', month: 'short' });
}

export const clockOnly = (at: number): string => fmt(at, HM);

export const whoSet = (by: string): string => (by === 'user' ? t('wisp.later.by.user') : by === 'agent' ? t('wisp.later.by.agent') : by);

/** The row's glyph and text: a follow-up held for the plan or the computer says so. */
export function laterLine(l: LaterView): [IconName, string] {
  const n = l.goal ?? 0;
  if (l.held?.load) return ['pause', l.goal ? t('wisp.later.line.goalLoad', { n }) : t('wisp.later.line.load', { text: l.text })];
  if (l.held) return ['pause', l.goal ? t('wisp.later.line.goalPlan', { n }) : t('wisp.later.line.plan', { text: l.text })];
  if (l.goal) return ['target', t('wisp.later.line.goal', { n })];
  return [l.remind ? 'bell' : 'clock', l.text];
}

/** "At 14:45 · set by you" over a follow-up row above the reply box. */
export function followUpTag(l: LaterView, now: number): string {
  const time = aheadLabel(l.at, now);
  if (l.held) return t(l.held.load ? 'wisp.later.tag.heldLoad' : 'wisp.later.tag.heldPlan', { time });
  return t(l.remind ? 'wisp.later.tag.remindAt' : 'wisp.later.tag.at', { time, who: whoSet(l.by) });
}

export const planIcon = (p: Plan): IconName => (p.kind !== 'task' ? 'bell' : p.draft ? 'pen' : p.after ? 'queue' : 'clock');
export const planTitle = (p: Plan): string => (p.kind === 'task' ? (p.title ?? (p.body?.prompt.split('\n')[0] ?? '').slice(0, 80)) : (p.text ?? ''));
export const planText = (p: Plan): string => (p.kind === 'task' ? (p.body?.prompt ?? '') : (p.text ?? ''));

/** Harness · mode: what a task plan will run with. */
export function runLine(p: Plan, agentName: (id: string) => string = (id) => id): string {
  const b = p.body;
  return [b?.agent && b.agent !== 'auto' ? agentName(b.agent) : t('wisp.later.agent.auto'), b?.mode].filter(Boolean).join(' · ');
}

/** The line under a plan's title. afterTitle: what the /after task is called now. */
export function planSub(p: Plan, afterTitle: string): string {
  if (p.kind !== 'task') return t('wisp.later.plan.reminder');
  if (p.after) return t('wisp.later.plan.after', { title: afterTitle, run: runLine(p) });
  if (p.lost) return t('wisp.later.plan.lost', { title: p.lost.title, why: t(`wisp.later.plan.lost.${p.lost.why}` as Key), run: runLine(p) });
  return runLine(p);
}

/** Change time… names what a time does: a draft or a /after task gets one instead. */
export const planTimeLabel = (p: Plan): string => t(p.kind !== 'task' ? 'wisp.later.plan.changeTime' : p.draft || p.after ? 'wisp.later.plan.startLater' : 'wisp.later.plan.changeStart');

/** The time menu's rows: label and the time each means. */
export function timeChoices(now: number): [string, number][] {
  const d = new Date(now);
  const morning = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9, 0).getTime();
  return [
    [t('wisp.later.time.in10'), now + 10 * 60_000],
    [t('wisp.later.time.in30'), now + 30 * 60_000],
    [t('wisp.later.time.in60'), now + 3600_000],
    [t('wisp.later.time.in180'), now + 3 * 3600_000],
    [t('wisp.later.time.morning'), morning],
  ];
}
