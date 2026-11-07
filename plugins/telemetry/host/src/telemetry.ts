// Anonymous usage analytics and error reports, sent to PostHog over its plain HTTP API (v1
// server/telemetry.js, behaviour for behaviour). Off when any of: no API key, DO_NOT_TRACK=1,
// WISP_TELEMETRY=0, CI, or the Settings switch ("telemetry": "off").
//
// Feedback is different: the user hands it to us on purpose, so it goes out even with usage stats off.
// Only WISP_FEEDBACK=0 or no key stops it. Offline, it waits in the outbox and goes with the next
// feedback or the next start.
import { randomUUID } from 'node:crypto';
import type { Json } from '@wisp/kernel';
import type { Store } from '@wisp/store';
import type { ErrorInfo, Props } from '@wisp-plugin/telemetry-api';
import { compact } from './kernel.ts';
import { frames, scrub, type ScrubOptions } from './scrub.ts';
import type { OutboxRow, Tables } from './schema.ts';

// PostHog project API key: write-only, safe to ship in the client.
export const DEFAULT_KEY = 'phc_wowwZkbP8e4zYuwT67JtX6oxdPwkMWL5kKnrUmYYXhcD';
export const DEFAULT_HOST = 'https://us.i.posthog.com';
export const FLUSH_MS = 15_000;
export const MAX_QUEUE = 50;
export const TIMEOUT_MS = 3000;
const FEEDBACK_MAX = 4000;
const OUTBOX_MAX = 100;
const PENDING_MAX = 200;

export type Env = Readonly<Record<string, string | undefined>>;
const truthy = (v: string | undefined): boolean => !!v && !/^(0|false|no|off)$/i.test(v);
const falsy = (v: string | undefined): boolean => /^(0|false|no|off)$/i.test(v ?? '');

/** The key, as v1 read it: WISP_POSTHOG_KEY wins, even empty (which turns everything off). */
export const keyOf = (env: Env): string => env['WISP_POSTHOG_KEY'] ?? DEFAULT_KEY;
export const hostOf = (env: Env): string => (env['WISP_POSTHOG_HOST'] || DEFAULT_HOST).replace(/\/$/, '');
export const envDisabled = (env: Env): boolean => !keyOf(env) || truthy(env['DO_NOT_TRACK']) || falsy(env['WISP_TELEMETRY']) || truthy(env['CI']);
export const feedbackAvailable = (env: Env): boolean => !!keyOf(env) && !falsy(env['WISP_FEEDBACK']);

/** Which shell wisp runs in, as v1 reported it. */
export const shellOf = (env: Env): string => (env['WISP_DESKTOP'] === 'tauri' ? 'tauri' : env['WISP_GRID_URL'] ? 'grid' : 'browser');

export interface TelemetryDeps {
  store: Store;
  tables: Tables;
  env: Env;
  /** the Settings switch (v1 defaults.telemetry) */
  setting(): Json | undefined;
  /** PostHog's batch endpoint: true once it has them */
  post(batch: Json[]): Promise<boolean>;
  scrub: ScrubOptions;
  /** $lib, version, os, … (v1 Telemetry.common) */
  common: Record<string, Json>;
  now(): number;
}

const ID_KEY = 'telemetryId';

export class Telemetry {
  readonly queue: Json[] = [];
  readonly #d: TelemetryDeps;

  constructor(d: TelemetryDeps) {
    this.#d = d;
  }

