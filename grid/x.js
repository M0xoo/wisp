// X on a grid: someone who linked their account posts `@wispbot fix the flaky login test`, their box
// wakes and runs it, one fixed line answers in public, and the result comes by DM. Off unless grid.json
// has X's credentials, and that needs `channels` (grid/inbox.js): a post comes in like any channel's
// message, held, and delivered to a box that may be asleep. Everything against a fake so far
// (test/fixtures/fake-x.mjs): readEvent is the one place that knows a live event's shape.
//
// Everything here is at the edge because a box can't be trusted with it:
//   - Who a post is from. X signs each webhook; only this file writes the x-wisp-x-* headers a box goes
//     by, from the numeric id of an author someone linked here. A stranger gets silence, not even a
//     reply, and costs a count. Only that author's text, minus the bot's own mention, is kept: a
//     quoted post, the thread above and includes are never read.
//   - What's said in public. X allows one reply per interaction, and AI-written replies need its
//     approval, so a public post is a key of PUBLIC and nothing else: no repo, no file, no agent text.
//     A post that holds a URL can cost $0.20, so no URLs either.
//   - Who a box can write to. The Box secret can be read by anything on the box, so sending takes a
//     thread and text and refuses anything else: a thread exists once its box accepted a message (a
//     2xx), and the recipient comes from the link. DMs never fall back to a public post.
//   - What a day costs. Anyone can mention the bot, and X bills for it, so strangers count in a pool of
//     their own: they can't spend what linked people's replies need. dailySpendCents is linked people's,
//     and past it nothing goes out or wakes until 00:00 UTC. X keeps billing whatever it delivers, so
//     strangerSpendCents, and twice dailySpendCents, are hard: the subscriptions are taken away, and
//     a person restores them with a restart. No box can spend more than piecesPerDay.
//
// A link isn't an identity. identities is what signs in, what isAdmin and allow lists read: x_links
// has none of that, so taking over an X account reaches a box, as it must, and never a grid account.
// The flow is kept here, not in a cookie: it's bound to the session that started it from the account
// page, so nothing a box serves can plant one. X's tokens are used once, to read the numeric id, and
// handed back. None are kept, so none can leak.
//
// Nothing a message said goes to a log or to audit. A result waits in x_outbox while it can't go (the
// DM isn't open, the day's money is gone, X said 429), in the clear, already scrubbed, until its thread
// expires: as the held inbox does, it sits where the box's own files would.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { scrubOut, STALE_S } from '../server/channels/policy.js';
import { b64u, sha256, token } from './secrets.js';

export const X_WEBHOOK = '/_x/webhook';
export const FROM_HEADER = 'x-wisp-x-sender';
export const ID_HEADER = 'x-wisp-x-id';
export const THREAD_HEADER = 'x-wisp-x-thread';
export const CONVERSATION_HEADER = 'x-wisp-x-conversation';
export const NEW_HEADER = 'x-wisp-x-new'; // '1': this is what started a task
const SIGNATURE = 'x-twitter-webhooks-signature-oauth2';
const LEGACY_SIGNATURE = 'x-twitter-webhooks-signature';

// What goes on X in public, all of it. A reply takes a key of this, never a string.
export const PUBLIC = Object.freeze({
  ack: 'Got it. The result comes by DM.',
  ackDm: 'Got it. DM me once for the result. Until then it waits in wisp, and nothing is lost.',
  limited: 'That’s a lot of requests. Try again in an hour.',
});

// What the grid itself says in a DM. A box's words come through reply().
export const DM = Object.freeze({
  open: 'You’re set: results come here. Send stop to unlink.',
  noTask: 'There’s no task to follow up on yet. Mention me in a post to start one, or send stop to unlink.',
  limited: 'That’s a lot of messages. Try again in an hour.',
  off: 'X is off on your wisp, so that didn’t run. Turn it on in Settings → Phone → X, then send it again.',
  truncated: 'That post was too long for me to read all of it, so it didn’t run. Send it again in fewer words.',
  stop: 'Unlinked: your posts no longer reach wisp, and nothing more comes here. Link again on your wisp account page.',
});

export const COST = Object.freeze({ post: 5, dmIn: 10, reply: 10, dmOut: 15 }); // tenths of a cent
export const TRIES_429 = 4; // of one DM: X's limit may not lift for hours, and the result stays in wisp
export const PER_IP = 1200; // webhooks a minute from one address, before anything is read

