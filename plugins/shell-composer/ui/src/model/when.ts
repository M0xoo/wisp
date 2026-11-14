// "in 5 min run the e2e suite", "tomorrow at 9 check the nightly": a time at the start of a prompt
// (v1 web/js/when.js), and the times Start later offers. Only a whole phrase at the start counts,
// so "make the cron run at 2pm" is just a prompt: nothing is ever delayed on a guess. Pure: `now`
// is passed in.

const UNIT: Readonly<Record<string, number>> = { m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000, h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000, d: 86_400_000, day: 86_400_000, days: 86_400_000 };
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SHORT_DAYS = DAYS.map((d) => d.slice(0, 3));
const CLOCK = String.raw`(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm)?`;

function clock(h: string, mm: string | undefined, ap: string | undefined): [number, number] | null {
  let hh = Number(h);
  const min = Number(mm ?? 0);
  if (ap) {
    if (hh < 1 || hh > 12) return null;
    hh = (hh % 12) + (ap.toLowerCase() === 'pm' ? 12 : 0);
  }
  return hh > 23 || min > 59 ? null : [hh, min];
}

function at(now: Date, hm: [number, number] | null, days: number): number | null {
  return hm ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hm[0], hm[1]).getTime() : null;
}

type Try = readonly [string, (m: RegExpMatchArray) => number | null];

function tries(now: Date): Try[] {
  const g = (m: RegExpMatchArray, i: number): string | undefined => m[i] ?? undefined;
  return [
    [String.raw`in\s+(\d+(?:\.\d+)?|an?|half\s+an)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)\b`, (m) => {
      const word = g(m, 1) ?? '';
      const n = /^half/i.test(word) ? 0.5 : /^an?$/i.test(word) ? 1 : Number(word);
      const u = UNIT[(g(m, 2) ?? '').toLowerCase()];
      return u && n > 0 ? now.getTime() + Math.round(n * u) : null;
    }],
    [String.raw`tomorrow(?:\s+(?:at\s+)?${CLOCK})?`, (m) => at(now, g(m, 1) ? clock(g(m, 1) ?? '', g(m, 2), g(m, 3)) : [9, 0], 1)],
    [String.raw`tonight(?:\s+at\s+${CLOCK})?`, (m) => at(now, g(m, 1) ? clock(g(m, 1) ?? '', g(m, 2), g(m, 3) ?? 'pm') : [20, 0], 0)],
    [String.raw`on\s+(${DAYS.join('|')})(?:\s+(?:at\s+)?${CLOCK})?|(${DAYS.join('|')})\s+at\s+${CLOCK}`, (m) => {
      const [day, h, mm, ap] = g(m, 1) ? [g(m, 1), g(m, 2), g(m, 3), g(m, 4)] : [g(m, 5), g(m, 6), g(m, 7), g(m, 8)];
      const ahead = (DAYS.indexOf((day ?? '').toLowerCase()) - now.getDay() + 7) % 7 || 7;
      return at(now, h ? clock(h, mm, ap) : [9, 0], ahead);
    }],
    [String.raw`at\s+${CLOCK}`, (m) => {
      const hm = clock(g(m, 1) ?? '', g(m, 2), g(m, 3));
      const t = at(now, hm, 0);
      return t && t > now.getTime() ? t : at(now, hm, 1); // already past today: tomorrow
    }],
  ];
}

function phrase(text: string, now: Date, where: 'start' | 'end'): { at: number; start: number; len: number } | null {
  for (const [src, fn] of tries(now)) {
    const re = new RegExp(where === 'start' ? String.raw`^\s*(?:${src})(?=$|[\s,.:;—–-])` : String.raw`(?:^|\s)(?:${src})\s*[.!]?\s*$`, 'i');
    const m = re.exec(text);
    if (!m) continue;
    const t = fn(m);
    if (t) return { at: t, start: m.index, len: m[0].length };
  }
  return null;
}

const REMIND = /^\s*remind\s+me\s+(?:to\s+|about\s+|that\s+|of\s+)?/i;
const tidy = (s: string): string => s.replace(/^[\s,.:;—–-]+|[\s,;—–-]+$/g, '').trim();

/** → { at, rest, reminder } or null; rest is the prompt without the time (and "remind me"). */
export function parseWhen(text: string, now: Date): { at: number; rest: string; reminder: boolean } | null {
  if (!text.trim() || text.length > 4000) return null;
  const lead = phrase(text, now, 'start');
  if (lead) {
    let rest = tidy(text.slice(lead.start + lead.len));
    const reminder = REMIND.test(rest);
    if (reminder) rest = tidy(rest.replace(REMIND, ''));
    return rest ? { at: lead.at, rest, reminder } : null;
  }
  if (!REMIND.test(text)) return null;
  const body = text.replace(REMIND, '');
  const tail = phrase(body, now, 'end');
  const rest = tail ? tidy(body.slice(0, tail.start)) : '';
  return tail && rest ? { at: tail.at, rest, reminder: true } : null;
}

/** Start later's "Pick a time…" field: "tomorrow 10", "Fri 9", "14:30", "in 2 h". Null until readable. */
export function parseTime(field: string, now: Date): number | null {
  const s = field.trim().toLowerCase().replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/, (d) => `on ${DAYS[SHORT_DAYS.indexOf(d.slice(0, 3))] ?? d}`);
  const bare = /^\d{1,2}(?:[:.h]\d{2})?\s*(am|pm)?$/.test(s) ? `at ${s}` : s;
  const p = phrase(`${bare} .`, now, 'start');
  return p && p.at - now.getTime() >= 60_000 ? p.at : null;
}

/** Start later's presets: 10 min, 30 min, 1 h, 3 h ahead, and tomorrow at 9. */
export function laterPresets(now: Date): { readonly id: string; readonly at: number }[] {
  const t = now.getTime();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0).getTime();
  return [
    { id: '10m', at: t + 10 * 60_000 },
    { id: '30m', at: t + 30 * 60_000 },
    { id: '1h', at: t + 3_600_000 },
    { id: '3h', at: t + 3 * 3_600_000 },
    { id: 'tomorrow', at: tomorrow },
  ];
}

/** A time ahead, short: 14:32 today, Mon 9:00 this week, 2 Nov 9:00 after (v1 aheadLabel). */
export function aheadLabel(t: number, now: Date, locale?: string): string {
  const d = new Date(t);
  const hm = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return hm;
  if (t - now.getTime() < 6 * 86_400_000) return `${d.toLocaleDateString(locale, { weekday: 'short' })} ${hm}`;
  return `${d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })} ${hm}`;
}
