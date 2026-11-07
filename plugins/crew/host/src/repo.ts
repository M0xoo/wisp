// The crew's rows, held in memory and written through the store (one transaction per change). Read
// once at setup; every later read is a map lookup, so a tick, a view or a turn ending never queries
// more than the rows it changes. The jobs index (crew_job) is queried only for a member's job list.
import type { Store } from '@wisp/store';
import type { JobRow, Link, LogEntry, Member, WaitingJob } from '@wisp-plugin/crew-api';
import { fromRow, toRow } from './schema.ts';
import type { Entities, JobDbRow } from './schema.ts';

export const LOG_MAX = 40;
const LINKS_MAX = 20;
export const QUEUE_MAX = 20;
const SEEN_KEEP_MS = 30 * 864e5;

interface Logged {
  id: number;
  entry: LogEntry;
}

const jobOf = (r: JobDbRow): JobRow => ({ sessionId: r.session_id, crewId: r.member_id, job: r.job, state: r.state, createdAt: r.created_at, updatedAt: r.updated_at });

export class CrewRepo {
  readonly members = new Map<string, Member>();
  readonly #queues = new Map<string, WaitingJob[]>();
  readonly #logs = new Map<string, Logged[]>();
  readonly #links = new Map<string, Link[]>();
  readonly #store: Store;
  readonly #e: Entities;
  #seq = 0;

  constructor(store: Store, e: Entities) {
    this.#store = store;
    this.#e = e;
  }

