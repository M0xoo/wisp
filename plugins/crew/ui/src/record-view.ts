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
