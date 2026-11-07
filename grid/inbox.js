// Channels reaching a sleeping box. A channel posts to <handle>.<domain>/_in/<token>; the grid keeps
// the request, answers 200 at once, wakes the box and delivers it to POST /api/channels/inbound, in
// order and one at a time. The grid reads nothing a person said, and but for a channel with an edge
// checks nothing it signed: the box verifies each message itself (server/channels/). A row is held for
// an hour at most, and once delivered keeps only its event_key, which stops a sender's retry.
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
// a sender told 503 tries again. skip is what no box acts on, so it isn't held: a wake for it would
// be refused and count as a strike. It's unsigned here, but forging one only drops the forger's own
// request.
// Mail is one too, but it has no webhook of its own: one provider's for everybody (grid/mail.js),
// which checks it and calls hold(). Its token is an address, so it can't be posted to at /_in/.
//
// A row may also have an edge, if its sender wants a real answer in the same call, sooner than a box
// can wake. That's the only thing here with a key, which the box sets over its Box secret (setKey): a
// public one, and what it lets through reaches that same box. Because of that a channel with an edge
// reaches a box and never a computer: a computer has no Box secret to set it with.

import { createHash, randomBytes } from 'node:crypto';
import { discordEdge, isPublicKey } from '../server/channels/discord-sign.js';
import { sha256, token } from './secrets.js';

export const IN_PATH = /^\/_in\/([A-Za-z0-9_-]{32,64})$/;

// Slack posts an edit, a deletion and wisp's own replies like any message; a file is the one subtype
// that is someone speaking (#event, server/channels/slack.js).
const slackNoise = (e) => !!e && (!!e.bot_id || (!!e.subtype && e.subtype !== 'file_share'));

const CHANNELS = {
  telegram: { headers: ['x-telegram-bot-api-secret-token'], eventId: (j) => j?.update_id },
  slack: { headers: ['x-slack-signature', 'x-slack-request-timestamp'], eventId: (j) => j?.event_id, live: (j) => j?.type === 'url_verification', skip: (j) => slackNoise(j?.event) },
  // Lower case: mail systems may fold a local part. 160 bits, and it fits one (64 characters at most).
  email: { headers: [], eventId: (j) => j?.messageId || undefined, mint: () => randomBytes(20).toString('hex') },
  discord: { headers: ['x-signature-ed25519', 'x-signature-timestamp'], eventId: (j) => j?.id, edge: discordEdge, ttlMs: 15 * 60_000 }, // an interaction's token is dead by then
};
export const BODY_MAX = 256 * 1024;
const READ_MS = 15_000; // a body that takes longer isn't a webhook
const TTL_MS = 60 * 60_000; // a message this old is stale anyway (STALE_S)
const MAX_TRIES = 5;
const LIVE_MS = 2500; // Slack gives a URL check 3 s
const EDGE_LIVE_MS = 2500; // Discord gives an answer 3 s
const NOT_UP = { status: 503, body: { error: 'wisp is asleep: try again with it open.' } };
const LINKED_MAX = 500;
const HASH = /^[0-9a-f]{64}$/;
const DEFAULTS = { maxRows: 200, maxBytes: 2 * 1024 * 1024, ttlMs: TTL_MS, retryMs: 2000, wakeRetryMs: 30_000, wakeStrikes: 3, wakeGapMs: 10 * 60_000, sweepMs: 60_000 };

