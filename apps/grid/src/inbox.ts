// Channels reaching a sleeping box. A channel posts to <handle>.<domain>/_in/<token>; the grid keeps
// the request, answers 200 at once, wakes the box and delivers it to POST /api/channels/inbound, in
// order and one at a time. The grid reads nothing a person said, and but for a channel with an edge
// checks nothing it signed: the box verifies each message itself. A row is held for an hour at most,
// and once delivered keeps only its event_key, which stops a sender's retry.
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
// A channel here is a row of CHANNELS (inbox-channels.ts). Mail is one too, but it has no webhook of
// its own: one provider's for everybody (mail.ts), which checks it and calls hold(). Its token is an
// address, so it can't be posted to at /_in/.
//
// A row may also have an edge, if its sender wants a real answer in the same call, sooner than a box
// can wake. That's the only thing here with a key, which the box sets over its Box secret (setKey): a
// public one, and what it lets through reaches that same box. Because of that a channel with an edge
// reaches a box and never a computer: a computer has no Box secret to set it with.

import type { IncomingMessage } from 'node:http';
import type { GridConfig } from './config.ts';
import type { Db } from './db.ts';
import { bad, messageOf, statusOf } from './errors.ts';
import type { Limit } from './http.ts';
import { BODY_MAX, CHANNELS, channelOf, eventKey, parsed, readCapped, type Body } from './inbox-channels.ts';
import { createDrain, type Deliver, type InboxAccounts, type InboxHostd, type InboxOpts } from './inbox-drain.ts';
import type { ChannelInboxRow, ChannelUrlRow, UserRow } from './rows.ts';
import { sha256, token, type Secrets } from './secrets.ts';
import { isPublicKey, type EdgeAnswer } from './shared/discord-sign.ts';

export { BODY_MAX, IN_PATH, readCapped } from './inbox-channels.ts';
export { boxDelivery } from './inbox-drain.ts';
export type { Deliver, Delivered, InboxHostd } from './inbox-drain.ts';

const LINKED_MAX = 500;
const HASH = /^[0-9a-f]{64}$/;
const NOT_UP: EdgeAnswer = { status: 503, body: { error: 'wisp is asleep: try again with it open.' } };
const LIVE_MS = 2500; // Slack gives a URL check 3 s
const EDGE_LIVE_MS = 2500; // Discord gives an answer 3 s
const DEFAULTS: InboxOpts = { enabled: false, maxRows: 200, maxBytes: 2 * 1024 * 1024, ttlMs: 60 * 60_000, retryMs: 2000, wakeRetryMs: 30_000, wakeStrikes: 3, wakeGapMs: 10 * 60_000, sweepMs: 60_000 };

export interface Answer {
  status: number;
  body: Record<string, unknown>;
}

export interface InboxDeps {
  db: Db;
  cfg: GridConfig;
  secrets: Secrets;
  accounts: InboxAccounts;
  hostd: InboxHostd;
  deliver: Deliver;
  delivered?: (row: ChannelInboxRow) => void;
  limit?: Limit;
  log?: (m: string) => void;
}

