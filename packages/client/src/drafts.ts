// Drafts, kind 5 (plan §4.6.2): composer text, attachments, a half-filled form. Keyed by
// (entity, field), so a draft follows its task across layouts and reloads; persisted per peer
// (`drafts:<peer>`), with writes debounced through the scope. The UI updates at once; only the
// disk write waits. A draft emptied to '' or undefined is deleted, not kept as an empty string.

import { ownerOf } from './ids.ts';
import type { Persist, PersistWrite } from './persist.ts';
import type { Scope } from './scope.ts';
import { signal, type Readable, type WritableSignal } from './signals.ts';
import type { Json, Warn } from './types.ts';

export interface Drafts {
  get<T extends Json = string>(entity: string, field: string): Readable<T | undefined>;
  set(entity: string, field: string, value: Json | undefined): void;
  clear(entity: string, field: string): void;
  load(): Promise<void>;
  /** writes what's waiting now (before the page hides) */
  flush(): Promise<void>;
}

export interface DraftsOptions {
  scope: Scope;
  persist?: Persist;
  debounceMs?: number;
  warn?: Warn;
}

const SEP = '\u0000';
const empty = (v: Json | undefined): boolean => v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

export function createDrafts(o: DraftsOptions): Drafts {
  const wait = o.debounceMs ?? 400;
  const cells = new Map<string, WritableSignal<Json | undefined>>();
  const dirty = new Map<string, () => void>(); // id → cancel its timer
  const cell = (id: string): WritableSignal<Json | undefined> => {
    let c = cells.get(id);
    if (!c) cells.set(id, (c = signal<Json | undefined>(undefined)));
    return c;
  };
  const split = (id: string): { entity: string; field: string } => {
    const i = id.lastIndexOf(SEP);
    return { entity: id.slice(0, i), field: id.slice(i + 1) };
  };
  const writeOf = (id: string): PersistWrite => {
    const { entity } = split(id);
    const v = cell(id)();
    return { ns: `drafts:${ownerOf(entity)}`, key: id, value: empty(v) ? undefined : v };
  };

  async function flush(): Promise<void> {
    const ids = [...dirty.keys()];
    for (const id of ids) dirty.get(id)?.();
    dirty.clear();
    if (!o.persist || ids.length === 0) return;
    await o.persist.write(ids.map(writeOf));
  }

  const drafts: Drafts = {
    get<T extends Json>(entity: string, field: string) {
      const c = cell(`${entity}${SEP}${field}`);
      return () => c() as T | undefined;
    },
    set(entity, field, value) {
      const id = `${entity}${SEP}${field}`;
      cell(id)(empty(value) ? undefined : value);
      if (!o.persist) return;
      dirty.get(id)?.();
      dirty.set(
        id,
        o.scope.timeout(wait, () => {
          dirty.delete(id);
          o.persist?.write([writeOf(id)]).catch((err: unknown) => o.warn?.('draft not saved', String(err)));
        }),
      );
    },
    clear: (entity, field) => drafts.set(entity, field, undefined),
    async load() {
      if (!o.persist) return;
      for (const ns of await o.persist.namespaces('drafts:')) {
        for (const [id, v] of await o.persist.entries(ns)) if (!dirty.has(id)) cell(id)(v as Json);
      }
    },
    flush,
  };
  // when the owner goes, what's still waiting is written rather than lost
  o.scope.add(() => void flush());
  return drafts;
}
