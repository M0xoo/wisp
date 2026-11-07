// The server half of sync (plan §4.3–§4.5, §7.2.3), sans-IO: `handle(input, now)` returns what to
// do and never reads a clock or a socket. One instance owns every connection of this wisp.
//
// The cursor a frame carries (its SSE `id:`) is a watermark, not the newest seq: every change at or
// below it, on every topic the client holds, has reached the client. Priorities and folding reorder
// what goes out, so the newest seq would let a resume skip a change still queued (test/server.test.ts).

import { PROTO, PROTO_MIN } from '@wisp/protocol';
import type { EntityOp, ServerMessage, Topic, Welcome } from '@wisp/protocol';
import { Outbox } from './outbox.ts';
import { encodeFrame, heartbeat } from './sse.ts';
import { parseClientMessage, parseHello } from './parse.ts';
import { OVERHEAD, rowBytes, toEntityOp } from './rows.ts';
import type { Conn, Options, Sub } from './conn.ts';
import type { ChangeRow, ConnectQuery, ConnId, ServerInput, ServerOutput, SnapshotAnswer, SyncServerOptions } from './types.ts';

export class SyncServer<C = unknown> {
  readonly epoch: string;
  #o: Options<C>;
  #head: number;
  #oldest: number;
  #conns = new Map<ConnId, Conn<C>>();
  #byClient = new Map<string, ConnId>();
  #req = 0;
  #out: ServerOutput<C>[] = [];
  /** each committed op's JSON, made once and shared by every connection's frame */
  #json = new WeakMap<EntityOp, string>();
  /** frames and bytes sent, for gate G3 and the status pane */
  readonly stats = { frames: 0, bytes: 0, heartbeats: 0, resyncs: 0 };

  constructor(opts: SyncServerOptions<C>) {
    this.epoch = opts.epoch;
    this.#o = { flushMs: 50, highWaterBytes: 1 << 20, heartbeatMs: 15_000, loadBufferBytes: 4 << 20, ...opts };
    this.#head = opts.headSeq;
    this.#oldest = opts.oldestSeq;
  }

  get headSeq(): number {
    return this.#head;
  }

  callerOf(conn: ConnId): C | undefined {
    return this.#conns.get(conn)?.caller;
  }

  connOf(clientId: string): ConnId | undefined {
    return this.#byClient.get(clientId);
  }