// The body, or null when it's over max (read to the end and dropped, so the 200 still gets there).
export function readCapped(req, max) {
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
// same row; one signed anew (Slack may) is a row of its own, and the box's seen list stops it. With
// an edge the id was verified here, so it's the key alone: a signature can be spelt more than one way.
function eventKey(channel, j, body, headers) {
  const id = CHANNELS[channel].eventId(j);
  if (CHANNELS[channel].edge && id) return `${channel}:${id}`;
  return `${channel}:${id ?? createHash('sha256').update(body).digest('base64url')}:${sha256(headers)}`;
}

export function createInbox({ db, cfg, secrets, accounts, hostd, deliver, delivered = () => {}, limit = () => {}, log = () => {} }) {
  const opts = { ...DEFAULTS, ...cfg.channels };
  const on = opts.enabled === true;
  const busy = new Map(); // user id -> the drain running
  const timers = new Map(); // user id -> the next try
  const wakes = new Map(); // user id -> { strikes, at }: wakes since a message the box accepted, the last one's time
  const sending = new Map(); // user id -> the delivery on its way to the box
  let stopped = false;

  const where = (user, channel, t) => (channel === 'email' ? { address: `${t}@${cfg.mail.domain}` } : { url: `${cfg.instanceUrl(user.handle)}/_in/${t}` });
  const pending = (userId) => db.get('SELECT count(*) n, coalesce(sum(size), 0) bytes FROM channel_inbox WHERE user_id = ? AND done_at IS NULL', userId);
  const count = (userId, channel) => db.run('UPDATE channel_urls SET dropped = dropped + 1 WHERE user_id = ? AND channel = ?', userId, channel);
  const lost = (userId, channel, size, why) => {
    count(userId, channel);
    accounts.audit(userId, 'channel.drop', { channel, size, why });
    log(`grid: inbox dropped ${size} bytes of ${channel} (${why})`);
  };
  const linkedOf = (user, channel) => {
    const kept = secrets.open(user.id, `channel-linked:${channel}`);
    return kept ? JSON.parse(kept) : null;
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
      let landed;
      sending.set(user.id, new Promise((r) => (landed = r)));
      try {
        ({ status } = await deliver(port, fresh, { channel: row.channel, headers: JSON.parse(row.headers), body: Buffer.from(row.body).toString('base64'), at: row.at, dropped, ...(row.verified && { verified: true }) }));
      } catch {}
      done();
      const ok = status >= 200 && status < 300;
      try {
        if (ok) delivered(row);
      } catch (err) {
        log(`grid: inbox after ${row.channel}: ${err.message}`);
      }
      sending.delete(user.id);
      landed();
      if (stopped) return;
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

  // A box that's up answers this itself; asleep or failing, the edge's own answer stands.
  async function passLive(user, channel, headers, body, fallback) {
    const port = hostd.state(user.id) === 'running' && hostd.port(user.id);
    if (!port) return fallback;
    const done = hostd.begin(user.id, { touch: false });
    try {
      const out = await deliver(port, user, { channel, headers, body: body.toString('base64'), at: Date.now() }, { timeout: opts.liveMs ?? EDGE_LIVE_MS });
      return out.status >= 200 && out.status < 300 && out.body?.type === fallback.body.type ? out : fallback; // only an answer of the kind the sender wants
    } catch {
      return fallback;
    } finally {
      done();
    }
  }

  // Past their hour, or their channel's own time: gone. One that never got there counts as lost; a
  // delivered one just stops guarding against a retry.
  function sweep() {
    const now = Date.now();
    for (const { channel } of db.all('SELECT DISTINCT channel FROM channel_inbox')) {
      const before = now - Math.min(CHANNELS[channel]?.ttlMs ?? opts.ttlMs, opts.ttlMs);
      for (const r of db.all('SELECT user_id, size FROM channel_inbox WHERE channel = ? AND at < ? AND done_at IS NULL', channel, before)) lost(r.user_id, channel, r.size, 'expired');
      db.run('DELETE FROM channel_inbox WHERE channel = ? AND at < ?', channel, before);
    }
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
    knows: (channel) => Object.hasOwn(CHANNELS, String(channel)) && (channel !== 'email' || !!cfg.mail),
    read: readCapped,
    delivering: (userId) => sending.get(userId),

    // The key this user's edge checks with, or none ('') to refuse everything: set by this user's
    // own box, so it can only ever open that box's URL. linked: hashes of who's linked there, for the
    // edge; none from a box that doesn't send them, and everything's held for it, as it always was.
    setKey(user, channel, key, linked) {
      if (!CHANNELS[channel].edge) throw Object.assign(new Error('not found'), { status: 404 });
      if (key === '') {
        secrets.drop(user.id, `channel-linked:${channel}`);
        return secrets.drop(user.id, `channel-key:${channel}`);
      }
      if (!isPublicKey(key)) throw Object.assign(new Error('A public key is 64 hex characters.'), { status: 400 });
      if (linked !== undefined && !(Array.isArray(linked) && linked.length <= LINKED_MAX && linked.every((h) => typeof h === 'string' && HASH.test(h)))) throw Object.assign(new Error('Who’s linked is a list of hashes.'), { status: 400 });
      secrets.seal(user.id, `channel-key:${channel}`, key.toLowerCase());
      if (linked) secrets.seal(user.id, `channel-linked:${channel}`, JSON.stringify(linked));
      else secrets.drop(user.id, `channel-linked:${channel}`);
    },

    edged: (channel) => !!CHANNELS[channel].edge,

    // { url, dropped }: this user's own, made the first time ({ address, dropped } for mail). dropped:
    // lost messages it hasn't been told of, which this tells it. The token is kept sealed, so a box
    // asking again gets the same URL.
    urlFor(user, channel) {
      const sealed = secrets.ensure(user.id, `channel:${channel}`, CHANNELS[channel].mint);
      db.run('INSERT INTO channel_urls (user_id, channel, token_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, channel) DO UPDATE SET token_hash = excluded.token_hash', user.id, channel, sha256(sealed), Date.now());
      const { dropped } = db.get('SELECT dropped FROM channel_urls WHERE user_id = ? AND channel = ?', user.id, channel);
      if (dropped) db.run('UPDATE channel_urls SET dropped = 0 WHERE user_id = ? AND channel = ?', user.id, channel);
      return { ...where(user, channel, sealed), dropped };
    },

    addressOf: (user) => where(user, 'email', secrets.ensure(user.id, 'channel:email', CHANNELS.email.mint)).address,

    // A new URL for a leaked one: the old token stops here. What's held and counted stays, and a box
    // can do this freely: all it can reach is its own URL. The seal is the truth: urlFor puts the
    // hash right if a crash comes between these two.
    rotate(user, channel) {
      const fresh = CHANNELS[channel].mint?.() ?? token('', 32);
      secrets.seal(user.id, `channel:${channel}`, fresh);
      db.run('UPDATE channel_urls SET token_hash = ? WHERE user_id = ? AND channel = ?', sha256(fresh), user.id, channel);
      return where(user, channel, fresh);
    },

    byToken: (t) => db.get("SELECT user_id, channel FROM channel_urls WHERE token_hash = ? AND channel != 'email'", sha256(t)) || null,
    byAddress: (local) => db.get("SELECT user_id FROM channel_urls WHERE token_hash = ? AND channel = 'email'", sha256(local)) || null,

    // Keep what came, and say so; the wake happens after the answer has left. Too big, or over the
    // caps: dropped and counted, still a 200, since a retry storm from the sender helps nobody.
    // → { status, body } when the sender gets more than that 200 (the box's own answer to a live
    // request, or an edge's), or nothing: held.
    async accept(user, channel, req) {
      const row = CHANNELS[channel];
      const body = await readCapped(req, BODY_MAX);
      const edge = row.edge?.({ key: secrets.open(user.id, `channel-key:${channel}`), linked: linkedOf(user, channel), raw: body, headers: req.headers });
      if (edge?.bucket) {
        try {
          limit(`intok|${user.id}|${channel}|${edge.bucket}`, edge.perMinute);
        } catch (err) {
          if (err.status !== 429) throw err;
          return edge.busy;
        }
      }
      if (edge && !edge.hold && !edge.live) return edge;
      if (!body) {
        count(user.id, channel);
        return;
      }
      const kept = Object.fromEntries(row.headers.filter((h) => typeof req.headers[h] === 'string').map((h) => [h, req.headers[h]]));
      if (edge?.live) return passLive(user, channel, kept, body, edge);
      const j = parsed(body);
      if (row.live?.(j)) return live(user, channel, kept, body);
      if (row.skip?.(j)) return;
      if (!this.hold(user, channel, body, { headers: kept, j })) return edge?.busy;
      return edge;
    },

    // verified: the grid checked this one itself (grid/route.js), and it has no secret the box knows.
    // Only the grid's own code sets it: nothing from a request does. → false when it was dropped.
    hold(user, channel, body, { headers: kept = {}, verified = false, j = parsed(body) } = {}) {
      if (!body) {
        count(user.id, channel);
        return false;
      }
      const headers = JSON.stringify(kept);
      const size = body.length + headers.length;
      const held = pending(user.id);
      if (held.n >= opts.maxRows || held.bytes + size > opts.maxBytes) {
        count(user.id, channel);
        return false;
      }
      db.run('INSERT INTO channel_inbox (user_id, channel, event_key, headers, body, size, at, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, event_key) DO NOTHING', user.id, channel, eventKey(channel, j, body, headers), headers, body, size, Date.now(), verified ? 1 : 0);
      setImmediate(() => drain(user));
      return true;
    },

    // True the first time a key comes by, for the hour a row lasts: a sender's retry stops here.
    first(userId, key) {
      return db.run("INSERT INTO channel_inbox (user_id, channel, event_key, headers, body, size, at, done_at) VALUES (?, 'seen', ?, '{}', x'', 0, ?, ?) ON CONFLICT(user_id, event_key) DO NOTHING", userId, key, Date.now(), Date.now()).changes > 0;
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
