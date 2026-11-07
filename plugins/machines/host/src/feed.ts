// What keeps a peer's rows here, behind one interface (plan §7.2.1):
//   sync   a v2 peer: @wisp/sync's SyncClient over the channel, a passive `list` subscription with a
//          cursor per (peer, epoch). A reconnect resumes from the cursor: only what changed comes.
//   relay  a v1 peer (it only speaks the old stream): today's whole-stream relay, the downgrade path.
// Which one runs is negotiated: the peer's /health says its protocol window, and a stream that
// answers with v1 events instead of a welcome is a v1 peer whatever /health said.

import type { ChannelResponse, Channel } from '@wisp-plugin/machines-api';
import { SseParser } from '@wisp/sync';
import type { Mirror } from './mirror.ts';

export type FeedEnd =
  /** the stream ended or failed: the channel may still be up */
  | { reason: 'lost'; error: string }
  /** outside the protocol window: `update` says which side is older */
  | { reason: 'incompatible'; update: 'peer' | 'client' }
  /** a stream that turned out to be v1 */
  | { reason: 'v1' }
  | { reason: 'closed' };

export interface FeedStats {
  /** bytes received on the event stream, plus the list fetch for the relay */
  bytes: number;
  frames: number;
  rows: number;
}

export interface Feed {
  readonly proto: number;
  readonly done: Promise<FeedEnd>;
  readonly stats: FeedStats;
  close(): void;
}

export interface FeedDeps {
  /** the local handle of the peer */
  peer: string;
  channel: Channel;
  mirror: Mirror;
  now(): number;
  log(line: string): void;
}

/** One SSE stream from the channel: each event to `onEvent`, the bytes counted, until it ends. */
export async function readEvents(res: ChannelResponse, stats: FeedStats, onEvent: (event: string, data: string, id: string | undefined) => boolean | void): Promise<void> {
  const parser = new SseParser();
  for await (const chunk of res.body) {
    stats.bytes += chunk.byteLength;
    for (const ev of parser.push(chunk)) if (onEvent(ev.event, ev.data, ev.id) === false) return;
  }
}

export const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A deferred: resolve once, from anywhere. */
export function settle<T>(): { promise: Promise<T>; resolve(v: T): void; settled(): boolean } {
  let done = false;
  let res: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => (res = r));
  return {
    promise,
    resolve(v) {
      if (done) return;
      done = true;
      res(v);
    },
    settled: () => done,
  };
}
