// What SyncServer keeps per connection and per subscription (src/server.ts runs the rules).

import type { ServerMessage, Topic } from '@wisp/protocol';
import type { Outbox } from './outbox.ts';
import type { ChangeRow, ConnId, SyncServerOptions } from './types.ts';

/** loading: a snapshot or delta is asked for · waiting: held back by backpressure · dropped: resync sent */
export type SubState = 'loading' | 'waiting' | 'live' | 'dropped';

export interface Sub {
  passive: boolean;
  state: SubState;
  /** loading, waiting, dropped: the client holds the topic as of this seq (null: no rows yet) */
  since: number | null;
  req: number;
  buffer: ChangeRow[];
  bufferBytes: number;
}

export interface Conn<C> {
  id: ConnId;
  caller: C;
  clientId: string;
  subs: Map<Topic, Sub>;
  out: Outbox;
  control: ServerMessage[];
  acks: { mid: string; seq: number; result?: unknown }[];
  windows: Map<string, Topic>;
  buffered: number;
  lastFlushAt: number;
  lastWriteAt: number;
  active: boolean;
}

export type Options<C> = SyncServerOptions<C> & { flushMs: number; highWaterBytes: number; heartbeatMs: number; loadBufferBytes: number };
