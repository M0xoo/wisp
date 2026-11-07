// Picks the feed for a peer: the sync protocol when its /health says it speaks v2, the v1 relay
// otherwise (and when a v2 stream turns out to be v1). The cursor a sync feed reaches is saved per
// peer, so the next connection, even after a restart, resumes from it.

import type { Clock } from '@wisp/kernel';
import type { Channel, PeerRow } from '@wisp-plugin/machines-api';
import type { Feed } from './feed.ts';
import { startRelayFeed } from './feed-relay.ts';
import { startSyncFeed, type SyncFeed } from './feed-sync.ts';
import type { Mirror } from './mirror.ts';
import type { LinkStore } from './state.ts';

export interface FeedHost {
  mirror: Mirror;
  links: LinkStore;
  clock: Clock;
  /** this wisp as a sync client of its peers */
  clientId: string;
  build: string;
  /** a v1 peer's session events, ids qualified (`<id>@<machine>`), for whoever shows them live */
  onRelayEvent(peer: string, event: string, data: Record<string, unknown>): void;
}

export function startFeed(h: FeedHost, peer: PeerRow, channel: Channel, proto: number, log: (line: string) => void): Feed {
  const base = { peer: peer.id, channel, mirror: h.mirror, now: () => h.clock.now(), log };
  if (proto < 2) return startRelayFeed({ ...base, onEvent: (event, data) => h.onRelayEvent(peer.id, event, data) });
  const saved = h.links.load(peer.id);
  return startSyncFeed({ ...base, clientId: h.clientId, build: h.build, ...(saved !== undefined && { saved }), onSaved: (s) => h.links.save(peer.id, s) });
}

export const isSyncFeed = (f: Feed | undefined): f is SyncFeed => f !== undefined && f.proto >= 2 && 'mutate' in f;
