// The sync endpoints (ADR-0005, plan §4.3): @wisp/sync's SyncServer mounted on node:http.
//   GET  /api/events?topics&cursor   the v2 stream (any of the hello's query keys is present)
//   GET  /api/events                 a v1 client: the v1 events (hello, summary, turn, …, ping)
//   POST /api/events                 sub, unsub, window, mutate for an open v2 stream
//   POST /api/cmd                    a command by Idempotency-Key, outside any stream
// The store's onCommit feeds both: v2 gets the change rows, v1 gets what server.legacy makes of them.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Json } from '@wisp/kernel';
import type { CommandResponse, Notice, PeerInfo, Topic } from '@wisp/protocol';
import type { ChangeRow as StoreChange, Store } from '@wisp/store';
import { SyncServer, type ChangeRow, type CommandOutcome } from '@wisp/sync';
import { NodeSync, command as httpCommand, type HostOutput } from '@wisp/sync/node';
import type { LegacyPart, TopicPart, TopicRow } from '@wisp-plugin/server-api';
import type { Caller } from './auth.ts';

const HELLO_KEYS = ['proto_min', 'proto_max', 'client_id', 'build', 'epoch', 'cursor', 'topics', 'fresh', 'passive'];
const PING_MS = 25_000;
/** mutation ids remembered for a retry over a flaky tunnel (the store's mutation table needs a sync tx) */
const MIDS_KEPT = 10_000;

export interface SyncDeps {
  store: Store;
  peer: () => PeerInfo;
  /** may this caller read this topic? (topic:read{topic:<t>}) */
  canRead(caller: Caller, topic: string): boolean;
  /** run a kernel command for a caller; throws a {code, message} on refusal */
  run(cmd: string, args: unknown, caller: Caller): Promise<unknown>;
  topics: () => readonly TopicPart[];
  legacy: () => readonly LegacyPart[];
  glob(pattern: string, value: string): boolean;
}

/** v1's plain event stream: every open one gets every broadcast. */
class LegacyStream {
  readonly clients = new Set<ServerResponse & { relay?: boolean }>();
  attach(req: IncomingMessage, res: ServerResponse & { relay?: boolean }): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('event: hello\ndata: {}\n\n');
    // another wisp relaying this one's events doesn't count as someone looking (GET /api/status clients)
    res.relay = req.headers['x-wisp-relay'] === '1';
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }
  /** fromMachine: relayed from a machine; not sent on to another wisp (two that list each other loop) */
  broadcast(event: string, data: unknown, fromMachine = false): void {
    if (!this.clients.size) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) if (!(fromMachine && res.relay)) res.write(frame);
  }
  looking(): number {
    let n = 0;
    for (const r of this.clients) if (!r.relay) n++;
    return n;
  }
  close(): void {
    for (const r of this.clients) r.end();
    this.clients.clear();
  }
}

export class SyncEdge {
  readonly legacy = new LegacyStream();
  readonly server: SyncServer<Caller>;
  readonly node: NodeSync<Caller>;
  readonly #d: SyncDeps;
  readonly #mids = new Map<string, CommandResponse>();
  #ping: ReturnType<typeof setInterval> | undefined;