const WEBHOOK_MAX = 512 * 1024;
const SCOPES = 'users.read tweet.read';
const FLOW_MS = 10 * 60_000;
const SEEN_MS = 2 * 86_400_000; // past this the post is stale anyway
const STALE_MS = STALE_S * 1000;
const REPLY_MAX = 40 * 1024; // the box stops at 30 000 characters
const DM_MAX = 9500; // X's limit is 10 000: room for a line break's luck
const TEXT_MAX = 25_000;
const SEND_TRIES = 3;
const RETRY_MS = 60_000; // a 429 with no Retry-After, a refusal
const BROKEN_MS = 2000; // a connection that broke: nobody refused anything
const SWEEP_MS = 60_000;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULTS = { sendPerHour: 30, postsPerHour: 20, threadDays: 7, piecesPerDay: 60, outboxRows: 50, outboxBytes: 256 * 1024 };

const EVENTS = ['post.mention.create', 'post.reply.create', 'dm.received'];

const refused = (message, status) => Object.assign(new Error(message), { status });

// --- X's wire -------------------------------------------------------------------------------------

// The CRC signs what it's given with the key events are signed with, so what it may be given has to
// be something no event can be. An event is a JSON object: X's tokens are base64, and `{` isn't in that.
const CRC_TOKEN = /^[A-Za-z0-9+/=_-]{1,256}$/;
export const crcShaped = (s) => typeof s === 'string' && CRC_TOKEN.test(s);
const isObject = (raw) => raw[0] === 0x7b; // `{`

export const crcAnswer = (crcToken, secret) => `sha256=${createHmac('sha256', secret).update(crcToken).digest('base64')}`;

