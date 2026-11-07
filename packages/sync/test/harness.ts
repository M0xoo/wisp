// Test harness: a fake store with a change log, and a simulated wire that carries SyncServer frames
// to SyncClients through the real SSE encoder and parser. Deterministic: a seeded RNG, a scripted clock.

import { applyPatch, diff } from '@wisp/protocol';
import type { PeerInfo, Topic } from '@wisp/protocol';
import { SyncServer } from '../src/server.ts';
import { SyncClient } from '../src/client.ts';
import { SseParser, decodeFrame } from '../src/sse.ts';
import { applyEntityOps, applySnapshot, rowKey } from '../src/apply.ts';
import type { EntityMap } from '../src/apply.ts';
import type { ChangeRow, ClientOutput, Row, ServerOutput, SyncServerOptions } from '../src/types.ts';

export const PEER: PeerInfo = { peer: 'laptop', name: 'laptop', build: 'test', version: '2.0.0', proto_min: 2, proto_max: 2, plugins: [] };

export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

export type Change = { topic: Topic; e: string; id: string } & ({ op: 'upsert'; v: unknown } | { op: 'set'; v: unknown } | { op: 'del' } | { op: 'append'; v: unknown[] });

export class FakeStore {
  rows = new Map<Topic, Map<string, Row>>();
  log: ChangeRow[] = [];
  seq = 0;
  oldest = 0;

  /** One transaction. `set` diffs the old value into a patch row, as the real store does. */
  commit(changes: Change[], at = 0): ChangeRow[] {
    const out: ChangeRow[] = [];
    for (const c of changes) {
      let t = this.rows.get(c.topic);
      if (t === undefined) this.rows.set(c.topic, (t = new Map()));
      const key = rowKey(c.e, c.id);
      const cur = t.get(key);
      const base = { seq: ++this.seq, topic: c.topic, entity: c.e, id: c.id, at };
      let row: ChangeRow;
      if (c.op === 'del') {
        if (cur === undefined) {
          this.seq--;
          continue;
        }
        t.delete(key);
        row = { ...base, op: 'del', patch: null };
      } else if (c.op === 'append') {
        const prev = cur !== undefined && Array.isArray(cur.v) ? cur.v : cur === undefined ? [] : null;
        if (prev === null) {
          this.seq--;
          continue;
        }
        t.set(key, { e: c.e, id: c.id, v: [...prev, ...c.v] });
        row = { ...base, op: 'append', patch: c.v };
      } else if (c.op === 'set' && cur !== undefined) {
        const ops = diff(cur.v, c.v);
        if (ops.length === 0) {
          this.seq--;
          continue;
        }
        t.set(key, { e: c.e, id: c.id, v: applyPatch(cur.v, ops) });
        row = { ...base, op: 'patch', patch: ops };
      } else {
        t.set(key, { e: c.e, id: c.id, v: c.v });
        row = { ...base, op: 'upsert', patch: c.v };
      }
      this.log.push(row);
      out.push(row);
    }
    return out;
  }

  snapshot(topic: Topic): Row[] {
    return [...(this.rows.get(topic)?.values() ?? [])];
  }

  /** Rows changed since `since` (current values) and the ones gone: a resume's delta. */
  delta(topic: Topic, since: number): { rows: Row[]; deleted: { e: string; id: string }[] } {
    const seen = new Map<string, { e: string; id: string }>();
    for (const r of this.log) if (r.topic === topic && r.seq > since) seen.set(rowKey(r.entity, r.id), { e: r.entity, id: r.id });
    const rows: Row[] = [];
    const deleted: { e: string; id: string }[] = [];
    const t = this.rows.get(topic);
    for (const [key, ref] of seen) {
      const cur = t?.get(key);
      if (cur === undefined) deleted.push(ref);
      else rows.push(cur);
    }
    return { rows, deleted };
  }

  trim(upTo: number): void {
    this.log = this.log.filter((r) => r.seq > upTo);
    this.oldest = Math.max(this.oldest, upTo);
  }
}

export function makeServer(store: FakeStore, over: Partial<SyncServerOptions<string>> = {}): SyncServer<string> {
  return new SyncServer<string>({ epoch: 'E1', peer: PEER, headSeq: store.seq, oldestSeq: store.oldest, canRead: () => true, ...over });
}

/** One client and its entity map, as @wisp/client would hold it. */
export class SimClient {
  client: SyncClient;
  map: EntityMap = new Map();
  conn: string | null = null;
  parser = new SseParser();
  acks: string[] = [];
  rejects: string[] = [];
  resyncs = 0;
  drifts = 0;
  resets = 0;
  lives = 0;
  retryAt: number | null = null;
  incompatible: string | null = null;
  /** frames sent but not yet read by the client: lost with the connection */
  transit: string[] = [];
  /** what the socket reports as still buffered after a write */
  backlog = 0;
  readonly name: string;
  constructor(name: string) {
    this.name = name;
    this.client = new SyncClient({ peer: 'laptop', clientId: name, build: 'test' });
  }
}

/** Wires one server to clients: frames go through encode → random chunking → parse. */
export class Sim {
  now = 1000;
  answers: (() => void)[] = [];
  /** every snapshotRequest the server made, in order */
  requests: { conn: string; topic: Topic; since: number | null }[] = [];
  frames = 0;
  bytes = 0;
  #n = 0;
  readonly store: FakeStore;
  server: SyncServer<string>;
  readonly rand: () => number;
  /** asyncAnswers: snapshot answers wait for answerAll() · wire: frames wait for deliver() */
  readonly opts: { asyncAnswers?: boolean; chunked?: boolean; wire?: boolean };
  constructor(store: FakeStore, server: SyncServer<string>, rand: () => number = rng(1), opts: Sim['opts'] = {}) {
    this.store = store;
    this.server = server;
    this.rand = rand;
    this.opts = opts;
  }

