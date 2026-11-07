// Reading the crew and writing a member, for the second half's screens: rows with their entity
// keys (a command goes to the peer that owns the member), and the one optimistic write path.

import { computed, type EntityKey, type PluginClient, type Readable } from '@wisp/client';
import { useSignal } from '@wisp/ui';
import type { Accessor } from 'solid-js';
import { KIND } from '../types.ts';
import { updateMember, type MemberBody } from './commands.ts';
import type { HarnessRow, MemberView, ProjectRow } from './types.ts';

export interface Keyed {
  readonly key: EntityKey;
  readonly m: MemberView;
}

const cache = new WeakMap<PluginClient, Readable<readonly Keyed[]>>();

/** Every member with its key, in the peer's order; one computed per client. */
export function crewOf(client: PluginClient): Readable<readonly Keyed[]> {
  let c = cache.get(client);
  if (!c) {
    const keys = client.entities.keys(KIND.member);
    c = computed(() =>
      keys().flatMap((key) => {
        const m = client.entities.row<MemberView>(KIND.member, key)() as MemberView | undefined;
        return m ? [{ key, m }] : [];
      }),
    );
    cache.set(client, c);
  }
  return c;
}

export function useCrew(client: PluginClient): Accessor<readonly Keyed[]> {
  return useSignal(crewOf(client));
}

export function keyOf(client: PluginClient, id: string): EntityKey | undefined {
  return crewOf(client)().find((x) => x.m.id === id)?.key;
}

export function memberOf(client: PluginClient, id: string): MemberView | undefined {
  return crewOf(client)().find((x) => x.m.id === id)?.m;
}

/** Saves part of a member: the row changes at once; refused, it goes back (and the client toasts). Resolves whether it saved. */
export async function patchMember(client: PluginClient, id: string, body: MemberBody): Promise<boolean> {
  const key = keyOf(client, id);
  if (!key) return false;
  try {
    await client.run(updateMember, { key, id, ...body });
    return true;
  } catch {
    return false;
  }
}

/** Projects, as the list holds them (for Works in). */
export function useProjects(client: PluginClient): Accessor<readonly ProjectRow[]> {
  return useSignal(client.entities.list<ProjectRow>('project')) as Accessor<readonly ProjectRow[]>;
}

const FALLBACK_HARNESSES: readonly HarnessRow[] = [
  { id: 'claude', name: 'Claude Code', available: true },
  { id: 'codex', name: 'Codex', available: true },
  { id: 'opencode', name: 'opencode', available: true },
  { id: 'gemini', name: 'Gemini CLI', available: true },
];

/** The harnesses the runtime offers (its `harness` rows), or the usual four until it sends them. */
export function useHarnesses(client: PluginClient): Accessor<readonly HarnessRow[]> {
  const rows = useSignal(client.entities.list<HarnessRow>('harness'));
  return () => ((rows() as readonly HarnessRow[]).length ? (rows() as readonly HarnessRow[]) : FALLBACK_HARNESSES);
}

export const harnessName = (list: readonly HarnessRow[], id: string): string => list.find((h) => h.id === id)?.name ?? id;
