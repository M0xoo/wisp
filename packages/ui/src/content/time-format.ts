// How a time reads (design/copy.md): relative for the past in lists (v1 format.js ago(): now, 28m, 4h, 3d;
// owner, 2026-11-10: v2 looks exactly like v1, ADR-0016), absolute for the
// future (14:32, Mon 9:00; never "in 18m", which reads as "ago"), the full date and "in 18 min"
// on hover. Pure, so it's tested without a clock.
import type { Translate } from '../core/i18n.tsx';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function toMs(at: number | Date | string): number {
  if (typeof at === 'number') return at;
  if (at instanceof Date) return at.getTime();
  return Date.parse(at);
}

/** The short label for a list column. */
export function timeLabel(at: number, now: number, t: Translate, locale?: string): string {
  const diff = now - at;
  if (diff >= 0) {
    if (diff < 45_000) return t('time.now');
    // v1 ago(): each unit rounded, days with no end
    if (diff < HOUR) return t('time.minutes', { n: Math.max(1, Math.round(diff / MIN)) });
    if (diff < DAY) return t('time.hours', { n: Math.round(diff / HOUR) });
    return t('time.days', { n: Math.round(diff / DAY) });
  }
  return futureLabel(at, now, locale);
}

/** The future, absolute: a clock time today, weekday and time this week, else the date. */
export function futureLabel(at: number, now: number, locale?: string): string {
  const clock = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  if (sameDay) return clock.format(at);
  if (at - now < 6 * DAY) {
    const day = new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(at);
    return `${day} ${clock.format(at)}`;
  }
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(at);
}

/** The hover text: the full date, and for the future how long until it. */
export function timeTitle(at: number, now: number, t: Translate, locale?: string): string {
  const full = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
  if (at <= now || at - now > DAY) return full;
  return `${full} · ${t('time.in-minutes', { n: Math.max(1, Math.round((at - now) / MIN)) })}`;
}
