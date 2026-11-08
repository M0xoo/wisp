// Review by another harness (v1 ship.js reviewState / partOfDiff / reviewWarning, server
// services/review.js): where the task's own PR stands. `partial` means no findings but only part
// of the diff was read, which is never a pass. Pure; who reviews and whether the setting is on
// come in as a ReviewContext.
import type { IconName } from '@wisp/ui';
import type { T } from '../i18n.ts';
import type { Coverage, ShipSession } from '../types.ts';

export interface ReviewContext {
  /** Settings → Review by another harness is on */
  readonly reviewOn: boolean;
  readonly agentName: (id: string | undefined) => string | undefined;
}

export type ReviewKind = 'running' | 'none' | 'failed' | 'held' | 'tests' | 'issues' | 'partial' | 'pass';

export interface ReviewView {
  readonly kind: ReviewKind;
  readonly label: string;
  readonly title: string;
  /** findings */
  readonly n?: number;
  /** how much of the diff it read, in words ('' for all of it) */
  readonly part?: string;
}

export const REVIEW_ICON = { running: 'clock', none: 'judge', failed: 'warn', held: 'clock', tests: 'x', issues: 'warn', partial: 'warn', pass: 'check' } as const satisfies Record<ReviewKind, IconName>;

/** Not reviewed (or it didn't finish): the chip starts a review. Otherwise it opens the pane. */
export const reviewActs = (k: ReviewKind): boolean => k === 'none' || k === 'failed' || k === 'held';

/** "only 3 of 12 files", "only part of a.ts", or '' when it read the whole diff. */
export function partOfDiff(t: T, c: Coverage | undefined): string {
  if (!c || c.seen >= c.files) return '';
  if (c.seen) return t('wisp.ship.rv.seen', { seen: c.seen, count: c.files });
  const n = c.cut.length;
  if (!n) return t('wisp.ship.rv.none', { count: c.files });
  if (c.files === 1) return t('wisp.ship.rv.partOf', { file: c.cut[0] ?? '' });
  return n === c.files ? t('wisp.ship.rv.partsAll', { count: c.files }) : t('wisp.ship.rv.parts', { n, count: c.files });
}

function finished(t: T, s: ShipSession, by: string): ReviewView {
  const r = s.review;
  if (!r) return { kind: 'none', label: t('wisp.ship.rv.notReviewed'), title: t('wisp.ship.rv.notYet') };
  const n = r.findings.length;
  const part = partOfDiff(t, r.coverage);
  const note = part ? t('wisp.ship.rv.read', { by, part }) : '';
  const partly = part ? t('wisp.ship.rv.partlySuffix') : '';
  const cmd = r.tests?.command ?? '';
  if (r.tests?.verdict === 'fail') {
    const label = part ? `${t('wisp.ship.rv.testsFail')}${partly}` : n ? `${t('wisp.ship.rv.testsFail')} · ${t('wisp.ship.rv.issues', { count: n })}` : t('wisp.ship.rv.testsFail');
    const found = n ? t('wisp.ship.rv.andFound', { by, count: n }) : '';
    return { kind: 'tests', label, n, part, title: `${t('wisp.ship.rv.testsTitle', { cmd })}${found}${note}` };
  }
  if (n) return { kind: 'issues', label: `${t('wisp.ship.rv.issues', { count: n })}${partly}`, n, part, title: `${t('wisp.ship.rv.found', { by, count: n, summary: r.summary ?? '' })}${note}` };
  const passes = r.tests?.verdict === 'pass' ? t('wisp.ship.rv.passes', { cmd }) : '';
  if (part) return { kind: 'partial', label: r.coverage && (r.coverage.seen || r.coverage.cut.length) ? t('wisp.ship.rv.partial') : t('wisp.ship.rv.notReviewed'), part, title: `${t('wisp.ship.rv.reviewedPart', { by, part })}${passes}` };
  return { kind: 'pass', label: t('wisp.ship.rv.reviewed'), title: `${t('wisp.ship.rv.passTitle', { by, summary: r.summary || t('wisp.ship.rv.nothing') })}${r.tests ? t('wisp.ship.rv.passes', { cmd }) : ''}` };
}

/** Undefined when the PR isn't open, or the setting is off and nothing was ever reviewed. */
export function reviewState(t: T, s: ShipSession | undefined, ctx: ReviewContext): ReviewView | undefined {
  if (!s || s.pr?.state !== 'OPEN') return undefined;
  const r = s.review;
  if (!r && !ctx.reviewOn) return undefined;
  const by = ctx.agentName(r?.by?.agent) ?? r?.by?.agent ?? t('wisp.ship.rv.another');
  if (r?.status === 'running' && r.current) return { kind: 'running', label: t('wisp.ship.rv.reviewing'), title: t('wisp.ship.rv.runningTitle', { by }) };
  if (!r || !r.current) return { kind: 'none', label: t('wisp.ship.rv.notReviewed'), title: r ? t('wisp.ship.rv.sincePush') : t('wisp.ship.rv.notYet') };
  if (r.status === 'failed' || r.status === 'held') return { kind: r.status, label: t('wisp.ship.rv.notReviewed'), title: t('wisp.ship.rv.retry', { why: r.why || t('wisp.ship.rv.didntFinish') }) };
  return finished(t, s, by);
}

/** Merge's confirmation, in words: why it isn't reviewed, or what the review found; '' when it passed. */
export function reviewWarning(t: T, s: ShipSession | undefined, ctx: ReviewContext): string {
  const v = reviewState(t, s, ctx);
  if (!v || v.kind === 'pass') return '';
  const by = ctx.agentName(s?.review?.by?.agent) ?? s?.review?.by?.agent ?? t('wisp.ship.rv.another');
  if (v.kind === 'running') return t('wisp.ship.rv.warnRunning');
  if (v.kind === 'tests') return `⚠ ${v.title}.`;
  if (v.kind === 'issues') return `${t('wisp.ship.rv.warnIssues', { by, count: v.n ?? 0 })}${v.part ? t('wisp.ship.rv.warnRead', { part: v.part }) : ''}`;
  if (v.kind === 'partial') return t('wisp.ship.rv.warnPartial', { by, part: v.part ?? '' });
  return t('wisp.ship.rv.warnNone');
}
