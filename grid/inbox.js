// Channels reaching a sleeping box. A channel posts to <handle>.<domain>/_in/<token>; the grid keeps
// the request, answers 200 at once, wakes the box and delivers it to POST /api/channels/inbound, in
// order and one at a time. The grid checks nothing a channel signed and reads nothing a person said:
// the box verifies each message itself (server/channels/). A row is held for an hour at most, and
// once delivered keeps only its event_key, which stops a sender's retry.
//
// A channel never keeps a box awake. A wake counts like a page opening it (same queue, may evict a
// quiet box), but delivering to a running box touches nothing: it goes back to sleep on its own idle
// timer, and a message that starts work keeps it up by that work alone. Anyone can message a bot, so
// that wake has to be earned: after wakeStrikes in a row with nothing the box accepted (a 2xx), one
// is a scheduled wake instead, behind people, evicting nobody, no use of the box, and at most one per
// wakeGapMs. The owner's own message then waits for the gap at worst; a page opening the box drains it.
//
// Nothing a message said goes to a log or to audit: channel and size only. The body and headers sit
// in the database in the clear until they're delivered, as the box's own files do on its disk.
//
// A channel here is a row of CHANNELS: what's worth keeping of its request, its event id, and which
// request can't be held (live): a sender checking its URL wants the box's answer in that same call.
// That goes through only to a box already up, and never wakes one: setup happens with wisp open, and
// a sender told 503 tries again.

import { createHash } from 'node:crypto';
import { sha256, token } from './secrets.js';

export const IN_PATH = /^\/_in\/([A-Za-z0-9_-]{32,64})$/;

const CHANNELS = {
  telegram: { headers: ['x-telegram-bot-api-secret-token'], eventId: (j) => j?.update_id },
  slack: { headers: ['x-slack-signature', 'x-slack-request-timestamp'], eventId: (j) => j?.event_id, live: (j) => j?.type === 'url_verification' },
};
const BODY_MAX = 256 * 1024;
const READ_MS = 15_000; // a body that takes longer isn't a webhook
const TTL_MS = 60 * 60_000; // a message this old is stale anyway (STALE_S)
const MAX_TRIES = 5;
const LIVE_MS = 2500; // Slack gives a URL check 3 s
const NOT_UP = { status: 503, body: { error: 'wisp is asleep: try again with it open.' } };
const DEFAULTS = { maxRows: 200, maxBytes: 2 * 1024 * 1024, ttlMs: TTL_MS, retryMs: 2000, wakeRetryMs: 30_000, wakeStrikes: 3, wakeGapMs: 10 * 60_000, sweepMs: 60_000 };

