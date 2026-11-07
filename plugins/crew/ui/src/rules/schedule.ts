// A schedule in words ("every monday", "8am every weekday", "every 15 min between 9 and 6") to a
// 5-field cron and back, for crew check-ins (v1 web/js/schedule.js, behaviour for behaviour). Pure:
// a phrase with a word it doesn't know is refused rather than guessed; a cron typed as-is passes.
// The wisp.later UI reads schedules the same way; this belongs in a shared api package once one exists.

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const DAY = String.raw`(sun|mon|tue|wed|thu|fri|sat)[a-z]*`;
const CLOCK = String.raw`(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm)?`;
const PART_OF_DAY: Readonly<Record<string, number>> = { morning: 9, mornings: 9, noon: 12, midday: 12, lunchtime: 12, afternoon: 14, afternoons: 14, evening: 18, evenings: 18, night: 21, nights: 21, tonight: 21, midnight: 0 };
// Words that carry no meaning of their own once the rest is read.
const FILLER = new Set(['every', 'each', 'on', 'at', 'in', 'the', 'and', 'a', 'an', 'of', 'run', 'runs', 'check', 'checks', 'please', 'o', 'clock', "o'clock", 'around', 'about', 'only', 'per', 'once', 'from', 'to', 'until', 'till', 'through', 'thru', 'between', 'during']);
const ALIASES = new Set(['@hourly', '@daily', '@weekly', '@monthly', '@weekdays']);
const CRON = /^[\d*,/-]+(\s+[\d*,/-]+){4}$/;

const isDay = (w: string): boolean => /^(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)$/.test(w) || /^(sun|mon|tues|wednes|thurs|fri|satur)days?$/.test(w);
const dayIndex = (w: string): number => DAY_NAMES.findIndex((d) => d.startsWith(w.slice(0, 3).toLowerCase()));
const range = (a: number, b: number): number[] => (a <= b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [...range(a, 6), ...range(0, b)]);
const ordinal = (n: number): string => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'));

type Time = readonly [number, number];

function clock(h: string | number, mm: string | undefined, ap: string | undefined): Time | null {
  let hh = Number(h);
  const min = Number(mm || 0);
  if (ap) {
    if (hh < 1 || hh > 12) return null;
    hh = (hh % 12) + (ap.startsWith('p') ? 12 : 0);
  }
  return hh > 23 || min > 59 ? null : [hh, min];
}

/** "1,2,3,4,5" → "1-5": what a person would write, and what cronWords reads back. */
function compact(list: readonly number[]): string {
  const s = [...new Set(list)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === (s[j] ?? 0) + 1) j++;
    out.push(j - i >= 2 ? `${s[i]}-${s[j]}` : j > i ? `${s[i]},${s[j]}` : `${s[i]}`);
    i = j;
  }
  return out.join(',');
}

/** What the words said so far. */
interface Said {
  s: string;
  minute: number | string | null; // a fixed minute, or '*/n'
  hour: string | null; // '*' or '*/n'
  hours: [number, number] | null; // [from, to) for "between 9 and 6"
  times: Time[];
  dow: number[] | null;
  dom: number | null;
  bad: boolean;
}

type Match = readonly (string | undefined)[];
/** Removes what `re` matches when `fn` accepts it (returns anything but false). */
function take(x: Said, re: RegExp, fn: (m: Match) => unknown): void {
  x.s = x.s.replace(re, (...m: unknown[]) => (fn(m.slice(0, -2) as Match) === false ? String(m[0]) : ' '));
}
const fail = (x: Said): true => (x.bad = true);

function howOften(x: Said): void {
  take(x, / (?:every|each) (?:(\d+|other|half an?|half|quarter|a) )?(minutes?|mins?|m|hours?|hrs?|h)\b(?: (?:past|after) the hour)?/g, (m) => {
    const word = m[1] || '1';
    const unitH = /^h/.test(m[2] ?? '');
    const n = word === 'other' ? 2 : /^half/.test(word) ? (unitH ? 30 : null) : word === 'quarter' ? (unitH ? 15 : null) : word === 'a' ? 1 : Number(word);
    if (!n) return fail(x);
    if (unitH && /^(half|quarter)/.test(word)) return (x.minute = `*/${n}`);
    if (unitH) {
      if (n > 23) return fail(x);
      x.hour = n === 1 ? '*' : `*/${n}`;
      x.minute ??= 0;
    } else {
      if (n > 59) return fail(x);
      x.minute = n === 1 ? '*' : `*/${n}`;
    }
    return true;
  });
  take(x, / (?:hourly|every hour on the hour)\b/g, () => {
    x.hour = '*';
    x.minute ??= 0;
  });
  take(x, / (\d{1,2}) (?:minutes? )?past the hour\b/g, (m) => {
    if (Number(m[1]) > 59) return fail(x);
    x.minute = Number(m[1]);
    x.hour ??= '*';
    return true;
  });
}

