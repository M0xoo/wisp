// An in-memory wisp for building screens before (and beside) the Rust one: it speaks the sync
// protocol (ADR-0005, packages/protocol) the way crates/wisp-sync does, over any carrier.
//
//   connect(params)   the hello as GET /api/events query parameters → welcome, then a snapshot per
//                     topic the hello named (resumed or fresh: always answered whole, which the
//                     protocol allows), each frame with `id` = the head seq (the cursor watermark)
//   receive(msg)      sub → snapshot · unsub · window → rows (older events) · mutate → the command
//                     runs, its ops go out as one patch to every connection holding a topic, and the
//                     caller gets the ack (or a reject) in the same frame, after the ops
//   stream(id)        a turn that streams: tool calls, then text one token every `everyMs`, then the
//                     answer's presentation; the list row's `live` and `updated_at` follow along
//
// Rows follow the Rust store (plugins/runtime/host/src/schema.rs): `session` rows on `list` and
// `session:<id>`, `turn` rows and one `event` list row per session on `session:<id>`, `setting`
// on `config`, `crew.member` on `crew`, `machine` on `machines`, `stuff` on `stuff`.
// Commands live in mock-commands.ts; add yours there. Pure: no node:, no DOM, timers injected.

import { PROTO, PROTO_MIN, applyPatch, type ClientMessage, type EntityOp, type PatchOp, type PeerInfo, type ServerMessage, type Topic } from '@wisp/protocol';
import { COMMANDS, type CommandCtx, type CommandFn } from './mock-commands.ts';
import { fromV1, seed, type Seeded, type V1Seed } from './seed.ts';

export interface MockFrame {
  readonly id: number | null;
  readonly messages: readonly ServerMessage[];
}

export interface MockTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  now(): number;
}

export interface MockPeerOptions {
  peer?: string;
  name?: string;
  /** extra sessions on top of the hand-written ones (a 5k list for perf) */
  sessions?: number;
  timers?: MockTimers;
  /** a fixed epoch makes resumes testable; default: one per process */
  epoch?: string;
  /** v1's reference data (design/v1-reference/seed.json): replayed instead of the hand-written seed */
  v1?: V1Seed;
}

interface Row {
  e: string;
  id: string;
  v: unknown;
}

interface Conn {
  readonly clientId: string;
  readonly topics: Set<Topic>;
  readonly send: (f: MockFrame) => void;
}

export interface MockPeer {
  readonly info: PeerInfo;
  readonly peer: string;
  connect(params: Readonly<Record<string, string>>, send: (f: MockFrame) => void): { clientId: string; close(): void };
  receive(clientId: string, msg: ClientMessage): void;
  /** streams a new turn into a session (the first running one by default); returns its id */
  stream(sessionId?: string, o?: { tokens?: number; everyMs?: number }): string | undefined;
  /** the next run of `cmd` is refused: to see a rollback and its toast */
  failNext(cmd: string, message?: string): void;
  handle(cmd: string, fn: CommandFn): void;
  rows(topic: Topic): readonly Row[];
  readonly headSeq: number;
}

const realTimers: MockTimers = { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (h) => globalThis.clearTimeout(h as number), now: () => Date.now() };

const rowKey = (e: string, id: string): string => `${e}\u0000${id}`;

