// The PR pane's reading of one PR (v1 panel.js verdict / checksHtml / talkHtml / filesHtml): the
// one sentence about where it stands and its one next step, the checks grouped, the conversation
// with the noise folded, the files. Pure, so the pane only lays out what this decides.

import type { T } from '../i18n.ts';
import type { Check, Note, PrDetail, ShipSession, Thread } from '../types.ts';
import { fixing } from './pr.ts';
import { reviewState, type ReviewContext } from './review.ts';

export type VerdictTone = 'pass' | 'fail' | 'pending' | 'merged' | 'closed' | 'draft';
export type VerdictAction = 'merge' | 'fix';

export interface Verdict {
  readonly tone: VerdictTone;
  readonly text: string;
  readonly action?: VerdictAction;
  /** Merge is the primary button only when everything is clear */
  readonly primary?: boolean;
}

export const VERDICT_ICON = { pass: 'check', fail: 'x', pending: 'clock', merged: 'merge', closed: 'x', draft: 'pen' } as const satisfies Record<VerdictTone, string>;
/** The kit's tones for each verdict: state colours only. */
export const VERDICT_TONE = { pass: 'good', fail: 'bad', pending: 'warn', merged: 'info', closed: 'neutral', draft: 'neutral' } as const satisfies Record<VerdictTone, string>;

/** Is this PR the task's own (the one wisp fixes conflicts on and reviews)? */
export const isOwn = (p: PrDetail, s: ShipSession | undefined): boolean => !!s?.pr && s.pr.number === p.number && (p.repo === undefined || p.repo === s.project || !s.also?.length);

function reviewVerdict(t: T, p: PrDetail, s: ShipSession | undefined, ctx: ReviewContext): Verdict {
  const rv = isOwn(p, s) ? reviewState(t, s, ctx) : undefined;
  if (!rv || rv.kind === 'pass') return { tone: 'pass', text: rv ? t('wisp.ship.verdict.readyReviewed') : t('wisp.ship.verdict.ready'), action: 'merge', primary: true };
  const n = rv.n ?? 0;
  const why =
    rv.kind === 'running' ? t('wisp.ship.verdict.why.running')
    : rv.kind === 'issues' ? (rv.part ? t('wisp.ship.verdict.why.issuesPartly', { count: n }) : t('wisp.ship.verdict.why.issues', { count: n }))
    : rv.kind === 'tests' ? t('wisp.ship.verdict.why.tests')
    : rv.kind === 'partial' && rv.label === t('wisp.ship.rv.partial') ? t('wisp.ship.verdict.why.partly')
    : t('wisp.ship.verdict.why.not');
  return { tone: rv.kind === 'issues' || rv.kind === 'tests' ? 'fail' : 'pending', text: t('wisp.ship.verdict.canMerge', { why }), action: 'merge' };
}

// size-ok: one decision table, read top to bottom like the design's (design/side-panel.md, PR §4)
/** `ago` reads a past time the kit's way ("3m ago"). */
export function verdict(t: T, p: PrDetail, s: ShipSession | undefined, ctx: ReviewContext, ago: (at: number) => string): Verdict {
  const c = p.checks;
  const base = p.base || 'main';
  if (p.state === 'MERGED') {
    const at = p.mergedAt ? Date.parse(p.mergedAt) : NaN;
    return { tone: 'merged', text: Number.isFinite(at) ? t('wisp.ship.verdict.mergedAgo', { base, ago: ago(at) }) : t('wisp.ship.verdict.merged', { base }) };
  }
  if (p.state === 'CLOSED') return { tone: 'closed', text: t('wisp.ship.verdict.closed') };
  if (p.conflict) {
    const busy = fixing(s?.conflictFix);
    const canFix = !busy && isOwn(p, s) && s?.state !== 'running';
    return { tone: busy ? 'pending' : 'fail', text: busy ? t('wisp.ship.verdict.resolving') : t('wisp.ship.verdict.conflicts', { base }), ...(canFix && { action: 'fix' as const }) };
  }
  const changes = (p.reviewers ?? []).find((r) => r.state === 'CHANGES_REQUESTED');
  if (c?.fail) return { tone: 'fail', text: t('wisp.ship.verdict.failing', { count: c.fail }) };
  if (changes) return { tone: 'fail', text: t('wisp.ship.verdict.changesBy', { who: changes.author }) };
  if (c?.pending) return { tone: 'pending', text: t('wisp.ship.verdict.waiting', { count: c.pending }), action: 'merge' };
  if (p.draft) return { tone: 'draft', text: t('wisp.ship.verdict.draft'), action: 'merge' };
  if (p.review === 'REVIEW_REQUIRED') return { tone: 'pending', text: t('wisp.ship.verdict.needsReview'), action: 'merge' };
  return reviewVerdict(t, p, s, ctx);
}

