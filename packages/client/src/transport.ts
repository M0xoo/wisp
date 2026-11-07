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
