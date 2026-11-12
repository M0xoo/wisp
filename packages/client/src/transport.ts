// How a peer is reached (plan §7.2.2). A transport opens the sync stream with the link's query
// parameters, yields its decoded frames, and posts client messages (sub, unsub, window, mutate)
// for that stream. The peer manager owns everything else: cursors, status, retries. HTTP is in
// http.ts; the phone's sshj and the grid transports implement the same shape.

import type { ClientMessage, ServerMessage } from '@wisp/protocol';

/** One SSE frame: its `id:` (the cursor watermark, when present) and its messages. */
export interface Frame {
  readonly id: number | null;
  readonly messages: readonly ServerMessage[];
}

export interface Transport {
  readonly kind: string; // 'http' | 'ssh' | 'grid' | 'grid-tunnel' | a plugin's
  /** the frames of one connection; it ends (or throws) when the connection does */
  connect(params: Readonly<Record<string, string>>, signal: AbortSignal): AsyncIterable<Frame>;
  /** sends a message for the open stream */
  post(message: ClientMessage, signal: AbortSignal): Promise<void>;
  /** grid only: ask hostd to start the box */
  wake?(signal: AbortSignal): Promise<void>;
  /** a plugin's own route, with a raw body (a dropped file's bytes) and the peer's headers; HTTP-like
   *  transports only. Resolves the status and the body as text; a status ≥ 400 is the caller's to read. */
  request?(r: RawRequest, signal: AbortSignal): Promise<RawResponse>;
  /** a plugin's own event-stream route (a terminal's output): each SSE event until it ends or `signal` aborts */
  events?(path: string, signal: AbortSignal): AsyncIterable<RouteEvent>;
}

export interface RawRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** under /api: `/stuff/upload?name=a.png` */
  readonly path: string;
  readonly body?: Blob | ArrayBuffer | string;
  readonly contentType?: string;
  /** extra request headers (`idempotency-key`, an untrusted UI's `x-wisp-plugin`, ADR-0048). Additive (2026-11-12). */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface RawResponse {
  readonly status: number;
  readonly text: string;
}

export interface RouteEvent {
  readonly event: string;
  readonly data: string;
}

/** A peer's routes, through its transport (PluginClient.http). Refuses on a transport without them. */
export interface PeerHttp {
  /** the body parsed as JSON (null when empty); a status ≥ 400 throws with the server's message */
  send(r: RawRequest, signal?: AbortSignal): Promise<unknown>;
  events(path: string, signal: AbortSignal): AsyncIterable<RouteEvent>;
}

/** A transport says why it can't connect: a sleeping box isn't an error and isn't retried. */
export class PeerDown extends Error {
  readonly status: 'asleep' | 'unreachable';
  constructor(status: 'asleep' | 'unreachable', reason: string) {
    super(reason);
    this.name = 'PeerDown';
    this.status = status;
  }
}