// The body, or null when it's over max (read to the end and dropped, so the 200 still gets there).
function readCapped(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let chunks = [];
    const timer = setTimeout(() => {
      reject(new Error('body too slow'));
      req.destroy();
    }, READ_MS);
    timer.unref?.();
    req.on('data', (c) => {
      size += c.length;
      if (size > max) chunks = null;
      else chunks?.push(c);
    });
    req.on('end', () => {
      clearTimeout(timer);
      resolve(chunks && Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const parsed = (body) => {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
};

// channel_inbox's key for a request: the channel's own event id, else the body's hash, and what it
// came with. An id alone could be taken: anyone holding the URL could post the next update_id with a
// bad secret, and the real update would hit that row and vanish. A retry that repeats both is the
// same row; one signed anew (Slack may) is a row of its own, and the box's seen list stops it.
function eventKey(channel, j, body, headers) {
  const id = CHANNELS[channel].eventId(j);
  return `${channel}:${id ?? createHash('sha256').update(body).digest('base64url')}:${sha256(headers)}`;
}

export function createInbox({ db, cfg, secrets, accounts, hostd, deliver, log = () => {} }) {
  const opts = { ...DEFAULTS, ...cfg.channels };
  const on = opts.enabled === true;
  const busy = new Map(); // user id -> the drain running
  const timers = new Map(); // user id -> the next try
  const wakes = new Map(); // user id -> { strikes, at }: wakes since a message the box accepted, the last one's time
  let stopped = false;

  const pending = (userId) => db.get('SELECT count(*) n, coalesce(sum(size), 0) bytes FROM channel_inbox WHERE user_id = ? AND done_at IS NULL', userId);
  const count = (userId, channel) => db.run('UPDATE channel_urls SET dropped = dropped + 1 WHERE user_id = ? AND channel = ?', userId, channel);
  const lost = (userId, channel, size, why) => {
    count(userId, channel);
    accounts.audit(userId, 'channel.drop', { channel, size, why });
    log(`grid: inbox dropped ${size} bytes of ${channel} (${why})`);
  };
  const finish = (id) => db.run("UPDATE channel_inbox SET done_at = ?, body = x'', headers = '{}' WHERE id = ?", Date.now(), id);

  const later = (user, ms) => {
    clearTimeout(timers.get(user.id));
    const t = setTimeout(() => {
      timers.delete(user.id);
      drain(user);
    }, ms);
    t.unref?.();
    timers.set(user.id, t);
  };

  function failed(row, user) {
    const tries = row.tries + 1;
    if (tries >= MAX_TRIES) {
      finish(row.id);
      lost(row.user_id, row.channel, row.size, 'tries');
      later(user, 0); // what's behind it was waiting its turn
      return;
    }
    const next = opts.retryMs * 2 ** (tries - 1);
    db.run('UPDATE channel_inbox SET tries = ?, next_at = ? WHERE id = ?', tries, Date.now() + next, row.id);
    later(user, next);
  }

  async function run(user) {
    const fresh = accounts.userById(user.id);
    if (!fresh || fresh.disabled) return;
    for (;;) {
      if (stopped) return;
      const row = db.get('SELECT * FROM channel_inbox WHERE user_id = ? AND done_at IS NULL ORDER BY id LIMIT 1', user.id);
      if (!row) return;
      const wait = row.next_at - Date.now();
      if (wait > 0) return later(user, wait); // strictly in order: nothing passes a row being retried
      if (hostd.state(user.id) !== 'running') {
        const w = wakes.get(user.id) || { strikes: 0, at: 0 };
        const cold = w.strikes >= opts.wakeStrikes;
        const wait = cold ? w.at + opts.wakeGapMs - Date.now() : 0;
        if (wait > 0) return later(user, wait);
        try {
          await hostd.ensure(fresh, { wake: cold });
        } catch (err) {
          // Full, or it wouldn't start: not the message's fault. It stays held until its hour is up.
          if (!stopped) log(`grid: inbox can't wake ${user.handle} yet: ${err.message}`);
          if (!stopped) later(user, opts.wakeRetryMs);
          return;
        }
        wakes.set(user.id, { strikes: w.strikes + 1, at: Date.now() });
        continue;
      }
      const port = hostd.port(user.id);
      if (!port) {
        later(user, opts.retryMs);
        return;
      }
      const dropped = db.get('SELECT dropped FROM channel_urls WHERE user_id = ? AND channel = ?', user.id, row.channel)?.dropped || 0;
      const done = hostd.begin(user.id, { touch: false }); // not stopped under it, and it isn't use
      let status = 0;
      try {
        ({ status } = await deliver(port, fresh, { channel: row.channel, headers: JSON.parse(row.headers), body: Buffer.from(row.body).toString('base64'), at: row.at, dropped }));
      } catch {}
      done();
      if (stopped) return;
      const ok = status >= 200 && status < 300;
      if (ok) wakes.delete(user.id);
      if (ok && dropped) db.run('UPDATE channel_urls SET dropped = max(0, dropped - ?) WHERE user_id = ? AND channel = ?', dropped, user.id, row.channel);
      // 4xx: the box read it and said no (a bad signature, a stranger, the channel switched off). Retrying can't help.
      if (ok || (status >= 400 && status < 500)) {
        finish(row.id);
        if (!ok) log(`grid: inbox ${row.channel}, ${row.size} bytes refused by the box (${status})`);
        continue;
      }
      failed(row, user);
      return;
    }
  }

  function drain(user) {
    if (!on || stopped) return Promise.resolve();
    if (busy.has(user.id)) return busy.get(user.id);
    const p = run(user)
      .catch((err) => log(`grid: inbox for ${user.handle}: ${err.message}`))
      .finally(() => busy.delete(user.id));
    busy.set(user.id, p);
    return p;
  }

  // The box's answer to the sender, for a request that can't wait. Asleep or starting: not now.
  async function live(user, channel, headers, body) {
    const port = hostd.state(user.id) === 'running' && hostd.port(user.id);
    if (!port) return NOT_UP;
    const done = hostd.begin(user.id, { touch: false });
    try {
      const out = await deliver(port, user, { channel, headers, body: body.toString('base64'), at: Date.now() }, { timeout: opts.liveMs ?? LIVE_MS });
      return out.status < 500 ? out : NOT_UP;
    } catch {
      return NOT_UP;
    } finally {
      done();
    }
  }

  // Past their hour: gone. One that never got there counts as lost; a delivered one just stops
  // guarding against a retry.
  function sweep() {
    const before = Date.now() - opts.ttlMs;
    for (const r of db.all('SELECT user_id, channel, size FROM channel_inbox WHERE at < ? AND done_at IS NULL', before)) lost(r.user_id, r.channel, r.size, 'expired');
    db.run('DELETE FROM channel_inbox WHERE at < ?', before);
  }

  // Switched off too: what it held stays in the clear until this takes it.
  const sweeper = setInterval(() => {
    try {
      sweep();
    } catch (err) {
      log(`grid: inbox sweep: ${err.message}`);
    }
  }, opts.sweepMs);
  sweeper.unref?.();

  return {
    on,
    opts,
    drain,
    sweep,
    knows: (channel) => Object.hasOwn(CHANNELS, String(channel)),

    // { url, dropped }: this user's own, made the first time. dropped: lost messages it hasn't been
    // told of, which this tells it. The token is kept sealed, so a box asking again gets the same URL.
    urlFor(user, channel) {
      const sealed = secrets.ensure(user.id, `channel:${channel}`);
      db.run('INSERT INTO channel_urls (user_id, channel, token_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, channel) DO UPDATE SET token_hash = excluded.token_hash', user.id, channel, sha256(sealed), Date.now());
      const { dropped } = db.get('SELECT dropped FROM channel_urls WHERE user_id = ? AND channel = ?', user.id, channel);
      if (dropped) db.run('UPDATE channel_urls SET dropped = 0 WHERE user_id = ? AND channel = ?', user.id, channel);
      return { url: `${cfg.instanceUrl(user.handle)}/_in/${sealed}`, dropped };
    },

    // A new URL for a leaked one: the old token stops here. What's held and counted stays, and a box
    // can do this freely: all it can reach is its own URL. The seal is the truth: urlFor puts the
    // hash right if a crash comes between these two.
    rotate(user, channel) {
      const fresh = token('', 32);
      secrets.seal(user.id, `channel:${channel}`, fresh);
      db.run('UPDATE channel_urls SET token_hash = ? WHERE user_id = ? AND channel = ?', sha256(fresh), user.id, channel);
      return { url: `${cfg.instanceUrl(user.handle)}/_in/${fresh}` };
    },

    byToken: (t) => db.get('SELECT user_id, channel FROM channel_urls WHERE token_hash = ?', sha256(t)) || null,

    // Keep what came, and say so; the wake happens after the answer has left. Too big, or over the
    // caps: dropped and counted, still a 200, since a retry storm from the sender helps nobody.
    // → { status, body } when the box answers this one itself, or nothing: held.
    async accept(user, channel, req) {
      const body = await readCapped(req, BODY_MAX);
      if (!body) {
        count(user.id, channel);
        return;
      }
      const row = CHANNELS[channel];
      const kept = Object.fromEntries(row.headers.filter((h) => typeof req.headers[h] === 'string').map((h) => [h, req.headers[h]]));
      const j = parsed(body);
      if (row.live?.(j)) return live(user, channel, kept, body);
      const headers = JSON.stringify(kept);
      const size = body.length + headers.length;
      const held = pending(user.id);
      if (held.n >= opts.maxRows || held.bytes + size > opts.maxBytes) {
        count(user.id, channel);
        return;
      }
      db.run('INSERT INTO channel_inbox (user_id, channel, event_key, headers, body, size, at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, event_key) DO NOTHING', user.id, channel, eventKey(channel, j, body, headers), headers, body, size, Date.now());
      setImmediate(() => drain(user));
    },

    // After a restart: everyone with something held.
    resume() {
      sweep();
      if (!on) return;
      for (const r of db.all('SELECT DISTINCT user_id FROM channel_inbox WHERE done_at IS NULL')) {
        const u = accounts.userById(r.user_id);
        if (u) drain(u);
      }
    },

    stop() {
      stopped = true;
      clearInterval(sweeper);
      for (const t of timers.values()) clearTimeout(t);
    },
    settled: () => Promise.all(busy.values()),
  };
}