function signed(raw, header, secret) {
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('base64')}`);
  const got = Buffer.from(String(header));
  return got.length === want.length && timingSafeEqual(got, want);
}

// The recommended header decides whenever it's there; the legacy one is keyed with the consumer secret.
export function verified(raw, headers, { clientSecret, consumerSecret }) {
  if (headers[SIGNATURE] !== undefined) return signed(raw, headers[SIGNATURE], clientSecret);
  return headers[LEGACY_SIGNATURE] !== undefined && signed(raw, headers[LEGACY_SIGNATURE], consumerSecret);
}

// The only code that knows an event's shape, so a live one that differs is one edit. Reads nothing but
// what's named here. → { id, kind: 'post' | 'dm', ... }, or null for what wisp doesn't take.
export function readEvent(raw) {
  let d;
  try {
    d = JSON.parse(raw.toString('utf8'))?.data;
  } catch {
    return null;
  }
  if (!d || typeof d.event_uuid !== 'string' || !d.event_uuid) return null;
  const p = d.payload;
  if (d.event_type === 'post.mention.create' || d.event_type === 'post.reply.create') {
    if (!p?.id || !p.author_id || typeof p.text !== 'string') return null;
    const refs = Array.isArray(p.referenced_tweets) ? p.referenced_tweets : [];
    return {
      id: d.event_uuid,
      kind: 'post',
      post: String(p.id),
      sender: String(p.author_id),
      conversation: String(p.conversation_id || p.id),
      text: p.text,
      at: Date.parse(p.created_at),
      range: Array.isArray(p.display_text_range) ? p.display_text_range : null, // where a reply's prefix ends
      retweet: refs.some((r) => r?.type === 'retweeted') || /^RT @/.test(p.text),
      truncated: p.truncated === true || !!p.note_tweet, // `text` is the start of a long post
    };
  }
  if (d.event_type === 'dm.received') {
    const e = p?.direct_message_events?.[0];
    const m = e?.message_create;
    if (!e?.id || !m?.sender_id || typeof m.message_data?.text !== 'string') return null;
    return { id: d.event_uuid, kind: 'dm', dm: String(e.id), sender: String(m.sender_id), recipient: String(m.target?.recipient_id ?? ''), text: m.message_data.text, at: Number(e.created_timestamp) };
  }
  return null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>' };

// A post's words: X escapes these three, and neither the bot's own mention nor a reply's prefix is
// part of what was asked. `@alice fix it` in a reply to Alice would otherwise read as a name in wisp's
// grammar. range: display_text_range, in code points of the text as X sent it; with none, leading
// handles go, whoever they are.
export function ownWords(text, handle, range = null) {
  const bot = new RegExp(`(^|[^\\w@])@${handle.replace(/\W/g, '')}(?!\\w)[\\s,:]*`, 'gi');
  const shown = range ? [...String(text)].slice(range[0], range[1]).join('') : String(text);
  const words = shown
    .replace(/&(amp|lt|gt);/g, (_, e) => ENTITIES[e])
    .replace(bot, '$1')
    .trim();
  return range ? words : words.replace(/^(?:@\w+[\s,:]*)+/, '');
}

// RFC 5849, for a JSON POST (the body isn't signed). The bot posts as itself: 1.0a tokens don't expire
// and fit grid.json, where an OAuth 2.0 one would need its refresh written back every two hours.
const pct = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export function oauth1(url, bot, { nonce = randomBytes(16).toString('hex'), now = Date.now() } = {}) {
  const p = { oauth_consumer_key: bot.consumerKey, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: String(Math.floor(now / 1000)), oauth_token: bot.accessToken, oauth_version: '1.0' };
  const params = Object.entries(p).map(([k, v]) => `${pct(k)}=${pct(v)}`).sort().join('&');
  const base = ['POST', pct(url), pct(params)].join('&');
  const signature = createHmac('sha1', `${pct(bot.consumerSecret)}&${pct(bot.accessSecret)}`).update(base).digest('base64');
  return `OAuth ${Object.entries({ ...p, oauth_signature: signature }).map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(', ')}`;
}

// Text in pieces X will take: at a line, if one's near the end, and never through a surrogate pair.
export function chunks(text, max = DM_MAX) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = /[\ud800-\udbff]/.test(rest[max - 1]) ? max - 1 : max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}

// --- the grid's side -------------------------------------------------------------------------------

export function createX({ db, cfg, inbox, accounts, log = () => {} }) {
  const opts = { ...DEFAULTS, ...cfg.x };
  const { bot } = opts;
  const api = opts.api;
  const authorizeUrl = opts.api === 'https://api.x.com' ? 'https://x.com/i/oauth2/authorize' : `${opts.api}/i/oauth2/authorize`;
  const redirectUri = `${cfg.publicUrl}/account/x/callback`;
  const cap = opts.dailySpendCents * 10;
  const sends = new Set(); // sends on their way, so close() can wait for them
  const pumping = new Map(); // user id -> the outbox being sent
  const again = new Set(); // user ids with more for it than it knew
  const timers = new Map(); // user id -> the outbox's next try
  let stopped = false;

  const threadsLive = () => Date.now() - opts.threadDays * DAY_MS;
  const today = () => new Date().toISOString().slice(0, 10);
  const linkOf = (userId) => db.get('SELECT * FROM x_links WHERE user_id = ?', userId);
  const linkByX = (xId) => db.get('SELECT * FROM x_links WHERE x_id = ?', xId);
  const track = (p) => {
    sends.add(p);
    p.finally(() => sends.delete(p));
    return p;
  };

  // --- spend: a row a UTC day, in tenths of a cent ---------------------------------------------------

  const day = () => db.get('SELECT * FROM x_spend WHERE day = ?', today());
  const spent = () => day()?.mills || 0;
  const charge = (mills) => db.run('INSERT INTO x_spend (day, mills) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET mills = mills + excluded.mills', today(), mills);
  const refund = (mills) => db.run('UPDATE x_spend SET mills = max(0, mills - ?) WHERE day = ?', mills, today());

  function trip() {
    db.run('INSERT INTO x_spend (day, mills) VALUES (?, 0) ON CONFLICT(day) DO NOTHING', today());
    if (!db.run('UPDATE x_spend SET tripped = 1 WHERE day = ? AND tripped = 0', today()).changes) return;
    accounts.audit(null, 'x.cap', { day: today(), cents: opts.dailySpendCents });
    log(`grid: X reached its daily spend cap (${opts.dailySpendCents}¢): no replies, no DMs and no wakes until 00:00 UTC.`);
  }

  // X bills what it delivers, whatever wisp does with it: the only way to stop that is to stop listening.
  function stopListening(why) {
    if (!db.run('UPDATE x_spend SET hard = 1 WHERE day = ? AND hard = 0', today()).changes) return;
    accounts.audit(null, 'x.hard', { day: today(), why });
    log(`grid: X stopped listening: ${why} passed its ceiling, so its subscriptions are removed and X bills nothing more. To restore them, wait for 00:00 UTC or raise the ceiling in grid.json, then restart the grid.`);
    track(unsubscribe().catch((err) => log(`grid: X: the subscriptions are still there: ${err.message}. It tries again every minute.`)));
  }

  // Everything that costs money asks here first. No await between the check and the count, so a burst
  // can't pass it: at most one event's worth over, from an inbound X has already billed.
  function reserve(mills) {
    if (spent() + mills > cap) {
      trip();
      return false;
    }
    charge(mills);
    return true;
  }

  // Inbound is billed whether anyone likes it or not: all that's left to decide is what happens next.
  function billed(mills) {
    charge(mills);
    if (spent() >= cap * 2) stopListening('what linked people cost');
    if (spent() < cap) return false;
    trip();
    return true;
  }

  // Strangers and the bot's own posts: a pool of their own. Who's asking isn't known until the link is.
  function billedApart(mills, { person = false } = {}) {
    db.run('INSERT INTO x_spend (day, stranger_mills, strangers) VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET stranger_mills = stranger_mills + excluded.stranger_mills, strangers = strangers + excluded.strangers', today(), mills, person ? 1 : 0);
    if (day().stranger_mills >= opts.strangerSpendCents * 10) stopListening('what strangers cost');
  }

  // --- what goes out --------------------------------------------------------------------------------

  async function post(path, body, auth) {
    const r = await fetch(`${api}${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json', authorization: auth }, body: JSON.stringify(body) });
    if (!r.ok) throw Object.assign(new Error(`X said ${r.status}`), { status: r.status, retryAfter: Number(r.headers.get('retry-after')) || 0 });
    return r.json().catch(() => ({}));
  }

  // The one way anything reaches the timeline. The post was recorded when it was first seen, so
  // whatever becomes of this, a retry of the event can't send it again.
  function publicReply(postId, key) {
    return track(
      post('/2/tweets', { text: PUBLIC[key], reply: { in_reply_to_tweet_id: postId } }, oauth1(`${api}/2/tweets`, bot)).catch((err) => {
        if (err.status) refund(COST.reply); // refused: X billed nothing. A broken connection may have got there.
        log(`grid: X: a public reply didn’t go: ${err.message}`);
      }),
    );
  }

  const sendDm = (xId, text) => post(`/2/dm_conversations/with/${encodeURIComponent(xId)}/messages`, { text }, oauth1(`${api}/2/dm_conversations/with/${encodeURIComponent(xId)}/messages`, bot));

  const queue = (userId, thread, text) => {
    for (const piece of chunks(text)) db.run('INSERT INTO x_outbox (user_id, thread, text, at) VALUES (?, ?, ?, ?)', userId, thread, piece, Date.now());
  };

  // Strictly in order, or a long report's pieces could pass each other. One at a time, for as long as
  // it can. Whatever stops it, the row stays: the next DM, the next day or a timer carries on, and it
  // goes when its thread does.
  async function send(userId) {
    for (;;) {
      if (stopped || opts.paused) return;
      const link = linkOf(userId);
      if (!link?.dm_open) return;
      const row = db.get('SELECT * FROM x_outbox WHERE user_id = ? ORDER BY id LIMIT 1', userId);
      if (!row) return;
      const wait = row.next_at - Date.now();
      if (wait > 0) return later(userId, wait);
      if (!reserve(COST.dmOut)) return;
      try {
        await sendDm(link.x_id, row.text);
        db.run('DELETE FROM x_outbox WHERE id = ?', row.id);
      } catch (err) {
        if (err.status) refund(COST.dmOut);
        if (err.status === 403) {
          db.run('UPDATE x_links SET dm_open = 0 WHERE user_id = ?', userId); // closed, or blocked: they have to write again
          return;
        }
        if (err.status === 429) {
          if (row.tries + 1 >= TRIES_429) {
            log('grid: X: a DM was given up on after its 429s: it stays in wisp.');
            db.run('DELETE FROM x_outbox WHERE id = ?', row.id);
            continue;
          }
          db.run('UPDATE x_outbox SET tries = tries + 1, next_at = ? WHERE id = ?', Date.now() + (err.retryAfter ? err.retryAfter * 1000 : RETRY_MS), row.id);
          continue;
        }
        log(`grid: X: a DM didn’t go: ${err.message}`);
        if (row.tries + 1 >= SEND_TRIES) db.run('DELETE FROM x_outbox WHERE id = ?', row.id);
        else db.run('UPDATE x_outbox SET tries = tries + 1, next_at = ? WHERE id = ?', Date.now() + (err.status ? RETRY_MS : BROKEN_MS), row.id);
      }
    }
  }

  // A touch past it: a timer can fire a moment early, and the row would look not yet due.
  function later(userId, ms) {
    clearTimeout(timers.get(userId));
    const t = setTimeout(() => {
      timers.delete(userId);
      pump(userId);
    }, ms + 25);
    t.unref?.();
    timers.set(userId, t);
  }

  function pump(userId) {
    if (pumping.has(userId)) {
      again.add(userId); // it may have already looked: something new was queued after that
      return pumping.get(userId);
    }
    const p = track(
      send(userId)
        .catch((err) => log(`grid: X: ${err.message}`))
        .finally(() => {
          pumping.delete(userId);
          if (again.delete(userId)) pump(userId);
        }),
    );
    pumping.set(userId, p);
    return p;
  }

  const room = (userId, bytes) => {
    const w = db.get('SELECT count(*) n, coalesce(sum(length(text)), 0) bytes FROM x_outbox WHERE user_id = ?', userId);
    return w.n < opts.outboxRows && w.bytes + bytes <= opts.outboxBytes;
  };

  const say = (userId, text) => {
    if (!room(userId, text.length)) return;
    queue(userId, null, text);
    pump(userId);
  };

  // --- what comes in ----------------------------------------------------------------------------------

  // True the first time, for as long as a repeat could still matter. The table survives a restart.
  const first = (key) => db.run('INSERT INTO x_seen (key, at) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', key, Date.now()).changes > 0;
  const fresh = (at) => Number.isFinite(at) && Math.abs(Date.now() - at) <= STALE_MS;
  const boxOn = (userId) => !!db.get('SELECT 1 FROM x_boxes WHERE user_id = ?', userId);

  // A person's posts and follow-ups in the last hour, kept here so a restart doesn't hand it back.
  // → { ok, tell }: tell once an hour, or a flood gets a flood of answers.
  function rate(link) {
    const since = Date.now() - HOUR_MS;
    db.run('DELETE FROM x_rate WHERE user_id = ? AND at < ?', link.user_id, since);
    if (db.get('SELECT count(*) n FROM x_rate WHERE user_id = ?', link.user_id).n < opts.postsPerHour) {
      db.run('INSERT INTO x_rate (user_id, at) VALUES (?, ?)', link.user_id, Date.now());
      return { ok: true };
    }
    const tell = link.told_at < since;
    if (tell) db.run('UPDATE x_links SET told_at = ? WHERE user_id = ?', Date.now(), link.user_id);
    return { ok: false, tell };
  }

  // A live thread of this person's, by what the event says it belongs to. Never someone else's.
  const liveThread = (userId, conversation) => db.get('SELECT thread FROM x_threads WHERE user_id = ? AND conversation = ? AND at >= ? ORDER BY at DESC LIMIT 1', userId, conversation, threadsLive())?.thread;
  const latestThread = (userId) => db.get('SELECT thread FROM x_threads WHERE user_id = ? AND at >= ? ORDER BY at DESC LIMIT 1', userId, threadsLive())?.thread;

  const hold = (user, link, { id, kind, text, at, thread, follow, conversation }) => {
    const headers = { [FROM_HEADER]: link.x_id, [ID_HEADER]: id, [THREAD_HEADER]: thread, [CONVERSATION_HEADER]: conversation };
    if (!follow) headers[NEW_HEADER] = '1';
    return inbox.hold(user, 'x', Buffer.from(JSON.stringify({ id, kind, text, at, thread, follow })), headers);
  };

  function takePost(ev) {
    const link = ev.sender === bot.id ? null : linkByX(ev.sender);
    if (!link) return billedApart(COST.post, { person: ev.sender !== bot.id });
    const over = billed(COST.post);
    if (ev.retweet || over || opts.paused) return; // a retweet's words are someone else's
    const user = accounts.userById(link.user_id);
    if (!user || user.disabled || !fresh(ev.at) || !first(`p:${ev.post}`)) return;
    const r = rate(link);
    if (!r.ok) {
      if (r.tell && reserve(COST.reply)) publicReply(ev.post, 'limited');
      return;
    }
    if (!boxOn(user.id)) return say(user.id, DM.off); // waking it to be told no costs a box's sleep
    if (ev.truncated) return say(user.id, DM.truncated);
    if (!reserve(COST.reply)) return; // no money for the one reply: nothing wakes either
    const follows = liveThread(user.id, ev.conversation);
    const held = hold(user, link, { id: ev.post, kind: 'post', text: ownWords(ev.text, bot.handle, ev.range).slice(0, TEXT_MAX), at: ev.at, thread: follows || ev.post, follow: !!follows, conversation: ev.conversation });
    if (held) publicReply(ev.post, link.dm_open ? 'ack' : 'ackDm');
    else refund(COST.reply);
  }

  function takeDm(ev) {
    if (ev.sender === bot.id || (ev.recipient && ev.recipient !== bot.id)) return;
    const link = linkByX(ev.sender);
    if (!link) return billedApart(COST.dmIn, { person: true });
    const over = billed(COST.dmIn);
    // Leaving works whatever the state: paused, over the cap, stale. It's their right, not a message.
    if (ev.text.trim().toLowerCase() === 'stop') {
      unlink(link.user_id, 'stop');
      if (over || opts.paused || !fresh(ev.at) || !reserve(COST.dmOut)) return;
      track(sendDm(link.x_id, DM.stop).catch((err) => {
        if (err.status) refund(COST.dmOut);
        log(`grid: X: a DM didn’t go: ${err.message}`);
      }));
      return;
    }
    // So does this: they did write, and X lets the bot answer from now on, whatever today's state is.
    const opened = !link.dm_open;
    if (opened) db.run('UPDATE x_links SET dm_open = 1 WHERE user_id = ?', link.user_id);
    if (over || opts.paused) return;
    const user = accounts.userById(link.user_id);
    if (!user || user.disabled) return;
    const waiting = db.get('SELECT 1 FROM x_outbox WHERE user_id = ? LIMIT 1', user.id);
    pump(user.id); // what waited for this
    // The DM that opens results is a hello, not a request: X makes people write first.
    if (opened) return waiting ? undefined : say(user.id, DM.open);
    if (!fresh(ev.at) || !first(`d:${ev.dm}`)) return;
    const r = rate(link);
    if (!r.ok) {
      if (r.tell) say(user.id, DM.limited);
      return;
    }
    const thread = latestThread(user.id);
    if (!thread) return say(user.id, DM.noTask);
    if (!boxOn(user.id)) return say(user.id, DM.off);
    hold(user, link, { id: ev.dm, kind: 'dm', text: ev.text.slice(0, TEXT_MAX), at: ev.at, thread, follow: true, conversation: thread });
  }

  // --- linking ----------------------------------------------------------------------------------------

  function unlink(userId, by) {
    if (!db.run('DELETE FROM x_links WHERE user_id = ?', userId).changes) return false;
    db.run('DELETE FROM x_threads WHERE user_id = ?', userId);
    db.run('DELETE FROM x_outbox WHERE user_id = ?', userId);
    accounts.audit(userId, 'x.unlink', { by });
    return true;
  }

  async function tokenCall(path, form) {
    const r = await fetch(`${api}${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64')}` }, body: new URLSearchParams(form).toString() });
    return { ok: r.ok, json: await r.json().catch(() => ({})) };
  }

  const meta = (k) => db.get('SELECT v FROM meta WHERE k = ?', k)?.v;
  const set = (k, v) => db.run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v));

  // Webhooks and subscriptions, once ever: the ids stay in meta. CRC runs while this waits, so it has
  // to come after the grid is listening. A failure only costs a line: the next start tries again.
  async function register() {
    const app = `Bearer ${bot.bearerToken}`;
    let id = meta('x.webhook');
    if (!id) {
      id = (await post('/2/webhooks', { url: `${cfg.publicUrl}${X_WEBHOOK}` }, app)).data?.id;
      if (!id) throw new Error('X gave the webhook no id');
      set('x.webhook', id);
    }
    for (const event of EVENTS) {
      if (meta(`x.sub.${event}`)) continue;
      const made = await post('/2/activity/subscriptions', { event_type: event, filter: { user_id: bot.id }, webhook_id: id, tag: 'wisp' }, app);
      set(`x.sub.${event}`, made.data?.subscription_id ?? 'unknown');
    }
  }

  async function unsubscribe() {
    for (const event of EVENTS) {
      const sub = meta(`x.sub.${event}`);
      if (!sub) continue;
      const r = await fetch(`${api}/2/activity/subscriptions/${encodeURIComponent(sub)}`, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${bot.bearerToken}` } });
      if (!r.ok) throw new Error(`X said ${r.status}`);
      db.run('DELETE FROM meta WHERE k = ?', `x.sub.${event}`);
    }
  }

  function sweep() {
    db.run('DELETE FROM x_seen WHERE at < ?', Date.now() - SEEN_MS);
    db.run('DELETE FROM x_flows WHERE expires_at < ?', Date.now());
    db.run('DELETE FROM x_threads WHERE at < ?', threadsLive());
    db.run('DELETE FROM x_outbox WHERE at < ?', threadsLive());
    db.run('DELETE FROM x_sent WHERE at < ?', Date.now() - HOUR_MS);
    db.run('DELETE FROM x_rate WHERE at < ?', Date.now() - HOUR_MS);
    db.run('DELETE FROM x_day WHERE day < ?', today());
    if (day()?.hard) track(unsubscribe().catch((err) => log(`grid: X: the subscriptions are still there: ${err.message}.`)));
    if (opts.paused) return;
    for (const r of db.all('SELECT DISTINCT o.user_id FROM x_outbox o JOIN x_links l ON l.user_id = o.user_id WHERE l.dm_open = 1')) pump(r.user_id);
  }
  const sweeper = setInterval(() => {
    try {
      sweep();
    } catch (err) {
      log(`grid: X sweep: ${err.message}`);
    }
  }, SWEEP_MS);
  sweeper.unref?.();

  return {
    paused: !!opts.paused,
    sweep,
    start() {
      if (opts.paused || day()?.hard) return; // hard: until tomorrow, or a higher ceiling and a new day's row
      setImmediate(() => register().catch((err) => log(`grid: X: the webhook isn’t set up: ${err.message}`)));
    },
    close() {
      stopped = true;
      clearInterval(sweeper);
      for (const t of timers.values()) clearTimeout(t);
      return Promise.allSettled([...sends]);
    },

    crc(crcToken) {
      if (!crcShaped(crcToken)) return { status: 400, body: { error: 'No crc_token.' } };
      return { status: 200, body: { response_token: crcAnswer(crcToken, opts.clientSecret) } };
    },

    // Signature first, and nothing kept before it. All the writes happen before the answer and all the
    // sending after it, so a crash in between loses a reply, never runs anything twice.
    async webhook(req) {
      const raw = await inbox.read(req, WEBHOOK_MAX);
      if (!raw) return { status: 413, body: { error: 'Too big.' } };
      if (!verified(raw, req.headers, { clientSecret: opts.clientSecret, consumerSecret: bot.consumerSecret })) return { status: 403, body: { error: 'Not signed.' } };
      if (!isObject(raw)) return { status: 403, body: { error: 'Not an event.' } };
      const ev = readEvent(raw);
      if (ev && first(`e:${ev.id}`)) {
        if (ev.kind === 'post') takePost(ev);
        else takeDm(ev);
      }
      return { status: 200, body: { ok: true } };
    },

    // Off the account page, session and CSRF already checked. → where to send the browser.
    linkStart(session) {
      if (linkOf(session.user.id)) throw refused('This account already has an X account linked.', 409);
      const state = token('', 24);
      const verifier = token('', 48);
      db.run('INSERT INTO x_flows (state_hash, user_id, session_hash, verifier, expires_at) VALUES (?, ?, ?, ?, ?)', sha256(state), session.user.id, session.hash, verifier, Date.now() + FLOW_MS);
      const u = new URL(authorizeUrl);
      u.search = new URLSearchParams({ response_type: 'code', client_id: opts.clientId, redirect_uri: redirectUri, scope: SCOPES, state, code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' }).toString();
      return u.href;
    },

    // Back from X. The flow has to be this session's own, and is spent by its first use. Someone else's
    // try leaves it be: nobody can use up a flow they didn't start.
    async linkFinish(session, params) {
      const hash = sha256(String(params.get('state') || ''));
      const flow = db.get('SELECT * FROM x_flows WHERE state_hash = ?', hash);
      if (flow?.user_id === session.user.id && flow.session_hash === session.hash) db.run('DELETE FROM x_flows WHERE state_hash = ?', hash);
      if (!flow || flow.user_id !== session.user.id || flow.session_hash !== session.hash || flow.expires_at < Date.now()) throw refused('This link timed out or was started elsewhere. Start again.', 400);
      if (params.get('error')) throw refused('X didn’t link the account.', 400);
      const t = await tokenCall('/2/oauth2/token', { grant_type: 'authorization_code', code: String(params.get('code') || ''), redirect_uri: redirectUri, code_verifier: flow.verifier, client_id: opts.clientId });
      if (!t.ok || !t.json.access_token) throw refused('X didn’t link the account. Try again.', 502);
      const me = await fetch(`${api}/2/users/me`, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${t.json.access_token}` } });
      const who = await me.json().catch(() => ({}));
      await tokenCall('/2/oauth2/revoke', { token: t.json.access_token, client_id: opts.clientId }).catch(() => {});
      const xId = who.data?.id && String(who.data.id);
      if (!me.ok || !xId) throw refused('X didn’t say who you are. Try again.', 502);
      const taken = linkByX(xId);
      if (taken) throw refused(taken.user_id === session.user.id ? 'That X account is already linked.' : 'That X account is already linked to someone else here.', 409);
      // A second flow finishing would swap the id under live threads: their results would go to it.
      if (linkOf(session.user.id)) throw refused('Unlink your X account first, then link the other one.', 409);
      db.run('INSERT INTO x_links (user_id, x_id, handle, linked_at) VALUES (?, ?, ?, ?)', session.user.id, xId, String(who.data.username || ''), Date.now());
      accounts.audit(session.user.id, 'x.link');
      return String(who.data.username || '');
    },

    unlink: (userId) => unlink(userId, 'account'),

    // For the account page. spend: only an admin's copy of it has this.
    view(user, { admin = false } = {}) {
      const l = linkOf(user.id);
      return {
        bot: bot.handle,
        linked: !!l,
        handle: l?.handle || '',
        dmOpen: !!l?.dm_open,
        paused: !!opts.paused,
        capped: spent() >= cap,
        on: boxOn(user.id),
        ...(admin && { spend: { cents: Math.round(spent() / 10), cap: opts.dailySpendCents, strangers: day()?.strangers || 0, strangerCents: Math.round((day()?.stranger_mills || 0) / 10), stopped: !!day()?.hard } }),
      };
    },

    // For the box: what Settings shows. The Box secret gets nothing it could use.
    state(user) {
      const { bot: handle, linked, handle: mine, dmOpen, paused, capped, on } = this.view(user);
      return { bot: handle, linked, handle: mine, dmOpen, paused, capped, on, account: `${cfg.publicUrl}/account#x` };
    },

    // The box's switch, as it told us. It's only whether a wake is worth it: an agent with the Box secret
    // can set this, and all it gets is a wake, since the box refuses for itself if it's really off.
    setBox(userId, on) {
      if (on) db.run('INSERT INTO x_boxes (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING', userId);
      else db.run('DELETE FROM x_boxes WHERE user_id = ?', userId);
      return { ok: true };
    },

    // Is a held row still wanted? The person may have left, or the day's money gone, since it came.
    still(row) {
      if (row.channel !== 'x') return true;
      if (opts.paused || spent() >= cap) return false;
      const from = JSON.parse(row.headers)[FROM_HEADER];
      return !!from && linkOf(row.user_id)?.x_id === from;
    },

    // A message its box accepted: from here on the box may answer it (grid/inbox.js calls this on a 2xx).
    delivered(row) {
      if (row.channel !== 'x') return;
      const h = JSON.parse(row.headers);
      if (!h[THREAD_HEADER] || !h[FROM_HEADER] || linkOf(row.user_id)?.x_id !== h[FROM_HEADER]) return;
      db.run('INSERT INTO x_threads (user_id, thread, conversation, at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, thread) DO UPDATE SET at = excluded.at', row.user_id, h[THREAD_HEADER], h[CONVERSATION_HEADER] || h[THREAD_HEADER], Date.now());
      if (h[NEW_HEADER]) accounts.audit(row.user_id, 'x.task', {});
    },

    // A box answering a thread it accepted. It says which thread and what to say: anything else in the
    // body is refused, not ignored, and the recipient comes from the link.
    async reply(user, body) {
      const b = body && typeof body === 'object' ? body : {};
      if (Object.keys(b).some((k) => k !== 'thread' && k !== 'text')) throw refused('A reply goes to the person of its thread, and nowhere else.', 400);
      await inbox.delivering(user.id); // this box's first answer can get here before its own 2xx is read
      const link = linkOf(user.id);
      const t = link && db.get('SELECT 1 FROM x_threads WHERE user_id = ? AND thread = ? AND at >= ?', user.id, String(b.thread ?? ''), threadsLive());
      if (!t) throw refused('No such thread.', 404);
      if (typeof b.text !== 'string' || !b.text.trim()) throw refused('Nothing to send.', 400);
      if (Buffer.byteLength(b.text) > REPLY_MAX) throw refused('That’s too long for a reply.', 413);
      db.run('DELETE FROM x_sent WHERE at < ?', Date.now() - HOUR_MS);
      if (db.get('SELECT count(*) n FROM x_sent WHERE user_id = ?', user.id).n >= opts.sendPerHour) throw refused('Too many replies this hour.', 429);
      // Here as well as on the box: an agent with the Box secret doesn't go through the box's code.
      const clean = scrubOut(b.text).text;
      const pieces = chunks(clean).length;
      const used = db.get('SELECT pieces FROM x_day WHERE user_id = ? AND day = ?', user.id, today())?.pieces || 0;
      if (used + pieces > opts.piecesPerDay) throw refused('This box has sent all it may today.', 429);
      if (!room(user.id, clean.length)) throw refused('Too much is waiting to go.', 429);
      db.run('INSERT INTO x_sent (user_id, at) VALUES (?, ?)', user.id, Date.now());
      db.run('INSERT INTO x_day (user_id, day, pieces) VALUES (?, ?, ?) ON CONFLICT(user_id, day) DO UPDATE SET pieces = pieces + excluded.pieces', user.id, today(), pieces);
      queue(user.id, String(b.thread), clean);
      const held = opts.paused || !link.dm_open || spent() + COST.dmOut > cap;
      pump(user.id);
      return { ok: true, held };
    },
  };
}
