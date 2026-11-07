// When a member's check-in is due (v1 server/crew.js nextCheckin, dueNow): its cron, once per
// minute, or a wake-up it asked for, once. Pure: callers pass ctx.clock.now(). Parsed crons are
// cached by expression, so a tick over every member parses nothing.
import { cronMatches, nextRun, parseCron } from '@wisp-plugin/automations-api';
import type { Cron } from '@wisp-plugin/automations-api';
import type { Member } from '@wisp-plugin/crew-api';

type Sched = Pick<Member, 'paused' | 'cron' | 'wakeAt' | 'lastMinute'>;

const parsed = new Map<string, Cron | null>();
function cronOf(expr: string): Cron | null {
  let c = parsed.get(expr);
  if (c === undefined) {
    try {
      c = parseCron(expr);
    } catch {
      c = null; // a stored cron that no longer reads: no schedule, as v1 swallowed it
    }
    if (parsed.size > 500) parsed.clear();
    parsed.set(expr, c);
  }
  return c;
}

/** When the member's next check-in is due: its schedule or a wake-up it asked for. null: none. */
export function nextCheckin(m: Sched, now: number): number | null {
  if (m.paused) return null;
  let at: number | null = null;
  const c = m.cron ? cronOf(m.cron) : null;
  if (c) {
    at = nextRun(c, now - 60_000); // this minute counts, unless it already ran in it
    if (at !== null && Math.floor(at / 60_000) === m.lastMinute) at = nextRun(c, at);
  }
  if (m.wakeAt && (at === null || m.wakeAt < at)) at = m.wakeAt;
  return at;
}

/** Whether a check-in is due this minute (once per minute for a cron, once for a wake-up). */
export function dueNow(m: Sched, now: number): boolean {
  if (m.paused) return false;
  if (m.wakeAt && m.wakeAt <= now) return true;
  if (!m.cron || m.lastMinute === Math.floor(now / 60_000)) return false;
  const c = cronOf(m.cron);
  return !!c && cronMatches(c, new Date(now));
}
