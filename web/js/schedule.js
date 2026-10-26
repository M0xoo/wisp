// A schedule in words ("every monday", "8am every weekday", "every 15 min between 9 and 6") to a
// 5-field cron and back, for crew check-ins and scheduled triggers. DOM-free: the server takes
// words too (server/crew.js, server/triggers.js), so agents and spells can write them. A phrase
// with a word it doesn't know is refused rather than guessed; a cron typed as-is passes through.

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY = String.raw`(sun|mon|tue|wed|thu|fri|sat)[a-z]*`;
const CLOCK = String.raw`(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm)?`;
const PART_OF_DAY = { morning: 9, mornings: 9, noon: 12, midday: 12, lunchtime: 12, afternoon: 14, afternoons: 14, evening: 18, evenings: 18, night: 21, nights: 21, tonight: 21, midnight: 0 };
// Words that carry no meaning of their own once the rest is read.
const FILLER = new Set(['every', 'each', 'on', 'at', 'in', 'the', 'and', 'a', 'an', 'of', 'run', 'runs', 'check', 'checks', 'please', 'o', 'clock', "o'clock", 'around', 'about', 'only', 'per', 'once', 'from', 'to', 'until', 'till', 'through', 'thru', 'between', 'during']);
const ALIASES = new Set(['@hourly', '@daily', '@weekly', '@monthly', '@weekdays']);
const CRON = /^[\d*,/-]+(\s+[\d*,/-]+){4}$/;

// Whole names, their plurals and the usual short forms; not "month" or "saturated".
const isDay = (w) => /^(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)$/.test(w) || /^(sun|mon|tues|wednes|thurs|fri|satur)days?$/.test(w);
const dayIndex = (w) => DAY_NAMES.findIndex((d) => d.startsWith(w.slice(0, 3).toLowerCase()));
const range = (a, b) => (a <= b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [...range(a, 6), ...range(0, b)]);
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

function clock(h, mm, ap) {
  let hh = Number(h);
  const min = Number(mm || 0);
  if (ap) {
    if (hh < 1 || hh > 12) return null;
    hh = (hh % 12) + (ap[0] === 'p' ? 12 : 0);
  }
  return hh > 23 || min > 59 ? null : [hh, min];
}

// "1,2,3,4,5" → "1-5": what a person would write, and what cronWords reads back.
function compact(nums) {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j - i >= 2 ? `${s[i]}-${s[j]}` : j > i ? `${s[i]},${s[j]}` : `${s[i]}`);
    i = j;
  }
  return out.join(',');
}