  constructor(d: SyncDeps) {
    this.#d = d;
    this.server = new SyncServer<Caller>({ epoch: d.store.epoch, peer: d.peer(), headSeq: d.store.headSeq(), oldestSeq: d.store.oldestSeq(), canRead: (c, t) => d.canRead(c, t) });
    this.node = new NodeSync<Caller>({ sync: this.server, onOutput: (o) => void this.#output(o), sameCaller: (a, b) => a.set === b.set && a.session === b.session });
    this.#ping = setInterval(() => this.legacy.broadcast('ping', {}), PING_MS);
    this.#ping.unref();
  }

  /** The store committed: v2 streams get the rows (one per topic), v1 streams the v1 events. */
  committed(changes: readonly StoreChange[]): void {
    const rows: ChangeRow[] = [];
    for (const c of changes) for (const topic of c.topics) rows.push({ seq: c.seq, topic, entity: c.entity, id: c.id, op: c.op, patch: c.patch, at: c.at });
    if (rows.length) this.node.input({ kind: 'committed', rows });
    if (this.legacy.clients.size) this.#legacyEvents(changes);
  }

  #legacyEvents(changes: readonly StoreChange[]): void {
    const parts = this.#d.legacy();
    for (const c of changes) {
      const row = c.op === 'del' ? undefined : (this.#d.store.get(c.entity, c.id) as Record<string, unknown> | undefined);
      for (const p of parts) {
        if (!p.entities.includes(c.entity)) continue;
        for (const ev of p.events({ entity: c.entity, id: c.id, op: c.op, row })) this.legacy.broadcast(ev.event, ev.data);
      }
    }
  }

  /** A notice: a `notice` frame for v2, an event of that name for v1 (toast, finished, reminder, …). */
  notice(kind: string, data: Json, topic?: string): void {
    const notice: Notice = { t: 'notice', kind, data };
    // a topic name comes from a plugin; the protocol's Topic union is checked where topics are made
    this.node.input(topic === undefined ? { kind: 'notice', notice } : { kind: 'notice', notice, topic: topic as Topic });
    this.legacy.broadcast(kind, data);
  }

  events(req: IncomingMessage, res: ServerResponse, caller: Caller): void {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    if (HELLO_KEYS.some((k) => q.has(k))) this.node.events(req, res, caller);
    else this.legacy.attach(req, res);
  }

  message(req: IncomingMessage, res: ServerResponse, caller: Caller): Promise<void> {
    return this.node.message(req, res, caller);
  }

  cmd(req: IncomingMessage, res: ServerResponse, caller: Caller): Promise<void> {
    return httpCommand(req, res, caller, (cmd, args, call) => this.#once(`${caller.set}|${caller.session ?? ''}|${call.mid}`, () => this.#command(cmd, args, caller)));
  }

  /** clients looking: v2 streams with a non-passive topic, v1 streams that aren't relays */
  looking(): number {
    return this.server.activeCount() + this.legacy.looking();
  }

  async #once(key: string, fn: () => Promise<CommandResponse>): Promise<CommandResponse> {
    const had = this.#mids.get(key);
    if (had) return had;
    const out = await fn();
    this.#mids.set(key, out);
    if (this.#mids.size > MIDS_KEPT) this.#mids.delete(this.#mids.keys().next().value ?? key);
    return out;
  }

  async #command(cmd: string, args: unknown, caller: Caller): Promise<CommandResponse> {
    try {
      const result = await this.#d.run(cmd, args, caller);
      return { ok: true, seq: this.#d.store.headSeq(), ...(result !== undefined && { result }) } as CommandResponse;
    } catch (err) {
      const e = (typeof err === 'object' && err !== null ? err : {}) as { code?: unknown; message?: unknown; retry?: unknown };
      return { ok: false, error: { code: typeof e.code === 'string' ? e.code : 'internal', message: typeof e.message === 'string' ? e.message : String(err), retry: e.retry === true } } as CommandResponse;
    }
  }

  async #output(o: HostOutput<Caller>): Promise<void> {
    if (o.kind === 'snapshotRequest') {
      const { rows, full, deleted } = this.#snapshot(o.topic, o.since);
      this.node.input({ kind: 'snapshotRows', conn: o.conn, topic: o.topic, req: o.req, seq: this.#d.store.headSeq(), rows, full, ...(deleted && { deleted }) });
    } else if (o.kind === 'windowRequest') {
      const rows = this.#d.store.changesSince(Math.max(0, o.beforeSeq - o.limit - 1), [o.topic], o.limit).filter((c) => c.seq < o.beforeSeq);
      this.node.input({ kind: 'windowRows', conn: o.conn, req: o.req, rows: rows.map((c) => ({ e: c.entity, id: c.id, v: c.patch })), done: true });
    } else if (o.kind === 'command') {
      const r = await this.#once(`${o.caller.set}|${o.caller.session ?? ''}|${o.mid}`, () => this.#command(o.cmd, o.args, o.caller));
      const outcome: CommandOutcome = r.ok ? { ok: true, seq: r.seq, ...(r.result !== undefined && { result: r.result }) } : { ok: false, code: r.error.code, message: r.error.message };
      this.node.input({ kind: 'commandResult', conn: o.conn, mid: o.mid, outcome });
    }
    // 'activity': looking() reads the server's count when /api/status asks
  }

  /** A delta from the change feed when it still holds `since`; else the owner's full read. */
  #snapshot(topic: string, since: number | null): { rows: TopicRow[]; full: boolean; deleted?: { e: string; id: string }[] } {
    const store = this.#d.store;
    if (since !== null && store.canResume(since)) {
      const changed = new Map<string, { e: string; id: string }>();
      for (const c of store.changesSince(since, [topic as Topic], 100_000)) changed.set(`${c.entity}\0${c.id}`, { e: c.entity, id: c.id });
      const rows: TopicRow[] = [];
      const deleted: { e: string; id: string }[] = [];
      for (const { e, id } of changed.values()) {
        const v = store.get(e, id);
        if (v === undefined) deleted.push({ e, id });
        else rows.push({ e, id, v });
      }
      return { rows, full: false, deleted };
    }
    const part = this.#d.topics().find((p) => this.#d.glob(p.match, topic));
    return { rows: part ? [...part.rows(topic)] : [], full: true };
  }

  close(): void {
    if (this.#ping) clearInterval(this.#ping);
    this.node.close();
    this.legacy.close();
  }
}
