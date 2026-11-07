// Usage stats for a grid's operator: sign-ups, sign-ins, devices, and how boxes start and sleep.
// Off unless grid.json says "telemetry": true (a self-hosted grid sends nothing by default). Goes
// to wisp's PostHog project, like wisp's own stats: fixed values only, and each user as a hash of
// their id, never a handle, email or address.

import { createHash } from 'node:crypto';
import type { GridConfig } from './config.ts';
import { VERSION, postBatch, posthogKey, type PosthogEvent } from './shared/posthog.ts';

const FLUSH_MS = 15_000;
// The browser analytics on the sign-in page, and the funnel events tied to it, are for wisp's own
// hosted grid only: a self-hosted grid never loads a script from PostHog.
export const HOSTED = 'grid.trywisp.dev';

// Audit actions (accounts.ts) that become events, and the meta they may carry.
const FROM_AUDIT: Readonly<Record<string, readonly [string, readonly string[]]>> = {
  signup: ['grid_signup', ['provider']],
  signin: ['grid_signin', ['provider']],
  'identity.link': ['grid_identity_linked', ['provider']],
  'device.allow': ['grid_device_allowed', []],
  'device.deny': ['grid_device_denied', []],
  'device.revoke': ['grid_device_revoked', []],
  'user.delete': ['grid_user_deleted', []],
  'signup.refused': ['grid_signup_refused', ['provider', 'reason']], // not in the audit table: no user
};

/** What hostd says when a box changes (the part telemetry reads). */
export interface BoxEvent {
  user: { id: string };
  state: string;
  event: string;
  startedAt: number | null;
  stoppedAt: number | null;
}

export interface TelemetryOptions {
  post?: (batch: PosthogEvent[]) => Promise<unknown>;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

const reasonOf = (r = ''): string => (r === 'idle' ? 'idle' : r === 'put to sleep' ? 'user' : r === 'grid stopped' ? 'grid' : r === 'deleted' ? 'deleted' : r === 'out of memory' ? 'oom' : /^exited/.test(r) ? 'crashed' : 'other');

export function createGridTelemetry(cfg: Pick<GridConfig, 'telemetry' | 'domain' | 'hostd'>, { post = postBatch, now = () => Date.now(), env = process.env }: TelemetryOptions = {}) {
  const on = cfg.telemetry === true && !/^(0|false|off)$/i.test(env['WISP_TELEMETRY'] || '') && !env['DO_NOT_TRACK'];
  const queue: PosthogEvent[] = [];
  const who = (userId: string | null): string => (userId ? `grid-${createHash('sha256').update(`wisp-grid:${userId}`).digest('hex').slice(0, 24)}` : 'grid-anonymous');
  const common = { $lib: 'wisp-grid', $process_person_profile: false, version: VERSION, driver: cfg.hostd?.driver, hosted: cfg.domain === HOSTED };

  function flush(): void {
    if (queue.length) post(queue.splice(0)).catch(() => {});
  }
  function send(event: string, distinctId: string, props: Record<string, unknown>): void {
    if (!on) return;
    queue.push({ event, timestamp: new Date(now()).toISOString(), properties: { ...common, ...props, distinct_id: distinctId } });
    if (queue.length >= 50) flush();
  }
  const track = (event: string, userId: string | null, props: Record<string, unknown> = {}): void => send(event, who(userId), props);
  const pages = on && cfg.domain === HOSTED && !!posthogKey();
  // The sign-in page's PostHog id, from its cookie: the anonymous random id the page made, so the
  // server's steps (off to GitHub, back signed in) join the page's in one funnel.
  const cookieName = `ph_${posthogKey()}_posthog`;
  function visitorId(cookies: Record<string, string> = {}): string | null {
    if (!pages) return null;
    try {
      const j: unknown = JSON.parse(cookies[cookieName] || '{}');
      const id = typeof j === 'object' && j !== null ? (j as { distinct_id?: unknown }).distinct_id : undefined;
      return typeof id === 'string' && /^[\w-]{8,64}$/.test(id) ? id : null;
    } catch {
      return null;
    }
  }
  const timer = on ? setInterval(flush, FLUSH_MS) : null;
  timer?.unref();

  // Box timings: from asking for it to its wisp answering, and how long it stayed up.
  const starting = new Map<string, number>();
  function box(e: BoxEvent): void {
    const id = e.user.id;
    if (e.state === 'starting') starting.set(id, now());
    else if (e.event === 'started') {
      const t = starting.get(id);
      starting.delete(id);
      track('grid_box_started', id, t ? { ms: now() - t } : {});
    } else if (e.event === 'failed') {
      starting.delete(id);
      track('grid_box_failed', id);
    } else if (e.state === 'stopped' && e.startedAt) track('grid_box_stopped', id, { reason: reasonOf(e.event), minutes: Math.round(((e.stoppedAt || now()) - e.startedAt) / 60_000) });
  }

  return {
    on,
    pages,
    track,
    visitorId,
    // A sign-in step for the funnel: started (off to the provider), finished (back, signed in or
    // signed up) or failed. Only on the hosted grid, as the page's anonymous id.
    funnel(event: string, visitor: string | null, props: Record<string, unknown> = {}): void {
      if (pages) send(event, visitor || 'grid-anonymous', props);
    },
    audit(userId: string | null, action: string, meta: Record<string, unknown> = {}): void {
      const m = FROM_AUDIT[action];
      if (m) track(m[0], userId, Object.fromEntries(m[1].filter((k) => meta[k] != null).map((k) => [k, meta[k]])));
    },
    box,
    close(): void {
      if (timer) clearInterval(timer);
      flush();
    },
  };
}

export type GridTelemetry = ReturnType<typeof createGridTelemetry>;
