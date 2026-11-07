// Track record's numbers (v1 crew-record.js), pure: token labels, shares, the per-day strip
// (weeks past 45 days), the one insight worth saying, and the whole crew ranked. Words are the
// component's (t keys); this returns which insight and its numbers.

import type { CrewStats, KindUsage, MemberStat, StatDay, StatKind, StatWindow } from './types.ts';

export const REPEATING: readonly StatKind[] = ['checkin', 'trigger'];

/** 950 → "950", 12_400 → "12k", 3_400_000 → "3.4M" */
export const toks = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
export const share = (a: number, b: number): number => (b ? Math.round((a / b) * 100) : 0);
export const pctOf = (a: number, b: number): string => `${share(a, b)}%`;
export const perDay = (n: number, r: { span: number }): number => n / (r.span || 1);
export const money = (usd: number): string => (usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`);

/** Check-ins that said something: all of them but the quiet ones. */
export const reported = (r: MemberStat): number => r.checkins - Math.min(r.quiet, r.checkins);

/** Past 45 days a bar is a week. */
export function binned(daily: readonly StatDay[]): (StatDay & { to?: string })[] {
  if (daily.length <= 45) return daily.slice();
  const out: (StatDay & { to?: string })[] = [];
  for (let i = 0; i < daily.length; i += 7) {
    const w = daily.slice(i, i + 7);
    const kinds: Partial<Record<StatKind, number>> = {};
    for (const d of w) for (const [k, v] of Object.entries(d.kinds ?? {})) kinds[k as StatKind] = (kinds[k as StatKind] ?? 0) + (v ?? 0);
    const first = w[0];
    const last = w.at(-1);
    if (!first || !last) continue;
    out.push({ date: first.date, to: last.date, tokens: w.reduce((n, d) => n + d.tokens, 0), quiet: w.reduce((n, d) => n + (d.quiet ?? 0), 0), kinds });
  }
  return out;
}

/** Repeating (check-ins, triggers) and asked (jobs you sent, tags, delegations) per day. */
export function splitDay(d: StatDay): { repeating: number; asked: number } {
  const k = d.kinds ?? {};
  return { repeating: (k.checkin ?? 0) + (k.trigger ?? 0), asked: (k.task ?? 0) + (k.mention ?? 0) + (k.delegated ?? 0) };
}

/** Where it went: kinds with runs, biggest first. */
export const kindsByTokens = (r: MemberStat): [StatKind, KindUsage][] =>
  (Object.entries(r.byKind) as [StatKind, KindUsage][]).filter(([, u]) => u.runs > 0).sort((a, b) => b[1].tokens - a[1].tokens);

/** A kind's line: repeating work as runs a day × tokens each, asked work as jobs × tokens each. */
export function kindLine(k: StatKind, u: KindUsage, r: MemberStat): { repeating: boolean; runsADay: number; runs: number; each: string; aDay: string; quietPct: number } {
  const each = toks(Math.round(u.tokens / (u.runs || 1)));
  return { repeating: REPEATING.includes(k), runsADay: Math.round(perDay(u.runs, r)), runs: u.runs, each, aDay: toks(Math.round(perDay(u.tokens, r))), quietPct: u.quiet ? share(u.quiet, u.runs) : 0 };
}

export type Insight =
  | { kind: 'quiet'; aDay: string; quietPct: number; quarter: string }
  | { kind: 'big'; pct: number; title: string; job: string }
  | { kind: 'limit'; pct: number; label: string }
  | { kind: 'missed' }
  | { kind: 'followed' };

/** One line that turns the numbers into a change, only with enough to go on (first match wins). */
export function insight(r: MemberStat, m: { id: string; paused: boolean }, st: Pick<CrewStats, 'windows'> | undefined): Insight | undefined {
  if (m.paused) return undefined;
  const c = r.byKind.checkin;
  if (c.runs >= 10 && c.quiet >= c.runs * 0.7 && c.tokens >= r.tokens * 0.3) {
    return { kind: 'quiet', aDay: toks(Math.round(perDay(c.tokens, r))), quietPct: share(c.quiet, c.runs), quarter: toks(Math.round(perDay(c.tokens, r) / 4)) };
  }
  const big = r.top[0];
  if (big && r.jobs >= 5 && big.tokens >= r.tokens * 0.4) return { kind: 'big', pct: share(big.tokens, r.tokens), title: big.title, job: big.id };
  const w = (st?.windows ?? []).filter((x) => (x.members[m.id] ?? 0) > 0 && x.used >= 0.5).sort((a, b) => b.used - a.used)[0];
  if (w && (w.members[m.id] ?? 0) >= w.tokens * 0.3) return { kind: 'limit', pct: share(w.members[m.id] ?? 0, w.tokens), label: w.label };
  const missed = r.partial + r.blocked + r.failed;
  const sent = r.jobs - r.kinds.checkin;
  if (r.counted >= 5 && missed >= r.counted * 0.4) return { kind: 'missed' };
  if (sent >= 5 && r.followedUp >= sent * 0.5) return { kind: 'followed' };
  return undefined;
}

/** The plan windows these members used, the fullest first, two at most. */
export function windowsFor(st: Pick<CrewStats, 'windows'> | undefined, ids: readonly string[]): (StatWindow & { mine: number; crew: number })[] {
  return (st?.windows ?? [])
    .filter((w) => ids.some((id) => (w.members[id] ?? 0) > 0))
    .sort((a, b) => b.used - a.used)
    .slice(0, 2)
    .map((w) => ({ ...w, mine: ids.reduce((n, id) => n + (w.members[id] ?? 0), 0), crew: Object.values(w.members).reduce((n, v) => n + v, 0) }));
}

export interface CrewRank {
  id: string;
  stat: MemberStat;
  pct: number;
}

/** The crew's view: members with tokens ranked, the rest idle, and your own tasks for scale. */
export function rankCrew(st: CrewStats, ids: readonly string[]): { busy: CrewRank[]; idle: MemberStat[]; tokens: number; cost: number; priced: boolean; yours: number } {
  const rows = ids.flatMap((id) => st.members.filter((x) => x.id === id));
  const tokens = rows.reduce((n, r) => n + (r.remote ? 0 : r.tokens), 0);
  const busy = rows
    .filter((r) => !r.remote && r.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map((r) => ({ id: r.id, stat: r, pct: share(r.tokens, tokens) }));
  return {
    busy,
    idle: rows.filter((r) => r.remote || !r.tokens),
    tokens,
    cost: rows.reduce((n, r) => n + (r.remote ? 0 : r.cost), 0),
    priced: rows.some((r) => r.priced),
    yours: Math.max(0, st.all.tokens - tokens),
  };
}

/** The crew's days: the busy members' tokens added up per day. */
export function crewDaily(busy: readonly CrewRank[]): StatDay[] {
  const first = busy[0]?.stat.daily ?? [];
  return first.map((d, i) => ({ date: d.date, tokens: busy.reduce((n, x) => n + (x.stat.daily[i]?.tokens ?? 0), 0), quiet: busy.reduce((n, x) => n + (x.stat.daily[i]?.quiet ?? 0), 0) }));
}
