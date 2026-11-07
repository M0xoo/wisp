// The seam to @wisp/sync (plan §7.2.1): one sans-IO link per peer. The link keeps the peer's
// (epoch, cursor), refcounts subscriptions, holds mutations until the welcome and resends them with
// the same mid, and negotiates the protocol window; the peer manager (peers.ts) carries out what it
// returns. `PeerLink` names only what the manager uses, so a test or another protocol can stand in.

import { SyncClient, type ClientInput, type ClientOutput, type SyncClientSaved } from '@wisp/sync';
import type { PeerId } from './types.ts';

export type { ClientInput, ClientOutput, SyncClientSaved as LinkSaved };

export interface PeerLink {
  readonly peer: string;
  readonly cursor: number | null;
  handle(input: ClientInput, now: number): ClientOutput[];
  /** what to persist so a restart resumes from the cursor instead of starting over */
  save(): SyncClientSaved;
}

export interface LinkOptions {
  peer: PeerId;
  clientId: string;
  build: string;
  saved?: SyncClientSaved;
}

/** The real link: @wisp/sync's SyncClient. */
export function syncLink(o: LinkOptions): PeerLink {
  return new SyncClient({ peer: o.peer, clientId: o.clientId, build: o.build, ...(o.saved && { saved: o.saved }) });
}
