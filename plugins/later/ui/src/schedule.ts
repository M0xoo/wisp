// A schedule in words ("every monday", "8am every weekday", "every 15 min between 9 and 6") to a
// 5-field cron and back (v1 web/js/schedule.js), plus the next times a cron runs, for the schedule
// editor's preview. Pure. A phrase with a word it doesn't know is refused rather than guessed; a
// cron typed as-is passes through.

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY = String.raw`(sun|mon|tue|wed|thu|fri|sat)[a-z]*`;
const CLOCK = String.raw`(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm)?`;
const PART_OF_DAY: Readonly<Record<string, number>> = { morning: 9, mornings: 9, noon: 12, midday: 12, lunchtime: 12, afternoon: 14, afternoons: 14, evening: 18, evenings: 18, night: 21, nights: 21, tonight: 21, midnight: 0 };
const FILLER = new Set(['every', 'each', 'on', 'at', 'in', 'the', 'and', 'a', 'an', 'of', 'run', 'runs', 'check', 'checks', 'please', 'o', 'clock', "o'clock", 'around', 'about', 'only', 'per', 'once', 'from', 'to', 'until', 'till', 'through', 'thru', 'between', 'during']);
const ALIASES: Readonly<Record<string, string>> = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@weekdays': '0 9 * * 1-5' };
const CRON = /^[\d*,/-]+(\s+[\d*,/-]+){4}$/;

type M = readonly (string | undefined)[];
interface Parse {
  minute: number | string | null;
  hour: string | null;
  hours: [number, number] | null;
  times: [number, number][];
  dow: number[] | null;
  dom: number | null;
  bad: boolean;
}

const isDay = (w: string): boolean => /^(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)$/.test(w) || /^(sun|mon|tues|wednes|thurs|fri|satur)days?$/.test(w);
const dayIndex = (w: string): number => DAY_NAMES.findIndex((d) => d.startsWith(w.slice(0, 3).toLowerCase()));
const range = (a: number, b: number): number[] => (a <= b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [...range(a, 6), ...range(0, b)]);
const ordinal = (n: number): string => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'));

function clock(h: string | number | undefined, mm: string | undefined, ap: string | undefined): [number, number] | null {
  let hh = Number(h);
  const min = Number(mm ?? 0);
  if (ap) {
    if (hh < 1 || hh > 12) return null;
    hh = (hh % 12) + (ap.startsWith('p') ? 12 : 0);
  }
  return hh > 23 || min > 59 ? null : [hh, min];
}

/** "1,2,3,4,5" → "1-5". */
function compact(nums: readonly number[]): string {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === (s[j] ?? 0) + 1) j++;
    out.push(j - i >= 2 ? `${s[i]}-${s[j]}` : j > i ? `${s[i]},${s[j]}` : `${s[i]}`);
    i = j;
  }
  return out.join(',');
}

/** Each rule reads one kind of phrase; `false` leaves the match in place (not this rule's). */
type Rule = readonly [RegExp, (m: M, p: Parse) => boolean | void];

function often(m: M, p: Parse): boolean | void {
  const word = m[1] ?? '1';
  const unitH = /^h/.test(m[2] ?? '');
  const n = word === 'other' ? 2 : /^half/.test(word) ? (unitH ? 30 : null) : word === 'quarter' ? (unitH ? 15 : null) : word === 'a' ? 1 : Number(word);
  if (!n) return void (p.bad = true);
  if (unitH && /^(half|quarter)/.test(word)) return void (p.minute = `*/${n}`);
  if (unitH) {
    if (n > 23) return void (p.bad = true);
    p.hour = n === 1 ? '*' : `*/${n}`;
    p.minute ??= 0;
  } else {
    if (n > 59) return void (p.bad = true);
    p.minute = n === 1 ? '*' : `*/${n}`;
  }
}

