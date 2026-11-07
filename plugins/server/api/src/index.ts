// @wisp-plugin/server-api: the contract of wisp.server, the HTTP edge (apps/server). The edge names no
// feature, so whatever it reports about features comes from these list points, contributed by the
// plugins that own the feature:
//   server.status  parts of GET /api/status (runs going, open terminals, the next wake-up…)
//   server.caller  which capability set a task's agent speaks with (its mode, a channel's cap)
//   server.legacy  v1 SSE events (summary, turn, …) for v1 clients, made from the change feed
//   server.quiet   POST routes that must not count as use (a channel's inbound message)
//   server.topics  full snapshots of a sync topic (the owner knows which rows a topic holds)
//   server.open    routes called from outside (a trigger's secret URL): no Host/Origin/JSON-only check,
//                  the route authenticates the call itself
import type { Json } from '@wisp/kernel';

export const SERVER_ID = 'wisp.server';

export const POINTS = {
  status: 'server.status',
  caller: 'server.caller',
  legacy: 'server.legacy',
  quiet: 'server.quiet',
  open: 'server.open',
  topics: 'server.topics',
} as const;

/** One plugin's part of GET /api/status. Each method is optional; all are cheap and synchronous. */
export interface StatusPart {
  /** fields merged into the answer, v1 names: { live, sides } from runtime, { terms } from terminal, … */
  fields?(): Record<string, Json>;
  /** when this plugin next wakes wisp on its own (a trigger, a check-in, a scheduled follow-up) */
  nextWakeAt?(): number | null;
  /** the last time something happened that counts as use (a turn started or ended) */
  lastActivityAt?(): number | null;
}

/** The set a session's agent speaks with: 'agent:session:plan', 'agent:capped', … (undefined: not mine). */
export interface CallerPart {
  setFor(session: string): string | undefined;
}

/** One committed change row, as the store reported it. */
export interface LegacyChange {
  entity: string;
  id: string;
  op: 'upsert' | 'patch' | 'del' | 'append';
  /** the row after the change (undefined for del) */
  row: Record<string, unknown> | undefined;
}

/** v1 event names for v1 clients' plain /api/events stream: change rows (and notices) → events. */
export interface LegacyPart {
  /** the entity kinds it maps; others aren't offered to it */
  entities: readonly string[];
  events(change: LegacyChange): readonly { event: string; data: Json }[];
}

/** A route (full path, `:param` style) whose POSTs don't keep a cloud wisp awake. */
export interface QuietPart {
  method: string;
  path: string;
}

/** A row as a snapshot carries it: entity kind, id, value. */
export interface TopicRow {
  e: string;
  id: string;
  v: unknown;
}

/**
 * Reads a whole topic for a snapshot. A delta (since a cursor) the edge answers from the change feed
 * itself; a full read only the owner can, so it contributes one per topic family it publishes.
 */
export interface TopicPart {
  /** a glob over topic names: 'list', 'session:*', 'plugin:wisp.crew:*' */
  match: string;
  rows(topic: string): readonly TopicRow[];
}

/** A route (full path, `:param` style) called from outside wisp's page, with its own check (a secret URL). */
export interface OpenPart {
  method: string;
  path: string;
}

/** The v1 status answer, as GET /api/status sends it. */
export interface Status {
  live: number;
  sides: number;
  terms: number;
  channels: number;
  clients: number;
  lastActivityAt: number | null;
  nextWakeAt: number | null;
  version: string;
  [field: string]: Json;
}
