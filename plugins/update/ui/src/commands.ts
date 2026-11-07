// Updates' writes. Check now shows "Checking…" at once; Update now shows "Updating…" at once. The
// peer's patch replaces the row (no `checking`, a new status), or a refusal rolls it back.

import { defineCommand, entityKey, type EntityOps, type EntityReader, type PeerId } from '@wisp/client';
import { KIND, ROW_ID, type CheckArgs, type InstallArgs, type UpdateState } from './types.ts';

const patchRow = (base: EntityReader, peer: PeerId, fields: Partial<UpdateState>): EntityOps => {
  const id = entityKey(peer, ROW_ID);
  const row = base.peek<UpdateState>(KIND, id);
  return row ? [{ e: KIND, id, op: 'upsert', v: { ...row, ...fields } }] : [];
};

/** Check now (v1 Updater.check, also run daily by the server). */
export const checkNow = defineCommand<CheckArgs>({
  id: 'update.check',
  owner: (a) => a.peer,
  optimistic: (base, a) => patchRow(base, a.peer, { checking: true }),
});

/** Update now: install the latest and restart (v1 POST /api/update). */
export const installUpdate = defineCommand<InstallArgs>({
  id: 'update.install',
  owner: (a) => a.peer,
  optimistic: (base, a) => patchRow(base, a.peer, { status: 'installing', error: null }),
});
