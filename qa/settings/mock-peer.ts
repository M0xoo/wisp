// A peer in memory for the Settings panes: their unit tests and the dev harness (qa/settings), until
// the shell's mock peer (apps/web/dev/mock-peer.ts) and then the Rust `wisp` serve them. It speaks the
// sync protocol through a Transport: a welcome, a snapshot per topic asked for, and for each mutate
// the handler's ops as a patch, then the ack (or a reject), after `delayMs` so the optimistic patch
// shows first, as it does in the app.
//
// Every pane package seeds it from `test/fixtures.ts`: `seed` (rows) and `handle` (its commands).
// `settings.set` is answered here for every package: it upserts the `setting` row, and refuses a
// locked one the way the server does.

import { createClient, entityKey, memoryHistory, peerId, type Client, type Frame, type PeerId, type PluginClient, type Transport } from '@wisp/client';
import { applyPatch, type ClientMessage, type EntityOp, type PeerInfo, type ServerMessage, type Topic } from '@wisp/protocol';

export interface SeedRow {
  readonly topic: Topic;
  readonly e: string;
  readonly id: string;
  readonly v: unknown;
}

export type Rows = ReadonlyMap<string, SeedRow>;
export type Answer = { ops?: EntityOp[]; result?: unknown } | { error: { code: string; message: string } };
/** What a command does on the peer; `undefined`: not this plugin's command. */
export type Handler = (cmd: string, args: unknown, rows: Rows) => Answer | undefined;

export interface MemoryPeer extends Transport {
  /** a change the peer makes on its own (a run finished, a window reset) */
  push(ops: EntityOp[]): void;
  readonly posted: ClientMessage[];
  readonly rows: Rows;
}

export const rowKey = (e: string, id: string): string => `${e}\u0000${id}`;
export const rowOf = <T>(rows: Rows, e: string, id: string): T | undefined => rows.get(rowKey(e, id))?.v as T | undefined;
export const rowsOf = <T>(rows: Rows, e: string): T[] => [...rows.values()].filter((r) => r.e === e).map((r) => r.v as T);
export const upsert = (topic: Topic, e: string, id: string, v: unknown): EntityOp => ({ topic, e, id, op: 'upsert', v });
export const del = (topic: Topic, e: string, id: string): EntityOp => ({ topic, e, id, op: 'del' });
export const refuse = (code: string, message: string): Answer => ({ error: { code, message } });

function apply(rows: Map<string, SeedRow>, op: EntityOp): void {
  const k = rowKey(op.e, op.id);
  const cur = rows.get(k);
  if (op.op === 'upsert') rows.set(k, { topic: op.topic, e: op.e, id: op.id, v: op.v });
  else if (op.op === 'del') rows.delete(k);
  else if (op.op === 'append') rows.set(k, { topic: op.topic, e: op.e, id: op.id, v: [...((cur?.v as unknown[] | undefined) ?? []), ...op.v] });
  else if (cur) rows.set(k, { ...cur, v: applyPatch(cur.v, op.ops) });
}

/** `settings.set`, for every package: the server's rules (a locked setting refuses). */
export const settingsHandler: Handler = (cmd, args, rows) => {
  if (cmd !== 'settings.set') return undefined;
  const a = args as { key: string; value: unknown };
  const cur = rowOf<{ key: string; value: unknown; locked_by?: string | null }>(rows, 'setting', a.key);
  if (cur?.locked_by) return refuse('forbidden', `${a.key} is set by ${cur.locked_by}`);
  return { ops: [upsert('config', 'setting', a.key, { ...cur, key: a.key, value: a.value })] };
};

/** Several packages' handlers as one: the first that knows the command answers. */
export function handlers(...hs: readonly Handler[]): Handler {
  return (cmd, args, rows) => {
    for (const h of hs) {
      const a = h(cmd, args, rows);
      if (a) return a;
    }
    return refuse('not_found', `no command ${cmd}`);
  };
}

export const HOME = peerId('mac');

export const PEER_INFO: PeerInfo = { peer: HOME, name: 'This Mac', build: 'dev', version: '2.0.0', proto_min: 2, proto_max: 2, plugins: [] };

