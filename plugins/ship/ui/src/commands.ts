// Ship it's writes (v1 routes/ship.js, one command each, so wisp-ship's route adapters map 1:1).
// Each declares what shows at once; a refusal rolls it back and the shell's toast says why. Args
// carry the task's entity key: its peer runs the command (origin routing).

import { defineCommand, type EntityKey, type EntityReader, type LocalOp } from '@wisp/client';
import type { PatchOp } from '@wisp/protocol';
import { SESSION, type MergeResult, type PrSummary, type Review, type ShipInfo, type ShipResult, type ShipSession, type ShipStep } from './types.ts';

interface Task {
  readonly key: EntityKey;
}
const owner = (a: Task): string => a.key;
const row = (base: EntityReader, key: EntityKey): ShipSession | undefined => base.peek<ShipSession>(SESSION, key) as ShipSession | undefined;
const set = (key: EntityKey, path: string, value: unknown): LocalOp => ({ e: SESSION, id: key, op: 'patch', ops: [{ op: 'add', path, value } satisfies PatchOp] });

/** GET /sessions/:id/ship: what would ship (routes, counts, the drafted message). Reads only. */
export const prepare = defineCommand<Task, ShipInfo>({ id: 'ship.prepare', owner, optimistic: 'none' });

export interface ShipArgs extends Task {
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  /** the dialog's view: it pushes to open PRs (no new one) */
  readonly update: boolean;
  /** the first stage, so the row's track starts there at once */
  readonly first: ShipStep;
}

/** POST /sessions/:id/ship: commit, push, open or update the PR. The row starts its track at once. */
export const ship = defineCommand<ShipArgs, ShipResult>({
  id: 'ship.ship',
  owner,
  optimistic: (base, a) => (row(base, a.key) ? [set(a.key, '/shipping', { step: a.first, update: a.update })] : []),
});

/** POST /sessions/:id/pr: check the PR now (wisp also checks every minute). */
export const refresh = defineCommand<Task, PrSummary>({ id: 'ship.refresh', owner, optimistic: 'none' });

/** POST /sessions/:id/fix-conflicts: the row says "Fixing merge conflicts" at once. */
export const fixConflicts = defineCommand<Task>({
  id: 'ship.fixConflicts',
  owner,
  optimistic: (base, a) => {
    const s = row(base, a.key);
    return s ? [set(a.key, '/conflictFix', { ...s.conflictFix, step: 'fixing', why: '' })] : [];
  },
});

/** POST /sessions/:id/review: review by another harness, now. The chip says Reviewing at once. */
export const review = defineCommand<Task>({
  id: 'ship.review',
  owner,
  optimistic: (base, a) => {
    const s = row(base, a.key);
    if (!s?.pr) return [];
    const was = s.review;
    const head = s.pr.head ?? was?.head;
    const next: Review = { ...was, status: 'running', current: true, findings: [], ...(head !== undefined && { head }), ...(was?.by && { by: was.by }) };
    return [set(a.key, '/review', next)];
  },
});

/** POST /sessions/:id/merge: squash-merge each open PR, sync the local base, clean up. The confirm
 * came first; the merge itself takes seconds, so the flow shows it (not a guess at the result). */
export const merge = defineCommand<Task, MergeResult>({ id: 'ship.merge', owner, optimistic: 'none' });

/** GET /sessions/:id/check-log: the end of a failing check's log, for Ask to fix. Reads only. */
export const checkLog = defineCommand<Task & { readonly url: string }, { log: string }>({ id: 'ship.checkLog', owner, optimistic: 'none' });

export const COMMANDS = [prepare, ship, refresh, fixConflicts, review, merge, checkLog] as const;
