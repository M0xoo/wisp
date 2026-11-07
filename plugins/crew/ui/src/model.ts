// What the crew's screens say about a member, from its row and its jobs (v1 web/js/features/crew.js
// statusLine, rankCrew, crewRows, cadenceText, origin). Pure: `t` and `now` come in, so the tests
// read the same rules the rail, the section and the thread do.

import type { Key, Vars } from './i18n.ts';
import { needsYou, type MemberState } from './rules/feed.ts';
import { cronWords } from './rules/schedule.ts';
import type { JobKind, Member, SessionRow } from './types.ts';

export type T = (key: Key, vars?: Vars) => string;
export type State = MemberState<SessionRow>;

/** When it checks in, in words; any other cron is read out, or shows as itself. */
export const CADENCES: readonly (readonly [string, Key])[] = [
  ['', 'wisp.crew.cadence.asked'],
  ['*/30 * * * *', 'wisp.crew.cadence.30min'],
  ['0 * * * *', 'wisp.crew.cadence.hourly'],
  ['0 9 * * 1-5', 'wisp.crew.cadence.weekdays'],
  ['0 9 * * *', 'wisp.crew.cadence.mornings'],
  ['0 9 * * 1', 'wisp.crew.cadence.mondays'],
];
export const cadenceLabel = (cron: string, t: T): string => {
  const k = CADENCES.find(([c]) => c === (cron || ''))?.[1];
  return k ? t(k) : (cronWords(cron) ?? cron);
};

/** What else starts their jobs (v1 EVENTS): the chip, and how a sentence says it. */
export const EVENTS: readonly (readonly [string, Key, Key])[] = [
  ['finished', 'wisp.crew.event.finished', 'wisp.crew.event.finished.words'],
  ['done', 'wisp.crew.event.done', 'wisp.crew.event.done.words'],
  ['ci', 'wisp.crew.event.ci', 'wisp.crew.event.ci.words'],
];
export function eventsLabel(m: Pick<Member, 'on'>, t: T): string {
  const on = EVENTS.filter(([k]) => m.on?.includes(k)).map(([, , w]) => t(w));
  // "a task finishes or is marked done": the second "a task" goes
  return on.length ? t('wisp.crew.event.when', { what: on.join(` ${t('wisp.crew.or')} `).replace(` ${t('wisp.crew.or')} a task `, ` ${t('wisp.crew.or')} `) }) : '';
}
/** Their schedule and what else wakes them, in words. */
export const cadenceText = (m: Pick<Member, 'cron' | 'on'>, t: T): string => [m.cron ? cadenceLabel(m.cron, t) : '', eventsLabel(m, t)].filter(Boolean).join(' · ') || t('wisp.crew.cadence.oncall');

const BUSY: Readonly<Record<string, number>> = { checkin: 4, task: 4, delegated: 3, trigger: 3, mention: 3 };
/** The same variant for the same jobs: picked from their ids, so a line holds still. */
const pickOf = (n: number, id: string): number => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % n;

/** What a busy member is doing, in its own words. */
export function busyLine(live: readonly SessionRow[], t: T): string {
  if (live.length > 1) return t(`wisp.crew.busy.many.${pickOf(3, live.map((s) => s.id).sort().join())}` as Key, { n: live.length });
  const s = live[0];
  if (!s) return '';
  const job = s.crew?.job && BUSY[s.crew.job] ? s.crew.job : 'task';
  const from = s.crew?.from?.title || (job === 'trigger' ? t('wisp.crew.a-trigger') : t('wisp.crew.a-task'));
  return t(`wisp.crew.busy.${job}.${pickOf(BUSY[job] ?? 4, s.id)}` as Key, { from });
}

export interface Line {
  readonly tone: 'asks' | 'live' | 'report' | '';
  readonly text: string;
}

export interface LineCtx {
  t: T;
  now: number;
  /** "14:30", "Tue 09:00" */
  when: (at: number) => string;
  /** a machine id → its name */
  place?: (id: string) => string;
}

