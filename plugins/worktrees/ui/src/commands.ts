// The pane's writes. Each shows its result at once and rolls back if the peer refuses (v1 did the
// same by hand: a `gone` set for removals, the item's status for Keep, the offer held for Bring in).

import { defineCommand, entityKey, type EntityReader, type LocalOp, type PeerId } from '@wisp/client';
import { KIND, type BringInArgs, type CleanArgs, type DismissArgs, type DoneApplyArgs, type DoneApplyOut, type DoneList, type KeepArgs, type WorktreeItem } from './types.ts';

/** Remove task folders and leftovers: their rows go now; the scan's next answer agrees or brings them back. */
export const clean = defineCommand<CleanArgs>({
  id: 'worktrees.clean',
  owner: (a) => a.peer,
  wire: ({ peer: _p, ...rest }) => rest,
  optimistic: (_base, a): LocalOp[] => [
    ...(a.ids ?? []).map((id): LocalOp => ({ e: KIND.item, id: entityKey(a.peer, id), op: 'del' })),
    ...(a.leftovers ?? []).map((name): LocalOp => ({ e: KIND.leftover, id: entityKey(a.peer, name), op: 'del' })),
  ],
});

/** Keep (pin) a task's worktree, or stop keeping it. Unpinned reads `checking` until the server looks again (v1). */
export const keep = defineCommand<KeepArgs>({
  id: 'worktrees.keep',
  owner: (a) => entityKey(a.peer, a.id),
  wire: (a) => ({ id: a.id, keep: a.keep }),
  optimistic: (base: EntityReader, a): LocalOp[] => {
    const id = entityKey(a.peer, a.id);
    if (!base.peek<WorktreeItem>(KIND.item, id)) return [];
    return [{ e: KIND.item, id, op: 'patch', ops: [{ op: 'replace', path: '/status', value: a.keep ? 'kept' : 'checking' }] }];
  },
});

/** Bring in an offer's worktrees as tasks: the offer goes at once; the tasks arrive on the list topic. */
export const bringIn = defineCommand<BringInArgs>({
  id: 'worktrees.bringIn',
  owner: (a) => a.peer,
  wire: (a) => ({ project: a.project, paths: a.paths }),
  dedupe: (a) => a.project, // a double click is the first click (v1 `held`)
  optimistic: (_base, a): LocalOp[] => [{ e: KIND.offer, id: entityKey(a.peer, a.project), op: 'del' }],
});

/** Not now: the project's offer goes and isn't made again. */
export const dismiss = defineCommand<DismissArgs>({
  id: 'worktrees.dismiss',
  owner: (a) => a.peer,
  wire: (a) => ({ project: a.project }),
  dedupe: (a) => a.project,
  optimistic: (_base, a): LocalOp[] => [{ e: KIND.offer, id: entityKey(a.peer, a.project), op: 'del' }],
});

/** Done's folders (v1 GET /sessions/:id/folders): `sizes: false` answers at once, the second ask brings sizes. */
export const doneList = defineCommand<{ peer: PeerId; sessionId: string; sizes: boolean }, DoneList>({
  id: 'worktrees.done.list',
  owner: (a) => entityKey(a.peer, a.sessionId),
  wire: (a) => ({ sessionId: a.sessionId, sizes: a.sizes }),
  optimistic: 'none',
  pending: 'the Done folders dialog (its placeholder rows)',
});

/** The answer (v1 POST /sessions/:id/folders): kept rows read Kept at once; removed ones leave when the server says. */
export const doneApply = defineCommand<DoneApplyArgs, DoneApplyOut>({
  id: 'worktrees.done.apply',
  owner: (a) => entityKey(a.peer, a.sessionId),
  wire: (a) => ({ sessionId: a.sessionId, remove: a.remove ?? [], force: a.force ?? [], keep: a.keep ?? [] }),
  optimistic: (base: EntityReader, a): LocalOp[] =>
    (a.keepTasks ?? [])
      .map((t) => entityKey(a.peer, t))
      .filter((id) => base.peek<WorktreeItem>(KIND.item, id) !== undefined)
      .map((id): LocalOp => ({ e: KIND.item, id, op: 'patch', ops: [{ op: 'replace', path: '/status', value: 'kept' }] })),
});
