// Generated from crates/wisp-protocol by `cargo test -p wisp-protocol export_bindings` (ts-rs).
// Do not edit: change the Rust types and run it again.

/**
 * `list` · `config` · `crew` · `machines` · `stuff` · `session:<id>` · `plugin:<id>:<topic>`.
 */
export type Topic = 'list' | 'config' | 'crew' | 'machines' | 'stuff' | `session:${string}` | `plugin:${string}:${string}`;

/**
 * RFC 6902, the subset wisp emits. Paths are JSON Pointers into the entity.
 */
export type PatchOp = { "op": "add", path: string, value: unknown, } | { "op": "replace", path: string, value: unknown, } | { "op": "remove", path: string, } | { "op": "test", path: string, value: unknown, };

/**
 * One entity change inside a patch frame. `e` is the entity kind (`session`, `turn`, `event`, …).
 */
export type EntityOp = { topic: Topic, e: string, id: string, } & ({ "op": "upsert", v: unknown, } | { "op": "patch", ops: Array<PatchOp>, } | { "op": "del" } | { "op": "append", v: unknown[], });

/**
 * A row as a snapshot, a delta or a window carries it.
 */
export type Row = { e: string, id: string, v: unknown, };

/**
 * One plugin a peer runs: features come from the peer, not from its version number.
 */
export type PeerPlugin = { id: string, version: string, commands: Array<string>, topics: Array<string>, blocks: Array<string>, };

/**
 * Who answers on the other end of a stream, and the protocol window it speaks.
 */
export type PeerInfo = { peer: string, name: string, build: string, version: string, proto_min: number, proto_max: number, plugins: Array<PeerPlugin>, };

export type Hello = { t: 'hello', proto_min: number, proto_max: number, client_id: string, build: string, epoch?: string, cursor?: number, };

export type Sub = { t: 'sub', topic: Topic, since?: number, 
/**
 * a passive subscription never counts as use of a box (plan §7.2.3)
 */
passive?: boolean, };

export type Unsub = { t: 'unsub', topic: Topic, };

/**
 * Page a transcript backwards: rows with seq < `before_seq`, newest first.
 */
export type Window = { t: 'window', req: string, topic: Topic, before_seq: number, limit: number, };

export type Mutate = { t: 'mutate', 
/**
 * uuidv7, the idempotency key
 */
mid: string, 
/**
 * `session.followUp`
 */
cmd: string, args: unknown, base_seq?: number, };

export type ClientMessage = Hello | Sub | Unsub | Window | Mutate;

export type Welcome = { t: 'welcome', epoch: string, head_seq: number, oldest_seq: number, 
/**
 * false: the client must drop its caches for this peer and take snapshots
 */
resume: boolean, proto: number, peer: PeerInfo, };

export type Snapshot = { t: 'snapshot', topic: Topic, seq: number, rows: Array<Row>, more?: boolean, };

export type Patch = { t: 'patch', seq: number, ops: Array<EntityOp>, };

export type Rows = { t: 'rows', req: string, rows: Array<Row>, done: boolean, };

export type Ack = { t: 'ack', mid: string, seq: number, result?: unknown, };

export type Reject = { t: 'reject', mid: string, code: string, message: string, };

/**
 * Outbox overflow: re-subscribe the topic from the cursor.
 */
export type Resync = { t: 'resync', topic: Topic, };

/**
 * Ephemeral: toasts, finished, reminders, denied topics.
 */
export type Notice = { t: 'notice', 
/**
 * `toast` · `finished` · `reminder` · `denied` · plugin-defined
 */
kind: string, data: unknown, };

export type ServerMessage = Welcome | Snapshot | Patch | Rows | Ack | Reject | Resync | Notice;

/**
 * The HTTP fallback of a command: `POST /api/cmd {cmd, args}` with an `Idempotency-Key`.
 */
export type CommandRequest = { cmd: string, args: unknown, };

/**
 * The error half of a command response: the kernel's `WireError` on the wire.
 */
export type CommandError = { code: string, message: string, retry?: boolean, };

export type CommandResponse = { ok: true, seq: number, result?: unknown, } | { ok: false, error: CommandError, };