/** The member's status line: the same on its row, its tile's label and its card. */
export function statusLine(m: Member, st: State, c: LineCtx): Line {
  const { t } = c;
  const ask = st.jobs.find((s) => s.state === 'waiting');
  if (ask) return { tone: 'asks', text: ask.question ? t('wisp.crew.status.asking-q', { q: ask.question }) : t('wisp.crew.status.asking') };
  if (st.live.length) return { tone: 'live', text: busyLine(st.live, t) };
  const report = st.jobs.filter((s) => s.state === 'review' && needsYou(s)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (report) return { tone: 'report', text: t('wisp.crew.status.reported', { title: report.title }) };
  if (m.changed && m.paused) return { tone: '', text: m.changed.from ? t('wisp.crew.status.spell-changed') : t('wisp.crew.status.spell-new') };
  if (m.queue?.length) return { tone: '', text: t('wisp.crew.status.waiting', { count: m.queue.length }) };
  if (m.paused) return { tone: '', text: t('wisp.crew.status.paused') };
  if (m.wakeAt && m.wakeAt > c.now) return { tone: '', text: t('wisp.crew.status.looks-again', { when: c.when(m.wakeAt) }) };
  const where = m.machine ? ` · ${t('wisp.crew.status.on', { place: c.place?.(m.machine) ?? m.machine })}` : '';
  return { tone: '', text: `${cadenceText(m, t)}${where}` };
}

// ---------- who comes first ----------

const SENT_DAYS = 30;
const BY_YOU = new Set(['task', 'mention']);
/** Jobs you handed them or @-tagged them in, the last 30 days. */
export function sentByYou(st: State, now: number): { n: number; last: number } {
  const since = now - SENT_DAYS * 864e5;
  let n = 0;
  let last = 0;
  for (const s of [...st.jobs, ...st.sent]) {
    if (!s.pending && !BY_YOU.has(s.crew?.job ?? '')) continue;
    const at = s.createdAt || s.updatedAt || 0;
    if (!s.pending && at < since) continue;
    n += 1;
    last = Math.max(last, at);
  }
  return { n, last };
}
/** Asking you, then working for you (not just its rounds), an unread report, the rest, paused last. */
export const tier = (m: Pick<Member, 'paused'>, st: State): number => (st.asks ? 0 : st.live.some((s) => s.crew?.job !== 'checkin') ? 1 : st.unread ? 2 : m.paused ? 4 : 3);

/** Most-needed first (the rail, the section, the @ picker). Ties: more sent, latest sent, join order. */
export function rankCrew<M extends Pick<Member, 'id' | 'paused'>>(list: readonly M[], states: ReadonlyMap<string, State>, now: number): M[] {
  const at = new Map(list.map((m, i) => [m.id, i]));
  const key = new Map(
    list.map((m) => {
      const st = states.get(m.id);
      return [m.id, st ? { tier: tier(m, st), ...sentByYou(st, now) } : { tier: 3, n: 0, last: 0 }];
    }),
  );
  const k = (m: M): { tier: number; n: number; last: number } => key.get(m.id) ?? { tier: 3, n: 0, last: 0 };
  return [...list].sort((a, b) => k(a).tier - k(b).tier || k(b).n - k(a).n || k(b).last - k(a).last || (at.get(a.id) ?? 0) - (at.get(b.id) ?? 0));
}

/** Holding still while the pointer or focus is in: newcomers go last, nobody moves. */
export function holdOrder<M extends { id: string }>(ranked: readonly M[], held: readonly string[] | null): M[] {
  if (!held?.length) return [...ranked];
  const i = new Map(held.map((id, k) => [id, k]));
  return [...ranked].sort((a, b) => (i.get(a.id) ?? 1e9) - (i.get(b.id) ?? 1e9));
}

// ---------- the section's compact form ----------

export const ROWS_MIN = 2; // full rows even when nobody's busy
export const FACES_MAX = 4; // faces on the folded row

/** Busy members always get a row: asking you, on a job (not just its rounds), unread, open, a spell's change. */
export const busy = (m: Pick<Member, 'changed' | 'paused'>, st: State, open: ReadonlySet<string>): boolean =>
  st.asks || !!st.unread || st.live.some((s) => s.crew?.job !== 'checkin') || (!!m.changed && m.paused) || st.jobs.some((s) => open.has(s.id));

/** Who gets a full row; the rest fold into one row of faces. A single quiet member never folds alone. */
export function crewRows(list: readonly Member[], states: ReadonlyMap<string, State>, o: { all: boolean; open: ReadonlySet<string>; held?: ReadonlySet<string>; min?: number }): { full: Set<string>; busy: Set<string> } {
  if (o.all) return { full: new Set(list.map((m) => m.id)), busy: new Set() };
  const busyIds = new Set(list.filter((m) => { const st = states.get(m.id); return !!st && busy(m, st, o.open); }).map((m) => m.id));
  const full = new Set(busyIds);
  for (const m of list) if (full.size < (o.min ?? ROWS_MIN)) full.add(m.id);
  for (const id of o.held ?? []) if (states.has(id)) full.add(id);
  if (list.length - full.size === 1) for (const m of list) full.add(m.id);
  return { full, busy: busyIds };
}

/** The folded row's words: "4 on call", "3 on call · 1 paused". */
export function foldedWords(folded: readonly Pick<Member, 'paused'>[], t: T): string {
  const paused = folded.filter((m) => m.paused).length;
  const on = folded.length - paused;
  return [on ? t('wisp.crew.section.oncall', { n: on }) : '', paused ? t('wisp.crew.section.paused', { n: paused }) : ''].filter(Boolean).join(' · ');
}

// ---------- the thread ----------

export const JOB_ICON: Readonly<Record<JobKind, 'clock' | 'send' | 'agent' | 'bolt' | 'ask'>> = { checkin: 'clock', task: 'send', delegated: 'agent', trigger: 'bolt', mention: 'ask', event: 'bolt' };

/** Where a job came from, as its chip says it. */
export function originLabel(s: SessionRow, t: T): string {
  const c = s.crew;
  if (!c) return t('wisp.crew.origin.job');
  const from = c.from?.title ?? '';
  switch (c.job) {
    case 'checkin':
      return t('wisp.crew.origin.checkin');
    case 'task':
      return c.kit ? t('wisp.crew.origin.kit') : t('wisp.crew.origin.you');
    case 'mention':
      return from ? t('wisp.crew.origin.tagged-in', { from }) : t('wisp.crew.origin.tagged');
    case 'delegated':
      return from ? t('wisp.crew.origin.delegated-by', { from }) : t('wisp.crew.origin.delegated');
    case 'trigger':
      return from ? t('wisp.crew.origin.trigger-named', { from }) : t('wisp.crew.origin.trigger');
    case 'event':
      return `${c.event === 'done' ? t('wisp.crew.origin.marked-done') : t('wisp.crew.origin.finished')}${from ? ` “${from}”` : ''}`;
    default:
      return t('wisp.crew.origin.job');
  }
}

/** A check-in (or a check on a task) that found nothing: one faint line in the thread. */
export const quietJob = (s: SessionRow): boolean => (s.crew?.job === 'checkin' || s.crew?.job === 'event') && !!s.archived && s.state === 'done';

export type ThreadItem = { kind: 'job'; job: SessionRow } | { kind: 'quiet'; id: string; jobs: SessionRow[] };

/** The thread: jobs oldest first, runs of quiet ones folded into one line, the last `show` items. */
export function threadItems(jobs: readonly SessionRow[], show: number): { items: ThreadItem[]; earlier: number } {
  const sorted = [...jobs].sort((a, b) => a.createdAt - b.createdAt);
  const out: ThreadItem[] = [];
  for (const s of sorted) {
    const prev = out.at(-1);
    if (quietJob(s) && prev?.kind === 'quiet') prev.jobs.push(s);
    else out.push(quietJob(s) ? { kind: 'quiet', id: `q-${s.id}`, jobs: [s] } : { kind: 'job', job: s });
  }
  return { items: out.slice(Math.max(0, out.length - show)), earlier: Math.max(0, out.length - show) };
}

/** What a card row says on its right: what it's doing, or when it finished. */
export function jobSide(s: SessionRow, t: T, ago: (at: number) => string): string {
  if (s.pending) return t('wisp.crew.job.starting');
  if (s.state === 'waiting') return t('wisp.crew.job.asking');
  if (s.state === 'running') return t('wisp.crew.job.working');
  return ago(s.updatedAt);
}