  get enabled(): boolean {
    return !envDisabled(this.#d.env) && this.#d.setting() !== 'off';
  }

  get feedbackAvailable(): boolean {
    return feedbackAvailable(this.#d.env);
  }

  /** Random per install, not tied to the machine or the user; made on the first event. */
  installId(make = true): string | undefined {
    const { store, tables } = this.#d;
    const had = store.get(tables.state, ID_KEY)?.value;
    if (had || !make) return had;
    const id = randomUUID();
    store.tx((w) => w.upsert(tables.state, { key: ID_KEY, value: id }));
    return id;
  }

  track(event: string, props: Props = {}): void {
    if (!this.enabled) return;
    const id = this.installId() ?? randomUUID();
    this.queue.push({ event, timestamp: new Date(this.#d.now()).toISOString(), properties: { ...this.#d.common, ...compact(props), distinct_id: id } });
    if (this.queue.length >= MAX_QUEUE) void this.flush();
  }

  /** PostHog's error tracking format. */
  captureError(err: ErrorInfo, props: Props = {}): void {
    const type = typeof props['type'] === 'string' && props['type'] ? props['type'] : err.name || 'Error';
    const handled = typeof props['handled'] === 'boolean' ? props['handled'] : true;
    this.track('$exception', {
      ...props,
      $exception_list: [{ type, value: scrub(err.message, this.#d.scrub), mechanism: { handled, synthetic: false }, stacktrace: { type: 'raw', frames: frames(err.stack, this.#d.scrub) } }],
    });
  }

  /**
   * A rating on a turn ('turn_rated') or a written note ('feedback'). True once PostHog has it; false
   * means it's kept in the outbox and retried.
   */
  async feedback(event: string, props: Props = {}): Promise<boolean> {
    if (!this.feedbackAvailable) return false;
    // With usage stats off, a fresh id per message so feedback can't be tied to anything else.
    const id = (this.enabled && this.installId(false)) || randomUUID();
    const raw = props['text'];
    const text = raw ? String(raw).split(this.#d.scrub.home).join('~').slice(0, FEEDBACK_MAX) : undefined;
    const ev: Json = { event, timestamp: new Date(this.#d.now()).toISOString(), properties: { ...this.#d.common, ...compact({ ...props, text }), distinct_id: id } };
    const batch = [...this.#box('feedback'), ev].slice(-OUTBOX_MAX);
    const ok = await this.#d.post(batch);
    this.#replace('feedback', ok ? [] : batch);
    return ok;
  }

  /** Offline or blocked: what was queued is dropped. Telemetry must never get in the way. */
  async flush(): Promise<void> {
    if (!this.queue.length) return;
    await this.#d.post(this.queue.splice(0));
  }

  /** Shutdown and crashes leave no time for a request: keep what's queued for the next start. */
  persist(): void {
    if (!this.queue.length) return;
    try {
      this.#replace('pending', this.queue.splice(0).slice(-PENDING_MAX));
    } catch {
      // the store is already closed: these events are lost, as v1's were when its write failed
    }
  }

  crashed(err: ErrorInfo): void {
    if (!this.enabled) return;
    this.captureError(err, { handled: false, type: err.name || 'UncaughtException' });
    this.persist();
  }

  /** At start: last run's stats queue joins this one, and feedback that waited goes out. */
  restore(): Promise<void> {
    const pending = this.#box('pending');
    if (pending.length) this.#replace('pending', []);
    if (this.enabled) this.queue.push(...pending.slice(-PENDING_MAX));
    const outbox = this.#box('feedback');
    if (!outbox.length || !this.feedbackAvailable) return Promise.resolve();
    return this.#d.post(outbox).then((ok) => {
      if (ok) this.#replace('feedback', []);
    });
  }

  #box(box: OutboxRow['box']): Json[] {
    const rows = this.#d.store.query(this.#d.tables.outbox, { where: { box }, order: [['n', 'asc']] });
    return rows.map((r) => r.event as Json);
  }

  #replace(box: OutboxRow['box'], events: readonly Json[]): void {
    const { store, tables } = this.#d;
    store.tx((w) => {
      for (const r of store.query(tables.outbox, { where: { box }, select: ['id'] })) w.del(tables.outbox, r.id);
      events.forEach((event, n) => w.upsert(tables.outbox, { id: randomUUID(), box, n, event }));
    });
  }
}
