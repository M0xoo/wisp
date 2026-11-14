// A member's Track record (v1 crew-record.js memberView), pure: what its jobs used over the range (tokens, a day's
// worth), where they went by kind of job (its schedule and triggers are the repeating work, often the bulk), its
// biggest jobs, and how its jobs went in one line. Shares are percentages; outcomes stay "x of y" counts.

import { REPEATING, share, toks } from './more/record-logic.ts';
import type { StatKind } from './more/types.ts';

export type Say = (k: string, v?: Readonly<Record<string, string | number>>) => string;

export interface KindUse {
  readonly runs: number;
  readonly tokens: number;
  readonly quiet: number;
}

export interface MemberStats {
  readonly id: string;
  readonly jobs: number;
  readonly done: number;
  readonly failed: number;
  readonly quiet: number;
  readonly before?: number;
  readonly cost?: number;
  readonly tokens?: number;
  readonly byKind?: Readonly<Record<string, KindUse>>;
  readonly top?: readonly { readonly id: string; readonly title: string; readonly job: string; readonly tokens: number }[];
  readonly days?: number;
  readonly limits?: readonly MemberLimit[];
}

/** A plan window this period and the parts of it a member's jobs, the crew's and every traced task took (0..1). */
export interface MemberLimit {
  readonly agent: string;
  readonly account: string;
  readonly window: string;
  readonly label: string;
  readonly used: number;
  readonly resetsAt: number;
  readonly since: number | null;
  readonly mine: number;
  readonly crew: number;
  readonly traced: number;
}

/** One window row of *What ate your limits* (the kit's PlanAccount window row). `group`: its harness and account,
 * one block each (the label column is narrow: the window's own name only). */
export interface LimitRow {
  readonly key: string;
  readonly agent: string;
  readonly account: string;
  readonly label: string;
  readonly used: number;
  readonly pct: string;
  readonly line: string;
  readonly aria: string;
  readonly tone?: 'warn' | 'full';
}

const pct = (x: number): string => `${Math.round(Math.min(1, Math.max(0, x)) * 100)}%`;
const limitKey = (l: MemberLimit): string => `${l.agent}@${l.account}/${l.window}`;
const toneOf = (used: number): LimitRow['tone'] => (used >= 1 ? 'full' : used >= 0.9 ? 'warn' : undefined);
const sinceOf = (l: MemberLimit, say: Say, when: (at: number) => string): string =>
  l.since === null ? say('wisp.crew.record.thisPeriod') : say('wisp.crew.record.since', { at: when(l.since) });

function row(l: MemberLimit, who: string, say: Say, when: (at: number) => string): LimitRow {
  const label = l.label;
  const tone = toneOf(l.used);
  return {
    key: limitKey(l),
    agent: l.agent,
    account: l.account && l.account !== 'default' ? l.account : '',
    label,
    used: l.used,
    pct: pct(l.used),
    line: `${who} · ${say('wisp.crew.record.resets', { at: when(l.resetsAt) })}`,
    aria: say('wisp.crew.record.limitAria', { label }),
    ...(tone && { tone }),
  };
}

/** A member's *What ate your limits* (v1 crew-record.js limitsHtml): the fullest two windows its jobs took part of,
 * each with its part and the crew's beside it. */
export function memberLimits(s: MemberStats | undefined, name: string, say: Say, when: (at: number) => string): LimitRow[] {
  return [...(s?.limits ?? [])]
    .sort((a, b) => b.used - a.used)
    .slice(0, 2)
    .map((l) => {
      const key = l.crew > l.mine + 0.005 ? 'wisp.crew.record.tookWithCrew' : 'wisp.crew.record.took';
      return row(l, say(key, { since: sinceOf(l, say, when), name, mine: pct(l.mine), crew: pct(l.crew) }), say, when);
    });
}

/** The crew's *What ate your limits*: each window any member took part of (the fullest two), the crew's part, its
 * three biggest members and what the rest of the traced tasks (yours) took. */
export function crewLimits(list: readonly MemberStats[], nameOf: (id: string) => string, say: Say, when: (at: number) => string): LimitRow[] {
  const by = new Map<string, { l: MemberLimit; members: [string, number][] }>();
  for (const s of list) {
    for (const l of s.limits ?? []) {
      const e = by.get(limitKey(l)) ?? { l, members: [] };
      e.members.push([s.id, l.mine]);
      by.set(limitKey(l), e);
    }
  }
  return [...by.values()]
    .sort((a, b) => b.l.used - a.l.used)
    .slice(0, 2)
    .map(({ l, members }) => {
      const top = members
        .sort((a, b) => b[1] - a[1] || nameOf(a[0]).localeCompare(nameOf(b[0])))
        .slice(0, 3)
        .map(([id, n]) => `${nameOf(id)} ${pct(n)}`)
        .join(', ');
      const yours = pct(Math.max(0, l.traced - l.crew));
      const who = say('wisp.crew.record.crewTook', { since: sinceOf(l, say, when), crew: pct(l.crew), top, yours });
      return row(l, who, say, when);
    });
}

export interface RecordView {
  /** "84k tokens · 2.8k a day" */
  head: string;
  /** one line a kind with runs, biggest first */
  kinds: { key: string; label: string; line: string; pct: number }[];
  top: { id: string; title: string; tokens: string; pct: number }[];
  /** "12 of 14 finished · 1 failed · 3 found nothing to do" */
  outcome: string;
  empty: boolean;
}

export function memberRecord(s: MemberStats | undefined, days: number, say: Say): RecordView {
  const tokens = s?.tokens ?? 0;
  const kinds = Object.entries(s?.byKind ?? {})
    .filter(([, u]) => u.runs > 0)
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([k, u]) => {
      const each = toks(Math.round(u.tokens / (u.runs || 1)));
      const line = REPEATING.includes(k as StatKind)
        ? say('wisp.crew.record.kindRepeating', { n: Math.round(u.runs / (days || 1)), each, quiet: u.quiet ? share(u.quiet, u.runs) : 0 })
        : say('wisp.crew.record.kindAsked', { count: u.runs, each });
      return { key: k, label: say(`wisp.crew.record.kind.${k}`), line, pct: share(u.tokens, tokens) };
    });
  const top = (s?.top ?? []).map((j) => ({ id: j.id, title: j.title || say('wisp.crew.record.untitled'), tokens: toks(j.tokens), pct: share(j.tokens, tokens) }));
  const parts = s
    ? [say('wisp.crew.record.finishedOf', { n: s.done, of: s.jobs }), s.failed ? say('wisp.crew.record.failedN', { n: s.failed }) : '', s.quiet ? say('wisp.crew.record.quietN', { n: s.quiet }) : ''].filter(Boolean)
    : [];
  return {
    head: say('wisp.crew.record.head', { tokens: toks(tokens), day: toks(Math.round(tokens / (days || 1))) }),
    kinds,
    top,
    outcome: parts.join(' · '),
    empty: !s || s.jobs === 0,
  };
}
