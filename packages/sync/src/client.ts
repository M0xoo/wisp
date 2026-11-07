// The client half of sync, one per peer (plan §4.5, §7.2.1, §7.3.2), sans-IO. It keeps the cursor
// for (peer, epoch), refcounts subscriptions (two views of one session are one sub), resends pending
// mutations after welcome with the same mid, and negotiates the protocol window.

import { PROTO, PROTO_MIN } from '@wisp/protocol';
import type { ClientMessage, EntityOp, Mutate, ServerMessage, Topic, Welcome } from '@wisp/protocol';
import type { ClientInput, ClientOutput, ClientState, Row } from './types.ts';

export interface SyncClientSaved {
  epoch: string | null;
  cursor: number | null;
  /** topics whose rows the client store holds as of `cursor` */
  synced: Topic[];
  pending: Mutate[];
}

export interface SyncClientOptions {
  peer: string;
  clientId: string;
  build: string;
  protoMin?: number;
  protoMax?: number;
  saved?: SyncClientSaved;
  retryBaseMs?: number; // 500
  retryMaxMs?: number; // 30 s
}

interface TopicSub {
  refs: number;
  activeRefs: number;
  synced: boolean;
  denied: boolean;
  pages: { seq: number; rows: Row[] } | null;
}

export class SyncClient {
  readonly peer: string;
  #o: SyncClientOptions & { protoMin: number; protoMax: number; retryBaseMs: number; retryMaxMs: number };
  #state: ClientState = 'idle';
  #epoch: string | null;
  #cursor: number | null;
  #topics = new Map<Topic, TopicSub>();
  #savedSynced: Set<Topic>;
  #pending = new Map<string, Mutate>();
  /** the topics the open hello carried: true when resumed from the cursor, false when fresh */
  #hello = new Map<Topic, boolean>();
  #attempt = 0;
  #out: ClientOutput[] = [];

  constructor(opts: SyncClientOptions) {
    this.peer = opts.peer;
    this.#o = { protoMin: PROTO_MIN, protoMax: PROTO, retryBaseMs: 500, retryMaxMs: 30_000, ...opts };
    this.#epoch = opts.saved?.epoch ?? null;
    this.#cursor = opts.saved?.cursor ?? null;
    this.#savedSynced = new Set(opts.saved?.synced ?? []);
    for (const m of opts.saved?.pending ?? []) this.#pending.set(m.mid, m);
  }

  get state(): ClientState {
    return this.#state;
  }

  get cursor(): number | null {
    return this.#cursor;
  }

  get epoch(): string | null {
    return this.#epoch;
  }