// → a cron string, or null when the words aren't a schedule it can read.
export function toCron(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (ALIASES.has(raw) || CRON.test(raw)) return raw;
  let s = ` ${raw.toLowerCase().replace(/[’`]/g, "'").replace(/[,;.!?]+(?=\s|$)/g, ' ').replace(/\s+/g, ' ')} `;
  const take = (re, fn) => {
    s = s.replace(re, (...m) => (fn(m) === false ? m[0] : ' '));
  };
  let minute = null; // a fixed minute, or '*/n'
  let hour = null; // '*/n' for "every n hours"
  let hours = null; // [from, to) for "between 9 and 6"
  const times = [];
  let dow = null;
  let dom = null;
  let bad = false;

  // How often: every n minutes / hours, hourly, every half hour.
  take(/ (?:every|each) (?:(\d+|other|half an?|half|quarter|a) )?(minutes?|mins?|m|hours?|hrs?|h)\b(?: (?:past|after) the hour)?/g, (m) => {
    const word = m[1] || '1';
    const unitH = /^h/.test(m[2]);
    let n = word === 'other' ? 2 : /^half/.test(word) ? (unitH ? 30 : null) : word === 'quarter' ? (unitH ? 15 : null) : word === 'a' ? 1 : Number(word);
    if (!n) return (bad = true);
    if (unitH && /^(half|quarter)/.test(word)) return (minute = `*/${n}`);
    if (unitH) {
      if (n > 23) return (bad = true);
      hour = n === 1 ? '*' : `*/${n}`;
      minute ??= 0;
    } else {
      if (n > 59) return (bad = true);
      minute = n === 1 ? '*' : `*/${n}`;
    }
  });
  take(/ (?:hourly|every hour on the hour)\b/g, () => {
    hour = '*';
    minute ??= 0;
  });
  take(/ (\d{1,2}) (?:minutes? )?past the hour\b/g, (m) => {
    if (Number(m[1]) > 59) return (bad = true);
    minute = Number(m[1]);
    hour ??= '*';
  });

  // Within which hours: "between 9 and 6", "from 9am to 5pm", "during work hours".
  take(/ (?:during )?(?:work|working|office|business) hours\b/g, () => {
    hours = [9, 18];
  });
  take(new RegExp(` (?:between|from) ${CLOCK} (?:and|to|until|till|-) ${CLOCK}\\b`, 'g'), (m) => {
    const a = clock(m[1], m[2], m[3] || (m[6] && Number(m[1]) <= 12 && Number(m[1]) > Number(m[4]) ? 'am' : ''));
    let b = clock(m[4], m[5], m[6]);
    // "between 9 and 6": the end is after the start, so 6 is 18:00.
    if (b && a && !m[6] && b[0] <= a[0] && b[0] < 12) b = [b[0] + 12, b[1]];
    if (!a || !b || b[0] <= a[0]) return (bad = true);
    hours = [a[0], b[0] + (b[1] ? 1 : 0)];
  });

  // Which days.
  take(/ (?:every |each |on )?(?:weekdays?|work ?days?|working days?|business days?|mon(?:day)?s? ?(?:-|to|through|thru) ?fri(?:day)?s?)\b/g, () => {
    dow = [1, 2, 3, 4, 5];
  });
  take(/ (?:every |each |on |at )?(?:the )?weekends?\b/g, () => {
    dow = [0, 6];
  });
  take(new RegExp(` (${DAY}) ?(?:-|to|through|thru|until) ?(${DAY})\\b`, 'g'), (m) => {
    if (!isDay(m[1]) || !isDay(m[3])) return false;
    dow = [...(dow || []), ...range(dayIndex(m[1]), dayIndex(m[3]))];
  });
  take(new RegExp(` ${DAY}\\b`, 'g'), (m) => {
    if (!isDay(m[0].trim())) return false;
    dow = [...(dow || []), dayIndex(m[1])];
  });
  take(/ (?:every day|each day|daily|nightly|everyday|(?:once )?(?:a|per) day|every night|every morning|every evening|every afternoon)\b/g, (m) => {
    const part = m[0].match(/morning|evening|afternoon|night/)?.[0];
    if (part) times.push([PART_OF_DAY[part], 0]);
    dow ??= [];
  });
  take(/ (?:every |each |on )?(?:the )?(first|1st|last|\d{1,2}(?:st|nd|rd|th)?) (?:day )?of (?:the |each |every )?month\b/g, (m) => {
    if (m[1] === 'last') return (bad = true); // cron has no "last day"
    const n = m[1] === 'first' ? 1 : parseInt(m[1], 10);
    if (n < 1 || n > 31) return (bad = true);
    dom = n;
  });
  take(/ (?:every month|each month|monthly|(?:once )?(?:a|per) month)\b/g, () => {
    dom ??= 1;
  });
  take(/ (?:every week|each week|weekly|(?:once )?(?:a|per) week)\b/g, () => {
    dow ??= [1];
  });

  // What time: "8am", "at 9", "17:30", "9am and 5pm", "noon", "in the morning".
  take(new RegExp(` (?:at |@ ?)?${CLOCK}(?= |$)`, 'g'), (m) => {
    // A bare number only counts after "at" ("at 9"), or with a colon ("17:30"), or am/pm.
    if (!/^\s*(at|@)/.test(m[0]) && !m[2] && !m[3]) return false;
    const t = clock(m[1], m[2], m[3]);
    if (!t) return (bad = true);
    times.push(t);
  });
  take(/ (?:in the |at |every )?(morning|mornings|noon|midday|lunchtime|afternoons?|evenings?|nights?|tonight|midnight)\b/g, (m) => {
    times.push([PART_OF_DAY[m[1]], 0]);
  });
  take(/ (?:and|&) (\d{1,2})(?= |$)/g, (m) => {
    // "at 9 and 5": the second time takes the first's half of the day only when it makes sense.
    if (!times.length) return false;
    const n = Number(m[1]);
    const prev = times[times.length - 1][0];
    const t = clock(n, 0, n <= 12 ? (prev >= 12 || n < prev ? 'pm' : 'am') : '');
    if (!t) return (bad = true);
    times.push(t);
  });

  const left = s.split(' ').filter((w) => w && !FILLER.has(w));
  if (bad || left.length) return null;
  const said = minute !== null || hour !== null || hours || times.length || dow || dom;
  if (!said) return null;

  let m;
  let h;
  if (times.length) {
    if (minute !== null || hour !== null) return null; // "every 15 min at 9am"
    const mins = new Set(times.map((t) => t[1]));
    if (mins.size > 1) return null; // 9:00 and 17:30 isn't one cron line
    m = `${times[0][1]}`;
    h = compact(times.map((t) => t[0]));
  } else if (minute !== null || hour !== null) {
    m = `${minute ?? 0}`;
    h = hour ?? '*';
    if (hours) h = h === '*' ? `${hours[0]}-${hours[1] - 1}` : `${hours[0]}-${hours[1] - 1}/${h.slice(2)}`;
  } else if (hours) {
    return null; // "during work hours", but how often?
  } else {
    m = '0';
    h = '9'; // a day with no time: the morning
  }
  return [m, h, dom ? `${dom}` : '*', '*', dow?.length && dow.length < 7 ? compact(dow) : '*'].join(' ');
}

const pad = (n) => String(n).padStart(2, '0');
export const clock24 = (h, m) => `${h}:${pad(m)}`;
let fmt;
const localClock = (h, m) => (fmt ||= new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' })).format(new Date(2000, 0, 1, h, m));

function nums(field, lo, hi) {
  const out = [];
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
// "Weekdays" → "weekdays" inside a sentence; day names keep their capital.
export const midSentence = (s) => (s && !DAY_NAMES.some((d) => s.toLowerCase().startsWith(d)) ? s[0].toLowerCase() + s.slice(1) : s);
const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);

function daysWords(dow) {
  if (dow === '*') return '';
  const ds = nums(dow.replace(/\b7\b/g, '0'), 0, 6);
  if (!ds) return null;
  const set = [...new Set(ds)].sort();
  const key = set.join();
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '0,6') return 'Weekends';
  if (set.length === 7) return '';
  const name = (d) => DAY_NAMES[d][0].toUpperCase() + DAY_NAMES[d].slice(1);
  if (/^\d-\d$/.test(dow) && set.length > 2) return `${name(set[0])} to ${name(set[set.length - 1])}`;
  return list(set.map((d) => `${name(d)}s`));
}

// A cron in words ("Weekdays at 8:00 AM", "Every 15 min, 9:00 AM to 6:00 PM"), or null when it's
// more than words can say simply (callers then show the cron itself).
export function cronWords(cron, fmtClock = localClock) {
  const raw = String(cron || '').trim();
  const alias = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@weekdays': '0 9 * * 1-5' }[raw];
  const f = (alias || raw).split(/\s+/);
  if (f.length !== 5 || f[3] !== '*') return null;
  const [mi, hr, dom, , dow] = f;
  const days = daysWords(dow);
  if (days === null) return null;
  let monthly = '';
  if (dom !== '*') {
    const d = nums(dom, 1, 31);
    if (!d || d.length !== 1 || dow !== '*') return null;
    monthly = `On the ${ordinal(d[0])} of each month`;
  }
  const on = (rest) => [monthly || days, rest].filter(Boolean).join(' ');
  // How often within the day.
  const step = mi.match(/^\*(?:\/(\d+))?$/);
  if (step) {
    const n = Number(step[1] || 1);
    const every = n === 1 ? 'Every minute' : `Every ${n} min`;
    if (hr === '*') return [every, midSentence(monthly || days)].filter(Boolean).join(', ');
    const span = hr.match(/^(\d+)-(\d+)$/);
    if (!span) return null;
    return [every, `${fmtClock(Number(span[1]), 0)} to ${fmtClock((Number(span[2]) + 1) % 24, 0)}`, midSentence(monthly || days)].filter(Boolean).join(', ');
  }
  const minute = nums(mi, 0, 59);
  if (!minute || minute.length !== 1) return null;
  const hstep = hr.match(/^(?:\*|(\d+)-(\d+))(?:\/(\d+))?$/);
  if (hstep) {
    const n = Number(hstep[3] || 1);
    const every = n === 1 ? (minute[0] ? `Every hour at :${pad(minute[0])}` : 'Hourly') : `Every ${n} hours${minute[0] ? ` at :${pad(minute[0])}` : ''}`;
    const span = hstep[1] ? `${fmtClock(Number(hstep[1]), 0)} to ${fmtClock((Number(hstep[2]) + 1) % 24, 0)}` : '';
    return [every, span, midSentence(monthly || days)].filter(Boolean).join(', ');
  }
  const hs = nums(hr, 0, 23);
  if (!hs || hs.length > 4) return null;
  const at = `at ${list(hs.map((h) => fmtClock(h, minute[0])))}`;
  return monthly || days ? on(at) : `Every day ${at}`;
}
