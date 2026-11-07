// The runtime's one door to the store (ADR-0004). Tasks being worked on live in memory as v1-shaped
// objects; what changes is marked dirty and written in one transaction at most every 250 ms, or at
// once at the end of a step (a turn starting or ending). Activity is appended to the event log; a
// task's row, its changed turns and its list row are upserted, and the store records the diff.
// Nothing here serialises a whole task per event (ADR-0011).

import type { Scope } from '@wisp/kernel';
import type { Store, Writer } from '@wisp/store';
import type { Session, Step, Turn } from './model.ts';
import { foldEvents, lazyActivity, sessionOf, sessionRow, setEvent, stepEvent, turnOf, turnRow } from './rows.ts';
import type { Entities, EventRow, SummaryRow } from './schema.ts';

export const FLUSH_MS = 250;
/** idle tasks kept in memory beyond the running and waiting ones */
const KEEP_IDLE = 64;

interface Dirty {
  session: boolean;
  summary: boolean;
  turns: Set<Turn>;
}

export interface PersistOptions {
  store: Store;
  entities: Entities;
  scope: Pick<Scope, 'timeout'>;
  /** the list row for a task (summary.ts); called at most once per task per flush */
  summarize(s: Session): Record<string, unknown>;
  /** after each commit: the steps it appended, for turn.activity */
  committed?(steps: readonly EventRow[]): void;
  onError?(err: unknown): void;
  /** tasks that must stay in memory (a run is live) */
  pinned?(id: string): boolean;
}

export class Persist {
  readonly #o: PersistOptions;
  readonly #mem = new Map<string, Session>();
  readonly #seq = new Map<string, number>();
  readonly #dirty = new Map<Session, Dirty>();
  readonly #removed = new Map<string, Set<string>>();
  readonly #deleted = new Set<string>();
  readonly #after: (() => void)[] = [];
  #events: EventRow[] = [];
  #armed = false;

  constructor(o: PersistOptions) {
    this.#o = o;
  }

  get store(): Store {
    return this.#o.store;
  }

  // ---------- reads ----------

