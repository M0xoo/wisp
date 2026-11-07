// A cron back in words ("Weekdays at 8:00 AM", "Every 15 min, 9:00 AM to 6:00 PM"), v1
// web/js/schedule.js cronWords. Pure; the clock format is the caller's (the UI passes its locale's).

import { CRON_ALIASES } from './cron.ts';
import { DAY_NAMES } from './words.ts';

const pad = (n: number): string => String(n).padStart(2, '0');
const ordinal = (n: number): string => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
/** 9, 5 → "9:05". */
export const clock24 = (h: number, m: number): string => `${h}:${pad(m)}`;

// The locale's clock ("9:00 AM"). Not cached: an api package keeps no module state, and this isn't hot.
const localClock = (h: number, m: number): string => new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function nums(field: string, lo: number, hi: number): number[] | null {
  const out: number[] = [];
  for (const piece of field.split(',')) {
    const r = piece.match(/^(\d+)(?:-(\d+))?$/);
    if (!r) return null;
    const a = Number(r[1]);
    const b = r[2] ? Number(r[2]) : a;
    if (a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v++) out.push(v);
  }
  return out;
}

/** "Weekdays" → "weekdays" inside a sentence; day names keep their capital. */
export const midSentence = (s: string): string => (s && !DAY_NAMES.some((d) => s.toLowerCase().startsWith(d)) ? (s[0] ?? '').toLowerCase() + s.slice(1) : s);
const list = (xs: string[]): string => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : (xs[0] ?? ''));
const dayName = (d: number): string => {
  const n = DAY_NAMES[d] ?? '';
  return (n[0] ?? '').toUpperCase() + n.slice(1);
};

function daysWords(dow: string): string | null {
  if (dow === '*') return '';
  const ds = nums(dow.replace(/\b7\b/g, '0'), 0, 6);
  if (!ds) return null;
  const set = [...new Set(ds)].sort();
  const key = set.join();
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '0,6') return 'Weekends';
  if (set.length === 7) return '';
  if (/^\d-\d$/.test(dow) && set.length > 2) return `${dayName(set[0] ?? 0)} to ${dayName(set[set.length - 1] ?? 0)}`;
  return list(set.map((d) => `${dayName(d)}s`));
}

type Fmt = (h: number, m: number) => string;

// Minutes as a step ("*/15"): every n minutes, within an hour span or all day.
function stepWords(step: RegExpMatchArray, hr: string, on: string, fmtClock: Fmt): string | null {
  const n = Number(step[1] || 1);
  const every = n === 1 ? 'Every minute' : `Every ${n} min`;
  if (hr === '*') return [every, midSentence(on)].filter(Boolean).join(', ');
  const span = hr.match(/^(\d+)-(\d+)$/);
  if (!span) return null;
  return [every, `${fmtClock(Number(span[1]), 0)} to ${fmtClock((Number(span[2]) + 1) % 24, 0)}`, midSentence(on)].filter(Boolean).join(', ');
}

// Hours as a step ("*/2", "9-17/2"): every n hours at a fixed minute.
function hourStepWords(hstep: RegExpMatchArray, minute: number, on: string, fmtClock: Fmt): string {
  const n = Number(hstep[3] || 1);
  const every = n === 1 ? (minute ? `Every hour at :${pad(minute)}` : 'Hourly') : `Every ${n} hours${minute ? ` at :${pad(minute)}` : ''}`;
  const span = hstep[1] ? `${fmtClock(Number(hstep[1]), 0)} to ${fmtClock((Number(hstep[2]) + 1) % 24, 0)}` : '';
  return [every, span, midSentence(on)].filter(Boolean).join(', ');
}

/** A cron in words, or null when it's more than words can say simply (callers show the cron). */
export function cronWords(cron: string | null | undefined, fmtClock: Fmt = localClock): string | null {
  const raw = String(cron || '').trim();
  const f = (CRON_ALIASES[raw] ?? raw).split(/\s+/);
  if (f.length !== 5 || f[3] !== '*') return null;
  const [mi = '', hr = '', dom = '', , dow = ''] = f;
  const days = daysWords(dow);
  if (days === null) return null;
  let monthly = '';
  if (dom !== '*') {
    const d = nums(dom, 1, 31);
    if (!d || d.length !== 1 || dow !== '*') return null;
    monthly = `On the ${ordinal(d[0] ?? 1)} of each month`;
  }
  const on = monthly || days;
  const step = mi.match(/^\*(?:\/(\d+))?$/);
  if (step) return stepWords(step, hr, on, fmtClock);
  const minute = nums(mi, 0, 59);
  if (!minute || minute.length !== 1) return null;
  const m0 = minute[0] ?? 0;
  const hstep = hr.match(/^(?:\*|(\d+)-(\d+))(?:\/(\d+))?$/);
  if (hstep) return hourStepWords(hstep, m0, on, fmtClock);
  const hs = nums(hr, 0, 23);
  if (!hs || hs.length > 4) return null;
  const at = `at ${list(hs.map((h) => fmtClock(h, m0)))}`;
  return on ? [on, at].join(' ') : `Every day ${at}`;
}