/** A check's duration: "4s", "2m 05s"; '' when unknown. */
export function dur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

/** A comment's text, short: the first lines, no markdown noise (images, HTML comments, badges). */
export function gist(body: string | undefined, max = 420): string {
  const text = String(body ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** An avatar's letter: "lena" → L, "copilot[bot]" → C. */
export const initialOf = (who: string | undefined): string => String(who || '?').replace(/\[bot\]$/, '').slice(0, 1).toUpperCase();

export interface CheckGroups {
  /** failing, then running: always shown */
  readonly bad: readonly Check[];
  /** passed and skipped: folded into one row while something is wrong */
  readonly ok: readonly Check[];
  readonly passed: number;
  readonly skipped: number;
  /** the passed ones show unfolded (nothing is wrong, or the fold was opened) */
  readonly open: boolean;
}

const ORDER = { fail: 0, pending: 1, pass: 2, skip: 3 } as const;

export function checkGroups(list: readonly Check[], unfolded: boolean): CheckGroups {
  const sorted = [...list].sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
  const bad = sorted.filter((c) => c.state === 'fail' || c.state === 'pending');
  const ok = sorted.filter((c) => c.state === 'pass' || c.state === 'skip');
  const passed = ok.filter((c) => c.state === 'pass').length;
  return { bad, ok, passed, skipped: ok.length - passed, open: unfolded || !bad.length };
}

export const CHECK_ICON = { fail: 'x', pending: 'clock', skip: 'skip', pass: 'check' } as const;
export const CHECK_TONE = { fail: 'bad', pending: 'warn', skip: 'faint', pass: 'good' } as const;

export interface Talk {
  /** unresolved threads, oldest first: always shown, whoever wrote them */
  readonly live: readonly { readonly t: Thread; readonly i: number }[];
  readonly outdated: readonly { readonly t: Thread; readonly i: number }[];
  /** people's comments and reviews with words, oldest first */
  readonly people: readonly { readonly n: Note; readonly i: number }[];
  /** bots': folded, never dropped */
  readonly bots: readonly { readonly n: Note; readonly i: number }[];
  readonly empty: boolean;
}

export function talkOf(p: PrDetail): Talk {
  const threads = (p.threads ?? []).map((t, i) => ({ t, i }));
  const notes = (p.notes ?? []).map((n, i) => ({ n, i })).filter((x) => String(x.n.body || '').trim());
  const live = threads.filter((x) => !x.t.outdated);
  const outdated = threads.filter((x) => x.t.outdated);
  const people = notes.filter((x) => !x.n.bot);
  const bots = notes.filter((x) => x.n.bot);
  return { live, outdated, people, bots, empty: !threads.length && !notes.length };
}

export const FILES_SHOWN = 8;

export function filesOf(p: PrDetail, all: boolean): { readonly shown: NonNullable<PrDetail['files']>; readonly more: number } {
  const files = [...(p.files ?? [])].sort((a, b) => a.path.localeCompare(b.path));
  const shown = all ? files : files.slice(0, FILES_SHOWN);
  return { shown, more: (p.changedFiles || files.length) - shown.length };
}

/** "Checked just now" / "Checked 12s ago" / "Couldn't check just now". */
export function checkedLine(t: T, at: number, error: string | undefined, now: number, ago: (at: number) => string): string {
  if (error) return t('wisp.ship.pane.checkFailed');
  return now - at < 45_000 ? t('wisp.ship.pane.checkedNow') : t('wisp.ship.pane.checkedAgo', { ago: ago(at) });
}
