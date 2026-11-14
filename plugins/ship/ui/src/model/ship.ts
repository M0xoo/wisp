// Ship it's words and shapes (v1 ship.js shipSkel / shipDialog / renderShipRun / sendShip). The
// dialog opens on the click in its final shape, guessed from the row, and the answer fills it in
// place; the row then follows the stages as a track. Pure.

import type { T } from '../i18n.ts';
import type { ShipInfo, ShipRepo, ShipResult, ShipSession, ShipStep, Shipping } from '../types.ts';
import { branchesOf, shippedPrs } from './pr.ts';

/** What the dialog knows before the peer answers, from the row (its skeleton has the real shape). */
export interface ShipGuess {
  readonly repos: number;
  /** every PR it shipped is open: this pushes to them */
  readonly update: boolean;
  readonly pr?: number;
  readonly branches: readonly string[];
}

export function guessShip(s: ShipSession | undefined): ShipGuess {
  const prs = shippedPrs(s);
  const update = prs.length > 0 && prs.every((x) => x.pr.state === 'OPEN');
  const pr = prs[0]?.pr.number;
  return { repos: branchesOf(s).length || 1, update, branches: branchesOf(s), ...(pr !== undefined && { pr }) };
}

/** The same guess, from what the peer said. */
export function infoGuess(info: ShipInfo): ShipGuess {
  const repos = info.repos ?? [info];
  const pr = info.pr?.number ?? repos[0]?.pr?.number;
  return { repos: repos.length, update: repos.every((r) => r.pr?.state === 'OPEN'), branches: repos.map((r) => r.branch), ...(pr !== undefined && { pr }) };
}

export function dialogTitle(t: T, g: ShipGuess): string {
  if (g.update) return g.repos > 1 ? t('wisp.ship.dialog.pushMany', { count: g.repos }) : t('wisp.ship.dialog.pushOne', { n: g.pr ?? 0 });
  return g.repos > 1 ? t('wisp.ship.dialog.shipMany', { count: g.repos }) : t('wisp.ship.dialog.ship');
}

export function goLabel(t: T, g: ShipGuess): string {
  if (g.update) return t('wisp.ship.dialog.goPush');
  return g.repos > 1 ? t('wisp.ship.dialog.goPrs') : t('wisp.ship.dialog.goPr');
}

/** "Runs git commit, git push and gh pr create in the worktree." */
export function footLine(t: T, g: ShipGuess): string {
  const where = g.repos > 1 ? t('wisp.ship.dialog.whereMany') : t('wisp.ship.dialog.whereOne');
  return g.update ? t('wisp.ship.dialog.runsPush', { where }) : t('wisp.ship.dialog.runsPr', { where });
}

/** A route line's facts: "2 uncommitted changes · 3 commits on the branch · PR #412". */
export function routeFacts(t: T, r: ShipRepo, several: boolean): string {
  const dirty = r.dirty ? t('wisp.ship.dialog.dirty', { count: r.dirty }) : t('wisp.ship.dialog.clean');
  const pr = several && r.pr ? ` · ${t('wisp.ship.tab.one', { n: r.pr.number })}` : '';
  return `${dirty} · ${t('wisp.ship.dialog.ahead', { count: r.ahead })}${pr}`;
}

export type ShipBlock = 'noRemote' | 'nothing' | undefined;

/** Why Commit & push can't go: no remote anywhere, or nothing to ship. */
export function shipBlock(info: ShipInfo): ShipBlock {
  const repos = info.repos ?? [info];
  if (repos.every((r) => !r.remote)) return 'noRemote';
  if (!info.dirty && !info.ahead) return 'nothing';
  return undefined;
}

/** The stages a ship goes through, from what the dialog knew. */
export const stepsFor = (dirty: boolean): ShipStep[] => [...(dirty ? (['commit'] as const) : []), 'push', 'pr'];

export interface TrackStep {
  readonly step: ShipStep;
  readonly status: 'done' | 'current' | 'pending' | 'failed';
}

export interface Track {
  readonly steps: readonly TrackStep[];
  /** "Pushing app (1 of 2)" or "Ship failed at Push: …" */
  readonly what: string;
  readonly failed: boolean;
}

const STEP_LABEL = { commit: 'wisp.ship.step.commit', push: 'wisp.ship.step.push', pr: 'wisp.ship.step.pr', start: 'wisp.ship.step.start' } as const;
const STEP_DOING = { commit: 'wisp.ship.doing.commit', push: 'wisp.ship.doing.push', pr: 'wisp.ship.doing.pr', start: 'wisp.ship.doing.start' } as const;
export const stepLabel = (t: T, step: ShipStep): string => t(STEP_LABEL[step]);

/** A run as the row shows it. `steps` from the flow (or the server's stage when it started elsewhere). */
export function track(t: T, steps: readonly ShipStep[], live: Shipping | null | undefined, error: string | undefined, localStep?: ShipStep): Track {
  const step = live && live.step !== 'start' ? live.step : (localStep ?? steps[0] ?? 'push');
  const at = Math.max(steps.indexOf(step), 0);
  const failed = error !== undefined;
  const status = (i: number): TrackStep['status'] => (i < at ? 'done' : i === at ? (failed ? 'failed' : 'current') : 'pending');
  const cur = steps[at] ?? 'start';
  const repo = !failed && live?.repo ? (live.of && live.of > 1 ? t('wisp.ship.run.repoOf', { repo: live.repo, at: live.at ?? 1, of: live.of }) : live.repo) : '';
  const what = failed ? t('wisp.ship.run.failed', { step: stepLabel(t, cur), error }) : [t(STEP_DOING[cur]), repo].filter(Boolean).join(' ');
  return { steps: steps.map((s, i) => ({ step: s, status: status(i) })), what, failed };
}

/** Started elsewhere (another tab, the API): the server's stage alone. */
export const stepsOfLive = (live: Shipping): ShipStep[] => (live.update ? ['push', 'pr'] : ['commit', 'push', 'pr']);

/** After it lands: "Opened PR #412" / "Pushed to PR #412" / "PRs: app #3, api #9". */
export function shippedToast(t: T, r: ShipResult, update: boolean): string {
  if (r.prs) return t(update ? 'wisp.ship.toast.pushedMany' : 'wisp.ship.toast.openedMany', { list: r.prs.map((x) => `${x.repo} #${x.number}`).join(', ') });
  return t(update ? 'wisp.ship.toast.pushed' : 'wisp.ship.toast.opened', { n: r.number ?? 0 });
}