function withinHours(x: Said): void {
  take(x, / (?:during )?(?:work|working|office|business) hours\b/g, () => {
    x.hours = [9, 18];
  });
  take(x, new RegExp(` (?:between|from) ${CLOCK} (?:and|to|until|till|-) ${CLOCK}\\b`, 'g'), (m) => {
    const a = clock(m[1] ?? '', m[2], m[3] || (m[6] && Number(m[1]) <= 12 && Number(m[1]) > Number(m[4]) ? 'am' : ''));
    let b = clock(m[4] ?? '', m[5], m[6]);
    // "between 9 and 6": the end is after the start, so 6 is 18:00.
    if (b && a && !m[6] && b[0] <= a[0] && b[0] < 12) b = [b[0] + 12, b[1]];
    if (!a || !b || b[0] <= a[0]) return fail(x);
    x.hours = [a[0], b[0] + (b[1] ? 1 : 0)];
    return true;
  });
}

function whichDays(x: Said): void {
  take(x, / (?:every |each |on )?(?:weekdays?|work ?days?|working days?|business days?|mon(?:day)?s? ?(?:-|to|through|thru) ?fri(?:day)?s?)\b/g, () => {
    x.dow = [1, 2, 3, 4, 5];
  });
  take(x, / (?:every |each |on |at )?(?:the )?weekends?\b/g, () => {
    x.dow = [0, 6];
  });
  take(x, new RegExp(` (${DAY}) ?(?:-|to|through|thru|until) ?(${DAY})\\b`, 'g'), (m) => {
    if (!isDay(m[1] ?? '') || !isDay(m[3] ?? '')) return false;
    x.dow = [...(x.dow ?? []), ...range(dayIndex(m[1] ?? ''), dayIndex(m[3] ?? ''))];
    return true;
  });
  take(x, new RegExp(` ${DAY}\\b`, 'g'), (m) => {
    if (!isDay((m[0] ?? '').trim())) return false;
    x.dow = [...(x.dow ?? []), dayIndex(m[1] ?? '')];
    return true;
  });
  take(x, / (?:every day|each day|daily|nightly|everyday|(?:once )?(?:a|per) day|every night|every morning|every evening|every afternoon)\b/g, (m) => {
    const part = /morning|evening|afternoon|night/.exec(m[0] ?? '')?.[0];
    if (part) x.times.push([PART_OF_DAY[part] ?? 9, 0]);
    x.dow ??= [];
  });
  take(x, / (?:every |each |on )?(?:the )?(first|1st|last|\d{1,2}(?:st|nd|rd|th)?) (?:day )?of (?:the |each |every )?month\b/g, (m) => {
    if (m[1] === 'last') return fail(x); // cron has no "last day"
    const n = m[1] === 'first' ? 1 : parseInt(m[1] ?? '', 10);
    if (n < 1 || n > 31) return fail(x);
    x.dom = n;
    return true;
  });
  take(x, / (?:every month|each month|monthly|(?:once )?(?:a|per) month)\b/g, () => {
    x.dom ??= 1;
  });
  take(x, / (?:every week|each week|weekly|(?:once )?(?:a|per) week)\b/g, () => {
    x.dow ??= [1];
  });
}

function whatTime(x: Said): void {
  take(x, new RegExp(` (?:at |@ ?)?${CLOCK}(?= |$)`, 'g'), (m) => {
    // A bare number only counts after "at" ("at 9"), or with a colon ("17:30"), or am/pm.
    if (!/^\s*(at|@)/.test(m[0] ?? '') && !m[2] && !m[3]) return false;
    const t = clock(m[1] ?? '', m[2], m[3]);
    if (!t) return fail(x);
    x.times.push(t);
    return true;
  });
  take(x, / (?:in the |at |every )?(morning|mornings|noon|midday|lunchtime|afternoons?|evenings?|nights?|tonight|midnight)\b/g, (m) => {
    x.times.push([PART_OF_DAY[m[1] ?? ''] ?? 9, 0]);
  });
  take(x, / (?:and|&) (\d{1,2})(?= |$)/g, (m) => {
    // "at 9 and 5": the second time takes the first's half of the day only when it makes sense.
    const prev = x.times.at(-1)?.[0];
    if (prev === undefined) return false;
    const n = Number(m[1]);
    const t = clock(n, '0', n <= 12 ? (prev >= 12 || n < prev ? 'pm' : 'am') : '');
    if (!t) return fail(x);
    x.times.push(t);
    return true;
  });
}

/** The cron line from what was said, or null when it isn't one schedule. */
function assemble(x: Said): string | null {
  let m: string;
  let h: string;
  const first = x.times[0];
  if (first) {
    if (x.minute !== null || x.hour !== null) return null; // "every 15 min at 9am"
    if (new Set(x.times.map((t) => t[1])).size > 1) return null; // 9:00 and 17:30 isn't one cron line
    m = `${first[1]}`;
    h = compact(x.times.map((t) => t[0]));
  } else if (x.minute !== null || x.hour !== null) {
    m = `${x.minute ?? 0}`;
    h = x.hour ?? '*';
    if (x.hours) h = h === '*' ? `${x.hours[0]}-${x.hours[1] - 1}` : `${x.hours[0]}-${x.hours[1] - 1}/${h.slice(2)}`;
  } else if (x.hours) {
    return null; // "during work hours", but how often?
  } else {
    m = '0';
    h = '9'; // a day with no time: the morning
  }
  return [m, h, x.dom ? `${x.dom}` : '*', '*', x.dow?.length && x.dow.length < 7 ? compact(x.dow) : '*'].join(' ');
}

