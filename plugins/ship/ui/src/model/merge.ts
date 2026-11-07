// Merge's words (v1 ship.js mergePr): what the confirm asks, what it warns about, and what the
// toasts say. A warning is a line, never a hold (design/ux.md): Merge turns red only for what's
// wrong with the PR (checks, review, a clash), not for comments you haven't sent.

import type { T } from '../i18n.ts';
import type { MergeResult, ShipSession } from '../types.ts';
import { openPrs, shippedPrs } from './pr.ts';
import { reviewWarning, type ReviewContext } from './review.ts';

export interface MergePlan {
  /** the confirm's question */
  readonly question: string;
  /** its lines under the question: warnings, then the unsent-comments line */
  readonly lines: readonly string[];
  /** the confirm's button: "Merge PR" / "Merge PRs" */
  readonly ok: string;
  /** something about the PR is wrong: the button is red */
  readonly danger: boolean;
  /** the toast while it merges */
  readonly merging: string;
  readonly several: boolean;
}

export function unsentLine(t: T, n: number | undefined): string {
  return n ? t('wisp.ship.warn.unsent', { count: n }) : '';
}

function checkWarnings(t: T, s: ShipSession, several: boolean): string[] {
  return openPrs(s).flatMap(({ repo, pr }) => {
    const c = pr.checks;
    const where = several ? t('wisp.ship.warn.where', { repo: repo ?? '' }) : '';
    if (c?.fail) return [t('wisp.ship.warn.failing', { count: c.fail, where })];
    if (c?.pending) return [t('wisp.ship.warn.pending', { count: c.pending, where })];
    return [];
  });
}

/** Undefined when the task has no open PR. */
export function mergePlan(t: T, s: ShipSession | undefined, ctx: ReviewContext): MergePlan | undefined {
  const open = openPrs(s);
  const first = open[0];
  if (!s || !first) return undefined;
  const several = open.length > 1;
  const warn = [...checkWarnings(t, s, several), reviewWarning(t, s, ctx), s.overlap ?? ''].filter(Boolean);
  const what = several
    ? t('wisp.ship.merge.these', { count: open.length, list: open.map((x) => `${x.repo ?? ''} #${x.pr.number}`).join(', ') })
    : t(first.pr.draft ? 'wisp.ship.merge.oneDraft' : 'wisp.ship.merge.one', { n: first.pr.number });
  // Only the PRs Ship it opened have a local base branch and a worktree; attached ones merge on
  // GitHub alone. A worktree brought in from another tool stays, whatever the merge does.
  const shipped = shippedPrs(s).filter((x) => x.pr.state === 'OPEN');
  const removed = shipped.filter((x) => !(s.foreign && x.pr === s.pr)).length;
  const after = shipped.length ? `${t('wisp.ship.merge.after', { count: shipped.length })}${removed ? t('wisp.ship.merge.andRemove', { count: removed }) : ''}` : '';
  return {
    question: t('wisp.ship.merge.question', { what, after }),
    lines: [...warn, unsentLine(t, s.unsentComments)].filter(Boolean),
    ok: several ? t('wisp.ship.merge.okMany') : t('wisp.ship.merge.okOne'),
    danger: warn.length > 0,
    merging: several ? t('wisp.ship.merge.mergingMany', { count: open.length }) : t('wisp.ship.merge.mergingOne', { n: first.pr.number }),
    several,
  };
}

/** The toast after: "Merged PR #412. main is up to date." — red when the local sync didn't work. */
export function mergedToast(t: T, r: MergeResult): { readonly text: string; readonly ok: boolean } {
  const merged = r.prs ? r.prs.filter((x) => x.state === 'MERGED').map((x) => `${x.repo} #${x.number}`).join(', ') : t('wisp.ship.tab.one', { n: r.pr.number });
  return { text: [t('wisp.ship.merge.done', { what: merged }), r.sync.text].filter(Boolean).join(' '), ok: r.sync.ok };
}
