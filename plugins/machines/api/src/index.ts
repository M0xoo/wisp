// @wisp-plugin/machines-api: the contract of wisp.machines, the plugin that owns peers (your other
// computers, cloud computers, sandboxes) and how they are reached (ADR-0010, plan §7.2).
//
// A peer row is v1's `config.machines` entry with a `transport` field. Its `id` is the local handle
// (v1's 6-hex machine id, kept on import so `<id>@<machine>` links and `copies[<machine>]` keep
// working); `peer` is the far side's own stable peer_id, learned from its welcome, which v2 ids
// carry as their origin (`<peer>:<uuid>`).
//
// How a peer is reached is an implementation of `machines.transport@1`: `ssh` ships in this plugin,
// `grid` and `grid-tunnel` in wisp.grid-client, and a user's plugin may add its own.

import type { Json, ServiceRef } from '@wisp/kernel';
import type { PeerInfo } from '@wisp/protocol';

export const PLUGIN = 'wisp.machines';

// ---------- rows ----------

/** ssh: OpenSSH with a -L forward · grid: a cloud computer or sandbox · grid-tunnel: another of your computers, through the tunnel it holds to the grid */
export type TransportKind = 'ssh' | 'grid' | 'grid-tunnel' | (string & {});

export interface PeerRow {
  /** the local handle: v1's machine id (6 hex), or a new one */
  id: string;
  /** the far side's peer_id, from its welcome; null until it has answered once (or a v1 wisp) */
  peer: string | null;
  name: string;
  transport: TransportKind;
  /** ssh: the target (user@host, an alias from ~/.ssh/config); grid: the https origin */
  address: string;
  /** ssh: wisp's port over there; grid: the origin's port */
  port: number;
  /** ssh: a custom start command, '' for `npx -y wisp-agents@<this version>` */
  command: string;
  autoConnect: boolean;
  addedAt: number;
  /** the transport's own fields (grid: grid, handle, user, computer, sandbox, owner) */
  data: { [k: string]: Json };
}

export type PeerState = 'off' | 'connecting' | 'reconnecting' | 'online' | 'asleep' | 'error' | 'incompatible';

export interface Step {
  id: string;
  label: string;
  status: 'pending' | 'run' | 'done' | 'warn' | 'fail';
  detail: string;
}

/** What a failure most likely needs, in words for someone who has never used SSH (v1 sshHint). */
export interface Hint {
  title?: string;
  text: string;
  command?: string;
  url?: string;
  /** the page offers the "type your password once" box (machines.letIn) */
  letIn?: boolean;
  tailscale?: boolean;
}

export interface RemoteAgent {
  id: string;
  name: string;
  available: boolean;
  version?: string;
  models?: Json;
  efforts?: Json;
  delegates?: Json;
  signedIn?: boolean;
}

export interface RemoteInfo {
  version?: string;
  pid?: number | null;
  home?: string;
  agents?: RemoteAgent[];
  /** 1: a v1 wisp, reached through the whole-stream relay; 2+: the sync protocol */
  proto?: number;
}

/** The live side of a peer: one row per peer, on the `machines` topic beside the peer row. */
export interface PeerStatus {
  id: string;
  state: PeerState;
  steps: Step[];
  error: string;
  hint: Hint | null;
  attempt: number;
  since: number | null;
  remote: RemoteInfo | null;
  /** an older wisp there refused this API: its pid, for Restart wisp there */
  stale: number | null;
  /** a request gets through even though it isn't online: an asleep cloud computer wakes on one */
  wakes: boolean;
}

/** A row the far side shows on its `list` topic, as this wisp mirrors it (ids as the peer made them). */
export interface MirrorRow {
  /** the local handle of the peer */
  peer: string;
  id: string;
  v: { [k: string]: unknown };
}

// ---------- commands (permission: `machines:<verb>`) ----------