// size-ok: the peer's state and its protocol handlers share these maps; each handler is short
export function createMockPeer(o: MockPeerOptions = {}): MockPeer {
  const timers = o.timers ?? realTimers;
  const peer = o.peer ?? 'local';
  const epoch = o.epoch ?? `mock-${timers.now().toString(36)}`;
  const data: Seeded = o.v1 ? fromV1(o.v1, peer) : seed({ peer, now: timers.now(), extra: o.sessions ?? 0 });
  const store = new Map<Topic, Map<string, Row>>();
  const conns = new Map<string, Conn>();
  const handlers = new Map<string, CommandFn>(Object.entries(COMMANDS));
  const failing = new Map<string, string>();
  let seq = 1;
  let connCount = 0;

  for (const [topic, rows] of data.topics) store.set(topic, new Map(rows.map((r) => [rowKey(r.e, r.id), r])));

  const info: PeerInfo = {
    peer,
    name: o.name ?? 'This Mac (mock)',
    build: 'mock',
    version: '2.0.0-mock',
    proto_min: PROTO_MIN,
    proto_max: PROTO,
    plugins: data.plugins,
  };

  const topicRows = (t: Topic): Row[] => [...(store.get(t)?.values() ?? [])];
  const snapshot = (t: Topic): ServerMessage => ({ t: 'snapshot', topic: t, seq, rows: topicRows(t) });

  /** applies ops to the store; returns those that applied (a patch on a missing row is dropped) */
  function apply(ops: readonly EntityOp[]): EntityOp[] {
    const done: EntityOp[] = [];
    for (const op of ops) {
      let rows = store.get(op.topic);
      if (!rows) store.set(op.topic, (rows = new Map()));
      const k = rowKey(op.e, op.id);
      const cur = rows.get(k);
      if (op.op === 'upsert') rows.set(k, { e: op.e, id: op.id, v: op.v });
      else if (op.op === 'del') rows.delete(k);
      else if (op.op === 'append') rows.set(k, { e: op.e, id: op.id, v: [...((cur?.v as unknown[] | undefined) ?? []), ...op.v] });
      else if (cur) rows.set(k, { e: op.e, id: op.id, v: applyPatch(cur.v, op.ops) });
      else continue;
      done.push(op);
    }
    return done;
  }

  /** one commit: ops to every connection that holds one of their topics, `extra` to the caller */
  function commit(ops: readonly EntityOp[], caller?: { clientId: string; messages: ServerMessage[] }): number {
    const applied = apply(ops);
    if (applied.length > 0) seq += 1;
    for (const c of conns.values()) {
      const mine = applied.filter((op) => c.topics.has(op.topic));
      const messages: ServerMessage[] = mine.length > 0 ? [{ t: 'patch', seq, ops: mine }] : [];
      if (caller && caller.clientId === c.clientId) messages.push(...caller.messages.map((m) => (m.t === 'ack' ? { ...m, seq } : m)));
      if (messages.length > 0) c.send({ id: seq, messages });
    }
    return seq;
  }

  const ctx: CommandCtx = {
    peer,
    now: () => timers.now(),
    row: (topic, e, id) => store.get(topic)?.get(rowKey(e, id))?.v,
    rows: (topic) => topicRows(topic),
    stream: (id) => api.stream(id),
    later: (ms, fn) => void timers.setTimeout(() => commit(fn()), ms),
  };

  function mutate(c: Conn, m: Extract<ClientMessage, { t: 'mutate' }>): void {
    const fail = failing.get(m.cmd);
    const fn = handlers.get(m.cmd);
    if (fail !== undefined || !fn) {
      failing.delete(m.cmd);
      const message = fail ?? `the mock peer has no ${m.cmd}: add it to apps/web/dev/mock-commands.ts`;
      c.send({ id: null, messages: [{ t: 'reject', mid: m.mid, code: fail === undefined ? 'unknown_command' : 'refused', message }] });
      return;
    }
    try {
      const out = fn(m.args, ctx);
      commit(out.ops, { clientId: c.clientId, messages: [{ t: 'ack', mid: m.mid, seq: 0, ...(out.result !== undefined && { result: out.result }) }] });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      c.send({ id: null, messages: [{ t: 'reject', mid: m.mid, code: e.code ?? 'invalid', message: e.message ?? String(err) }] });
    }
  }

  function windowRows(c: Conn, w: Extract<ClientMessage, { t: 'window' }>): void {
    const sid = w.topic.startsWith('session:') ? w.topic.slice('session:'.length) : '';
    const list = (store.get(w.topic)?.get(rowKey('event', sid))?.v as { seq: number }[] | undefined) ?? [];
    const older = list.filter((e) => e.seq < w.before_seq);
    const page = older.slice(-w.limit);
    c.send({ id: null, messages: [{ t: 'rows', req: w.req, rows: [{ e: 'event', id: sid, v: page }], done: page.length < w.limit }] });
  }

  const api: MockPeer = {
    info,
    peer,
    get headSeq() {
      return seq;
    },
    connect(params, send) {
      connCount += 1;
      const clientId = params['client_id'] || `conn-${connCount}`;
      const topics = new Set<Topic>([...(params['topics'] ?? '').split(','), ...(params['fresh'] ?? '').split(',')].filter((t): t is Topic => t !== ''));
      const c: Conn = { clientId, topics, send };
      conns.get(clientId) && conns.delete(clientId);
      conns.set(clientId, c);
      const resume = params['epoch'] === epoch && params['cursor'] !== undefined;
      send({ id: seq, messages: [{ t: 'welcome', epoch, head_seq: seq, oldest_seq: 0, resume, proto: PROTO, peer: info }, ...[...topics].map(snapshot)] });
      return {
        clientId,
        close: () => {
          if (conns.get(clientId) === c) conns.delete(clientId);
        },
      };
    },
    receive(clientId, msg) {
      const c = conns.get(clientId);
      if (!c) return;
      switch (msg.t) {
        case 'sub':
          c.topics.add(msg.topic);
          return c.send({ id: seq, messages: [snapshot(msg.topic)] });
        case 'unsub':
          c.topics.delete(msg.topic);
          return;
        case 'window':
          return windowRows(c, msg);
        case 'mutate':
          return mutate(c, msg);
        case 'hello':
          return;
      }
    },
    stream(sessionId, so = {}) {
      const id = sessionId ?? topicRows('list').find((r) => (r.v as { state?: string }).state === 'running')?.id ?? topicRows('list')[0]?.id;
      if (!id) return undefined;
      runStream(id, so.tokens ?? 120, so.everyMs ?? 16);
      return id;
    },
    failNext(cmd, message = `${cmd} was refused (the mock was asked to)`) {
      failing.set(cmd, message);
    },
    handle(cmd, fn) {
      handlers.set(cmd, fn);
    },
    rows: (t) => topicRows(t),
  };

  /** A turn that streams: a tool call, the answer token by token, then done with a presentation. */
  function runStream(sid: string, tokens: number, everyMs: number): void {
    const topic: Topic = `session:${sid}`;
    const turns = topicRows(topic).filter((r) => r.e === 'turn');
    const turnId = `${sid}:t${turns.length + 1}`;
    const words = data.words;
    const events = (): { seq: number }[] => (store.get(topic)?.get(rowKey('event', sid))?.v as { seq: number }[] | undefined) ?? [];
    const nextSeq = (): number => (events().at(-1)?.seq ?? 0) + 1;
    const now = timers.now();
    const listOps = (patch: PatchOp[]): EntityOp[] => (['list', topic] as Topic[]).map((t) => ({ topic: t, e: 'session', id: sid, op: 'patch', ops: patch }));
    commit([
      { topic, e: 'turn', id: turnId, op: 'upsert', v: data.turn(sid, turnId, turns.length, 'Keep going: and make the empty state say what to do next.', now) },
      { topic, e: 'event', id: sid, op: 'append', v: [{ session_id: sid, seq: nextSeq(), turn_id: turnId, t: now, kind: 'tool', body: { kind: 'tool', tool: 'read', label: 'Read src/list.ts' } }] },
      { topic, e: 'event', id: sid, op: 'append', v: [{ session_id: sid, seq: nextSeq() + 1, turn_id: turnId, t: now, kind: 'text', body: { kind: 'text', text: '' } }] },
      ...listOps([{ op: 'replace', path: '/state', value: 'running' }, { op: 'replace', path: '/summary/status', value: 'running' }, { op: 'replace', path: '/summary/live', value: 'Reading src/list.ts' }]),
    ]);
    let text = '';
    let n = 0;
    const tick = (): void => {
      const at = events().length - 1;
      text += `${words[n % words.length] ?? 'and'} `;
      n += 1;
      const ops: EntityOp[] = [{ topic, e: 'event', id: sid, op: 'patch', ops: [{ op: 'replace', path: `/${at}/body/text`, value: text }] }];
      if (n % 20 === 0) ops.push(...listOps([{ op: 'replace', path: '/summary/live', value: `Writing… ${n} words` }, { op: 'replace', path: '/updated_at', value: timers.now() }]));
      if (n < tokens) {
        commit(ops);
        timers.setTimeout(tick, everyMs);
        return;
      }
      commit([
        ...ops,
        { topic, e: 'turn', id: turnId, op: 'patch', ops: [{ op: 'replace', path: '/status', value: 'done' }, { op: 'replace', path: '/answer', value: text.trim() }, { op: 'replace', path: '/body/presentation', value: data.presentation() }] },
        ...listOps([{ op: 'replace', path: '/state', value: 'review' }, { op: 'replace', path: '/summary/status', value: 'done' }, { op: 'replace', path: '/summary/live', value: '' }, { op: 'replace', path: '/summary/preview', value: text.slice(0, 80).trim() }, { op: 'replace', path: '/updated_at', value: timers.now() }]),
      ]);
    };
    timers.setTimeout(tick, everyMs);
  }

  return api;
}
