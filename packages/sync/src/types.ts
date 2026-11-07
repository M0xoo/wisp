// Inputs and outputs of the sans-IO sync machines (plan §3.1 rule 3). A machine never reads the
// clock or a socket: the host feeds it `handle(input, now)` and carries out what it returns.

import type { ClientMessage, EntityOp, Notice, PeerInfo, ServerMessage, Topic } from '@wisp/protocol';

export type ConnId = string;

/** One row of the store's `change` feed, as `onCommit` reports it (plan §4.1). */
export interface ChangeRow {
  seq: number;
  topic: Topic;
  entity: string;
  id: string;
  op: EntityOp['op'];
  /** upsert: the value · patch: the RFC 6902 ops · append: the items · del: unused */
  patch: unknown;
  at: number;
}

/** A row as a snapshot or a window carries it. */
export interface Row {
  e: string;
  id: string;
  v: unknown;
}

/** What `GET /api/events` carried: the hello, flattened into query parameters. */
export interface ConnectQuery {
  proto_min?: string;
  proto_max?: string;
  client_id?: string;
  build?: string;
  epoch?: string;
  /** the client's cursor; Last-Event-ID is used when this is missing */
  cursor?: string;
  last_event_id?: string;
  /** comma-separated topics the client holds as of `cursor`: resumed from it */
  topics?: string;
  /** comma-separated topics the client has no rows for yet: always a full snapshot */
  fresh?: string;
  /** '1': every topic of this hello is passive (plan §7.2.3); else a comma-separated list of them */
  passive?: string;
}

/** The host's answer to a snapshotRequest. */
export interface SnapshotAnswer {
  conn: ConnId;
  topic: Topic;
  /** the snapshotRequest's `req`: an answer to a request since replaced is ignored */
  req: number;
  /** the head seq the rows were read at */
  seq: number;
  rows: Row[];
  /**
   * true: `rows` is the whole topic (the client replaces its set). false: only the rows changed
   * since the request's `since`, with `deleted` for those gone. A since-request may be answered
   * full (the host's call, e.g. when the delta would be larger), a full request never as a delta.
   * It must be answered full when retention has dropped changes after `since` since it was asked.
   */
  full: boolean;
  deleted?: { e: string; id: string }[];
  /** more pages of the same snapshot follow, at the same seq */
  more?: boolean;
}

export type CommandOutcome =
  | { ok: true; seq: number; result?: unknown }
  | { ok: false; code: string; message: string };

export type ServerInput<C = unknown> =
  | { kind: 'connect'; conn: ConnId; caller: C; query: ConnectQuery }
  | { kind: 'message'; conn: ConnId; message: unknown }
  | { kind: 'committed'; rows: readonly ChangeRow[] }
  | ({ kind: 'snapshotRows' } & SnapshotAnswer)
  | { kind: 'windowRows'; conn: ConnId; req: string; rows: Row[]; done: boolean }
  | { kind: 'commandResult'; conn: ConnId; mid: string; outcome: CommandOutcome }
  | { kind: 'notice'; notice: Notice; topic?: Topic }
  | { kind: 'retained'; oldestSeq: number }
  | { kind: 'tick' }
  | { kind: 'drained'; conn: ConnId; bufferedBytes: number }
  | { kind: 'close'; conn: ConnId };

export type ServerOutput<C = unknown> =
  /** write `frame` to the connection as is: one SSE event (or a heartbeat comment) */
  | { kind: 'send'; conn: ConnId; frame: string; messages: ServerMessage[]; id: number | null }
  /** read `topic` and answer with snapshotRows: since=null is a full snapshot, else a delta */
  | { kind: 'snapshotRequest'; conn: ConnId; topic: Topic; since: number | null; req: number }
  | { kind: 'windowRequest'; conn: ConnId; req: string; topic: Topic; beforeSeq: number; limit: number }
  /** run it (idempotent by mid) and answer with commandResult */
  | { kind: 'command'; conn: ConnId; caller: C; mid: string; cmd: string; args: unknown; baseSeq?: number }
  /** the connection started or stopped counting as use of this box (any non-passive sub) */
  | { kind: 'activity'; conn: ConnId; active: boolean }
  | { kind: 'closeConn'; conn: ConnId; reason: string };

export interface SyncServerOptions<C> {
  epoch: string;
  peer: PeerInfo;
  headSeq: number;
  /** the lowest cursor that can still resume: every change with seq > oldestSeq is kept */
  oldestSeq: number;
  canRead(caller: C, topic: Topic): boolean;
  flushMs?: number; // 50
  highWaterBytes?: number; // ~1 MB
  heartbeatMs?: number; // 15 s
  /** a loading topic buffers live changes up to this; past it the snapshot is asked again */
  loadBufferBytes?: number;
}

export type Update = 'peer' | 'client';

export type ClientOutput =
  /** open `GET /api/events` with these query parameters */
  | { kind: 'request'; params: Record<string, string> }
  /** POST this to the connection (sub, unsub, window, mutate) */
  | { kind: 'send'; message: ClientMessage }
  | { kind: 'reset'; peer: string }
  | { kind: 'snapshot'; peer: string; topic: Topic; rows: Row[] }
  | { kind: 'entityOps'; peer: string; ops: EntityOp[] }
  | { kind: 'rows'; peer: string; req: string; rows: Row[]; done: boolean }
  | { kind: 'ack'; mid: string; seq: number; result?: unknown }
  | { kind: 'reject'; mid: string; code: string; message: string }
  | { kind: 'needResubscribe'; topic: Topic }
  | { kind: 'denied'; topic: Topic; code: string }
  | { kind: 'notice'; notice: Notice }
  | { kind: 'state'; state: ClientState; update?: Update }
  /** reconnect at this time (the host owns the timer) */
  | { kind: 'retry'; at: number };

export type ClientState = 'idle' | 'connecting' | 'live' | 'offline' | 'incompatible';

export type ClientInput =
  | { kind: 'open' }
  /** one decoded SSE frame: its `id:` (the cursor) and its messages */
  | { kind: 'frame'; id: number | null; messages: readonly ServerMessage[] }
  /** the stream ended or failed */
  | { kind: 'lost' }
  | { kind: 'subscribe'; topic: Topic; passive?: boolean }
  | { kind: 'unsubscribe'; topic: Topic; passive?: boolean }
  | { kind: 'mutate'; mid: string; cmd: string; args: unknown; base_seq?: number }
  | { kind: 'window'; req: string; topic: Topic; beforeSeq: number; limit: number }
  /** the client store couldn't apply an op on this topic: start it over */
  | { kind: 'drifted'; topic: Topic };
