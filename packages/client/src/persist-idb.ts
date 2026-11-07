// IndexedDB behind `Persist`. The IndexedDB types live in lib.dom, which the package's own
// typecheck (Node) doesn't load, so this file names only the structural subset it uses; the app
// passes the real `indexedDB` and `IDBKeyRange`. Handlers are typed `(this: never, ev: never)` so
// the DOM's `(this: IDBRequest, ev: Event) => any` fits them.

import type { Persist, PersistWrite } from './persist.ts';

type Handler = ((this: never, ev: never) => unknown) | null;

export interface IdbRequest<T> {
  readonly result: T;
  readonly error: unknown;
  onsuccess: Handler;
  onerror: Handler;
}
export interface IdbOpenRequest extends IdbRequest<IdbDatabase> {
  onupgradeneeded: Handler;
}
export interface IdbObjectStore {
  get(key: string): IdbRequest<unknown>;
  put(value: unknown, key: string): unknown;
  delete(key: string): unknown;
  getAll(range: unknown): IdbRequest<unknown[]>;
  getAllKeys(range: unknown): IdbRequest<unknown[]>;
}
export interface IdbTransaction {
  objectStore(name: string): IdbObjectStore;
  readonly error: unknown;
  oncomplete: Handler;
  onerror: Handler;
  onabort: Handler;
}
export interface IdbDatabase {
  readonly objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(store: string, mode: 'readonly' | 'readwrite'): IdbTransaction;
}
export interface IdbFactory {
  open(name: string, version?: number): IdbOpenRequest;
}
export interface IdbKeyRangeStatic {
  bound(lower: string, upper: string): unknown;
}

const STORE = 'kv';
const SEP = '\u0001';
const fullKey = (ns: string, key: string): string => `${ns}${SEP}${key}`;

function done<T>(req: IdbRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function finished(tx: IdbTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export function indexedDBPersist(idb: IdbFactory, keyRange: IdbKeyRangeStatic, name = 'wisp-client'): Persist {
  let opened: Promise<IdbDatabase> | undefined;
  const db = (): Promise<IdbDatabase> => {
    opened ??= new Promise((resolve, reject) => {
      const req = idb.open(name, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return opened;
  };
  const range = (ns: string): unknown => keyRange.bound(`${ns}${SEP}`, `${ns}${SEP}￿`);

  return {
    async get(ns, key) {
      const store = (await db()).transaction(STORE, 'readonly').objectStore(STORE);
      return done(store.get(fullKey(ns, key)));
    },
    async entries(ns) {
      const store = (await db()).transaction(STORE, 'readonly').objectStore(STORE);
      const [keys, values] = await Promise.all([done(store.getAllKeys(range(ns))), done(store.getAll(range(ns)))]);
      return keys.map((k, i) => [String(k).slice(ns.length + 1), values[i]]);
    },
    async write(batch: readonly PersistWrite[]) {
      if (batch.length === 0) return;
      const tx = (await db()).transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const w of batch) {
        if (w.value === undefined) store.delete(fullKey(w.ns, w.key));
        else store.put(w.value, fullKey(w.ns, w.key));
      }
      await finished(tx);
    },
    async clear(ns) {
      const tx = (await db()).transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const k of await done(store.getAllKeys(range(ns)))) store.delete(String(k));
      await finished(tx);
    },
    async namespaces(prefix) {
      const store = (await db()).transaction(STORE, 'readonly').objectStore(STORE);
      const keys = await done(store.getAllKeys(keyRange.bound(prefix, `${prefix}\uffff`)));
      return [...new Set(keys.map((k) => String(k).split(SEP, 1)[0] ?? ''))].filter((n) => n.startsWith(prefix));
    },
  };
}
