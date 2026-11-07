// My Stuff's rows as the UI reads them: every `stuff.item` the client holds, with its entity key,
// newest first (a save on its way at the top), minus what waits for its Undo toast.

import { createMemo, type Accessor } from 'solid-js';
import { entityKey, ownerOf, type EntityKey, type PluginClient, type SessionId } from '@wisp/client';
import { useSignal } from '@wisp/ui';
import { stuffState } from './state.ts';
import { ITEM, type Item, type TaskRow } from './types.ts';

export interface Entry {
  readonly key: EntityKey;
  readonly it: Item;
}

const order = (a: Entry, b: Entry): number => Number(!!b.it.pending) - Number(!!a.it.pending) || b.it.at - a.it.at;

/** Every item, hidden ones left out. Reading it tracks every row: a change anywhere repaints the list's shape, not its cards. */
export function useEntries(client: PluginClient): Accessor<Entry[]> {
  const keys = useSignal(client.entities.keys(ITEM));
  const rows = useSignal(client.entities.list<Item>(ITEM));
  const st = stuffState(client);
  return createMemo(() => {
    rows();
    const hidden = st.hidden();
    const out: Entry[] = [];
    for (const key of keys()) {
      if (hidden.has(key)) continue;
      const it = client.entities.peek<Item>(ITEM, key) as Item | undefined;
      if (it) out.push({ key, it });
    }
    return out.sort(order);
  });
}

/** One item, live. */
export function useItem(client: PluginClient, key: () => EntityKey | undefined): Accessor<Item | undefined> {
  // the subscription follows the key; reading the row doesn't re-subscribe
  const follow = createMemo(() => {
    const k = key();
    return k ? useSignal(client.entities.row<Item>(ITEM, k)) : undefined;
  });
  return () => follow()?.() as Item | undefined;
}

/** The key of the task an item came from, on the peer that keeps the item. */
export const taskKey = (key: EntityKey, session: string): SessionId => entityKey(ownerOf(key), session) as unknown as SessionId;

/** A task's row as the list has it (the runtime's `session` entity), if it's there. */
export function taskRow(client: PluginClient, key: EntityKey, session: string | undefined): TaskRow | undefined {
  if (!session) return undefined;
  return client.entities.peek<TaskRow>('session', entityKey(ownerOf(key), session)) as TaskRow | undefined;
}
