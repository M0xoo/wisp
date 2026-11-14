// An in-memory peer speaking the sync protocol (welcome, snapshot, patch, ack, reject, window →
// rows), for this package's dev page and tests until apps/web/dev/mock-peer.ts serves the whole app.
// (Copied from plugins/crew/ui/dev and given transcripts: a session's events are snapshotted as
// their last `tail`, and older pages answer `window`.) It drives the
// real @wisp/client (createClient), so optimistic patches, acks and rollbacks behave as they will
// against the Rust `wisp`. Dev-only: never shipped.

import type { ClientMessage, EntityOp, PeerInfo, ServerMessage, Topic } from '@wisp/protocol';
import type { Frame, Transport } from '@wisp/client';

export interface MockRow {
  readonly e: string;
  readonly id: string;
  v: unknown;
}

/** What a handler sees: the rows, and the writes it makes (each becomes one op of the patch). */
export interface MockDb {
  rows(e: string): unknown[];
  get<T = unknown>(e: string, id: string): T | undefined;
  upsert(topic: Topic, e: string, id: string, v: unknown): void;
  del(topic: Topic, e: string, id: string): void;
  now(): number;
}

export type MockAnswer = { result?: unknown } | { reject: { code: string; message: string } };
export type MockHandler = (args: Record<string, unknown>, db: MockDb) => MockAnswer | undefined | void;

export interface MockPeerOptions {
  peer: string;
  name?: string;
  rows: Readonly<Record<string, readonly MockRow[]>>; // topic → rows
  handlers?: Readonly<Record<string, MockHandler>>;
  /** ms before an answer; 0 answers on the next microtask */
  latency?: number;
  /** session id → its whole event log (oldest first); `session:<id>` snapshots hold the last `tail` */
  transcripts?: Readonly<Record<string, readonly { seq: number }[]>>;
  tail?: number;
  now?: () => number;
}

export interface MockPeer {
  readonly transport: Transport;
  readonly posted: ClientMessage[];
  readonly db: MockDb;
  /** pushes a server-side change to every open stream, as if the peer did it */
  push(ops: readonly EntityOp[]): void;
  /** the next command with this id is refused */
  refuseNext(cmd: string, message?: string): void;
  /** appends events to a session's log and to every stream (`append` on its event list row) */
  appendEvents(sessionId: string, events: readonly { seq: number }[]): void;
  /** the ops as-is (a `patch` on an event list row: a streaming token) */
  pushRaw(ops: readonly EntityOp[]): void;
}

const info = (peer: string, name: string): PeerInfo => ({ peer, name, build: 'mock', version: '2.0.0', proto_min: 2, proto_max: 2, plugins: [] });