  /** connections that count as use of this box: any non-passive subscription */
  activeCount(): number {
    let n = 0;
    for (const c of this.#conns.values()) if (c.active) n++;
    return n;
  }

  /** When `tick` next has work: a due flush or heartbeat. Null when nothing is connected. */
  nextWakeAt(): number | null {
    let at: number | null = null;
    const min = (t: number): void => void (at = at === null ? t : Math.min(at, t));
    for (const c of this.#conns.values()) {
      if (this.#pending(c)) min(c.lastFlushAt + this.#o.flushMs);
      min(c.lastWriteAt + this.#o.heartbeatMs);
    }
    return at;
  }

  handle(input: ServerInput<C>, now: number): ServerOutput<C>[] {
    this.#out = [];
    switch (input.kind) {
      case 'connect':
        this.#connect(input.conn, input.caller, input.query, now);
        break;
      case 'message':
        this.#message(input.conn, input.message, now);
        break;
      case 'committed':
        this.#committed(input.rows, now);
        break;
      case 'snapshotRows':
        this.#snapshotRows(input, now);
        break;
      case 'windowRows':
        this.#windowRows(input, now);
        break;
      case 'commandResult':
        this.#commandResult(input, now);
        break;
      case 'notice':
        for (const c of this.#conns.values()) {
          if (input.topic !== undefined && !c.subs.has(input.topic)) continue;
          c.control.push(input.notice);
          this.#maybeFlush(c, now);
        }
        break;
      case 'retained':
        this.#oldest = Math.max(this.#oldest, input.oldestSeq);
        break;
      case 'tick':
        for (const c of this.#conns.values()) this.#tick(c, now);
        break;
      case 'drained': {
        const c = this.#conns.get(input.conn);
        if (c === undefined) break;
        c.buffered = input.bufferedBytes;
        this.#requestWaiting(c);
        this.#maybeFlush(c, now);
        break;
      }
      case 'close':
        this.#drop(input.conn);
        break;
    }
    return this.#out;
  }

  #windowRows(input: Extract<ServerInput<C>, { kind: 'windowRows' }>, now: number): void {
    const c = this.#conns.get(input.conn);
    const topic = c?.windows.get(input.req);
    if (c === undefined || topic === undefined) return;
    if (input.done) c.windows.delete(input.req);
    const msg: ServerMessage = { t: 'rows', req: input.req, rows: input.rows, done: input.done };
    c.out.pushFront(topic, msg, JSON.stringify(input.rows).length + OVERHEAD);
    this.#maybeFlush(c, now);
  }

  #commandResult(input: Extract<ServerInput<C>, { kind: 'commandResult' }>, now: number): void {
    const c = this.#conns.get(input.conn);
    if (c === undefined) return;
    const r = input.outcome;
    // an ack waits in c.acks until the watermark passes its seq (#flush): its effects go first
    if (r.ok) c.acks.push({ mid: input.mid, seq: r.seq, ...(r.result !== undefined && { result: r.result }) });
    else c.control.push({ t: 'reject', mid: input.mid, code: r.code, message: r.message });
    this.#maybeFlush(c, now);
  }

  // ---------- connections ----------

  #connect(id: ConnId, caller: C, query: ConnectQuery, now: number): void {
    const hello = parseHello(query, id);
    const old = this.#byClient.get(hello.clientId);
    if (old !== undefined && old !== id) {
      this.#drop(old);
      this.#out.push({ kind: 'closeConn', conn: old, reason: 'replaced' });
    }
    const c: Conn<C> = { id, caller, clientId: hello.clientId, subs: new Map(), out: new Outbox(), control: [], acks: [], windows: new Map(), buffered: 0, lastFlushAt: -Infinity, lastWriteAt: now, active: false };
    this.#conns.set(id, c);
    this.#byClient.set(hello.clientId, id);
    const compatible = Math.min(hello.protoMax, PROTO) >= Math.max(hello.protoMin, PROTO_MIN);
    const resume = compatible && hello.epoch === this.epoch && hello.cursor !== null && hello.cursor >= this.#oldest && hello.cursor <= this.#head;
    const welcome: Welcome = { t: 'welcome', epoch: this.epoch, head_seq: this.#head, oldest_seq: this.#oldest, resume, proto: compatible ? Math.min(hello.protoMax, PROTO) : PROTO, peer: this.#o.peer };
    if (!compatible) {
      this.#write(c, [welcome], now);
      this.#drop(id);
      this.#out.push({ kind: 'closeConn', conn: id, reason: 'incompatible' });
      return;
    }
    c.control.push(welcome);
    for (const t of hello.invalid) this.#deny(c, t, 'invalid');
    const since = resume ? hello.cursor : null;
    const passive = (t: Topic): boolean => hello.passive === 'all' || hello.passive.includes(t);
    for (const t of hello.topics) this.#subscribe(c, t, passive(t), since);
    for (const t of hello.fresh) this.#subscribe(c, t, passive(t), null);
    this.#updateActivity(c);
    this.#flush(c, now); // the welcome goes at once...
    c.lastFlushAt = -Infinity; // ...and doesn't hold back the snapshots behind it
  }

  #drop(id: ConnId): void {
    const c = this.#conns.get(id);
    if (c === undefined) return;
    this.#conns.delete(id);
    if (this.#byClient.get(c.clientId) === id) this.#byClient.delete(c.clientId);
  }

  #message(id: ConnId, raw: unknown, now: number): void {
    const c = this.#conns.get(id);
    const m = parseClientMessage(raw);
    if (c === undefined || m === null) return;
    switch (m.t) {
      case 'sub':
        this.#subscribe(c, m.topic, m.passive === true, m.since ?? null);
        this.#updateActivity(c);
        break;
      case 'unsub':
        c.subs.delete(m.topic);
        c.out.drop(m.topic, false);
        this.#updateActivity(c);
        break;
      case 'window':
        if (!this.#o.canRead(c.caller, m.topic)) {
          this.#deny(c, m.topic, 'forbidden');
          break;
        }
        c.windows.set(m.req, m.topic);
        this.#out.push({ kind: 'windowRequest', conn: id, req: m.req, topic: m.topic, beforeSeq: m.before_seq, limit: m.limit });
        break;
      case 'mutate':
        this.#out.push({ kind: 'command', conn: id, caller: c.caller, mid: m.mid, cmd: m.cmd, args: m.args, ...(m.base_seq !== undefined && { baseSeq: m.base_seq }) });
        break;
      case 'hello':
        break; // the hello rides on the GET; a second one means nothing
    }
    this.#maybeFlush(c, now);
  }

  // ---------- subscriptions ----------

  #subscribe(c: Conn<C>, topic: Topic, passive: boolean, since: number | null): void {
    if (!this.#o.canRead(c.caller, topic)) return this.#deny(c, topic, 'forbidden');
    const existing = c.subs.get(topic);
    if (existing !== undefined && existing.state !== 'dropped' && since === null) {
      existing.passive = passive; // the same sub again: only its passive flag can change
      return;
    }
    c.out.drop(topic);
    // a cursor older than the change log can't be resumed from: take the whole topic
    const from = since !== null && since >= this.#oldest && since <= this.#head ? since : null;
    const sub: Sub = { passive, state: 'waiting', since: from, req: 0, buffer: [], bufferBytes: 0 };
    c.subs.set(topic, sub);
    if (c.buffered <= this.#lowWater()) this.#request(c, topic, sub);
  }

  #deny(c: Conn<C>, topic: string, code: string): void {
    c.control.push({ t: 'notice', kind: 'denied', data: { topic, code } });
  }

  #request(c: Conn<C>, topic: Topic, sub: Sub): void {
    sub.state = 'loading';
    sub.req = ++this.#req;
    sub.buffer = [];
    sub.bufferBytes = 0;
    this.#out.push({ kind: 'snapshotRequest', conn: c.id, topic, since: sub.since, req: sub.req });
  }

