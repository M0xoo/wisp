// A schedule in words ("every monday", "8am every weekday", "every 15 min between 9 and 6") to a
// 5-field cron (v1 web/js/schedule.js). DOM-free and pure: the server takes words too, so agents
// and spells can write them. A phrase with a word it doesn't know is refused rather than guessed;
// a cron typed as-is passes through. cronWords (the way back) is in ./says.ts.

export const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const DAY = String.raw`(sun|mon|tue|wed|thu|fri|sat)[a-z]*`;
const CLOCK = String.raw`(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm)?`;
const PART_OF_DAY: Readonly<Record<string, number>> = {
  morning: 9, mornings: 9, noon: 12, midday: 12, lunchtime: 12, afternoon: 14, afternoons: 14,
  evening: 18, evenings: 18, night: 21, nights: 21, tonight: 21, midnight: 0,
};
// Words that carry no meaning of their own once the rest is read.
const FILLER = new Set(['every', 'each', 'on', 'at', 'in', 'the', 'and', 'a', 'an', 'of', 'run', 'runs', 'check', 'checks', 'please', 'o', 'clock', "o'clock", 'around', 'about', 'only', 'per', 'once', 'from', 'to', 'until', 'till', 'through', 'thru', 'between', 'during']);
const ALIASES = new Set(['@hourly', '@daily', '@weekly', '@monthly', '@weekdays']);
const CRON = /^[\d*,/-]+(\s+[\d*,/-]+){4}$/;

// Whole names, their plurals and the usual short forms; not "month" or "saturated".
const isDay = (w: string): boolean => /^(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)$/.test(w) || /^(sun|mon|tues|wednes|thurs|fri|satur)days?$/.test(w);
const dayIndex = (w: string): number => DAY_NAMES.findIndex((d) => d.startsWith(w.slice(0, 3).toLowerCase()));
const range = (a: number, b: number): number[] => (a <= b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [...range(a, 6), ...range(0, b)]);

/** A clock reading → [hour, minute] in 24 h, or null when it isn't one. */
function clock(h: string | number | undefined, mm: string | undefined, ap: string | undefined): [number, number] | null {
  let hh = Number(h);
  const min = Number(mm || 0);
  if (ap) {
    if (hh < 1 || hh > 12) return null;
    hh = (hh % 12) + (ap[0] === 'p' ? 12 : 0);
  }
  return hh > 23 || min > 59 ? null : [hh, min];
}

/** "1,2,3,4,5" → "1-5": what a person would write, and what cronWords reads back. */
export function compact(nums: readonly number[]): string {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && (s[j + 1] ?? 0) === (s[j] ?? 0) + 1) j++;
    out.push(j - i >= 2 ? `${s[i]}-${s[j]}` : j > i ? `${s[i]},${s[j]}` : `${s[i]}`);
    i = j;
  }
  return out.join(',');
}

type Groups = (string | undefined)[];

/** What the words said so far, and what is left of them. */
interface Read {
  s: string;
  minute: string | number | null; // a fixed minute, or '*/n'
  hour: string | null; // '*/n' for "every n hours"
  hours: [number, number] | null; // [from, to) for "between 9 and 6"
  times: [number, number][];
  dow: number[] | null;
  dom: number | null;
  bad: boolean;
}

// Each match is cut out of r.s, unless fn returns false (the words weren't what it reads).
function take(r: Read, re: RegExp, fn: (m: Groups) => boolean | void): void {
  r.s = r.s.replace(re, (match: string, ...rest: unknown[]) => {
    const m: Groups = [match, ...rest.map((x) => (typeof x === 'string' ? x : undefined))];
    return fn(m) === false ? match : ' ';
  });
}

