// Reading a task and the people who can judge it, for the goal's components: the task's entity key,
// its row, the crew and the harnesses. One place, so every component reads them the same way.

import type { EntityKey, PluginClient } from '@wisp/client';
import { useSignal } from '@wisp/ui';
import type { Accessor } from 'solid-js';
import { KIND, type HarnessRow, type MemberRow, type SessionRow } from './types.ts';

/**
 * A task's entity key. The shell hands extensions the row (whose id may already carry its origin)
 * and screens the key; a bare id is this client's own wisp's.
 */
export function keyOf(client: PluginClient, id: string): EntityKey {
  return (id.includes(':') ? id : `${client.home}:${id}`) as EntityKey;
}

/** The bare id the peer knows the task by. */
export const bareId = (key: string): string => key.slice(key.indexOf(':') + 1);

/** The task's row, live. */
export function useTask(client: PluginClient, key: () => EntityKey | undefined): Accessor<SessionRow | undefined> {
  const k = key();
  if (!k) return () => undefined;
  const row = useSignal(client.entities.row<SessionRow>(KIND.session, k));
  // the server's row keeps the list's fields (the goal among them) in `summary`: read them as the row's own
  return () => {
    const r = row() as (SessionRow & { summary?: Record<string, unknown> }) | undefined;
    return r?.summary && typeof r.summary === 'object' ? ({ ...r.summary, ...r } as SessionRow) : r;
  };
}

export function useCrew(client: PluginClient): Accessor<readonly MemberRow[]> {
  const list = useSignal(client.entities.list<MemberRow>(KIND.member));
  return () => list() as readonly MemberRow[];
}

export function useHarnesses(client: PluginClient): Accessor<readonly HarnessRow[]> {
  const list = useSignal(client.entities.list<HarnessRow>(KIND.harness));
  return () => list() as readonly HarnessRow[];
}