export interface AddArgs {
  name?: string;
  transport?: TransportKind;
  /** ssh: user@host; v1 called it `target` (accepted as well) */
  address?: string;
  target?: string;
  port?: number;
  command?: string;
  autoConnect?: boolean;
  /** false: add it without connecting (v1 `connect: false`) */
  connect?: boolean;
  data?: { [k: string]: Json };
  /** a secret the transport keeps for it (a grid device token): goes to secrets, never to the row */
  token?: string;
}
export type UpdateArgs = { id: string; token?: string } & Omit<AddArgs, 'transport' | 'connect' | 'token'>;

export const COMMANDS = {
  add: 'machines.add', // AddArgs → PeerView
  update: 'machines.update', // UpdateArgs → PeerView
  remove: 'machines.remove', // { id } → { ok, removed: string[] }
  connect: 'machines.connect', // { id } → PeerView
  disconnect: 'machines.disconnect', // { id } → PeerView
  stop: 'machines.stop', // { id, restart?: boolean } → { ok }   (stop wisp over there)
  letIn: 'machines.letIn', // { id, password } → { ok, madeKey, machine }
  follow: 'machines.follow', // { id } → {}   (watch without waking: an asleep box)
  recheck: 'machines.recheckAgents', // { id?, agent? } → {}
  list: 'machines.list', // {} → PeerView[]   (read-only)
  get: 'machines.get', // { id } → PeerView   (read-only)
  sessions: 'machines.sessions', // { id? } → MirrorRow[]   (read-only)
  hosts: 'machines.hosts', // {} → SshHost[]   (read-only, ~/.ssh/config)
  discover: 'machines.discover', // {} → FoundHost[]   (read-only)
  reachable: 'machines.reachable', // {} → Reachability   (read-only)
  /** a v2 command for a row another peer owns: sent there with the same idempotency key */
  route: 'machines.route', // RouteArgs → unknown (the far side's result)
} as const;

export interface RouteArgs {
  /** the local handle; omitted: the peer named by the origin of `args.id` */
  id?: string;
  cmd: string;
  args: unknown;
  /** the idempotency key: the same one the client sent here */
  mid: string;
}

/** A peer as GET /api/machines shows it (v1's view): the row, its status and what the page needs. */
export interface PeerView {
  id: string;
  peer: string | null;
  name: string;
  transport: TransportKind;
  address: string;
  port: number;
  command: string;
  autoConnect: boolean;
  addedAt: number;
  /** v1's names, kept for older clients: kind 'ssh' | 'grid', target = address */
  kind: string;
  target: string;
  defaultCommand: string;
  state: PeerState;
  steps: Step[];
  error: string;
  hint: Hint | null;
  stale: boolean;
  attempt: number;
  since: number | null;
  remote: RemoteInfo | null;
  outdated: string | null;
  log: string[];
  working: number;
  [field: string]: unknown;
}

// ---------- events (after commit) ----------

export const EVENTS = {
  online: 'machines.online', // { id }
  offline: 'machines.offline', // { id, state }
  changed: 'machines.changed', // { id }
  removed: 'machines.removed', // { id, row: PeerRow }   (projects drop their copies there)
  /** a row on a peer's list changed: other plugins (crew, router) follow remote tasks this way */
  remote: 'machines.remote', // { id, op: 'upsert' | 'del', rowId }
} as const;

export const TOPIC = 'machines';

// ---------- extension point: machines.transport@1 ----------

export interface ConnectIO {
  /** move a step along (one of the transport's `steps`) */
  step(id: string, status: Step['status'], detail?: string): void;
  log(line: string): void;
  /** an older wisp there refused this one: its pid, for Restart */
  stale(pid: number | null): void;
  /** the secret kept for this peer (`secretKey(id)`) */
  secret(): Promise<string | undefined>;
}

export interface ChannelRequest {
  method: string;
  /** the path under /api, with its query: '/health', '/events?topics=list' */
  path: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | AsyncIterable<Uint8Array>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** this request must never count as use of the box (a passive subscription, a watch) */
  passive?: boolean;
}

