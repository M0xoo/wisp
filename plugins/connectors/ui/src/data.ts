// Reading the home peer's rows: Settings is about this wisp, so rows other peers carry under the
// same kind (a machine's mirrored config) stay out of its lists.

import { computed, entityKey, filterBy, ownerOf, type DeepReadonly, type PluginClient, type Readable } from '@wisp/client';

export function homeRows<T>(client: PluginClient, kind: string): Readable<readonly DeepReadonly<T>[]> {
  const keys = filterBy(client.entities.keys(kind), (k) => ownerOf(k) === client.home);
  return computed(() =>
    keys()
      .map((k) => client.entities.row<T>(kind, k)())
      .filter((v): v is DeepReadonly<T> => v !== undefined),
  );
}

export const homeRow = <T>(client: PluginClient, kind: string, id: string): Readable<DeepReadonly<T> | undefined> => client.entities.row<T>(kind, entityKey(client.home, id));