  /** Snapshots held back while the connection was over the high-water mark. */
  #requestWaiting(c: Conn<C>): void {
    if (c.buffered > this.#lowWater()) return;
    for (const [topic, sub] of c.subs) if (sub.state === 'waiting') this.#request(c, topic, sub);
  }

  #snapshotRows(a: SnapshotAnswer, now: number): void {
    const c = this.#conns.get(a.conn);
    const sub = c?.subs.get(a.topic);
    if (c === undefined || sub === undefined || sub.state !== 'loading' || a.req !== sub.req) return;
    if (a.full || sub.since === null) {
      const msg: ServerMessage = { t: 'snapshot', topic: a.topic, seq: a.seq, rows: a.rows, ...(a.more === true && { more: true }) };
      // replacing rows the client holds as of `since`: the cursor stays there until this is sent
      c.out.pushFront(a.topic, msg, JSON.stringify(a.rows).length + OVERHEAD, sub.since === null ? null : sub.since + 1);
    } else {
      const first = sub.since + 1;
      for (const r of a.rows) c.out.pushOp({ topic: a.topic, e: r.e, id: r.id, op: 'upsert', v: r.v }, first, JSON.stringify(r.v).length + OVERHEAD);
      for (const d of a.deleted ?? []) c.out.pushOp({ topic: a.topic, e: d.e, id: d.id, op: 'del' }, first, OVERHEAD);
    }
    if (a.more === true) return this.#maybeFlush(c, now);
    sub.state = 'live';
    sub.since = null;
    for (const row of sub.buffer) if (row.seq > a.seq) c.out.pushOp(toEntityOp(row), row.seq, rowBytes(row));
    sub.buffer = [];
    sub.bufferBytes = 0;
    this.#maybeFlush(c, now);
  }

  #updateActivity(c: Conn<C>): void {
    const active = [...c.subs.values()].some((s) => !s.passive);
    if (active === c.active) return;
    c.active = active;
    this.#out.push({ kind: 'activity', conn: c.id, active });
  }

  // ---------- the change feed ----------

  #committed(rows: readonly ChangeRow[], now: number): void {
    const sorted = rows.length > 1 ? [...rows].sort((a, b) => a.seq - b.seq) : rows;
    for (const row of sorted) {
      if (row.seq > this.#head) this.#head = row.seq;
      let op: EntityOp | null = null;
      let bytes = 0;
      for (const c of this.#conns.values()) {
        const sub = c.subs.get(row.topic);
        if (sub === undefined) continue;
        if (sub.state === 'live') {
          if (op === null) {
            op = toEntityOp(row);
            const json = JSON.stringify(op);
            this.#json.set(op, json);
            bytes = json.length;
          }
          c.out.pushOp(op, row.seq, bytes);
        } else if (sub.state === 'loading') {
          sub.buffer.push(row);
          sub.bufferBytes += bytes ||= rowBytes(row);
          // the host is slow to answer: start the topic over rather than hold changes without end
          if (sub.bufferBytes > this.#o.loadBufferBytes) this.#request(c, row.topic, sub);
        }
        // waiting and dropped: the snapshot or delta asked for later covers it
      }
    }
    for (const c of this.#conns.values()) this.#maybeFlush(c, now);
  }

  // ---------- flushing ----------

  #lowWater(): number {
    return this.#o.highWaterBytes / 2;
  }

  #pending(c: Conn<C>): boolean {
    return c.control.length > 0 || !c.out.empty || (c.acks.length > 0 && c.acks.some((a) => a.seq <= this.#watermark(c)));
  }

  #maybeFlush(c: Conn<C>, now: number): void {
    if (now - c.lastFlushAt >= this.#o.flushMs && this.#pending(c)) this.#flush(c, now);
  }

  #tick(c: Conn<C>, now: number): void {
    this.#requestWaiting(c);
    this.#maybeFlush(c, now);
    if (now - c.lastWriteAt >= this.#o.heartbeatMs) {
      const frame = heartbeat();
      c.lastWriteAt = now;
      this.stats.heartbeats++;
      this.#out.push({ kind: 'send', conn: c.id, frame, messages: [], id: null });
    }
  }

  #flush(c: Conn<C>, now: number): void {
    c.lastFlushAt = now;
    if (c.buffered > this.#o.highWaterBytes) this.#shed(c);
    const taken = c.buffered > this.#o.highWaterBytes ? { messages: [], ops: [], bytes: 0 } : c.out.take(this.#o.highWaterBytes - c.buffered);
    const w = this.#watermark(c);
    const acks: ServerMessage[] = [];
    c.acks = c.acks.filter((a) => {
      if (a.seq > w) return true;
      acks.push({ t: 'ack', ...a });
      return false;
    });
    const messages: ServerMessage[] = [...acks, ...c.control, ...taken.messages];
    c.control = [];
    if (taken.ops.length > 0) messages.push({ t: 'patch', seq: w, ops: taken.ops });
    if (messages.length > 0) this.#write(c, messages, now, w);
  }

  /** Past the high-water mark: drop each busy topic's queue and tell the client to resync it. */
  #shed(c: Conn<C>): void {
    for (const topic of c.out.busyTopics()) {
      const sub = c.subs.get(topic);
      const dropped = c.out.drop(topic);
      if (sub === undefined || !dropped.any) continue;
      // the client holds the topic as of just before the oldest change it now won't get
      if (dropped.oldestSeq !== null) sub.since = dropped.oldestSeq - 1;
      sub.state = 'dropped';
      sub.buffer = [];
      this.stats.resyncs++;
      c.control.push({ t: 'resync', topic });
    }
  }

  #watermark(c: Conn<C>): number {
    let w = this.#head;
    const queued = c.out.oldestSeq();
    if (queued !== null) w = Math.min(w, queued - 1);
    for (const sub of c.subs.values()) if (sub.state !== 'live' && sub.since !== null) w = Math.min(w, sub.since);
    return w;
  }

  #write(c: Conn<C>, messages: ServerMessage[], now: number, id = this.#watermark(c)): void {
    const frame = encodeFrame(id, messages, this.#json);
    c.buffered += frame.length; // until the adapter reports the socket's real number
    c.lastWriteAt = now;
    this.stats.frames++;
    this.stats.bytes += frame.length;
    this.#out.push({ kind: 'send', conn: c.id, frame, messages, id });
  }
}