export interface ChannelResponse {
  status: number;
  headers: Record<string, string>;
  /** the body as it comes; read it once, with this or with text() */
  body: AsyncIterable<Uint8Array>;
  text(): Promise<string>;
  /** stop reading: the request over there is cancelled */
  cancel(): void;
}

export interface ChannelEnd {
  /** lost: try again; asleep: watch without waking; gone: signed out or removed, stop; closed: we hung up */
  reason: 'lost' | 'asleep' | 'gone' | 'closed';
  error?: string;
  hint?: Hint;
  /** retrying won't change the answer */
  giveUp?: boolean;
}

/** A way to the peer's wisp: HTTP requests multiplexed over whatever the transport holds open. */
export interface Channel {
  request(req: ChannelRequest): Promise<ChannelResponse>;
  /** resolves when the way is gone, and says why */
  readonly closed: Promise<ChannelEnd>;
  close(): void;
  /** where it goes, for the tunnel step ('localhost:51234 → 4477') */
  readonly label: string;
}

export interface Transport {
  kind: TransportKind;
  /**
   * The steps a connect goes through, [id, label], shown on the machine's card. The manager runs
   * 'tunnel' (wisp answers through the channel) and 'agents' itself when they are listed.
   */
  steps: readonly (readonly [string, string])[];
  /** validates add/update input into row fields; throws an Error with words the page shows */
  clean?(input: AddArgs, prev: PeerRow | undefined): Partial<PeerRow>;
  /** opens the way. Rejects with a TransportError when it can't, resolves once requests go through */
  connect(peer: PeerRow, io: ConnectIO, signal: AbortSignal): Promise<Channel>;
  /** checked while asleep, without waking the box: 'running' means connect again */
  probe?(peer: PeerRow, io: ConnectIO, signal: AbortSignal): Promise<'running' | 'asleep' | 'gone'>;
  /** an asleep box still takes requests (they wake it); false for a computer only its owner can turn on */
  wakesOnRequest?(peer: PeerRow): boolean;
  /**
   * a way that needs no open connection (grid: one HTTPS request each). The manager sends requests
   * this way while the peer is asleep or waking and `wakesOnRequest` says the request wakes it.
   */
  direct?(peer: PeerRow, io: ConnectIO): Channel;
  /** stop wisp over there: 'asleep' (the grid stopped it, watch it) or 'off'. Restart is the manager's */
  stopRemote?(peer: PeerRow, io: { pid: number | null; secret(): Promise<string | undefined> }): Promise<'asleep' | 'off'>;
  /** the peer is about to be removed: tidy up over there; returns other peers that go with it */
  forget?(peer: PeerRow, all: readonly PeerRow[]): Promise<{ also?: string[] }>;
  /** a terminal there running `command` (Take over), or null when the transport has none */
  terminalArgv?(peer: PeerRow, command: string): string[] | null;
  /** "type your password once" (ssh) */
  letIn?(peer: PeerRow, password: string): Promise<{ ok: true; madeKey: boolean }>;
  /** start the peers this transport keeps on its own (true: connect now; false: follow without waking) */
  autoStart?(peer: PeerRow): boolean;
}

/** What a transport throws: the card shows `message` and `hint`; giveUp stops the retries. */
export interface TransportFailure {
  message: string;
  hint?: Hint;
  giveUp?: boolean;
  /** 'asleep': the box is stopped (watch it); 'gone': signed out or removed */
  kind?: 'asleep' | 'gone';
  /** an HTTP status to answer with, when a route surfaces it */
  status?: number;
}
export class TransportError extends Error implements TransportFailure {
  readonly hint?: Hint;
  readonly giveUp?: boolean;
  readonly kind?: 'asleep' | 'gone';
  readonly status?: number;
  constructor(f: TransportFailure) {
    super(f.message);
    this.name = 'TransportError';
    if (f.hint !== undefined) this.hint = f.hint;
    if (f.giveUp !== undefined) this.giveUp = f.giveUp;
    if (f.kind !== undefined) this.kind = f.kind;
    if (f.status !== undefined) this.status = f.status;
  }
}

