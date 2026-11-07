// Banked resets in words, for Plan budget (Settings → Usage): Codex's reset credits as the last read
// gave them (server/budget.js codexBanked), "1 banked reset, expires tomorrow 17:00". DOM-free.

import { fmtDate, SHORT_TIME, whenLabel } from './core/format.js';

const DAY = 24 * 3600_000;

// "today 17:00", "tomorrow 17:00", else whenLabel's "Thu, Nov 12, 09:00".
export function dayWhen(t, now = Date.now()) {
  const d = new Date(t).toDateString();
  if (d === new Date(now).toDateString()) return `today ${fmtDate(t, SHORT_TIME)}`;
  if (d === new Date(now + DAY).toDateString()) return `tomorrow ${fmtDate(t, SHORT_TIME)}`;
  return whenLabel(t);
}

// k: { count, credits: [{ expiresAt }] | null }. Only the count when Codex gave no list or no expiry.
export function bankedWords(k, now = Date.now()) {
  if (!k?.count) return '';
  const head = `${k.count} banked reset${k.count === 1 ? '' : 's'}`;
  const next = k.credits?.find((c) => c.expiresAt && c.expiresAt > now);
  if (!next) return head;
  return `${head}, ${k.count === 1 ? '' : 'the next '}expires ${dayWhen(next.expiresAt, now)}`;
}

// One expires within a day: the line turns --warn (the phone hears of it then too).
export const bankedSoon = (k, now = Date.now()) => !!k?.credits?.some((c) => c.expiresAt && c.expiresAt > now && c.expiresAt - now <= DAY);
