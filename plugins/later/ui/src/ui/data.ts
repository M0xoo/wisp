// Reads shared by Later's screens: rows with their entity keys (commands route by key), and a clock
// that ticks while a component shows (so "has passed" and Coming up follow the time).

import { computed, uuidv7, type PluginClient, type Readable } from '@wisp/client';
import { createSignal, onCleanup, type Accessor } from 'solid-js';
import { nowOf } from '../host.ts';
import { KIND, type Plan, type SessionRow } from '../types.ts';

export interface Keyed<T> {
  readonly key: string;
  readonly row: T;
}

const cache = new WeakMap<PluginClient, Map<string, Readable<readonly Keyed<unknown>[]>>>();

/** A kind's rows with their keys, in the store's order (keys and list share the member order). */
export function keyedRows<T>(client: PluginClient, kind: string): Readable<readonly Keyed<T>[]> {
  let byKind = cache.get(client);
  if (!byKind) cache.set(client, (byKind = new Map()));
  let r = byKind.get(kind);
  if (!r) {
    const keys = client.entities.keys(kind);
    const list = client.entities.list(kind);
    r = computed(() => {
      const ks = keys();
      const vs = list();
      return ks.map((key, i) => ({ key, row: vs[i] }));
    });
    byKind.set(kind, r);
  }
  return r as Readable<readonly Keyed<T>[]>;
}

export const sessions = (c: PluginClient): Readable<readonly Keyed<SessionRow>[]> => keyedRows<SessionRow>(c, KIND.session);

/** Plans as { key, plan }. */
export function plans(c: PluginClient): Readable<readonly { key: string; plan: Plan }[]> {
  const rows = keyedRows<Plan>(c, KIND.plan);
  // a `later_plan` row is `{id, body}`, the plan in its body
  return computed(() => rows().map((r) => ({ key: r.key, plan: planOf(r.row) })));
}

/** The time, now and every `ms` while the calling component lives. */
export function useNow(client: PluginClient, ms = 30_000): Accessor<number> {
  const [now, setNow] = createSignal(nowOf(client));
  const stop = client.scope.interval(ms, () => setNow(nowOf(client)));
  onCleanup(stop);
  return now;
}

/** A temp id for an optimistic row (the peer gives the real one). */
export const tmpId = (now: number): string => `tmp-${uuidv7(now)}`;

/** The plan in a `later_plan` row (`{id, body: Plan}`), or the row itself when it is the plan. */
export function planOf(row: unknown): Plan {
  const b = (row as { body?: unknown } | null)?.body;
  return (b && typeof b === 'object' && 'kind' in b ? b : row) as Plan;
}