// How often: every n minutes / hours, hourly, every half hour.
function readEvery(r: Read): void {
  take(r, / (?:every|each) (?:(\d+|other|half an?|half|quarter|a) )?(minutes?|mins?|m|hours?|hrs?|h)\b(?: (?:past|after) the hour)?/g, (m) => {
    const word = m[1] || '1';
    const unitH = /^h/.test(m[2] ?? '');
    const n = word === 'other' ? 2 : /^half/.test(word) ? (unitH ? 30 : null) : word === 'quarter' ? (unitH ? 15 : null) : word === 'a' ? 1 : Number(word);
    if (!n) return (r.bad = true);
    if (unitH && /^(half|quarter)/.test(word)) {
      r.minute = `*/${n}`;
      return true;
    }
    if (n > (unitH ? 23 : 59)) return (r.bad = true);
    if (unitH) {
      r.hour = n === 1 ? '*' : `*/${n}`;
      r.minute ??= 0;
    } else r.minute = n === 1 ? '*' : `*/${n}`;
    return true;
  });
  take(r, / (?:hourly|every hour on the hour)\b/g, () => {
    r.hour = '*';
    r.minute ??= 0;
  });
  take(r, / (\d{1,2}) (?:minutes? )?past the hour\b/g, (m) => {
    if (Number(m[1]) > 59) return (r.bad = true);
    r.minute = Number(m[1]);
    r.hour ??= '*';
    return true;
  });
}

// Within which hours: "between 9 and 6", "from 9am to 5pm", "during work hours".
function readWithin(r: Read): void {
  take(r, / (?:during )?(?:work|working|office|business) hours\b/g, () => {
    r.hours = [9, 18];
  });
  take(r, new RegExp(` (?:between|from) ${CLOCK} (?:and|to|until|till|-) ${CLOCK}\\b`, 'g'), (m) => {
    const a = clock(m[1], m[2], m[3] || (m[6] && Number(m[1]) <= 12 && Number(m[1]) > Number(m[4]) ? 'am' : ''));
    let b = clock(m[4], m[5], m[6]);
    // "between 9 and 6": the end is after the start, so 6 is 18:00.
    if (b && a && !m[6] && b[0] <= a[0] && b[0] < 12) b = [b[0] + 12, b[1]];
    if (!a || !b || b[0] <= a[0]) return (r.bad = true);
    r.hours = [a[0], b[0] + (b[1] ? 1 : 0)];
    return true;
  });
}

// Which days.
function readDays(r: Read): void {
  take(r, / (?:every |each |on )?(?:weekdays?|work ?days?|working days?|business days?|mon(?:day)?s? ?(?:-|to|through|thru) ?fri(?:day)?s?)\b/g, () => {
    r.dow = [1, 2, 3, 4, 5];
  });
  take(r, / (?:every |each |on |at )?(?:the )?weekends?\b/g, () => {
    r.dow = [0, 6];
  });
  take(r, new RegExp(` (${DAY}) ?(?:-|to|through|thru|until) ?(${DAY})\\b`, 'g'), (m) => {
    if (!isDay(m[1] ?? '') || !isDay(m[3] ?? '')) return false;
    r.dow = [...(r.dow || []), ...range(dayIndex(m[1] ?? ''), dayIndex(m[3] ?? ''))];
    return true;
  });
  take(r, new RegExp(` ${DAY}\\b`, 'g'), (m) => {
    if (!isDay((m[0] ?? '').trim())) return false;
    r.dow = [...(r.dow || []), dayIndex(m[1] ?? '')];
    return true;
  });
  take(r, / (?:every day|each day|daily|nightly|everyday|(?:once )?(?:a|per) day|every night|every morning|every evening|every afternoon)\b/g, (m) => {
    const part = (m[0] ?? '').match(/morning|evening|afternoon|night/)?.[0];
    if (part) r.times.push([PART_OF_DAY[part] ?? 9, 0]);
    r.dow ??= [];
  });
  take(r, / (?:every |each |on )?(?:the )?(first|1st|last|\d{1,2}(?:st|nd|rd|th)?) (?:day )?of (?:the |each |every )?month\b/g, (m) => {
    if (m[1] === 'last') return (r.bad = true); // cron has no "last day"
    const n = m[1] === 'first' ? 1 : parseInt(m[1] ?? '', 10);
    if (!(n >= 1 && n <= 31)) return (r.bad = true);
    r.dom = n;
    return true;
  });
  take(r, / (?:every month|each month|monthly|(?:once )?(?:a|per) month)\b/g, () => {
    r.dom ??= 1;
  });
  take(r, / (?:every week|each week|weekly|(?:once )?(?:a|per) week)\b/g, () => {
    r.dow ??= [1];
  });
}

