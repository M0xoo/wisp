// The entity store, kind 1 of the six (plan §4.6.2, §4.5). Rows from every peer, keyed by origin
// (`<peer>:<id>`), one signal per row. Two layers:
//   base     server truth, advanced only by patches and snapshots, in seq order per peer;
//   pending  optimistic ops of commands in flight, replayed over base in the order they ran.
// A row's signal holds base with every pending op on it replayed. UI code gets an EntityReader,
// which has no way to write; the EntityWriter goes only to the sync layer and the command runner.

import { deepEqual, type EntityOp, type Topic } from '@wisp/protocol';
import { entityKey } from './ids.ts';
import { applyOp, type EntityOps, type LocalOp } from './ops.ts';
import { batch, computed, signal, untracked, type Readable, type WritableSignal } from './signals.ts';
import type { DeepReadonly, EntityKey, PeerId, Warn } from './types.ts';

export interface PendingInfo {
  readonly mid: string;
  readonly peer: PeerId;
  readonly ops: EntityOps;
  /** set by the ack: the pending layer goes once the peer's base reaches this seq */
  readonly settleAt?: number;
}

export interface EntityReader {
  row<T = unknown>(kind: string, key: EntityKey): Readable<DeepReadonly<T> | undefined>;
  /** the current value, untracked */
  peek<T = unknown>(kind: string, key: EntityKey): DeepReadonly<T> | undefined;
  keys(kind: string): Readable<readonly EntityKey[]>;
  list<T = unknown>(kind: string): Readable<readonly DeepReadonly<T>[]>;
  pending(): Readable<readonly PendingInfo[]>;
}

export interface ChangedRow {
  readonly kind: string;
  readonly key: EntityKey;
}

/** A base row as persisted for first paint. */
export interface StoredRow {
  readonly e: string;
  readonly key: EntityKey;
  readonly v: unknown;
  readonly topics: readonly Topic[];
}

export interface EntityWriter {
  /** ops from `peer`, in stream order (@wisp/sync drops duplicates). Returns topics that failed to apply: resync them. */
  applyServer(peer: PeerId, ops: readonly EntityOp[]): Topic[];
  /** a whole topic as of now: its rows replace the ones the topic held */
  snapshot(peer: PeerId, topic: Topic, rows: readonly { e: string; id: string; v: unknown }[]): void;
  /** the peer's cursor moved: acked commands whose effect is now in base stop overlaying it */
  advance(peer: PeerId, cursor: number): void;
  /**
   * Older items of a list row (a transcript page from `window`) merged under the ones held: deduped
   * and ordered by `seqOf`. The row keeps its topics; a row not held yet joins `topic`.
   */
  mergeOlder(peer: PeerId, kind: string, id: string, topic: Topic, items: readonly unknown[], seqOf: (item: unknown) => number): void;
  /** the peer's cache is no longer trusted (a new epoch, or the cursor is too old) */
  resetPeer(peer: PeerId): void;
  restore(peer: PeerId, cursor: number, rows: readonly StoredRow[]): void;
  addPending(mid: string, peer: PeerId, ops: EntityOps): void;
  /** the ack: drop the overlay once the peer's cursor reaches `seq` */
  settle(mid: string, seq: number): void;
  /** the reject: drop the overlay now */
  dropPending(mid: string): void;
  cursor(peer: PeerId): number;
  stored(kind: string, key: EntityKey): StoredRow | undefined;
  onChange(fn: (rows: readonly ChangedRow[]) => void): () => void;
}

interface Cell {
  base: unknown;
  readonly sig: WritableSignal<unknown>;
  readonly topics: Set<Topic>;
  readonly peer: PeerId;
}

interface Collection {
  readonly rows: Map<EntityKey, Cell>;
  readonly members: WritableSignal<readonly EntityKey[]>;
  /** the values in member order, kept up to date in place once someone reads list() */
  list?: { readonly sig: WritableSignal<readonly unknown[]>; index: Map<EntityKey, number> };
}

/** What one batch changed in a collection, applied once at its end: a snapshot of 5,000 rows is one update, not 5,000. */
interface Dirty {
  readonly added: EntityKey[];
  readonly removed: Set<EntityKey>;
  readonly changed: Map<EntityKey, unknown>;
}