  /** What to persist (IndexedDB on a phone) so a restart resumes instead of starting over. */
  save(): SyncClientSaved {
    const synced = [...this.#topics].filter(([, s]) => s.synced).map(([t]) => t);
    return { epoch: this.#epoch, cursor: this.#cursor, synced, pending: [...this.#pending.values()] };
  }

  handle(input: ClientInput, now: number): ClientOutput[] {
    this.#out = [];
    switch (input.kind) {
      case 'open':
        this.#open();
        break;
      case 'frame':
        this.#frame(input.id, input.messages);
        break;
      case 'lost':
        this.#lost(now);
        break;
      case 'subscribe':
        this.#subscribe(input.topic, input.passive === true);
        break;
      case 'unsubscribe':
        this.#unsubscribe(input.topic, input.passive === true);
        break;
      case 'mutate': {
        const m: Mutate = { t: 'mutate', mid: input.mid, cmd: input.cmd, args: input.args, ...(input.base_seq !== undefined && { base_seq: input.base_seq }) };
        this.#pending.set(m.mid, m);
        if (this.#state === 'live') this.#send(m);
        break;
      }
      case 'window':
        if (this.#state === 'live') this.#send({ t: 'window', req: input.req, topic: input.topic, before_seq: input.beforeSeq, limit: input.limit });
        break;
      case 'drifted': {
        const s = this.#topics.get(input.topic);
        if (s === undefined) break;
        s.synced = false;
        s.pages = null;
        if (this.#state === 'live') {
          this.#send({ t: 'unsub', topic: input.topic });
          this.#send(this.#subMessage(input.topic, s));
        }
        break;
      }
    }
    return this.#out;
  }

  // ---------- connection ----------

  #open(): void {
    if (this.#state === 'connecting' || this.#state === 'live') return;
    this.#setState('connecting');
    const params: Record<string, string> = { proto_min: String(this.#o.protoMin), proto_max: String(this.#o.protoMax), client_id: this.#o.clientId, build: this.#o.build };
    const canResume = this.#epoch !== null && this.#cursor !== null;
    if (canResume) {
      params['epoch'] = this.#epoch as string; // checked just above
      params['cursor'] = String(this.#cursor);
    }
    const topics: Topic[] = [];
    const fresh: Topic[] = [];
    const passive: Topic[] = [];
    this.#hello.clear();
    for (const [t, s] of this.#topics) {
      if (s.denied) continue;
      const resumed = canResume && (s.synced || this.#savedSynced.has(t));
      this.#hello.set(t, resumed);
      (resumed ? topics : fresh).push(t);
      if (s.activeRefs === 0) passive.push(t);
    }
    if (topics.length > 0) params['topics'] = topics.join(',');
    if (fresh.length > 0) params['fresh'] = fresh.join(',');
    if (passive.length > 0) params['passive'] = passive.length === this.#hello.size ? '1' : passive.join(',');
    this.#out.push({ kind: 'request', params });
  }

  #lost(now: number): void {
    if (this.#state === 'incompatible' || this.#state === 'idle') return;
    for (const s of this.#topics.values()) s.pages = null; // a half-received snapshot is worthless
    this.#setState('offline');
    this.#attempt++;
    const delay = Math.min(this.#o.retryMaxMs, this.#o.retryBaseMs * 2 ** (this.#attempt - 1));
    this.#out.push({ kind: 'retry', at: now + delay });
  }

  #welcome(w: Welcome): boolean {
    const lo = Math.max(this.#o.protoMin, w.peer.proto_min);
    const hi = Math.min(this.#o.protoMax, w.peer.proto_max);
    if (lo > hi) {
      // outside the window: whichever side is older must update (plan §7.3.2)
      const update = w.peer.proto_max < this.#o.protoMin ? 'peer' : 'client';
      this.#state = 'incompatible';
      this.#out.push({ kind: 'state', state: 'incompatible', update });
      return false;
    }
    const resume = w.resume && w.epoch === this.#epoch;
    if (!resume) this.#out.push({ kind: 'reset', peer: this.peer });
    for (const [t, s] of this.#topics) {
      s.synced = resume && this.#hello.get(t) === true;
      s.pages = null;
    }
    this.#savedSynced.clear();
    this.#epoch = w.epoch;
    this.#attempt = 0;
    this.#setState('live');
    // what changed while the hello was in flight
    for (const [t, s] of this.#topics) if (!this.#hello.has(t) && !s.denied) this.#send(this.#subMessage(t, s));
    for (const t of this.#hello.keys()) if (!this.#topics.has(t)) this.#send({ t: 'unsub', topic: t });
    this.#hello.clear();
    for (const m of this.#pending.values()) this.#send(m);
    return true;
  }

  // ---------- frames ----------

  #frame(id: number | null, messages: readonly ServerMessage[]): void {
    const settle: ClientOutput[] = [];
    const resyncs: Topic[] = [];
    for (const m of messages) {
      if (m.t === 'welcome') {
        if (!this.#welcome(m)) return;
        continue;
      }
      if (this.#state !== 'live') continue; // nothing counts before the welcome
      this.#message(m, settle, resyncs);
    }
    if (this.#state !== 'live') return;
    // the frame's id is a watermark: everything at or below it is here (src/server.ts)
    if (id !== null) this.#cursor = id;
    for (const t of resyncs) {
      const s = this.#topics.get(t);
      if (s === undefined) continue;
      this.#out.push({ kind: 'needResubscribe', topic: t });
      s.pages = null;
      this.#send(this.#subMessage(t, s, s.synced && this.#cursor !== null ? this.#cursor : undefined));
    }
    this.#out.push(...settle); // acks after the frame's ops: the effect is in base when the optimistic patch goes
  }

  #message(m: ServerMessage, settle: ClientOutput[], resyncs: Topic[]): void {
    switch (m.t) {
      case 'snapshot': {
        const s = this.#topics.get(m.topic);
        if (s === undefined) return;
        if (s.pages === null || s.pages.seq !== m.seq) s.pages = { seq: m.seq, rows: [] };
        s.pages.rows.push(...m.rows);
        if (m.more === true) return;
        this.#out.push({ kind: 'snapshot', peer: this.peer, topic: m.topic, rows: s.pages.rows });
        s.pages = null;
        s.synced = true;
        return;
      }
      case 'patch': {
        // a topic waiting for its snapshot takes no ops: the snapshot replaces them (and ops still on
        // the wire from before an unsub would patch rows the client no longer has)
        const ops: EntityOp[] = m.ops.filter((op) => this.#topics.get(op.topic)?.synced === true);
        if (ops.length > 0) this.#out.push({ kind: 'entityOps', peer: this.peer, ops });
        return;
      }
      case 'rows':
        this.#out.push({ kind: 'rows', peer: this.peer, req: m.req, rows: m.rows, done: m.done });
        return;
      case 'ack':
        if (this.#pending.delete(m.mid)) settle.push({ kind: 'ack', mid: m.mid, seq: m.seq, ...(m.result !== undefined && { result: m.result }) });
        return;
      case 'reject':
        if (this.#pending.delete(m.mid)) settle.push({ kind: 'reject', mid: m.mid, code: m.code, message: m.message });
        return;
      case 'resync':
        if (this.#topics.has(m.topic) && !resyncs.includes(m.topic)) resyncs.push(m.topic);
        return;
      case 'notice':
        this.#notice(m);
        return;
      case 'welcome':
        return;
    }
  }

  #notice(m: Extract<ServerMessage, { t: 'notice' }>): void {
    const d = m.data as { topic?: unknown; code?: unknown } | null;
    if (m.kind === 'denied' && d !== null && typeof d === 'object' && typeof d.topic === 'string') {
      const topic = d.topic as Topic;
      const s = this.#topics.get(topic);
      if (s !== undefined) s.denied = true;
      this.#out.push({ kind: 'denied', topic, code: typeof d.code === 'string' ? d.code : 'forbidden' });
      return;
    }
    this.#out.push({ kind: 'notice', notice: m });
  }

  // ---------- subscriptions ----------

  #subscribe(topic: Topic, passive: boolean): void {
    let s = this.#topics.get(topic);
    if (s === undefined) {
      s = { refs: 0, activeRefs: 0, synced: false, denied: false, pages: null };
      this.#topics.set(topic, s);
    }
    const wasActive = s.activeRefs > 0;
    s.refs++;
    if (!passive) s.activeRefs++;
    if (this.#state !== 'live') return;
    // the first view sends the sub; a first active view turns a passive sub into one that counts
    if (s.refs === 1 || (!wasActive && s.activeRefs === 1)) this.#send(this.#subMessage(topic, s));
  }

  #unsubscribe(topic: Topic, passive: boolean): void {
    const s = this.#topics.get(topic);
    if (s === undefined) return;
    s.refs--;
    if (!passive && s.activeRefs > 0) s.activeRefs--;
    if (s.refs > 0) {
      if (s.activeRefs === 0 && !passive && this.#state === 'live') this.#send(this.#subMessage(topic, s));
      return;
    }
    this.#topics.delete(topic);
    if (this.#state === 'live' && !s.denied) this.#send({ t: 'unsub', topic });
  }

  #subMessage(topic: Topic, s: TopicSub, since?: number): ClientMessage {
    return { t: 'sub', topic, ...(since !== undefined && { since }), ...(s.activeRefs === 0 && { passive: true }) };
  }

  #send(message: ClientMessage): void {
    this.#out.push({ kind: 'send', message });
  }

  #setState(state: ClientState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#out.push({ kind: 'state', state });
  }
}