  /** Everything into memory (setup only: these reads are synchronous). */
  load(): void {
    for (const r of this.#store.query(this.#e.member, { order: [['pos', 'asc']] })) this.members.set(r.id, fromRow(r));
    for (const r of this.#store.query(this.#e.queue, { order: [['seq', 'asc']] })) {
      this.#seq = Math.max(this.#seq, r.seq);
      this.#list(this.#queues, r.member_id).push(r.job as WaitingJob);
    }
    for (const r of this.#store.query(this.#e.log, { order: [['id', 'desc']] })) {
      const list = this.#list(this.#logs, r.member_id);
      if (list.length < LOG_MAX) list.push({ id: r.id ?? 0, entry: r.entry as LogEntry });
    }
    for (const r of this.#store.query(this.#e.link, { order: [['at', 'desc']] })) this.#list(this.#links, r.member_id).push({ id: r.task_id, title: r.title, at: r.at });
  }

  #list<T>(map: Map<string, T[]>, id: string): T[] {
    let l = map.get(id);
    if (!l) map.set(id, (l = []));
    return l;
  }

  list(): Member[] {
    return [...this.members.values()];
  }

  save(m: Member): void {
    const pos = [...this.members.keys()].indexOf(m.id);
    this.members.set(m.id, m);
    this.#store.tx((w) => w.upsert(this.#e.member, toRow(m, pos < 0 ? this.members.size - 1 : pos)));
  }

  /** The member and everything that is only its: queue, log, links, its place on the Org page. */
  remove(id: string): void {
    this.members.delete(id);
    const queue = this.#queues.get(id) ?? [];
    const logs = this.#logs.get(id) ?? [];
    const links = this.#links.get(id) ?? [];
    this.#queues.delete(id);
    this.#logs.delete(id);
    this.#links.delete(id);
    this.#store.tx((w) => {
      w.del(this.#e.member, id);
      for (const q of queue) w.del(this.#e.queue, q.id);
      for (const l of logs) w.del(this.#e.log, l.id);
      for (const l of links) w.del(this.#e.link, `${id}:${l.id}`);
      w.del(this.#e.layout, id);
    });
  }

  // ---------- queue ----------

  queue(id: string): readonly WaitingJob[] {
    return this.#queues.get(id) ?? [];
  }
  enqueue(id: string, w: WaitingJob): void {
    this.#list(this.#queues, id).push(w);
    this.#store.tx((x) => x.upsert(this.#e.queue, { id: w.id, member_id: id, seq: ++this.#seq, at: w.at, job: w }));
  }
  /** Takes the first waiting job off the queue. */
  shift(id: string): WaitingJob | undefined {
    const w = this.#queues.get(id)?.shift();
    if (w) this.#store.tx((x) => x.del(this.#e.queue, w.id));
    return w;
  }
  /** Keeps only the waiting jobs named (PATCH /crew/:id { queue }). */
  keep(id: string, ids: readonly string[]): void {
    const list = this.#queues.get(id) ?? [];
    const gone = list.filter((w) => !ids.includes(w.id));
    if (!gone.length) return;
    this.#queues.set(id, list.filter((w) => ids.includes(w.id)));
    this.#store.tx((x) => {
      for (const w of gone) x.del(this.#e.queue, w.id);
    });
  }

  // ---------- log ----------

  log(id: string): LogEntry[] {
    return (this.#logs.get(id) ?? []).map((l) => l.entry);
  }
  /** A line on top of the log; past LOG_MAX the oldest goes. */
  addLog(id: string, entry: LogEntry): void {
    const list = this.#list(this.#logs, id);
    const dropped = list.length >= LOG_MAX ? list.splice(LOG_MAX - 1) : [];
    this.#store.tx((x) => {
      const [row] = x.append(this.#e.log, [{ member_id: id, at: entry.at, entry }]);
      list.unshift({ id: row?.id ?? 0, entry });
      for (const d of dropped) x.del(this.#e.log, d.id);
    });
  }
  /** Rewrites the top line (skips in a row share one). */
  setTopLog(id: string, entry: LogEntry): void {
    const top = this.#logs.get(id)?.[0];
    if (!top) return this.addLog(id, entry);
    top.entry = entry;
    this.#store.tx((x) => x.upsert(this.#e.log, { id: top.id, member_id: id, at: entry.at, entry }));
  }

  // ---------- links ----------

  links(id: string): readonly Link[] {
    return this.#links.get(id) ?? [];
  }
  /** A task that tagged or delegated to the member, newest first. */
  link(id: string, l: Link): void {
    const was = this.#links.get(id) ?? [];
    const next = [l, ...was.filter((x) => x.id !== l.id)];
    const dropped = next.splice(LINKS_MAX);
    this.#links.set(id, next);
    this.#store.tx((x) => {
      x.upsert(this.#e.link, { id: `${id}:${l.id}`, member_id: id, task_id: l.id, title: l.title, at: l.at });
      for (const d of dropped) x.del(this.#e.link, `${id}:${d.id}`);
    });
  }

  // ---------- jobs ----------

  addJob(j: JobRow): void {
    this.#store.tx((x) => x.upsert(this.#e.job, { session_id: j.sessionId, member_id: j.crewId, job: j.job, state: j.state, created_at: j.createdAt, updated_at: j.updatedAt }));
  }
  job(sessionId: string): JobRow | undefined {
    const r = this.#store.get(this.#e.job, sessionId);
    return r ? jobOf(r) : undefined;
  }
  setJobState(sessionId: string, state: string, at: number): void {
    if (this.#store.get(this.#e.job, sessionId)) this.#store.tx((x) => x.upsert(this.#e.job, { session_id: sessionId, state, updated_at: at }));
  }
  dropJob(sessionId: string): void {
    this.#store.tx((x) => x.del(this.#e.job, sessionId));
  }
  /** A member's jobs, newest first (crew_job_member index). */
  jobs(id: string, limit = 50): JobRow[] {
    return this.#store.query(this.#e.job, { where: { member_id: id }, order: [['created_at', 'desc']], limit }).map(jobOf);
  }
  jobCount(id: string): number {
    return this.#store.count(this.#e.job, { member_id: id });
  }
  /** The jobs still running (setup: the live index starts from them). */
  running(): JobRow[] {
    return this.#store.query(this.#e.job, { where: { state: 'running' } }).map(jobOf);
  }

  // ---------- seen ----------

  /** true the first time a job's turn is filed: events come at least once, a turn is filed once. */
  firstSeen(key: string, memberId: string, now: number): boolean {
    if (this.#store.get(this.#e.seen, key)) return false;
    this.#store.tx((x) => x.upsert(this.#e.seen, { id: key, member_id: memberId, at: now }));
    return true;
  }
  pruneSeen(now: number): void {
    const old = this.#store.query(this.#e.seen, { select: ['id'], where: { at: { lt: now - SEEN_KEEP_MS } }, limit: 500 });
    if (old.length) this.#store.tx((x) => {
      for (const r of old) x.del(this.#e.seen, r.id);
    });
  }

  // ---------- layout ----------

  layout(): Record<string, { x: number; y: number }> {
    const out: Record<string, { x: number; y: number }> = {};
    for (const r of this.#store.query(this.#e.layout)) if (this.members.has(r.member_id)) out[r.member_id] = { x: r.x, y: r.y };
    return out;
  }
  setLayout(next: Record<string, { x: number; y: number }>): void {
    const had = this.#store.query(this.#e.layout, { select: ['member_id'] });
    this.#store.tx((x) => {
      for (const r of had) if (!(r.member_id in next)) x.del(this.#e.layout, r.member_id);
      for (const [id, p] of Object.entries(next)) x.upsert(this.#e.layout, { member_id: id, x: p.x, y: p.y });
    });
  }
}