// size-ok: a factory; its body is small closures over shared private state, each under the cap
export function createEntityStore(warn: Warn = () => {}): { reader: EntityReader; writer: EntityWriter } {
  const collections = new Map<string, Collection>();
  const dirty = new Map<Collection, Dirty>();
  const cursors = new Map<PeerId, number>();
  const pending = signal<readonly PendingInfo[]>([]);
  const listeners = new Set<(rows: readonly ChangedRow[]) => void>();

  const coll = (kind: string): Collection => {
    let c = collections.get(kind);
    if (!c) {
      c = { rows: new Map(), members: signal<readonly EntityKey[]>([]) };
      collections.set(kind, c);
    }
    return c;
  };
  const cell = (kind: string, key: EntityKey): Cell => {
    const c = coll(kind);
    let r = c.rows.get(key);
    if (!r) {
      r = { base: undefined, sig: signal<unknown>(undefined), topics: new Set(), peer: ownerPeer(key) };
      c.rows.set(key, r);
    }
    return r;
  };
  const cursorOf = (peer: PeerId): number => cursors.get(peer) ?? 0;

  /** base + every pending op on this row, in order. A pending op that no longer fits is skipped. */
  function recompute(kind: string, key: EntityKey): void {
    const c = coll(kind);
    const r = cell(kind, key);
    let v = r.base;
    for (const p of untracked(pending)) {
      for (const op of p.ops) {
        if (op.e !== kind || op.id !== key) continue;
        try {
          v = applyOp(v, op);
        } catch {
          // an optimistic patch over a row the server changed meanwhile: the server wins
        }
      }
    }
    const before = r.sig();
    if (deepEqual(before, v)) return; // same value keeps the same reference: nothing repaints
    r.sig(v);
    let d = dirty.get(c);
    if (!d) dirty.set(c, (d = { added: [], removed: new Set(), changed: new Map() }));
    if (before === undefined) d.added.push(key);
    else if (v === undefined) d.removed.add(key);
    else d.changed.set(key, v);
  }

  /** membership and the list, once per batch: a token patch copies one array and sets one slot */
  function applyDirty(): void {
    for (const [c, d] of dirty) {
      const grew = d.added.length > 0;
      const shrank = d.removed.size > 0;
      if (grew || shrank) {
        const kept = shrank ? untracked(c.members).filter((k) => !d.removed.has(k)) : untracked(c.members);
        c.members(grew ? [...kept, ...d.added.filter((k) => !d.removed.has(k))] : kept);
      }
      if (!c.list) continue;
      if (grew || shrank) rebuildList(c);
      else if (d.changed.size > 0) {
        const next = untracked(c.list.sig).slice();
        for (const [k, v] of d.changed) {
          const i = c.list.index.get(k);
          if (i !== undefined) next[i] = v;
        }
        c.list.sig(next);
      }
    }
    dirty.clear();
  }

  function rebuildList(c: Collection): void {
    const keys = untracked(c.members);
    const values = keys.map((k) => untracked(() => c.rows.get(k)?.sig()));
    const index = new Map(keys.map((k, i) => [k, i]));
    if (c.list) {
      c.list.index = index;
      c.list.sig(values);
    } else c.list = { sig: signal<readonly unknown[]>(values), index };
  }

  const touchedBy = (ops: EntityOps): ChangedRow[] => ops.map((o) => ({ kind: o.e, key: o.id }));
  /** listeners hear every touched row, base or overlay: a base change under an overlay must be saved too */
  const recomputeAll = (rows: readonly ChangedRow[]): void => {
    if (rows.length === 0) return;
    batch(() => {
      for (const r of rows) recompute(r.kind, r.key);
      applyDirty();
    });
    for (const fn of listeners) fn(rows);
  };

  function dropTopicRow(kind: string, key: EntityKey, topic: Topic): ChangedRow | undefined {
    const r = coll(kind).rows.get(key);
    if (!r) return undefined;
    r.topics.delete(topic);
    if (r.topics.size > 0) return undefined;
    r.base = undefined;
    return { kind, key };
  }

  function applyServerOp(peer: PeerId, op: EntityOp): ChangedRow {
    const key = entityKey(peer, op.id);
    const r = cell(op.e, key);
    r.base = applyOp(r.base, op);
    if (r.base === undefined) r.topics.clear();
    else r.topics.add(op.topic);
    return { kind: op.e, key };
  }

  /** acked commands whose effect the base now holds stop overlaying it */
  function settleReached(peer: PeerId): ChangedRow[] {
    const cursor = cursorOf(peer);
    const list = untracked(pending);
    const gone = list.filter((p) => p.peer === peer && p.settleAt !== undefined && p.settleAt <= cursor);
    if (gone.length === 0) return [];
    pending(list.filter((p) => !gone.includes(p)));
    return gone.flatMap((p) => touchedBy(p.ops));
  }

  const writer: EntityWriter = {
    applyServer(peer, ops) {
      const rows: ChangedRow[] = [];
      const failed = new Set<Topic>();
      for (const op of ops) {
        try {
          rows.push(applyServerOp(peer, op));
        } catch (err) {
          failed.add(op.topic);
          warn(`an op from ${peer} doesn't apply`, { topic: op.topic, error: String(err) });
        }
      }
      recomputeAll(rows);
      return [...failed];
    },
    snapshot(peer, topic, rows) {
      const seen = new Set<EntityKey>();
      const touched: ChangedRow[] = [];
      for (const row of rows) {
        const key = entityKey(peer, row.id);
        const r = cell(row.e, key);
        r.base = row.v;
        r.topics.add(topic);
        seen.add(key);
        touched.push({ kind: row.e, key });
      }
      for (const [kind, c] of collections) {
        for (const [key, r] of c.rows) {
          if (r.peer !== peer || !r.topics.has(topic) || seen.has(key)) continue;
          const gone = dropTopicRow(kind, key, topic);
          if (gone) touched.push(gone);
        }
      }
      recomputeAll(touched);
    },
    mergeOlder(peer, kind, id, topic, items, seqOf) {
      if (items.length === 0) return;
      const key = entityKey(peer, id);
      const r = cell(kind, key);
      const held: readonly unknown[] = Array.isArray(r.base) ? r.base : [];
      const have = new Set(held.map(seqOf));
      const older = items.filter((x) => !have.has(seqOf(x)));
      if (older.length === 0) return;
      // pages arrive older than what's held, so this is almost always a concat; sort keeps it right if not
      r.base = [...older, ...held].sort((a, b) => seqOf(a) - seqOf(b));
      if (r.topics.size === 0) r.topics.add(topic);
      recomputeAll([{ kind, key }]);
    },
    advance(peer, cursor) {
      if (cursor <= cursorOf(peer)) return;
      cursors.set(peer, cursor);
      recomputeAll(settleReached(peer));
    },
    resetPeer(peer) {
      cursors.delete(peer);
      const touched: ChangedRow[] = [];
      for (const [kind, c] of collections) {
        for (const [key, r] of c.rows) {
          if (r.peer !== peer || r.base === undefined) continue;
          r.base = undefined;
          r.topics.clear();
          touched.push({ kind, key });
        }
      }
      recomputeAll(touched);
    },
    restore(peer, cursor, rows) {
      cursors.set(peer, cursor);
      for (const row of rows) {
        const r = cell(row.e, row.key);
        r.base = row.v;
        for (const t of row.topics) r.topics.add(t);
      }
      recomputeAll(rows.map((r) => ({ kind: r.e, key: r.key })));
    },
    addPending(mid, peer, ops) {
      if (untracked(pending).some((p) => p.mid === mid)) return;
      pending([...untracked(pending), { mid, peer, ops }]);
      recomputeAll(touchedBy(ops));
    },
    settle(mid, seq) {
      const list = untracked(pending);
      const p = list.find((x) => x.mid === mid);
      if (!p) return;
      if (seq <= cursorOf(p.peer)) return writer.dropPending(mid);
      pending(list.map((x) => (x === p ? { ...p, settleAt: seq } : x)));
    },
    dropPending(mid) {
      const list = untracked(pending);
      const p = list.find((x) => x.mid === mid);
      if (!p) return;
      pending(list.filter((x) => x !== p));
      recomputeAll(touchedBy(p.ops));
    },
    cursor: cursorOf,
    stored(kind, key) {
      const r = collections.get(kind)?.rows.get(key);
      return r && r.base !== undefined ? { e: kind, key, v: r.base, topics: [...r.topics] } : undefined;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };

  const reader: EntityReader = {
    row<T>(kind: string, key: EntityKey) {
      const r = cell(kind, key);
      return () => r.sig() as DeepReadonly<T> | undefined;
    },
    peek<T>(kind: string, key: EntityKey) {
      return untracked(() => coll(kind).rows.get(key)?.sig()) as DeepReadonly<T> | undefined;
    },
    keys(kind) {
      const c = coll(kind);
      return () => c.members();
    },
    list<T>(kind: string) {
      const c = coll(kind);
      if (!c.list) rebuildList(c);
      const l = c.list as NonNullable<Collection['list']>; // rebuildList just made it
      return (() => l.sig()) as Readable<readonly DeepReadonly<T>[]>;
    },
    pending: () => () => pending(),
  };

  return { reader, writer };
}

function ownerPeer(key: EntityKey): PeerId {
  const i = key.indexOf(':');
  return (i < 0 ? key : key.slice(0, i)) as PeerId;
}

export type { LocalOp, EntityOps };
