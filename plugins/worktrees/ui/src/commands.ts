// The pane's writes. Each shows its result at once and rolls back if the peer refuses (v1 did the
// same by hand: a `gone` set for removals, the item's status for Keep, the offer held for Bring in).

import { defineCommand, entityKey, type EntityReader, type LocalOp } from '@wisp/client';
import { KIND, type BringInArgs, type CleanArgs, type DismissArgs, type KeepArgs, type WorktreeItem } from './types.ts';

/** Remove task folders and leftovers: their rows go now; the scan's next answer agrees or brings them back. */
export const clean = defineCommand<CleanArgs>({
  id: 'worktrees.clean',
  owner: (a) => a.peer,
  optimistic: (_base, a): LocalOp[] => [
    ...(a.ids ?? []).map((id): LocalOp => ({ e: KIND.item, id: entityKey(a.peer, id), op: 'del' })),
    ...(a.leftovers ?? []).map((name): LocalOp => ({ e: KIND.leftover, id: entityKey(a.peer, name), op: 'del' })),
  ],
});

/** Keep (pin) a task's worktree, or stop keeping it. Unpinned reads `checking` until the server looks again (v1). */
export const keep = defineCommand<KeepArgs>({
  id: 'worktrees.keep',
  owner: (a) => entityKey(a.peer, a.id),
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
  dedupe: (a) => a.project, // a double click is the first click (v1 `held`)
  optimistic: (_base, a): LocalOp[] => [{ e: KIND.offer, id: entityKey(a.peer, a.project), op: 'del' }],
});

/** Not now: the project's offer goes and isn't made again. */
export const dismiss = defineCommand<DismissArgs>({
  id: 'worktrees.dismiss',
  owner: (a) => a.peer,
  dedupe: (a) => a.project,
  optimistic: (_base, a): LocalOp[] => [{ e: KIND.offer, id: entityKey(a.peer, a.project), op: 'del' }],
});