function between(m: M, p: Parse): void {
  const a = clock(m[1], m[2], m[3] ?? (m[6] && Number(m[1]) <= 12 && Number(m[1]) > Number(m[4]) ? 'am' : ''));
  let b = clock(m[4], m[5], m[6]);
  // "between 9 and 6": the end is after the start, so 6 is 18:00.
  if (b && a && !m[6] && b[0] <= a[0] && b[0] < 12) b = [b[0] + 12, b[1]];
  if (!a || !b || b[0] <= a[0]) return void (p.bad = true);
  p.hours = [a[0], b[0] + (b[1] ? 1 : 0)];
}

const RULES: readonly Rule[] = [
  [/ (?:every|each) (?:(\d+|other|half an?|half|quarter|a) )?(minutes?|mins?|m|hours?|hrs?|h)\b(?: (?:past|after) the hour)?/g, often],
  [/ (?:hourly|every hour on the hour)\b/g, (_m, p) => void ((p.hour = '*'), (p.minute ??= 0))],
  [/ (\d{1,2}) (?:minutes? )?past the hour\b/g, (m, p) => void (Number(m[1]) > 59 ? (p.bad = true) : ((p.minute = Number(m[1])), (p.hour ??= '*')))],
  [/ (?:during )?(?:work|working|office|business) hours\b/g, (_m, p) => void (p.hours = [9, 18])],
  [new RegExp(` (?:between|from) ${CLOCK} (?:and|to|until|till|-) ${CLOCK}\\b`, 'g'), between],
  [/ (?:every |each |on )?(?:weekdays?|work ?days?|working days?|business days?|mon(?:day)?s? ?(?:-|to|through|thru) ?fri(?:day)?s?)\b/g, (_m, p) => void (p.dow = [1, 2, 3, 4, 5])],
  [/ (?:every |each |on |at )?(?:the )?weekends?\b/g, (_m, p) => void (p.dow = [0, 6])],
  [new RegExp(` (${DAY}) ?(?:-|to|through|thru|until) ?(${DAY})\\b`, 'g'), (m, p) => (!isDay(m[1] ?? '') || !isDay(m[3] ?? '') ? false : void (p.dow = [...(p.dow ?? []), ...range(dayIndex(m[1] ?? ''), dayIndex(m[3] ?? ''))]))],
  [new RegExp(` ${DAY}\\b`, 'g'), (m, p) => (!isDay((m[0] ?? '').trim()) ? false : void (p.dow = [...(p.dow ?? []), dayIndex(m[1] ?? '')]))],
  [/ (?:every day|each day|daily|nightly|everyday|(?:once )?(?:a|per) day|every night|every morning|every evening|every afternoon)\b/g, (m, p) => {
    const part = (m[0] ?? '').match(/morning|evening|afternoon|night/)?.[0];
    if (part) p.times.push([PART_OF_DAY[part] ?? 9, 0]);
    p.dow ??= [];
  }],
  [/ (?:every |each |on )?(?:the )?(first|1st|last|\d{1,2}(?:st|nd|rd|th)?) (?:day )?of (?:the |each |every )?month\b/g, (m, p) => {
    if (m[1] === 'last') return void (p.bad = true); // cron has no "last day"
    const n = m[1] === 'first' ? 1 : parseInt(m[1] ?? '', 10);
    if (n < 1 || n > 31) return void (p.bad = true);
    p.dom = n;
  }],
  [/ (?:every month|each month|monthly|(?:once )?(?:a|per) month)\b/g, (_m, p) => void (p.dom ??= 1)],
  [/ (?:every week|each week|weekly|(?:once )?(?:a|per) week)\b/g, (_m, p) => void (p.dow ??= [1])],
  [new RegExp(` (?:at |@ ?)?${CLOCK}(?= |$)`, 'g'), (m, p) => {
    // A bare number only counts after "at", with a colon ("17:30"), or with am/pm.
    if (!/^\s*(at|@)/.test(m[0] ?? '') && !m[2] && !m[3]) return false;
    const t = clock(m[1], m[2], m[3]);
    if (!t) return void (p.bad = true);
    p.times.push(t);
  }],
  [/ (?:in the |at |every )?(morning|mornings|noon|midday|lunchtime|afternoons?|evenings?|nights?|tonight|midnight)\b/g, (m, p) => void p.times.push([PART_OF_DAY[m[1] ?? ''] ?? 9, 0])],
  [/ (?:and|&) (\d{1,2})(?= |$)/g, (m, p) => {
    // "at 9 and 5": the second takes the first's half of the day only when it makes sense.
    const last = p.times[p.times.length - 1];
    if (!last) return false;
    const n = Number(m[1]);
    const t = clock(n, '0', n <= 12 ? (last[0] >= 12 || n < last[0] ? 'pm' : 'am') : '');
    if (!t) return void (p.bad = true);
    p.times.push(t);
  }],
];

