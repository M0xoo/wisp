// The rows each peer's `list` shows, as this wisp last saw them: fresh while the peer is online,
// kept while it isn't (an asleep box's tasks stay on screen), and saved so a restart shows them
// and resumes from the cursor instead of taking the whole list again.
//
// Ids stay as the peer made them (a v2 peer's `<peer>:<uuid>`); only the v1 relay qualifies them,
// as v1 did. Writes are coalesced: one transaction per flush, not one per remote change.

import { deepEqual, type EntityOp, type Topic } from '@wisp/protocol';
import type { EntityDef, Store } from '@wisp/store';
import type { Scope } from '@wisp/kernel';
import { applyEntityOps, applySnapshot, type EntityMap, type Row } from '@wisp/sync';
import type { MirrorRow } from '@wisp-plugin/machines-api';
import { MIRROR, type MirrorTable } from './migrations.ts';

export const LIST: Topic = 'list';
const SEP = '\u0001';
const storeKey = (peer: string, e: string, id: string): string => `${peer}${SEP}${e}${SEP}${id}`;
const rowKey = (e: string, id: string): string => `${e}\u0000${id}`;

export type MirrorChange = (peer: string, op: 'upsert' | 'del', id: string) => void;

export interface MirrorOptions {
  store: Store;
  scope: Scope;
  flushMs?: number;
  onChange?: MirrorChange;
}

export class Mirror {
  readonly #store: Store;
  readonly #scope: Scope;
  readonly #def: EntityDef<MirrorTable>;
  readonly #flushMs: number;
  readonly #onChange: MirrorChange;
  readonly #maps = new Map<string, EntityMap>();
  /** peer → row keys whose stored copy is behind */
  readonly #dirty = new Map<string, Set<string>>();
  #scheduled = false;

  constructor(o: MirrorOptions) {
    this.#store = o.store;
    this.#scope = o.scope;
    this.#def = o.store.defineEntity<MirrorTable>(MIRROR);
    this.#flushMs = o.flushMs ?? 1_000;
    this.#onChange = o.onChange ?? (() => {});
    for (const t of o.store.query(this.#def)) {
      const [peer = '', e = '', id = ''] = t.key.split(SEP);
      this.#list(peer).set(rowKey(e, id), { e, id, v: t.v });
    }
    o.scope.add(() => this.flush());
  }

  #map(peer: string): EntityMap {
    let m = this.#maps.get(peer);
    if (!m) this.#maps.set(peer, (m = new Map()));
    return m;
  }

  #list(peer: string): Map<string, Row> {
    const m = this.#map(peer);
    let l = m.get(LIST);
    if (!l) m.set(LIST, (l = new Map()));
    return l;
  }

  /** the rows of one peer's list (or every peer's) */
  rows(peer?: string): MirrorRow[] {
    const out: MirrorRow[] = [];
    for (const [p, m] of this.#maps) {
      if (peer !== undefined && p !== peer) continue;
      for (const r of m.get(LIST)?.values() ?? []) out.push({ peer: p, id: r.id, v: (r.v ?? {}) as MirrorRow['v'] });
    }
    return out;
  }

  get(peer: string, id: string, e = 'session'): Row | undefined {
    return this.#map(peer).get(LIST)?.get(rowKey(e, id));
  }

  /** a full snapshot of one topic replaces what was there */
  snapshot(peer: string, topic: Topic, rows: readonly Row[]): void {
    const before = topic === LIST ? new Map(this.#list(peer)) : undefined;
    applySnapshot(this.#map(peer), topic, rows);
    if (!before) return;
    const after = this.#list(peer);
    for (const [k, r] of before) if (!after.has(k)) this.#touch(peer, k, r.id, 'del');
    for (const [k, r] of after) if (!deepEqual(before.get(k)?.v, r.v)) this.#touch(peer, k, r.id, 'upsert');
  }

  /** applies ops in order; returns the topics that drifted (resubscribe those) */
  apply(peer: string, ops: readonly EntityOp[]): Topic[] {
    const failed = applyEntityOps(this.#map(peer), ops);
    const list = this.#list(peer);
    for (const op of ops) if (op.topic === LIST) this.#touch(peer, rowKey(op.e, op.id), op.id, list.has(rowKey(op.e, op.id)) ? 'upsert' : 'del');
    return failed;
  }

  /** one row, as the v1 relay sees it (a summary event) */
  put(peer: string, id: string, v: Record<string, unknown>, e = 'session'): void {
    const k = rowKey(e, id);
    this.#list(peer).set(k, { e, id, v });
    this.#touch(peer, k, id, 'upsert');
  }

  del(peer: string, id: string, e = 'session'): void {
    const k = rowKey(e, id);
    if (this.#list(peer).delete(k)) this.#touch(peer, k, id, 'del');
  }

  /** a peer whose cache can't be trusted any more (a new epoch), or one removed */
  reset(peer: string): void {
    for (const [k, r] of this.#list(peer)) this.#touch(peer, k, r.id, 'del');
    this.#maps.delete(peer);
  }

  #touch(peer: string, key: string, id: string, op: 'upsert' | 'del'): void {
    let d = this.#dirty.get(peer);
    if (!d) this.#dirty.set(peer, (d = new Set()));
    d.add(key);
    this.#onChange(peer, op, id);
    if (this.#scheduled || !this.#scope.alive) return;
    this.#scheduled = true;
    this.#scope.timeout(this.#flushMs, () => this.flush());
  }

  /** writes what changed since the last flush, in one transaction */
  flush(): void {
    this.#scheduled = false;
    if (this.#dirty.size === 0) return;
    const dirty = [...this.#dirty];
    this.#dirty.clear();
    try {
      this.#store.tx((w) => {
        for (const [peer, keys] of dirty) {
          const list = this.#maps.get(peer)?.get(LIST);
          for (const k of keys) {
            const r = list?.get(k);
            const [e = '', id = ''] = k.split('\u0000');
            const sk = storeKey(peer, e, id);
            if (r) w.upsert(this.#def, { key: sk, peer, id, v: (r.v ?? {}) as Record<string, unknown> });
            else w.del(this.#def, sk);
          }
        }
      });
    } catch {
      // the store closed under us (shutdown): what was lost is taken again on the next connect
    }
  }
}
