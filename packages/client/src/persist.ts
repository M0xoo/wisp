// Persistence (plan §4.6.9): everything the client keeps between runs goes through `Persist`, a
// namespaced key-value store with atomic batches. IndexedDB in the browser (persist-idb.ts),
// memory in tests and wherever IndexedDB is missing.
//
// Namespaces: rows:<peer> · link (epoch + cursor per peer) · pending · drafts:<peer> ·
// store:<plugin> · settings · nav

export interface PersistWrite {
  readonly ns: string;
  readonly key: string;
  /** undefined deletes the key */
  readonly value: unknown;
}

export interface Persist {
  get(ns: string, key: string): Promise<unknown>;
  entries(ns: string): Promise<[string, unknown][]>;
  /** all of it or none of it: rows and the cursor that matches them land together */
  write(batch: readonly PersistWrite[]): Promise<void>;
  clear(ns: string): Promise<void>;
  /** the namespaces that start with `prefix` and hold something: 'drafts:' → ['drafts:laptop', …] */
  namespaces(prefix: string): Promise<string[]>;
}

export function memoryPersist(): Persist & { dump(): Record<string, unknown> } {
  const data = new Map<string, Map<string, unknown>>();
  const ns = (n: string): Map<string, unknown> => {
    let m = data.get(n);
    if (!m) data.set(n, (m = new Map()));
    return m;
  };
  // values are cloned both ways, as IndexedDB's structured clone would, so nobody shares objects
  const clone = (v: unknown): unknown => (v === undefined ? undefined : structuredClone(v));
  return {
    get: async (n, key) => clone(data.get(n)?.get(key)),
    entries: async (n) => [...(data.get(n) ?? new Map<string, unknown>())].map(([k, v]) => [k, clone(v)]),
    async write(batch) {
      for (const w of batch) {
        if (w.value === undefined) data.get(w.ns)?.delete(w.key);
        else ns(w.ns).set(w.key, clone(w.value));
      }
    },
    clear: async (n) => {
      data.delete(n);
    },
    namespaces: async (prefix) => [...data].filter(([n, m]) => n.startsWith(prefix) && m.size > 0).map(([n]) => n),
    dump: () => Object.fromEntries([...data].map(([n, m]) => [n, Object.fromEntries(m)])),
  };
}