function assemble(p: Parse): string | null {
  let m: string;
  let h: string;
  if (p.times.length) {
    if (p.minute !== null || p.hour !== null) return null; // "every 15 min at 9am"
    const mins = new Set(p.times.map((t) => t[1]));
    if (mins.size > 1) return null; // 9:00 and 17:30 isn't one cron line
    m = `${p.times[0]?.[1] ?? 0}`;
    h = compact(p.times.map((t) => t[0]));
  } else if (p.minute !== null || p.hour !== null) {
    m = `${p.minute ?? 0}`;
    h = p.hour ?? '*';
    if (p.hours) h = h === '*' ? `${p.hours[0]}-${p.hours[1] - 1}` : `${p.hours[0]}-${p.hours[1] - 1}/${h.slice(2)}`;
  } else if (p.hours) {
    return null; // "during work hours", but how often?
  } else {
    m = '0';
    h = '9'; // a day with no time: the morning
  }
  return [m, h, p.dom ? `${p.dom}` : '*', '*', p.dow?.length && p.dow.length < 7 ? compact(p.dow) : '*'].join(' ');
}

/** Words → a cron string, or null when the words aren't a schedule it can read. */
export function toCron(text: string): string | null {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (raw in ALIASES || CRON.test(raw)) return raw;
  let s = ` ${raw.toLowerCase().replace(/[’`]/g, "'").replace(/[,;.!?]+(?=\s|$)/g, ' ').replace(/\s+/g, ' ')} `;
  const p: Parse = { minute: null, hour: null, hours: null, times: [], dow: null, dom: null, bad: false };
  for (const [re, fn] of RULES) s = s.replace(re, (...m: string[]) => (fn(m, p) === false ? (m[0] ?? '') : ' '));
  const left = s.split(' ').filter((w) => w && !FILLER.has(w));
  if (p.bad || left.length) return null;
  if (p.minute === null && p.hour === null && !p.hours && !p.times.length && !p.dow && !p.dom) return null;
  return assemble(p);
}

const pad = (n: number): string => String(n).padStart(2, '0');
export const clock24 = (h: number, m: number): string => `${h}:${pad(m)}`;

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

export const midSentence = (s: string): string => (s && !DAY_NAMES.some((d) => s.toLowerCase().startsWith(d)) ? (s[0] ?? '').toLowerCase() + s.slice(1) : s);
const list = (xs: readonly string[]): string => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : (xs[0] ?? ''));

function daysWords(dow: string): string | null {
  if (dow === '*') return '';
  const ds = nums(dow.replace(/\b7\b/g, '0'), 0, 6);
  if (!ds) return null;
  const set = [...new Set(ds)].sort();
  const key = set.join();
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '0,6') return 'Weekends';
  if (set.length === 7) return '';
  const name = (d: number): string => {
    const n = DAY_NAMES[d] ?? '';
    return (n[0] ?? '').toUpperCase() + n.slice(1);
  };
  if (/^\d-\d$/.test(dow) && set.length > 2) return `${name(set[0] ?? 0)} to ${name(set[set.length - 1] ?? 0)}`;
  return list(set.map((d) => `${name(d)}s`));
}

export type ClockFormat = (h: number, m: number) => string;

function within(mi: string, hr: string, on: string, fmt: ClockFormat): string | null {
  const step = mi.match(/^\*(?:\/(\d+))?$/);
  if (step) {
    const n = Number(step[1] ?? 1);
    const every = n === 1 ? 'Every minute' : `Every ${n} min`;
    if (hr === '*') return [every, midSentence(on)].filter(Boolean).join(', ');
    const span = hr.match(/^(\d+)-(\d+)$/);
    if (!span) return null;
    return [every, `${fmt(Number(span[1]), 0)} to ${fmt((Number(span[2]) + 1) % 24, 0)}`, midSentence(on)].filter(Boolean).join(', ');
  }
  const minute = nums(mi, 0, 59);
  if (minute?.length !== 1) return null;
  const mm = minute[0] ?? 0;
  const hstep = hr.match(/^(?:\*|(\d+)-(\d+))(?:\/(\d+))?$/);
  if (hstep) {
    const n = Number(hstep[3] ?? 1);
    const every = n === 1 ? (mm ? `Every hour at :${pad(mm)}` : 'Hourly') : `Every ${n} hours${mm ? ` at :${pad(mm)}` : ''}`;
    const span = hstep[1] ? `${fmt(Number(hstep[1]), 0)} to ${fmt((Number(hstep[2]) + 1) % 24, 0)}` : '';
    return [every, span, midSentence(on)].filter(Boolean).join(', ');
  }
  const hs = nums(hr, 0, 23);
  if (!hs || hs.length > 4) return null;
  const at = `at ${list(hs.map((h) => fmt(h, mm)))}`;
  return on ? `${on} ${at}` : `Every day ${at}`;
}

/** A cron in words ("Weekdays at 8:00", "Every 15 min, 9:00 to 18:00"), or null when it's more than words can say simply. */
export function cronWords(cron: string, fmt: ClockFormat = clock24): string | null {
  const raw = String(cron || '').trim();
  const f = (ALIASES[raw] ?? raw).split(/\s+/);
  if (f.length !== 5 || f[3] !== '*') return null;
  const [mi = '', hr = '', dom = '', , dow = ''] = f;
  const days = daysWords(dow);
  if (days === null) return null;
  let monthly = '';
  if (dom !== '*') {
    const d = nums(dom, 1, 31);
    if (d?.length !== 1 || dow !== '*') return null;
    monthly = `On the ${ordinal(d[0] ?? 1)} of each month`;
  }
  return within(mi, hr, monthly || days, fmt);
}

/** Each value a cron field allows, in order. */
function field(f: string, lo: number, hi: number): Set<number> | null {
  const out = new Set<number>();
  for (const piece of f.split(',')) {
    const r = piece.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!r) return null;
    const step = Number(r[2] ?? 1);
    const [a = lo, b] = r[1] === '*' ? [lo, hi] : (r[1] ?? '').split('-').map(Number);
    const end = b ?? (r[2] ? hi : a);
    if (step < 1 || a < lo || end > hi || a > end) return null;
    for (let v = a; v <= end; v += step) out.add(v);
  }
  return out;
}

/** The next `n` times (local) a cron runs after `from`, minute by minute up to a year out. */
export function nextRuns(cron: string, from: number, n = 3): number[] {
  const f = (ALIASES[cron.trim()] ?? cron.trim()).split(/\s+/);
  if (f.length !== 5) return [];
  const [mi, hr, dom, mon, dow] = [field(f[0] ?? '', 0, 59), field(f[1] ?? '', 0, 23), field(f[2] ?? '', 1, 31), field(f[3] ?? '', 1, 12), field((f[4] ?? '').replace(/\b7\b/g, '0'), 0, 6)];
  if (!mi || !hr || !dom || !mon || !dow) return [];
  const anyDom = f[2] === '*';
  const anyDow = f[4] === '*';
  const out: number[] = [];
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60 && out.length < n; i++) {
    const day = anyDom && anyDow ? true : anyDom ? dow.has(d.getDay()) : anyDow ? dom.has(d.getDate()) : dom.has(d.getDate()) || dow.has(d.getDay());
    if (!mon.has(d.getMonth() + 1) || !day) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!hr.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (mi.has(d.getMinutes())) out.push(d.getTime());
    d.setMinutes(d.getMinutes() + 1);
  }
  return out;
}
