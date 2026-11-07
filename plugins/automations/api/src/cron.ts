// Cron, read and run (v1 server/triggers.js): a 5-field cron in local time, what minute it next
// fires, and a schedule as a person (or an agent) wrote it → a checked cron. Pure: no I/O, no
// clock of its own (callers pass ctx.clock.now()). Crew check-ins and scheduled triggers both use it.

import { toCron } from './words.ts';

/** What the schedule helpers throw: `code` is what the kernel puts on the wire. */
export class ScheduleError extends Error {
  readonly code = 'invalid';
}

/** A parsed cron: the values each field allows, and whether the field was `*` (or `*` / n). */
export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  minuteAny: boolean;
  hourAny: boolean;
  domAny: boolean;
  monthAny: boolean;
  dowAny: boolean;
}

type Field = 'minute' | 'hour' | 'dom' | 'month' | 'dow';

const FIELDS: readonly (readonly [Field, number, number])[] = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['dom', 1, 31],
  ['month', 1, 12],
  ['dow', 0, 6],
];

export const CRON_ALIASES: Readonly<Record<string, string>> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@weekdays': '0 9 * * 1-5',
};

// One comma-separated field → the values it allows.
function readField(name: Field, lo: number, hi: number, part: string): Set<number> {
  const set = new Set<number>();
  for (const piece of part.split(',')) {
    const m = piece.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!m) throw new ScheduleError(`Bad ${name} field: ${piece}`);
    let a = m[1] === '*' ? lo : Number(m[2]);
    let b = m[1] === '*' ? hi : m[3] !== undefined ? Number(m[3]) : m[4] ? hi : a;
    const step = m[4] ? Number(m[4]) : 1;
    if (name === 'dow' && b === 7) {
      b = 6; // 7 is Sunday too
      set.add(0);
    }
    if (name === 'dow' && a === 7) a = 0;
    if (a < lo || b > hi || a > b || step < 1) throw new ScheduleError(`Bad ${name} field: ${piece}`);
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return set;
}

/** A cron (or an alias such as `@daily`) → its fields. Throws ScheduleError when it isn't one. */
export function parseCron(expr: string): Cron {
  const said = String(expr || '').trim();
  const src = CRON_ALIASES[said] ?? said;
  const parts = src.split(/\s+/);
  if (parts.length !== 5) throw new ScheduleError('A schedule needs 5 fields: minute hour day-of-month month day-of-week');
  const sets: Partial<Record<Field, Set<number>>> = {};
  const any: Partial<Record<Field, boolean>> = {};
  FIELDS.forEach(([name, lo, hi], i) => {
    const part = parts[i] ?? '';
    sets[name] = readField(name, lo, hi, part);
    any[name] = part === '*' || part.startsWith('*/');
  });
  const get = (f: Field): Set<number> => sets[f] ?? new Set();
  return {
    minute: get('minute'),
    hour: get('hour'),
    dom: get('dom'),
    month: get('month'),
    dow: get('dow'),
    minuteAny: any.minute === true,
    hourAny: any.hour === true,
    domAny: any.dom === true,
    monthAny: any.month === true,
    dowAny: any.dow === true,
  };
}

// Classic cron: when both day fields are restricted, either one matching is enough.
function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.dom.has(d.getDate());
  const dow = c.dow.has(d.getDay());
  return !c.domAny && !c.dowAny ? dom || dow : dom && dow;
}

/** Does the cron fire in the minute `d` falls in (local time)? */
export const cronMatches = (c: Cron, d: Date): boolean =>
  c.minute.has(d.getMinutes()) && c.hour.has(d.getHours()) && c.month.has(d.getMonth() + 1) && dayMatches(c, d);

/** The next matching minute after `from` (ms), within a year; null if it never matches. */
export function nextRun(c: Cron, from: number): number | null {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const end = from + 366 * 864e5;
  while (d.getTime() < end) {
    if (!c.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
    } else if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
    } else if (!c.hour.has(d.getHours())) d.setHours(d.getHours() + 1, 0, 0, 0);
    else if (c.minute.has(d.getMinutes())) return d.getTime();
    else d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

/** A schedule as the user (or an agent) wrote it → a checked cron. '' stays '' (no schedule). */
export function readSchedule(text: string | null | undefined): string {
  const said = String(text || '').trim();
  if (!said) return '';
  const cron = toCron(said);
  if (!cron) throw new ScheduleError(`Couldn’t read “${said.slice(0, 60)}” as a schedule. Try “every monday”, “8am every weekday” or “every 30 min”.`);
  parseCron(cron);
  return cron;
}
