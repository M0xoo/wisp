// A task's PRs and their words (v1 ship.js prTone / prLine / shippedPrs / prsOf / shippable /
// shipLabel): which PRs a row has, the tone each is in, its one line, and whether Ship it applies.
// Pure: the pill, the strip, the dialog and the pane all read these.
import type { T } from '../i18n.ts';
import type { ConflictFix, PrSummary, RepoPr, ShipSession } from '../types.ts';

export type PrTone = 'fail' | 'pending' | 'pass' | 'merged' | 'closed';

/** Worst first: the row takes the worst of its PRs. */
const ORDER: readonly PrTone[] = ['fail', 'pending', 'pass', 'merged', 'closed'];

/** wisp is resolving the PR's merge conflicts itself. */
export const fixing = (fix: ConflictFix | undefined | null): boolean => fix?.step === 'fixing' || fix?.step === 'pushing';

export function prTone(pr: PrSummary, fix?: ConflictFix | null): PrTone {
  if (pr.state === 'MERGED') return 'merged';
  if (pr.state === 'CLOSED') return 'closed';
  if (pr.conflict) return fixing(fix) ? 'pending' : 'fail';
  if (pr.checks?.fail) return 'fail';
  if (pr.checks?.pending) return 'pending';
  return pr.review === 'CHANGES_REQUESTED' ? 'fail' : 'pass';
}

export const worstTone = (tones: readonly PrTone[]): PrTone => [...tones].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))[0] ?? 'pass';

const REVIEW = { APPROVED: 'wisp.ship.pr.approved', CHANGES_REQUESTED: 'wisp.ship.pr.changes', REVIEW_REQUIRED: 'wisp.ship.pr.reviewRequired' } as const;

function conflictLine(t: T, fix: ConflictFix | null | undefined): string {
  const what =
    fix?.step === 'pushing' ? t('wisp.ship.pr.pushingFix')
    : fixing(fix) ? t('wisp.ship.pr.fixing')
    : fix?.step === 'failed' ? t('wisp.ship.pr.notFixed', { why: fix.why ?? '' })
    : t('wisp.ship.pr.conflicts');
  return `${t('wisp.ship.pr.open')} · ${what}`;
}

/** "Open · 2 checks failing · Changes requested" (v1 prLine). */
export function prLine(t: T, pr: PrSummary, fix?: ConflictFix | null): string {
  if (pr.state === 'OPEN' && (pr.conflict || fixing(fix))) return conflictLine(t, fix);
  const c = pr.checks;
  const checks = c?.fail ? t('wisp.ship.pr.failing', { count: c.fail }) : c?.pending ? t('wisp.ship.pr.running', { count: c.pending }) : c?.pass ? t('wisp.ship.pr.passed', { count: c.pass }) : t('wisp.ship.pr.noChecks');
  const state = pr.state === 'MERGED' ? t('wisp.ship.pr.merged') : pr.state === 'CLOSED' ? t('wisp.ship.pr.closed') : pr.draft ? t('wisp.ship.pr.draft') : t('wisp.ship.pr.open');
  const review = pr.state === 'OPEN' && pr.review ? t(REVIEW[pr.review]) : '';
  return [state, pr.state === 'OPEN' ? checks : '', review].filter(Boolean).join(' · ');
}

/** The pill's tooltip: "PR #412: Open · 3 checks passed". */
export const pillTitle = (t: T, pr: PrSummary, fix?: ConflictFix | null): string => t('wisp.ship.pill.title', { n: pr.number, line: prLine(t, pr, fix) });

/** The PRs Ship it opened: the task's own first, then its other repos'. */
export function shippedPrs(s: ShipSession | undefined): RepoPr[] {
  if (!s) return [];
  const own: RepoPr[] = s.pr ? [{ repo: s.project, pr: s.pr }] : [];
  const also = (s.also ?? []).flatMap((a): RepoPr[] => (a.pr ? [{ repo: a.project, pr: a.pr }] : []));
  return [...own, ...also];
}

/** Every PR the row shows: shipped ones, then the ones its agent attached (wisp_pr). */
export const prsOf = (s: ShipSession | undefined): RepoPr[] => [...shippedPrs(s), ...(s?.prs ?? []).map((x): RepoPr => ({ repo: x.repo, pr: x.pr }))];

/** The PR the row's pill shows. */
export const prOf = (s: ShipSession | undefined): PrSummary | undefined => prsOf(s)[0]?.pr;

export const openPrs = (s: ShipSession | undefined): RepoPr[] => prsOf(s).filter((x) => x.pr.state === 'OPEN');

/** Its branches: the task's own, then its other repos'. */
export const branchesOf = (s: ShipSession | undefined): string[] => [s?.branch, ...(s?.also ?? []).map((a) => a.branch)].filter((b): b is string => !!b);

/**
 * Ship it applies to a finished worktree task with something to ship: uncommitted changes, or
 * commits its open PR (or a new one) doesn't have. Not checked yet: it might. After its PR merged,
 * only work since then. Several repos: the server counts the ones with something new.
 */
export function shippable(s: ShipSession | undefined, sending = false): boolean {
  if (!s || !branchesOf(s).length || s.agent === 'wisp' || s.state === 'running' || s.state === 'waiting' || s.shipping || sending) return false;
  const ts = s.toShip;
  if (ts?.repos !== undefined) return ts.repos > 0;
  if (s.pr?.state === 'MERGED') return !!(ts?.dirty || ts?.unpushed);
  return !ts || !!(ts.dirty || (s.pr?.state === 'OPEN' ? ts.unpushed : ts.ahead));
}

/** The action's one name, in the bar, the menus and ⌘K. */
export function shipLabel(t: T, s: ShipSession): string {
  if (branchesOf(s).length > 1) return shippedPrs(s).some((x) => x.pr.state === 'OPEN') ? t('wisp.ship.action.pushMany') : t('wisp.ship.action.ship');
  return s.pr?.state === 'OPEN' ? t('wisp.ship.action.push', { n: s.pr.number }) : t('wisp.ship.action.ship');
}