  /** The task, from memory or its rows. undefined when there is none (or it is being deleted). */
  get(id: string): Session | undefined {
    if (this.#deleted.has(id)) return undefined;
    const had = this.#mem.get(id);
    if (had) return had;
    const row = this.#o.store.get(this.#o.entities.session, id);
    if (!row) return undefined;
    const turns = this.#o.store
      .query(this.#o.entities.turn, { where: { session_id: id }, order: [['idx', 'asc']] })
      .map((r) => turnOf(r, () => this.activity(id, r.id)));
    const s = sessionOf(row, turns);
    this.#mem.set(id, s);
    return s;
  }

  has(id: string): boolean {
    return this.#mem.has(id) || (!this.#deleted.has(id) && this.#o.store.get(this.#o.entities.session, id) !== undefined);
  }

  /** In memory now (open or running): never loads anything. */
  loaded(): IterableIterator<Session> {
    return this.#mem.values();
  }

  /** A turn's steps, oldest first, from the log plus what is still buffered. */
  activity(sessionId: string, turnId: string): Step[] {
    const rows = this.#o.store.query(this.#o.entities.event, { where: { turn_id: turnId }, order: [['seq', 'asc']] });
    const buffered = this.#events.filter((e) => e.turn_id === turnId && e.session_id === sessionId);
    return foldEvents([...rows, ...buffered]);
  }

  /** Steps of a turn after `sinceSeq` (a client resuming). */
  activitySince(turnId: string, sinceSeq: number): { seq: number; items: Step[] } {
    const rows = this.#o.store.query(this.#o.entities.event, { where: { turn_id: turnId, seq: { gt: sinceSeq } }, order: [['seq', 'asc']] });
    const items = foldEvents(rows);
    return { seq: rows.at(-1)?.seq ?? sinceSeq, items };
  }

  // ---------- writes ----------

  /** A new task (or one imported): every turn is written. */
  put(s: Session, o: { now?: boolean } = {}): void {
    this.#deleted.delete(s.id);
    this.#mem.set(s.id, s);
    const d = this.#mark(s);
    d.session = true;
    d.summary = true;
    for (const t of s.turns) d.turns.add(t);
    this.#after.push(() => undefined);
    if (o.now) this.flush();
    else this.#arm();
  }

  /**
   * Something on the task changed. `turns`: the turns it touched (the last one always counts);
   * summary: false for a change the list doesn't show (a streamed text delta).
   */
  save(s: Session, o: { turns?: readonly (Turn | undefined)[]; summary?: boolean; now?: boolean } = {}): void {
    if (this.#deleted.has(s.id) || this.#mem.get(s.id) !== s) return;
    const d = this.#mark(s);
    d.session = true;
    if (o.summary !== false) d.summary = true;
    const last = s.turns.at(-1);
    if (last) d.turns.add(last);
    for (const t of o.turns ?? []) if (t) d.turns.add(t);
    if (o.now) this.flush();
    else this.#arm();
  }

  /** Only the list row: something a summary reads changed elsewhere (a child's state). */
  touchSummary(s: Session): void {
    if (this.#mem.get(s.id) !== s) return;
    this.#mark(s).summary = true;
    this.#arm();
  }

  /** A turn left the task (a held turn released): its row goes. */
  dropTurn(s: Session, t: Turn): void {
    const set = this.#removed.get(s.id) ?? new Set<string>();
    set.add(t.id);
    this.#removed.set(s.id, set);
    this.#dirty.get(s)?.turns.delete(t);
    this.#arm();
  }

  /** A step of a running turn: appended to the log (and to the turn in memory, by the caller). */
  appendStep(s: Session, t: Turn, step: Step): void {
    const seq = this.#nextSeq(s.id);
    step.seq = seq;
    this.#events.push(stepEvent(s.id, t.id, seq, step));
    this.#arm();
  }

  /** Fields laid over an earlier step (a call's output came in). */
  setStep(s: Session, t: Turn, step: Step, fields: Partial<Step>, now: number): void {
    if (step.seq === undefined) return; // not stored yet: the step row carries its fields when it goes
    const seq = this.#nextSeq(s.id);
    this.#events.push(setEvent(s.id, t.id, seq, step.seq, fields, now));
    this.#arm();
  }

  /** Runs after the next commit (events are published after their rows are). */
  afterCommit(fn: () => void): void {
    this.#after.push(fn);
    this.#arm();
  }

  delete(id: string): void {
    this.#deleted.add(id);
    const s = this.#mem.get(id);
    if (s) this.#dirty.delete(s);
    this.#mem.delete(id);
    this.#removed.delete(id);
    this.#events = this.#events.filter((e) => e.session_id !== id);
    this.#seq.delete(id);
    this.#arm();
  }

  /** Writes everything pending in one transaction, then runs what waited for it. */
  flush(): void {
    this.#armed = false;
    const dirty = [...this.#dirty.entries()];
    const events = this.#events;
    const removed = [...this.#removed.entries()];
    const deleted = [...this.#deleted];
    const after = this.#after.splice(0);
    this.#dirty.clear();
    this.#events = [];
    this.#removed.clear();
    this.#deleted.clear();
    // The list rows are made before the transaction: a summary reads other tasks (its children).
    const rows = dirty.map(([s, d]) => ({ s, d, sum: d.summary ? this.#summaryRow(s) : null }));
    try {
      this.#o.store.tx((w) => {
        for (const id of deleted) w.del(this.#o.entities.session, id);
        for (const [sid, ids] of removed) for (const tid of ids) if (!deleted.includes(sid)) w.del(this.#o.entities.turn, tid);
        for (const r of rows) this.#write(w, r.s, r.d, r.sum);
        if (events.length) w.append(this.#o.entities.event, events);
      });
    } catch (err) {
      this.#retryApart(rows, events, err);
    }
    if (events.length) this.#o.committed?.(events);
    for (const fn of after) {
      try {
        fn();
      } catch (err) {
        this.#o.onError?.(err);
      }
    }
    this.#evict();
  }

  // ---------- internals ----------

  #write(w: Writer, s: Session, d: Dirty, sum: SummaryRow | null): void {
    if (d.session) w.upsert(this.#o.entities.session, sessionRow(s));
    for (const t of d.turns) {
      const idx = s.turns.indexOf(t);
      if (idx >= 0) w.upsert(this.#o.entities.turn, turnRow(s.id, idx, t));
    }
    if (sum) w.upsert(this.#o.entities.summary, sum);
  }

  // One task the store refused (deleted meanwhile, a bad row) must not cost the others their writes.
  #retryApart(rows: { s: Session; d: Dirty; sum: SummaryRow | null }[], events: EventRow[], first: unknown): void {
    this.#o.onError?.(first);
    for (const r of rows) {
      try {
        this.#o.store.tx((w) => this.#write(w, r.s, r.d, r.sum));
      } catch (err) {
        this.#o.onError?.(err);
      }
    }
    const bySession = new Map<string, EventRow[]>();
    for (const e of events) bySession.set(e.session_id, [...(bySession.get(e.session_id) ?? []), e]);
    for (const list of bySession.values()) {
      try {
        this.#o.store.tx((w) => w.append(this.#o.entities.event, list));
      } catch (err) {
        this.#o.onError?.(err);
      }
    }
  }

  #summaryRow(s: Session): SummaryRow {
    const row = this.#o.summarize(s);
    return { id: s.id, archived: !!s.archived, updated_at: s.updatedAt, parent_id: s.parentId ?? null, row };
  }

  #mark(s: Session): Dirty {
    let d = this.#dirty.get(s);
    if (!d) {
      d = { session: false, summary: false, turns: new Set() };
      this.#dirty.set(s, d);
    }
    return d;
  }

  #nextSeq(id: string): number {
    let n = this.#seq.get(id);
    if (n === undefined) {
      const last = this.#o.store.query(this.#o.entities.event, { where: { session_id: id }, order: [['seq', 'desc']], limit: 1 })[0];
      n = last?.seq ?? 0;
    }
    n++;
    this.#seq.set(id, n);
    return n;
  }

  #arm(): void {
    if (this.#armed) return;
    this.#armed = true;
    this.#o.scope.timeout(FLUSH_MS, () => {
      if (this.#armed) this.flush();
    });
  }

  // Only open or running tasks stay in memory: the oldest idle ones go once there are too many.
  #evict(): void {
    if (this.#mem.size <= KEEP_IDLE) return;
    const idle = [...this.#mem.values()].filter((s) => s.state !== 'running' && s.state !== 'waiting' && !this.#o.pinned?.(s.id) && !this.#dirty.has(s));
    idle.sort((a, b) => a.updatedAt - b.updatedAt);
    for (const s of idle.slice(0, this.#mem.size - KEEP_IDLE)) this.#mem.delete(s.id);
  }
}

export { lazyActivity };
