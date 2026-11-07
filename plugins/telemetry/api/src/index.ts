// @wisp-plugin/telemetry-api: the contract of wisp.telemetry, anonymous usage stats and error reports
// sent to PostHog (v1 server/telemetry.js), and the feedback users send the wisp team on purpose (v1
// server/services/feedback.js). Event names and property names are PostHog's dashboards: they never
// change. What goes out is fixed values only, never prompts, paths, project names or agent output.
//
// Other plugins and the edge report through the `telemetry.service` contract:
//   const t = ctx.tryUse(TELEMETRY);  t?.track('ship', { agent, draft });
// with `telemetry:track` in their manifest's permissions.

import type { Json, ServiceRef } from '@wisp/kernel';

export const TELEMETRY_ID = 'wisp.telemetry';

/** Fixed values about an event. `undefined` fields are dropped before they go out. */
export type Props = Record<string, Json | undefined>;

/** An error as plain data: an `Error` can't cross a service boundary, its parts can. */
export interface ErrorInfo {
  name?: string;
  message: string;
  stack?: string;
}

/** Anything thrown, as an ErrorInfo. */
export function errorInfo(e: unknown): ErrorInfo {
  if (e instanceof Error) return { name: e.name, message: e.message, ...(e.stack !== undefined && { stack: e.stack }) };
  return { message: String(e) };
}

export interface TelemetryService {
  /** count an event (nothing happens while usage stats are off) */
  track(event: string, props?: Props): void;
  /** PostHog error tracking (`$exception`): the message and stack are scrubbed of paths */
  captureError(err: ErrorInfo, props?: Props): void;
  /** usage stats are on: no opt-out in the environment and the Settings switch isn't off */
  enabled(): boolean;
  /** the first-run line the edge prints once it listens, or null (stats off, or already seen) */
  startupNotice(): string | null;
}

/** telemetry.service@1: counting needs `telemetry:track`, reading `telemetry:read`. */
export const TELEMETRY = {
  id: 'telemetry.service',
  major: 1,
  permissions: {
    track: 'telemetry:track',
    captureError: 'telemetry:track',
    enabled: 'telemetry:read',
    startupNotice: 'telemetry:read',
  },
  readOnly: ['enabled', 'startupNotice'],
} as const satisfies ServiceRef<TelemetryService>;

// ---------- settings (contributes.settings, v1 config.defaults names) ----------

export const SETTINGS = {
  /** 'off' turns usage stats off (v1 defaults.telemetry); unset means on */
  telemetry: 'telemetry',
  /** 'seen' once the page showed the first-run line (v1 defaults.telemetryNotice) */
  notice: 'telemetry.telemetryNotice',
} as const;

// ---------- feedback (POST /api/feedback) ----------

export type Rating = 'up' | 'down';

export interface FeedbackArgs {
  /** thumbs; null takes a rating on a turn back */
  rating?: Rating | null;
  text?: string;
  kind?: 'bug' | 'idea' | null;
  sessionId?: string;
  turnId?: string;
  /** where it was sent from ('turn', 'dialog', 'home', …), at most 20 characters */
  source?: string;
}

export interface FeedbackResult {
  ok: true;
  /** PostHog has it; false: it waits in the outbox */
  sent: boolean;
  /** feedback can go out at all (a key, and WISP_FEEDBACK isn't 0) */
  available: boolean;
}

/** What sticks to a rated turn, in its `ext['wisp.telemetry']` slot (v1 `turn.feedback`). */
export interface TurnFeedback {
  feedback?: { rating: Rating; at: number };
}

// ---------- events ----------

export const EVENTS = {
  /** a rating on a turn, or one taken back: wisp.router counts it (v1 router.signal({ feedback })) */
  rated: 'telemetry.rated', // { sessionId, turnId, rating: 'up' | 'down' | null }
} as const;

export interface RatedEvent {
  sessionId: string;
  turnId: string;
  rating: Rating | null;
}

// ---------- page events (POST /api/telemetry/event) ----------

/** Events the page may send, each with the only props it may carry and their allowed values. */
export const PAGE_EVENTS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  getapp_opened: { from: ['button', 'search'] },
  getapp_clicked: {},
  getapp_hidden: {},
};

/** The allowed part of a page event, or null when the event isn't one the page may send. */
export function pageEvent(event: unknown, props: unknown = {}): Record<string, string> | null {
  if (typeof event !== 'string' || !Object.hasOwn(PAGE_EVENTS, event)) return null;
  const allowed = PAGE_EVENTS[event] ?? {};
  const given = typeof props === 'object' && props !== null ? (props as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const [k, values] of Object.entries(allowed)) {
    const v = given[k];
    if (typeof v === 'string' && values.includes(v)) out[k] = v;
  }
  return out;
}