export function createInbox({ db, cfg, secrets, accounts, hostd, deliver, delivered = () => {}, limit = () => {}, log = () => {} }: InboxDeps) {
  const opts: InboxOpts = { ...DEFAULTS, ...(cfg.channels as Partial<InboxOpts> | undefined) };
  const on = opts.enabled === true;
  const where = (user: UserRow, channel: string, t: string): { url: string } | { address: string } => (channel === 'email' ? { address: `${t}@${cfg.mail?.domain ?? ''}` } : { url: `${cfg.instanceUrl(user.handle)}/_in/${t}` });
  const count = (userId: string, channel: string): void => void db.run('UPDATE channel_urls SET dropped = dropped + 1 WHERE user_id = ? AND channel = ?', userId, channel);
  const lost = (userId: string, channel: string, size: number, why: string): void => {
    count(userId, channel);
    accounts.audit(userId, 'channel.drop', { channel, size, why });
    log(`grid: inbox dropped ${size} bytes of ${channel} (${why})`);
  };
  const linkedOf = (user: UserRow, channel: string): string[] | null => {
    const kept = secrets.open(user.id, `channel-linked:${channel}`);
    return kept ? (JSON.parse(kept) as string[]) : null;
  };
  const drainer = createDrain({ db, opts, on, accounts, hostd, deliver, delivered, lost, log });
  const { drain } = drainer;

  // Past their hour, or their channel's own time: gone. One that never got there counts as lost; a
  // delivered one just stops guarding against a retry.
  function sweep(): void {
    const now = Date.now();
    for (const { channel } of db.all<{ channel: string }>('SELECT DISTINCT channel FROM channel_inbox')) {
      const before = now - Math.min(CHANNELS[channel]?.ttlMs ?? opts.ttlMs, opts.ttlMs);
      for (const r of db.all<{ user_id: string; size: number }>('SELECT user_id, size FROM channel_inbox WHERE channel = ? AND at < ? AND done_at IS NULL', channel, before)) lost(r.user_id, channel, r.size, 'expired');
      db.run('DELETE FROM channel_inbox WHERE channel = ? AND at < ?', channel, before);
    }
  }

  // Switched off too: what it held stays in the clear until this takes it.
  const sweeper = setInterval(() => {
    try {
      sweep();
    } catch (err) {
      log(`grid: inbox sweep: ${messageOf(err)}`);
    }
  }, opts.sweepMs);
  sweeper.unref();

  // The box's answer to the sender, for a request that can't wait. Asleep or starting: not now.
  // fallback: an edge's own answer, which stands unless the box answers in kind.
  async function live(user: UserRow, channel: string, headers: Record<string, string>, body: Buffer, fallback: EdgeAnswer | null): Promise<Answer> {
    const port = hostd.state(user.id) === 'running' ? hostd.port(user.id) : null;
    const none = fallback ?? NOT_UP;
    if (!port) return none;
    const done = hostd.begin(user.id, { touch: false });
    try {
      const out = await deliver(port, user, { channel, headers, body: body.toString('base64'), at: Date.now() }, { timeout: opts.liveMs ?? (fallback ? EDGE_LIVE_MS : LIVE_MS) });
      if (!fallback) return out.status < 500 ? out : NOT_UP;
      return out.status >= 200 && out.status < 300 && out.body['type'] === fallback.body.type ? out : fallback; // only an answer of the kind the sender wants
    } catch {
      return none;
    } finally {
      done();
    }
  }

  // verified: the grid checked this one itself (route.ts), and it has no secret the box knows.
  // Only the grid's own code sets it: nothing from a request does. → false when it was dropped.
  function hold(user: UserRow, channel: string, body: Buffer | null, { headers: kept = {}, verified = false, j }: { headers?: Record<string, string>; verified?: boolean; j?: Body } = {}): boolean {
    if (!body) {
      count(user.id, channel);
      return false;
    }
    const headers = JSON.stringify(kept);
    const size = body.length + headers.length;
    const held = db.get<{ n: number; bytes: number }>('SELECT count(*) n, coalesce(sum(size), 0) bytes FROM channel_inbox WHERE user_id = ? AND done_at IS NULL', user.id) ?? { n: 0, bytes: 0 };
    if (held.n >= opts.maxRows || held.bytes + size > opts.maxBytes) {
      count(user.id, channel);
      return false;
    }
    const key = eventKey(channel, j === undefined ? parsed(body) : j, body, headers);
    db.run('INSERT INTO channel_inbox (user_id, channel, event_key, headers, body, size, at, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, event_key) DO NOTHING', user.id, channel, key, headers, body, size, Date.now(), verified ? 1 : 0);
    setImmediate(() => void drain(user));
    return true;
  }

  // Keep what came, and say so; the wake happens after the answer has left. Too big, or over the
  // caps: dropped and counted, still a 200, since a retry storm from the sender helps nobody.
  // → { status, body } when the sender gets more than that 200 (the box's own answer to a live
  // request, or an edge's), or nothing: held.
  async function accept(user: UserRow, channel: string, req: IncomingMessage): Promise<Answer | EdgeAnswer | undefined> {
    const row = channelOf(channel);
    const body = await readCapped(req, BODY_MAX);
    const edge = row.edge?.({ key: secrets.open(user.id, `channel-key:${channel}`), linked: linkedOf(user, channel), raw: body, headers: req.headers });
    if (edge?.bucket) {
      try {
        limit(`intok|${user.id}|${channel}|${edge.bucket}`, edge.perMinute ?? 0);
      } catch (err) {
        if (statusOf(err) !== 429) throw err;
        return edge.busy;
      }
    }
    if (edge && !edge.hold && !edge.live) return edge;
    if (!body) {
      count(user.id, channel);
      return undefined;
    }
    const kept: Record<string, string> = {};
    for (const h of row.headers) {
      const v = req.headers[h];
      if (typeof v === 'string') kept[h] = v;
    }
    if (edge?.live) return live(user, channel, kept, body, edge);
    const j = parsed(body);
    if (row.live?.(j)) return live(user, channel, kept, body, null);
    if (row.skip?.(j)) return undefined;
    if (!hold(user, channel, body, { headers: kept, j })) return edge?.busy;
    return edge;
  }

  return {
    on,
    opts,
    drain,
    sweep,
    accept,
    hold,
    knows: (channel: unknown): channel is string => typeof channel === 'string' && Object.hasOwn(CHANNELS, channel) && (channel !== 'email' || !!cfg.mail),
    read: readCapped,
    delivering: drainer.delivering,
    edged: (channel: string): boolean => !!CHANNELS[channel]?.edge,

    // The key this user's edge checks with, or none ('') to refuse everything: set by this user's
    // own box, so it can only ever open that box's URL. linked: hashes of who's linked there, for the
    // edge; none from a box that doesn't send them, and everything's held for it, as it always was.
    setKey(user: UserRow, channel: string, key: unknown, linked: unknown): void {
      if (!CHANNELS[channel]?.edge) throw bad('not found', 404);
      if (key === '') {
        secrets.drop(user.id, `channel-linked:${channel}`);
        return secrets.drop(user.id, `channel-key:${channel}`);
      }
      if (!isPublicKey(key)) throw bad('A public key is 64 hex characters.', 400);
      if (linked !== undefined && !(Array.isArray(linked) && linked.length <= LINKED_MAX && linked.every((h) => typeof h === 'string' && HASH.test(h)))) throw bad('Who’s linked is a list of hashes.', 400);
      secrets.seal(user.id, `channel-key:${channel}`, key.toLowerCase());
      if (linked) secrets.seal(user.id, `channel-linked:${channel}`, JSON.stringify(linked));
      else secrets.drop(user.id, `channel-linked:${channel}`);
    },

    // { url, dropped }: this user's own, made the first time ({ address, dropped } for mail). dropped:
    // lost messages it hasn't been told of, which this tells it. The token is kept sealed, so a box
    // asking again gets the same URL.
    urlFor(user: UserRow, channel: string): ({ url: string } | { address: string }) & { dropped: number } {
      const mint = channelOf(channel).mint;
      const sealed = mint ? secrets.ensure(user.id, `channel:${channel}`, mint) : secrets.ensure(user.id, `channel:${channel}`);
      db.run('INSERT INTO channel_urls (user_id, channel, token_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, channel) DO UPDATE SET token_hash = excluded.token_hash', user.id, channel, sha256(sealed), Date.now());
      const dropped = db.get<Pick<ChannelUrlRow, 'dropped'>>('SELECT dropped FROM channel_urls WHERE user_id = ? AND channel = ?', user.id, channel)?.dropped ?? 0;
      if (dropped) db.run('UPDATE channel_urls SET dropped = 0 WHERE user_id = ? AND channel = ?', user.id, channel);
      return { ...where(user, channel, sealed), dropped };
    },

    addressOf: (user: UserRow): string => {
      const w = where(user, 'email', secrets.ensure(user.id, 'channel:email', channelOf('email').mint));
      return 'address' in w ? w.address : '';
    },

    // A new URL for a leaked one: the old token stops here. What's held and counted stays, and a box
    // can do this freely: all it can reach is its own URL. The seal is the truth: urlFor puts the
    // hash right if a crash comes between these two.
    rotate(user: UserRow, channel: string): { url: string } | { address: string } {
      const fresh = channelOf(channel).mint?.() ?? token('', 32);
      secrets.seal(user.id, `channel:${channel}`, fresh);
      db.run('UPDATE channel_urls SET token_hash = ? WHERE user_id = ? AND channel = ?', sha256(fresh), user.id, channel);
      return where(user, channel, fresh);
    },

    byToken: (t: string): { user_id: string; channel: string } | null => db.get<{ user_id: string; channel: string }>("SELECT user_id, channel FROM channel_urls WHERE token_hash = ? AND channel != 'email'", sha256(t)) ?? null,
    byAddress: (local: string): { user_id: string } | null => db.get<{ user_id: string }>("SELECT user_id FROM channel_urls WHERE token_hash = ? AND channel = 'email'", sha256(local)) ?? null,

    // True the first time a key comes by, for the hour a row lasts: a sender's retry stops here.
    first(userId: string, key: string): boolean {
      return Number(db.run("INSERT INTO channel_inbox (user_id, channel, event_key, headers, body, size, at, done_at) VALUES (?, 'seen', ?, '{}', x'', 0, ?, ?) ON CONFLICT(user_id, event_key) DO NOTHING", userId, key, Date.now(), Date.now()).changes) > 0;
    },

    // After a restart: everyone with something held.
    resume(): void {
      sweep();
      if (!on) return;
      for (const r of db.all<{ user_id: string }>('SELECT DISTINCT user_id FROM channel_inbox WHERE done_at IS NULL')) {
        const u = accounts.userById(r.user_id);
        if (u) void drain(u);
      }
    },

    stop(): void {
      drainer.stop();
      clearInterval(sweeper);
    },
    settled: drainer.settled,
  };
}

export type Inbox = ReturnType<typeof createInbox>;
