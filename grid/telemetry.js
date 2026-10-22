// Usage stats for a grid's operator: sign-ups, sign-ins, devices, and how boxes start and sleep.
// Off unless grid.json says "telemetry": true (a self-hosted grid sends nothing by default). Goes
// to wisp's PostHog project, like wisp's own stats (server/telemetry.js): fixed values only, and
// each user as a hash of their id, never a handle, email or address.

import { createHash } from 'node:crypto';
import { postBatch } from '../server/telemetry.js';
import { VERSION } from '../server/util.js';

const FLUSH_MS = 15_000;

// Audit actions (grid/accounts.js) that become events, and the meta they may carry.
const FROM_AUDIT = {
  signup: ['grid_signup', ['provider']],
  signin: ['grid_signin', ['provider']],
  'identity.link': ['grid_identity_linked', ['provider']],
  'device.allow': ['grid_device_allowed', []],
  'device.deny': ['grid_device_denied', []],
  'device.revoke': ['grid_device_revoked', []],
  'user.delete': ['grid_user_deleted', []],
  'signup.refused': ['grid_signup_refused', ['provider', 'reason']], // not in the audit table: no user
};

export function createGridTelemetry(cfg, { post = postBatch, now = () => Date.now(), env = process.env } = {}) {
  const on = cfg.telemetry === true && !/^(0|false|off)$/i.test(env.WISP_TELEMETRY || '') && !env.DO_NOT_TRACK;
  const queue = [];
  const who = (userId) => (userId ? `grid-${createHash('sha256').update(`wisp-grid:${userId}`).digest('hex').slice(0, 24)}` : 'grid-anonymous');
  const common = { $lib: 'wisp-grid', $process_person_profile: false, version: VERSION, driver: cfg.hostd?.driver, hosted: cfg.domain === 'grid.trywisp.dev' };

  function track(event, userId, props = {}) {
    if (!on) return;
    queue.push({ event, timestamp: new Date(now()).toISOString(), properties: { ...common, ...props, distinct_id: who(userId) } });
    if (queue.length >= 50) flush();
  }
  function flush() {
    if (queue.length) post(queue.splice(0)).catch?.(() => {});
  }
  const timer = on ? setInterval(flush, FLUSH_MS) : null;
  timer?.unref?.();

  // Box timings: from asking for it to its wisp answering, and how long it stayed up.
  const starting = new Map();
  const reasonOf = (r = '') => (r === 'idle' ? 'idle' : r === 'put to sleep' ? 'user' : r === 'grid stopped' ? 'grid' : r === 'deleted' ? 'deleted' : /^exited/.test(r) ? 'crashed' : 'other');

  return {
    on,
    track,
    audit(userId, action, meta = {}) {
      const m = FROM_AUDIT[action];
      if (m) track(m[0], userId, Object.fromEntries(m[1].filter((k) => meta[k] != null).map((k) => [k, meta[k]])));
    },
    box(e) {
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
    },
    close() {
      clearInterval(timer);
      flush();
    },
  };
}
