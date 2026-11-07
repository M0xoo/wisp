// @wisp-plugin/ship-api: the contract of wisp.ship. Ship it (commit, push, open or update the PR in
// each of the task's repos), following PRs (checks, reviews, merges), Fix conflicts, squash-merging,
// and PRs an agent attaches to its task (wisp_pr).
//
// Per-task data sits in the session's ext slot `ext['wisp.ship']` (ShipExt): v1's session.pr, prs,
// also[].pr, toShip, shipping, conflictFix and pushedAt, so the importer maps them 1:1.
//
// The secret scanner lives here too (secret-scan.ts): text about to leave the computer — a PR body,
// a gist, a shared task — is checked by it. It is pure, so the page and other plugins import it.

import type { Json } from '@wisp/kernel';
import type { PrSummary } from '@wisp-plugin/git-api';

export { redactSecrets, scanAll, scanSecrets } from './secret-scan.ts';
export type { SecretHit } from './secret-scan.ts';

export const PLUGIN = 'wisp.ship';

export interface ToShip {
  dirty: number;
  ahead: number;
  unpushed: number;
  /** a task in several repos: how many have something to ship */
  repos?: number;
}

export interface Shipping {
  step: 'start' | 'commit' | 'push' | 'pr';
  update: boolean;
  startedAt: number;
  of?: number;
  repo?: string;
  at?: number;
}

export interface ConflictFix {
  step: 'fixing' | 'pushing' | 'done' | 'failed';
  head?: string;
  tries?: number;
  startedAt?: number;
  why?: string;
}

export interface ShipExt {
  /** the PR of the task's own branch */
  pr?: PrSummary;
  /** PRs of the task's other folders, by worktree path */
  alsoPrs?: Record<string, PrSummary>;
  /** PRs its agent attached (wisp_pr) */
  prs?: { repo: string; pr: PrSummary }[];
  toShip?: ToShip;
  shipping?: Shipping;
  conflictFix?: ConflictFix;
  pushedAt?: number;
}

export function shipOf(s: { ext?: Record<string, Json> } | null | undefined): ShipExt {
  const v = s?.ext?.[PLUGIN];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as unknown as ShipExt) : {};
}

// ---------- commands (permissions: git:ship, prs:*) ----------

export const COMMANDS = {
  /** { id } → what would ship (v1 GET /sessions/:id/ship) */
  view: 'ship.view',
  /** { id, title?, body?, draft? } → the PR (and prs, several repos) */
  ship: 'ship.ship',
  /** { id } → PrSummary: read its PRs again */
  refresh: 'ship.refresh',
  /** { id } → { conflictFix } */
  fixConflicts: 'ship.fixConflicts',
  /** { id } → { pr, sync, prs? } */
  merge: 'ship.merge',
  /** { id, ref, remove? } → PrSummary & { own } */
  attach: 'ship.attach',
  /** { id } → every PR in full (the PR panel) */
  details: 'ship.details',
  /** { id } → {}: is there something to ship (after wisp may have changed the folder) */
  recheck: 'ship.recheck',
  /** { id } → { title, body }: the default commit message and PR text */
  draft: 'ship.draft',
} as const;

export const EVENTS = {
  /** { sessionId, pr: PrSummary, prev?: PrSummary }: the task's own PR moved (state, head, checks, review) */
  prChanged: 'ship.pr.changed',
  /** { sessionId, prs: number } after Ship it */
  shipped: 'ship.shipped',
  /** { sessionId } after Merge */
  merged: 'ship.merged',
} as const;

export const HOOKS = {
  /** { sessionId, title, body, draft }: refuse or change a ship before anything is pushed */
  beforeShip: 'before:ship',
} as const;