// What time: "8am", "at 9", "17:30", "9am and 5pm", "noon", "in the morning".
function readTimes(r: Read): void {
  take(r, new RegExp(` (?:at |@ ?)?${CLOCK}(?= |$)`, 'g'), (m) => {
    // A bare number only counts after "at" ("at 9"), or with a colon ("17:30"), or am/pm.
    if (!/^\s*(at|@)/.test(m[0] ?? '') && !m[2] && !m[3]) return false;
    const t = clock(m[1], m[2], m[3]);
    if (!t) return (r.bad = true);
    r.times.push(t);
    return true;
  });
  take(r, / (?:in the |at |every )?(morning|mornings|noon|midday|lunchtime|afternoons?|evenings?|nights?|tonight|midnight)\b/g, (m) => {
    r.times.push([PART_OF_DAY[m[1] ?? ''] ?? 9, 0]);
  });
  take(r, / (?:and|&) (\d{1,2})(?= |$)/g, (m) => {
    // "at 9 and 5": the second time takes the first's half of the day only when it makes sense.
    const last = r.times.at(-1);
    if (!last) return false;
    const n = Number(m[1]);
    const t = clock(n, '0', n <= 12 ? (last[0] >= 12 || n < last[0] ? 'pm' : 'am') : '');
    if (!t) return (r.bad = true);
    r.times.push(t);
    return true;
  });
}

// What was read → the minute and hour fields, or null when they don't make one cron line.
function minuteHour(r: Read): [string, string] | null {
  if (r.times.length) {
    if (r.minute !== null || r.hour !== null) return null; // "every 15 min at 9am"
    const mins = new Set(r.times.map((t) => t[1]));
    if (mins.size > 1) return null; // 9:00 and 17:30 isn't one cron line
    return [`${r.times[0]?.[1] ?? 0}`, compact(r.times.map((t) => t[0]))];
  }
  if (r.minute !== null || r.hour !== null) {
    let h = r.hour ?? '*';
    if (r.hours) h = h === '*' ? `${r.hours[0]}-${r.hours[1] - 1}` : `${r.hours[0]}-${r.hours[1] - 1}/${h.slice(2)}`;
    return [`${r.minute ?? 0}`, h];
  }
  if (r.hours) return null; // "during work hours", but how often?
  return ['0', '9']; // a day with no time: the morning
}

/** Words → a cron string, or null when the words aren't a schedule it can read. */
export function toCron(text: string | null | undefined): string | null {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (ALIASES.has(raw) || CRON.test(raw)) return raw;
  const s = ` ${raw.toLowerCase().replace(/[’`]/g, "'").replace(/[,;.!?]+(?=\s|$)/g, ' ').replace(/\s+/g, ' ')} `;
  const r: Read = { s, minute: null, hour: null, hours: null, times: [], dow: null, dom: null, bad: false };
  readEvery(r);
  readWithin(r);
  readDays(r);
  readTimes(r);
  const left = r.s.split(' ').filter((w) => w && !FILLER.has(w));
  if (r.bad || left.length) return null;
  const said = r.minute !== null || r.hour !== null || r.hours || r.times.length || r.dow || r.dom;
  if (!said) return null;
  const mh = minuteHour(r);
  if (!mh) return null;
  const dow = r.dow?.length && r.dow.length < 7 ? compact(r.dow) : '*';
  return [mh[0], mh[1], r.dom ? `${r.dom}` : '*', '*', dow].join(' ');
}
