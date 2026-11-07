// A peer in memory for this plugin's dev page and tests, until the shell's mock peer
// (apps/web/dev/mock-peer.ts) serves every plugin. It speaks the sync protocol through a Transport:
// a welcome, a snapshot per topic asked for, and for each mutate the handler's ops as a patch and
// then the ack (or a reject). Seeded rows are { topic, e, id, v }.

import type { Frame, Transport } from '@wisp/client';
import type { ClientMessage, EntityOp, PeerInfo, ServerMessage, Topic } from '@wisp/protocol';

export interface SeedRow {
  readonly topic: Topic;
  readonly e: string;
  readonly id: string;
  readonly v: unknown;
}

/** What a command does on the peer: rows to change, an answer, or a refusal. */
export type Handler = (cmd: string, args: unknown, rows: ReadonlyMap<string, SeedRow>) => { ops?: EntityOp[]; result?: unknown } | { error: { code: string; message: string } };

export interface MemoryPeer extends Transport {
  /** what the dev page or a test pushes on its own (a row the peer changed) */
  push(ops: EntityOp[]): void;
  readonly posted: ClientMessage[];
  readonly rows: ReadonlyMap<string, SeedRow>;
}

const keyOf = (e: string, id: string): string => `${e}\u0000${id}`;

function apply(rows: Map<string, SeedRow>, op: EntityOp): void {
  const k = keyOf(op.e, op.id);
  const cur = rows.get(k);
  if (op.op === 'upsert') rows.set(k, { topic: op.topic, e: op.e, id: op.id, v: op.v });
  else if (op.op === 'del') rows.delete(k);
  else if (op.op === 'append') rows.set(k, { topic: op.topic, e: op.e, id: op.id, v: [...((cur?.v as unknown[] | undefined) ?? []), ...op.v] });
  // patches: the dev peer keeps upserts only; a handler that patches also sends the upsert it means
}

// size-ok: a factory; small closures over the connection's state
export function memoryPeer(info: PeerInfo, seed: readonly SeedRow[], handle: Handler, delayMs = 0): MemoryPeer {
  const rows = new Map(seed.map((r) => [keyOf(r.e, r.id), r]));
  const posted: ClientMessage[] = [];
  let seq = 1;
  let send: ((f: Frame) => void) | undefined;
  const subs = new Set<Topic>();
  // a real peer answers later: the optimistic patch shows first, the way it does in the app
  const later = (fn: () => void): void => void globalThis.setTimeout(fn, delayMs);
  const snapshot = (topic: Topic): ServerMessage => ({ t: 'snapshot', topic, seq, rows: [...rows.values()].filter((r) => r.topic === topic).map(({ e, id, v }) => ({ e, id, v })) });
  const patch = (ops: EntityOp[]): void => {
    for (const op of ops) apply(rows, op);
    seq += 1;
    send?.({ id: seq, messages: [{ t: 'patch', seq, ops: ops.filter((o) => subs.has(o.topic)) }] });
  };
  return {
    kind: 'memory',
    posted,
    rows,
    push: patch,
    connect(params, signal) {
      const queue: Frame[] = [];
      let wake: (() => void) | undefined;
      send = (f) => {
        queue.push(f);
        wake?.();
      };
      for (const t of (params['topics'] ?? '').split(',').filter(Boolean)) subs.add(t as Topic);
      send({ id: seq, messages: [{ t: 'welcome', epoch: 'dev', head_seq: seq, oldest_seq: 0, resume: false, proto: 2, peer: info }, ...[...subs].map(snapshot)] });
      return {
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            const f = queue.shift();
            if (f) yield f;
            else await new Promise<void>((r) => {
              wake = r;
              signal.addEventListener('abort', () => r(), { once: true });
            });
          }
        },
      };
    },
    async post(m) {
      posted.push(m);
      if (m.t === 'sub') {
        subs.add(m.topic);
        send?.({ id: seq, messages: [snapshot(m.topic)] });
      } else if (m.t === 'unsub') subs.delete(m.topic);
      else if (m.t === 'mutate') {
        later(() => {
          const out = handle(m.cmd, m.args, rows);
          if ('error' in out) return send?.({ id: null, messages: [{ t: 'reject', mid: m.mid, ...out.error }] });
          patch(out.ops ?? []);
          send?.({ id: null, messages: [{ t: 'ack', mid: m.mid, seq, result: out.result }] });
        });
      }
    },
  };
}