/** What a request to a peer throws: v1's `bad(message, status)`, so routes answer the same status. */
export class PeerHttpError extends Error {
  readonly status: number;
  readonly hold?: Json;
  constructor(message: string, status: number, hold?: Json) {
    super(message);
    this.name = 'PeerHttpError';
    this.status = status;
    if (hold !== undefined) this.hold = hold;
  }
}

export const POINTS = {
  transport: 'machines.transport', // Transport, version 1
  /** an action of /sessions/<id>@<machine>/<action> another plugin answers (take over, move, …) */
  proxy: 'machines.proxy', // ProxyAction, version 1
} as const;

export interface ProxyCall {
  machine: string;
  /** the id over there */
  id: string;
  /** the id here, `<id>@<machine>` */
  qualified: string;
  action: string;
  method: string;
  query: URLSearchParams;
  body: unknown;
  /** what the request came through (x-wisp-tunnel, a proxy): some answers differ for the grid */
  headers: Readonly<Record<string, string | string[] | undefined>>;
}
/** `machines.proxy@1`: answers one action of a remote task; undefined lets it pass through unchanged. */
export interface ProxyAction {
  action: string;
  methods: readonly string[];
  handle(call: ProxyCall, peers: MachinesService): Promise<{ status: number; json: unknown } | undefined>;
}

// ---------- service: machines.peers@1 ----------

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  cancel(): void;
}

/** A handle on the peers for other plugins: requests to a peer's wisp, its harnesses, its rows. */
export interface MachinesService {
  /** a JSON call to the peer's API (path under /api); throws PeerHttpError as v1's bad() did */
  json<T = unknown>(id: string, method: string, path: string, body?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
  /** a raw request (files, uploads, terminals) */
  stream(id: string, method: string, path: string, opts?: { body?: ChannelRequest['body']; headers?: Record<string, string>; timeoutMs?: number }): Promise<RawResponse>;
  /** online, or asleep and woken by a request */
  usable(id: string): boolean;
  online(id: string): boolean;
  agentsOf(id: string): RemoteAgent[] | null;
  /** the peer that owns an id: `<id>@<machine>` (v1) or `<peer>:<uuid>` (v2) */
  ownerOf(id: string): { machine: string; id: string } | null;
  /** the rows a peer's list shows (fresh while online, the last seen ones while not) */
  rows(id?: string): MirrorRow[];
  terminalArgv(id: string, command: string): string[];
  peers(): readonly PeerRow[];
}

export const MACHINES_SERVICE: ServiceRef<MachinesService> = {
  id: 'machines.peers',
  major: 1,
  permissions: {
    json: 'machines:call',
    stream: 'machines:call',
    usable: 'machines:read',
    online: 'machines:read',
    agentsOf: 'machines:read',
    ownerOf: 'machines:read',
    rows: 'machines:read',
    terminalArgv: 'machines:call',
    peers: 'machines:read',
  },
  readOnly: ['usable', 'online', 'agentsOf', 'ownerOf', 'rows', 'peers'],
};

// ---------- ids ----------

/** v1: a remote session is `<remote id>@<machine id>` here. Local ids never contain '@'. */
export const qualify = (id: string, machine: string): string => (id ? `${id}@${machine}` : id);
export function splitId(id: string): { id: string; machine: string } | null {
  const i = String(id || '').lastIndexOf('@');
  return i > 0 ? { id: id.slice(0, i), machine: id.slice(i + 1) } : null;
}

/** The secret key a peer's token is kept under (v1: secrets.json → machines → <id>). */
export const secretKey = (id: string): string => `machines.${id}`;

export type { PeerInfo };