// size-ok: a factory; small closures over the connection's state
export function memoryPeer(seed: readonly SeedRow[], handle: Handler, delayMs = 0, info: PeerInfo = PEER_INFO): MemoryPeer {
  const rows = new Map(seed.map((r) => [rowKey(r.e, r.id), r]));
  const posted: ClientMessage[] = [];
  const subs = new Set<Topic>();
  const state = { seq: 1, send: undefined as ((f: Frame) => void) | undefined };
  const later = (fn: () => void): void => {
    if (delayMs <= 0) queueMicrotask(fn);
    else globalThis.setTimeout(fn, delayMs);
  };
  const snapshot = (topic: Topic): ServerMessage => ({ t: 'snapshot', topic, seq: state.seq, rows: [...rows.values()].filter((r) => r.topic === topic).map(({ e, id, v }) => ({ e, id, v })) });
  const patch = (ops: EntityOp[]): void => {
    for (const op of ops) apply(rows, op);
    state.seq += 1;
    const live = ops.filter((o) => subs.has(o.topic));
    if (live.length > 0) state.send?.({ id: state.seq, messages: [{ t: 'patch', seq: state.seq, ops: live }] });
  };
  return {
    kind: 'memory',
    posted,
    rows,
    push: patch,
    connect(params, signal) {
      const queue: Frame[] = [];
      const wake = { fn: undefined as (() => void) | undefined };
      state.send = (f) => {
        queue.push(f);
        wake.fn?.();
      };
      const asked = [...(params['topics'] ?? '').split(','), ...(params['fresh'] ?? '').split(',')].filter(Boolean) as Topic[];
      for (const t of asked) subs.add(t);
      state.send({ id: state.seq, messages: [{ t: 'welcome', epoch: 'dev', head_seq: state.seq, oldest_seq: 0, resume: false, proto: 2, peer: info }, ...asked.map(snapshot)] });
      return {
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            const f = queue.shift();
            if (f) yield f;
            else
              await new Promise<void>((r) => {
                wake.fn = r;
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
        state.send?.({ id: state.seq, messages: [snapshot(m.topic)] });
      } else if (m.t === 'unsub') subs.delete(m.topic);
      else if (m.t === 'mutate') {
        later(() => {
          const out = handle(m.cmd, m.args, rows) ?? refuse('not_found', `no command ${m.cmd}`);
          if ('error' in out) {
            state.send?.({ id: null, messages: [{ t: 'reject', mid: m.mid, ...out.error }] });
            return;
          }
          patch(out.ops ?? []);
          state.send?.({ id: null, messages: [{ t: 'ack', mid: m.mid, seq: state.seq, result: out.result }] });
        });
      }
    },
  };
}

/** One setting row as the config topic carries it: every declared key, with its value or default. */
export const setting = (key: string, value: unknown, lockedBy?: string): SeedRow => ({ topic: 'config', e: 'setting', id: key, v: { key, value, ...(lockedBy !== undefined && { locked_by: lockedBy }) } });

export interface TestClient {
  readonly client: Client;
  readonly plugin: PluginClient;
  readonly peer: MemoryPeer;
  readonly home: PeerId;
  readonly errors: { code: string; message: string; cmd: string }[];
  /** lets the stream and the command answers run */
  settle(): Promise<void>;
  dispose(): void;
}

/** A client on a memory peer, watching `topics`, with `pluginId`'s client: what a pane gets. */
export async function testClient(o: { seed: readonly SeedRow[]; handle?: Handler; topics: readonly Topic[]; pluginId: string; delayMs?: number; catalogue?: Readonly<Record<string, string>> }): Promise<TestClient> {
  const peer = memoryPeer(o.seed, handlers(settingsHandler, ...(o.handle ? [o.handle] : [])), o.delayMs ?? 0);
  const errors: TestClient['errors'] = [];
  const client = createClient({ clientId: 'test', build: 'dev', home: HOME, width: 1440, history: memoryHistory(), onError: (e, cmd) => errors.push({ code: e.code, message: e.message, cmd }) });
  const plugin = client.plugin(o.pluginId);
  if (o.catalogue) plugin.strings(o.catalogue);
  await client.start([{ peer: HOME, name: 'This Mac', transport: peer }]);
  for (const t of new Set<Topic>(['config', ...o.topics])) client.peers.watch(HOME, t, client.scope);
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await new Promise((r) => globalThis.setTimeout(r, Math.max(1, o.delayMs ?? 0)));
  };
  await settle();
  return { client, plugin, peer, home: HOME, errors, settle, dispose: () => client.dispose() };
}

/** The entity key of a row of the home peer, for `client.entities.row(e, key)`. */
export const homeKey = (id: string) => entityKey(HOME, id);
