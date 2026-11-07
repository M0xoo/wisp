// POST /api/hooks/:token (v1 server/hooks.js deliver): the token is the only way in, then the
// signature, when there is one, is checked before anything else. At most one task per trigger every
// 30 s; each delivery is kept (the last five) with what came of it. Answered at once (Slack gives up
// after 3 s); the task starts behind, and the delivery says how it went.

import type { Delivery } from '@wisp-plugin/automations-api';
import { HOOK_KINDS } from '@wisp-plugin/automations-api';
import type { Engine } from './engine.ts';
import { RATE_MS, readDelivery, sameToken, type Headers } from './hooks.ts';
import type { Trigger } from './types.ts';
import { errorText } from './util.ts';

const KEEP_DELIVERIES = 5;
const KEEP_SEEN = 50;

export interface Answer {
  status: number;
  body: Record<string, unknown>;
}

function record(e: Engine, t: Trigger, d: Delivery): void {
  d.at = e.d.now();
  t.deliveries = [d, ...(t.deliveries || [])].slice(0, KEEP_DELIVERIES);
}

/** The trigger behind a token, compared in constant time. */
const byToken = (e: Engine, token: string): Trigger | undefined =>
  e.d.repo.list().find((x) => HOOK_KINDS.has(x.kind) && !!x.token && sameToken(x.token, token));

export async function deliver(e: Engine, on: boolean, token: string, raw: Uint8Array, headers: Headers): Promise<Answer> {
  const notFound: Answer = { status: 404, body: { error: 'not found' } };
  if (!on) return notFound;
  const t = byToken(e, token);
  if (!t) return notFound;
  const now = e.d.now();
  const got = readDelivery(t, raw, headers, now);
  const done = (status: number, body: Record<string, unknown>, d: Omit<Delivery, 'at'> | null): Answer => {
    if (d) record(e, t, { ...d, at: 0 });
    e.d.repo.saveTrigger(t);
    return { status, body };
  };
  if ('reject' in got) return done(401, { error: got.reject }, { result: 'rejected', why: got.reject });
  if ('answer' in got) return done(200, got.answer as Record<string, unknown>, { result: 'skipped', why: got.why });
  if ('skip' in got) return done(200, { ok: true, skipped: got.skip }, { result: 'skipped', why: got.skip });
  if (!t.enabled) return done(200, { ok: true, skipped: 'The trigger is off.' }, { result: 'skipped', why: 'The trigger is off' });
  // Slack resends what it thinks went unanswered: the same event, once.
  if (got.key && t.seen.includes(got.key)) return done(200, { ok: true, skipped: 'Already seen' }, null);
  if (t.lastHookAt && now - t.lastHookAt < RATE_MS) {
    const why = 'At most one task every 30 s';
    return done(t.kind === 'webhook' ? 429 : 200, { ok: false, skipped: why }, { result: 'skipped', why });
  }
  t.lastHookAt = now;
  if (got.key) t.seen = [got.key, ...t.seen].slice(0, KEEP_SEEN);
  const d: Delivery = { at: 0, result: 'started', why: '', session: null };
  record(e, t, d);
  e.hook(t, got.vars)
    .then((s) => {
      const id = s?.['id'];
      if (typeof id === 'string') d.session = id;
      else Object.assign(d, { result: 'skipped', why: t.held?.why ? (t.held.load ? t.held.why : `Held for your plan: ${t.held.why}`) : 'Nothing started' });
    })
    .catch((err: unknown) => Object.assign(d, { result: 'rejected', why: errorText(err).slice(0, 200) }))
    .finally(() => {
      if (e.d.repo.triggers.get(t.id) === t) e.d.repo.saveTrigger(t);
    });
  return done(202, { ok: true, accepted: true }, null);
}
