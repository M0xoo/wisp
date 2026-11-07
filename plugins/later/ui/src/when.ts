// "in 5 min run the e2e suite", "tomorrow at 9 check the nightly", "remind me to review the PR in
// 1 hour": the time a prompt starts with (or, after "remind me", ends with), v1 web/js/when.js.
// Pure: the clock comes in as `now`. Only a whole phrase at the start counts, so "make the cron run
// at 2pm" is just a prompt: nothing is ever delayed on a guess.

export interface When {
  at: number;
  /** the prompt without the time (and without "remind me") */
  rest: string;
  reminder: boolean;
}

const UNIT: Readonly<Record<string, number>> = { m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000, h: 3600_000, hr: 3600_000, hrs: 3600_000, hour: 3600_000, hours: 3600_000, d: 86400_000, day: 86400_000, days: 86400_000 };
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const CLOCK = String.raw`(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm)?`;

type Groups = readonly (string | undefined)[];

function clock(h: string | undefined, mm: string | undefined, ap: string | undefined): [number, number] | null {
  let hh = Number(h);
  const min = Number(mm ?? 0);
  if (ap) {
    if (hh < 1 || hh > 12) return null;
    hh = (hh % 12) + (ap.toLowerCase() === 'pm' ? 12 : 0);
  }
  return hh > 23 || min > 59 ? null : [hh, min];
}

function at(now: Date, hm: [number, number] | null, days: number): number | null {
  if (!hm) return null;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hm[0], hm[1]).getTime();
}

function tries(now: Date): [string, (m: Groups) => number | null][] {
  return [
    [String.raw`in\s+(\d+(?:\.\d+)?|an?|half\s+an)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)\b`, (m) => {
      const n = /^half/i.test(m[1] ?? '') ? 0.5 : /^an?$/i.test(m[1] ?? '') ? 1 : Number(m[1]);
      const u = UNIT[(m[2] ?? '').toLowerCase()];
      return u && n > 0 ? now.getTime() + Math.round(n * u) : null;
    }],
    [String.raw`tomorrow(?:\s+(?:at\s+)?${CLOCK})?`, (m) => at(now, m[1] ? clock(m[1], m[2], m[3]) : [9, 0], 1)],
    [String.raw`tonight(?:\s+at\s+${CLOCK})?`, (m) => at(now, m[1] ? clock(m[1], m[2], m[3] ?? 'pm') : [20, 0], 0)],
    // "on Monday (at 9)" or "Monday at 9": a bare "Monday standup notes" is a prompt.
    [String.raw`on\s+(${DAYS.join('|')})(?:\s+(?:at\s+)?${CLOCK})?|(${DAYS.join('|')})\s+at\s+${CLOCK}`, (m) => {
      const [day, h, mm, ap] = m[1] ? m.slice(1, 5) : m.slice(5, 9);
      const ahead = (DAYS.indexOf((day ?? '').toLowerCase()) - now.getDay() + 7) % 7 || 7;
      return at(now, h ? clock(h, mm, ap) : [9, 0], ahead);
    }],
    [String.raw`at\s+${CLOCK}`, (m) => {
      const hm = clock(m[1], m[2], m[3]);
      if (!hm) return null;
      const t = at(now, hm, 0);
      return t !== null && t > now.getTime() ? t : at(now, hm, 1); // a time already past today is tomorrow
    }],
  ];
}

/** One phrase, anchored at the start or the end. */
function phrase(text: string, now: Date, where: 'start' | 'end'): { at: number; start: number; len: number } | null {
  const wrap = (src: string): RegExp => new RegExp(where === 'start' ? `^\\s*(?:${src})(?=$|[\\s,.:;—–-])` : `(?:^|\\s)(?:${src})\\s*[.!]?\\s*$`, 'i');
  for (const [src, fn] of tries(now)) {
    const m = text.match(wrap(src));
    if (!m) continue;
    const t = fn(m);
    if (t) return { at: t, start: m.index ?? 0, len: m[0].length };
  }
  return null;
}

const REMIND = /^\s*remind\s+me\s+(?:to\s+|about\s+|that\s+|of\s+)?/i;
const tidy = (s: string): string => s.replace(/^[\s,.:;—–-]+|[\s,;—–-]+$/g, '').trim();

/** The time a prompt starts with (or ends with, after "remind me"), or null. */
export function parseWhen(text: string, now: Date): When | null {
  const raw = String(text || '');
  if (!raw.trim() || raw.length > 4000) return null;
  const lead = phrase(raw, now, 'start');
  if (lead) {
    let rest = tidy(raw.slice(lead.start + lead.len));
    const reminder = REMIND.test(rest);
    if (reminder) rest = tidy(rest.replace(REMIND, ''));
    return rest ? { at: lead.at, rest, reminder } : null;
  }
  if (REMIND.test(raw)) {
    const body = raw.replace(REMIND, '');
    const tail = phrase(body, now, 'end');
    if (!tail) return null;
    const rest = tidy(body.slice(0, tail.start));
    return rest ? { at: tail.at, rest, reminder: true } : null;
  }
  return null;
}

/** "16:30", "tomorrow 10", "Friday 9", "2h": what the Pick a time… field reads. */
export function parseTime(v: string, now: Date): number | null {
  const t = String(v || '').trim();
  if (!t) return null;
  for (const x of [`${t} x`, `at ${t} x`, `on ${t} x`, `in ${t} x`]) {
    const p = parseWhen(x, now);
    if (p && p.rest === 'x') return p.at;
  }
  return null;
}