/** Words → a cron string, or null when the words aren't a schedule it can read. */
export function toCron(text: unknown): string | null {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  if (ALIASES.has(raw) || CRON.test(raw)) return raw;
  const s = ` ${raw.toLowerCase().replace(/[’`]/g, "'").replace(/[,;.!?]+(?=\s|$)/g, ' ').replace(/\s+/g, ' ')} `;
  const x: Said = { s, minute: null, hour: null, hours: null, times: [], dow: null, dom: null, bad: false };
  howOften(x);
  withinHours(x);
  whichDays(x);
  whatTime(x);
  const left = x.s.split(' ').filter((w) => w && !FILLER.has(w));
  if (x.bad || left.length) return null;
  const said = x.minute !== null || x.hour !== null || x.hours || x.times.length || x.dow || x.dom;
  return said ? assemble(x) : null;
}

const pad = (n: number): string => String(n).padStart(2, '0');
export type ClockFormat = (h: number, m: number) => string;
/** 24-hour clock, the tests' and the fallback format. */
export const clock24: ClockFormat = (h, m) => `${h}:${pad(m)}`;

function nums(field: string, lo: number, hi: number): number[] | null {
  const out: number[] = [];
  for (const piece of field.split(',')) {
    const r = /^(\d+)(?:-(\d+))?$/.exec(piece);
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
const joinAnd = (xs: readonly string[]): string => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : (xs[0] ?? ''));
const dayName = (d: number): string => {
  const n = DAY_NAMES[d] ?? '';
  return (n[0] ?? '').toUpperCase() + n.slice(1);
};

function daysWords(dow: string): string | null {
  if (dow === '*') return '';
  const ds = nums(dow.replace(/\b7\b/g, '0'), 0, 6);
  if (!ds) return null;
  const set = [...new Set(ds)].sort((a, b) => a - b);
  const key = set.join();
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '0,6') return 'Weekends';
  if (set.length === 7) return '';
  if (/^\d-\d$/.test(dow) && set.length > 2) return `${dayName(set[0] ?? 0)} to ${dayName(set.at(-1) ?? 0)}`;
  return joinAnd(set.map((d) => `${dayName(d)}s`));
}

const ALIAS: Readonly<Record<string, string>> = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@weekdays': '0 9 * * 1-5' };

function hourly(mi: number, hr: string, fmt: ClockFormat, tail: string): string | null {
  const hstep = /^(?:\*|(\d+)-(\d+))(?:\/(\d+))?$/.exec(hr);
  if (!hstep) return null;
  const n = Number(hstep[3] || 1);
  const every = n === 1 ? (mi ? `Every hour at :${pad(mi)}` : 'Hourly') : `Every ${n} hours${mi ? ` at :${pad(mi)}` : ''}`;
  const span = hstep[1] ? `${fmt(Number(hstep[1]), 0)} to ${fmt((Number(hstep[2]) + 1) % 24, 0)}` : '';
  return [every, span, midSentence(tail)].filter(Boolean).join(', ');
}

/**
 * A cron in words ("Weekdays at 8:00", "Every 15 min, 9:00 to 18:00"), or null when it's more than
 * words can say simply (callers then show the cron itself).
 */
export function cronWords(cron: unknown, fmt: ClockFormat = clock24): string | null {
  const raw = String(cron ?? '').trim();
  const f = (ALIAS[raw] ?? raw).split(/\s+/);
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
  const tail = monthly || days;
  const step = /^\*(?:\/(\d+))?$/.exec(mi);
  if (step) {
    const n = Number(step[1] || 1);
    const every = n === 1 ? 'Every minute' : `Every ${n} min`;
    if (hr === '*') return [every, midSentence(tail)].filter(Boolean).join(', ');
    const span = /^(\d+)-(\d+)$/.exec(hr);
    if (!span) return null;
    return [every, `${fmt(Number(span[1]), 0)} to ${fmt((Number(span[2]) + 1) % 24, 0)}`, midSentence(tail)].filter(Boolean).join(', ');
  }
  const minute = nums(mi, 0, 59);
  if (!minute || minute.length !== 1) return null;
  const m0 = minute[0] ?? 0;
  if (/^(?:\*|\d+-\d+)(?:\/\d+)?$/.test(hr)) return hourly(m0, hr, fmt, tail);
  const hs = nums(hr, 0, 23);
  if (!hs || hs.length > 4) return null;
  const at = `at ${joinAnd(hs.map((h) => fmt(h, m0)))}`;
  return tail ? `${tail} ${at}` : `Every day ${at}`;
}