// size-ok: a factory; small closures over the mock's shared state
export function mockPeer(o: MockPeerOptions): MockPeer {
  const now = o.now ?? Date.now;
  const topics = new Map<Topic, Map<string, MockRow>>();
  for (const [t, rows] of Object.entries(o.rows)) topics.set(t as Topic, new Map(rows.map((r) => [`${r.e}/${r.id}`, { ...r }])));
  const streams = new Set<(f: Frame) => void>();
  const refusals = new Map<string, string>();
  const posted: ClientMessage[] = [];
  let seq = 1;
  let staged: EntityOp[] = [];

  const table = (t: Topic): Map<string, MockRow> => {
    let m = topics.get(t);
    if (!m) topics.set(t, (m = new Map()));
    return m;
  };
  const db: MockDb = {
    rows: (e) => [...topics.values()].flatMap((m) => [...m.values()].filter((r) => r.e === e).map((r) => r.v)),
    get: <T>(e: string, id: string) => {
      for (const m of topics.values()) {
        const r = m.get(`${e}/${id}`);
        if (r) return r.v as T;
      }
      return undefined;
    },
    upsert(topic, e, id, v) {
      table(topic).set(`${e}/${id}`, { e, id, v });
      staged.push({ topic, e, id, op: 'upsert', v });
    },
    del(topic, e, id) {
      table(topic).delete(`${e}/${id}`);
      staged.push({ topic, e, id, op: 'del' });
    },
    now,
  };
  const send = (messages: ServerMessage[], id: number | null = null): void => {
    for (const s of streams) s({ id, messages });
  };
  const logs = new Map<string, { seq: number }[]>(Object.entries(o.transcripts ?? {}).map(([k, v]) => [k, [...v]]));
  const tail = o.tail ?? 60;
  const eventRows = (t: Topic): { e: string; id: string; v: unknown }[] => {
    const id = t.startsWith('session:') ? t.slice('session:'.length) : '';
    const log = logs.get(id);
    return log ? [{ e: 'event', id, v: log.slice(-tail) }] : [];
  };
  const snapshot = (t: Topic): ServerMessage => ({ t: 'snapshot', topic: t, seq, rows: [...[...table(t).values()].map((r) => ({ e: r.e, id: r.id, v: r.v })), ...eventRows(t)] });
  const windowAnswer = (m: Extract<ClientMessage, { t: 'window' }>): ServerMessage => {
    const id = m.topic.startsWith('session:') ? m.topic.slice('session:'.length) : '';
    const older = (logs.get(id) ?? []).filter((e) => e.seq < m.before_seq);
    return { t: 'rows', req: m.req, rows: [{ e: 'event', id, v: older.slice(-m.limit) }], done: true };
  };
  const later = (fn: () => void): void => {
    if (o.latency) globalThis.setTimeout(fn, o.latency);
    else queueMicrotask(fn);
  };

  function mutate(m: Extract<ClientMessage, { t: 'mutate' }>): void {
    const refused = refusals.get(m.cmd);
    if (refused !== undefined) {
      refusals.delete(m.cmd);
      return send([{ t: 'reject', mid: m.mid, code: 'refused', message: refused }]);
    }
    const handler = o.handlers?.[m.cmd];
    if (!handler) return send([{ t: 'reject', mid: m.mid, code: 'unknown_command', message: `the mock peer has no ${m.cmd}` }]);
    staged = [];
    const answer = handler((m.args ?? {}) as Record<string, unknown>, db) ?? {};
    if ('reject' in answer) return send([{ t: 'reject', mid: m.mid, ...answer.reject }]);
    const ops = staged;
    staged = [];
    if (ops.length > 0) {
      seq += 1;
      send([{ t: 'patch', seq, ops }], seq);
    }
    send([{ t: 'ack', mid: m.mid, seq, ...(answer.result !== undefined && { result: answer.result }) }]);
  }

  const transport: Transport = {
    kind: 'mock',
    connect(params, signal) {
      const queue: Frame[] = [];
      let wake: (() => void) | undefined;
      const push = (f: Frame): void => {
        queue.push(f);
        wake?.();
      };
      streams.add(push);
      signal.addEventListener('abort', () => {
        streams.delete(push);
        wake?.();
      });
      const first = [params['topics'], params['fresh']].flatMap((s) => (s ? s.split(',') : [])) as Topic[];
      push({ id: seq, messages: [{ t: 'welcome', epoch: 'mock', head_seq: seq, oldest_seq: 1, resume: false, proto: 2, peer: info(o.peer, o.name ?? o.peer) }, ...first.map(snapshot)] });
      return {
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            const f = queue.shift();
            if (f) yield f;
            else await new Promise<void>((r) => (wake = r));
          }
        },
      };
    },
    async post(message) {
      posted.push(message);
      if (message.t === 'sub') later(() => send([snapshot(message.topic)], seq));
      if (message.t === 'mutate') later(() => mutate(message));
      if (message.t === 'window') later(() => send([windowAnswer(message)]));
    },
  };

  return {
    transport,
    posted,
    db,
    push(ops) {
      for (const op of ops) {
        if (op.op === 'upsert') table(op.topic).set(`${op.e}/${op.id}`, { e: op.e, id: op.id, v: op.v });
        if (op.op === 'del') table(op.topic).delete(`${op.e}/${op.id}`);
      }
      seq += 1;
      send([{ t: 'patch', seq, ops: [...ops] }], seq);
    },
    refuseNext(cmd, message = 'Refused by the mock peer') {
      refusals.set(cmd, message);
    },
    appendEvents(sessionId, events) {
      const log = logs.get(sessionId) ?? [];
      log.push(...events);
      logs.set(sessionId, log);
      seq += 1;
      send([{ t: 'patch', seq, ops: [{ topic: `session:${sessionId}` as Topic, e: 'event', id: sessionId, op: 'append', v: [...events] }] }], seq);
    },
    pushRaw(ops) {
      seq += 1;
      send([{ t: 'patch', seq, ops: [...ops] }], seq);
    },
  };
}
