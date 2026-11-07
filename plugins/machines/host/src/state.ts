// The two small stores beside the peer rows: each peer's live status (on the `machines` topic, so
// every client sees steps and errors as they happen) and each peer's saved link (SyncClient.save():
// epoch, cursor, synced topics, pending mutations), written coalesced so a stream of patches costs
// one small write every few seconds, not one per frame.

import type { Scope } from '@wisp/kernel';
import type { EntityDef, Store } from '@wisp/store';
import type { SyncClientSaved } from '@wisp/sync';
import type { Hint, PeerStatus, RemoteInfo, Step } from '@wisp-plugin/machines-api';
import { LINK, STATUS, type LinkTable, type StatusTable } from './migrations.ts';

const toTable = (s: PeerStatus): StatusTable => ({
  id: s.id,
  state: s.state,
  steps: s.steps,
  error: s.error,
  hint: s.hint,
  attempt: s.attempt,
  since: s.since,
  remote: s.remote,
  stale: s.stale,
  wakes: s.wakes,
});

export class StatusStore {
  readonly #store: Store;
  readonly #def: EntityDef<StatusTable>;

  constructor(store: Store) {
    this.#store = store;
    this.#def = store.defineEntity<StatusTable>(STATUS);
  }

  /** what a restart starts from: nothing is connected yet */
  resetAll(): void {
    const rows = this.#store.query(this.#def, { where: { state: { ne: 'off' } } });
    if (rows.length === 0) return;
    this.#store.tx((w) => {
      for (const r of rows) w.upsert(this.#def, { ...r, state: 'off', steps: [], error: '', hint: null, attempt: 0, since: null, wakes: false });
    });
  }

  write(s: PeerStatus): void {
    try {
      this.#store.tx((w) => w.upsert(this.#def, toTable(s)));
    } catch {
      // the store is closing (shutdown): the next start begins from 'off' anyway
    }
  }

  read(id: string): Pick<PeerStatus, 'remote'> | undefined {
    const r = this.#store.get(this.#def, id);
    return r ? { remote: (r.remote ?? null) as RemoteInfo | null } : undefined;
  }

  delete(ids: readonly string[]): void {
    this.#store.tx((w) => {
      for (const id of ids) w.del(this.#def, id);
    });
  }
}

export const isSaved = (v: unknown): v is SyncClientSaved => {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (s['epoch'] === null || typeof s['epoch'] === 'string') && (s['cursor'] === null || typeof s['cursor'] === 'number') && Array.isArray(s['synced']) && Array.isArray(s['pending']);
};

export class LinkStore {
  readonly #store: Store;
  readonly #def: EntityDef<LinkTable>;
  readonly #scope: Scope;
  readonly #now: () => number;
  readonly #dirty = new Map<string, SyncClientSaved>();
  readonly #flushMs: number;
  #scheduled = false;

  constructor(store: Store, scope: Scope, now: () => number, flushMs = 3_000) {
    this.#flushMs = flushMs;
    this.#store = store;
    this.#def = store.defineEntity<LinkTable>(LINK);
    this.#scope = scope;
    this.#now = now;
    scope.add(() => this.flush());
  }

  load(id: string): SyncClientSaved | undefined {
    const pending = this.#dirty.get(id);
    if (pending) return pending;
    const saved = this.#store.get(this.#def, id)?.saved;
    return isSaved(saved) ? saved : undefined;
  }

  save(id: string, saved: SyncClientSaved): void {
    this.#dirty.set(id, saved);
    if (this.#scheduled || !this.#scope.alive) return;
    this.#scheduled = true;
    this.#scope.timeout(this.#flushMs, () => this.flush());
  }

  flush(): void {
    this.#scheduled = false;
    if (this.#dirty.size === 0) return;
    const batch = [...this.#dirty];
    this.#dirty.clear();
    try {
      this.#store.tx((w) => {
        for (const [id, saved] of batch) w.upsert(this.#def, { id, saved, at: this.#now() });
      });
    } catch {
      // closing: the cursor written last time still resumes, a little further back
    }
  }

  delete(ids: readonly string[]): void {
    for (const id of ids) this.#dirty.delete(id);
    this.#store.tx((w) => {
      for (const id of ids) w.del(this.#def, id);
    });
  }
}

/** v1 #step: set one step; a step done starts the next pending one. */
export function moveStep(steps: Step[], id: string, status: Step['status'], detail?: string): boolean {
  const i = steps.findIndex((s) => s.id === id);
  const s = steps[i];
  if (!s) return false;
  s.status = status;
  if (detail !== undefined) s.detail = detail;
  const next = steps[i + 1];
  if (status === 'done' && next?.status === 'pending') next.status = 'run';
  return true;
}

export const freshSteps = (steps: readonly (readonly [string, string])[]): Step[] => steps.map(([id, label], i) => ({ id, label, status: i ? 'pending' : 'run', detail: '' }));

export type { Hint };