  server_(outs: ServerOutput<string>[], clients: SimClient[]): void {
    for (const o of outs) {
      const c = clients.find((x) => x.conn === o.conn);
      if (o.kind === 'send') {
        if (c === undefined) continue;
        this.frames += o.id === null ? 0 : 1;
        this.bytes += o.frame.length;
        c.transit.push(o.frame);
        this.server_(this.server.handle({ kind: 'drained', conn: o.conn, bufferedBytes: c.backlog }, this.now), clients);
        if (this.opts.wire !== true) this.deliver(c, clients);
      } else if (o.kind === 'closeConn') {
        if (c !== undefined) this.lose(c, clients);
      } else if (o.kind === 'snapshotRequest') {
        this.requests.push({ conn: o.conn, topic: o.topic, since: o.since });
        const answer = (): void => {
          const base = { conn: o.conn, topic: o.topic, req: o.req, seq: this.store.seq };
          // a delta needs the log back to `since`: once retention passed it, only a full snapshot will do
          const input = o.since === null || o.since < this.store.oldest || this.rand() < 0.2
            ? { kind: 'snapshotRows' as const, ...base, rows: this.store.snapshot(o.topic), full: true }
            : { kind: 'snapshotRows' as const, ...base, ...this.store.delta(o.topic, o.since), full: false };
          this.server_(this.server.handle(input, this.now), clients);
        };
        if (this.opts.asyncAnswers === true) this.answers.push(answer);
        else answer();
      }
    }
  }

  /** Reads up to `max` frames off the wire into the client. */
  deliver(c: SimClient, clients: SimClient[], max = Infinity): void {
    for (let i = 0; i < max && c.transit.length > 0; i++) this.#deliver(c, c.transit.shift() as string, clients); // length checked
  }

  #deliver(c: SimClient, frame: string, clients: SimClient[]): void {
    const parts: string[] = [];
    if (this.opts.chunked === true) {
      let i = 0;
      while (i < frame.length) {
        const n = 1 + Math.floor(this.rand() * 40);
        parts.push(frame.slice(i, i + n));
        i += n;
      }
    } else parts.push(frame);
    for (const p of parts) {
      for (const ev of c.parser.push(p)) {
        const f = decodeFrame(ev);
        if (f !== null) this.client_(c, c.client.handle({ kind: 'frame', id: f.id, messages: f.messages }, this.now), clients);
      }
    }
  }

  client_(c: SimClient, outs: ClientOutput[], clients: SimClient[]): void {
    for (const o of outs) {
      switch (o.kind) {
        case 'request': {
          c.conn = `conn${++this.#n}`;
          c.parser = new SseParser();
          this.server_(this.server.handle({ kind: 'connect', conn: c.conn, caller: c.name, query: o.params }, this.now), clients);
          break;
        }
        case 'send':
          if (c.conn !== null) this.server_(this.server.handle({ kind: 'message', conn: c.conn, message: o.message }, this.now), clients);
          break;
        case 'reset':
          c.resets++;
          c.map.clear();
          break;
        case 'snapshot':
          applySnapshot(c.map, o.topic, o.rows);
          break;
        case 'entityOps':
          for (const t of applyEntityOps(c.map, o.ops)) { c.drifts++; this.client_(c, c.client.handle({ kind: 'drifted', topic: t }, this.now), clients); }
          break;
        case 'ack':
          c.acks.push(o.mid);
          break;
        case 'reject':
          c.rejects.push(o.mid);
          break;
        case 'needResubscribe':
          c.resyncs++;
          break;
        case 'retry':
          c.retryAt = o.at;
          break;
        case 'state':
          if (o.state === 'incompatible') c.incompatible = o.update ?? '';
          if (o.state === 'live') c.lives++;
          break;
        default:
          break;
      }
    }
  }

  commit(changes: Change[], clients: SimClient[]): ChangeRow[] {
    const rows = this.store.commit(changes, this.now);
    if (rows.length > 0) this.server_(this.server.handle({ kind: 'committed', rows }, this.now), clients);
    return rows;
  }

  tick(ms: number, clients: SimClient[]): void {
    this.now += ms;
    this.server_(this.server.handle({ kind: 'tick' }, this.now), clients);
  }

  lose(c: SimClient, clients: SimClient[]): void {
    if (c.conn === null) return;
    const conn = c.conn;
    c.conn = null;
    c.transit = [];
    this.server.handle({ kind: 'close', conn }, this.now);
    this.client_(c, c.client.handle({ kind: 'lost' }, this.now), clients);
  }

  open(c: SimClient, clients: SimClient[]): void {
    this.client_(c, c.client.handle({ kind: 'open' }, this.now), clients);
  }

  answerAll(): void {
    while (this.answers.length > 0) this.answers.shift()?.();
  }
}

/** The client's rows for `topic`, as plain sorted data, to compare with the store's. */
export function view(map: EntityMap, topic: Topic): Row[] {
  return [...(map.get(topic)?.values() ?? [])].sort((a, b) => (a.e + a.id < b.e + b.id ? -1 : 1));
}
