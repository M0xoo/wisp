// `on laptop` in a message to wisp on Cloud (grid.json: channels.route). The grid reads the place,
// the computer does the work, and the box is never asked: a prompt injection in a box must never
// reach a laptop, so nothing here takes its word for anything (trust.ts: a box never gets a token for
// a laptop).
//
// That's why the grid owns the webhook. Everywhere else a box makes Telegram's secret_token itself,
// so anything on that box could post a message with it and any sender id it liked. Here the person
// gives the account page the bot's token (grid's own origin: session and CSRF, out of a box page's
// reach, never the Box secret) and the grid calls setWebhook with a URL and a secret of its own, both
// sealed. Telegram never gives a secret_token back, so nothing else with the bot's token can sign a
// message: it can't forge a route.
//
// It can do everything else, though. Anything on a box can read a token that box holds: forwardMessage
// returns a report's text, setWebhook to its own URL reads every later `on laptop`, sendMessage speaks
// as the grid. So routing wants a bot of its own, one the box never has, and the page says so. Nothing
// stops the same bot being given, so the box says which it has by botMark, a hash that proves it holds
// the token: then the page warns, the box leaves the webhook alone (`held`), and what isn't a route
// still goes to it. A public bot id wouldn't do: it would let a box ask for a bot it doesn't hold.
//
//   Telegram → POST <grid>/_route/<token> → secret → an allowed person, in private, naming one of
//   this user's computers (the shared grammar) → 200 → through that computer's tunnel,
//   POST /api/channels/routed, which answers only if it switched on Accept tasks from channels.
//
// Anything else: on a bot of its own, a line saying what the bot does, to the people listed and nobody
// else, and the box is neither told nor woken. On the box's own bot, the box, through the held inbox,
// marked verified since it no longer carries a secret the box knows. Nothing is held for a computer:
// offline, it's a line back.
//
// The way back: the computer never holds the bot. Each routed message gets a thread, which is all
// POST /api/channels/reply takes with a device token, and it reaches that one chat. A reply in that
// chat to something the grid sent there is a follow-up, and goes back to the same computer.

import { randomBytes } from 'node:crypto';
import { parseRoute, stripFormatting } from '@wisp-plugin/channels-api/kit';
import type { DeviceOf } from './accounts.ts';
import type { GridConfig } from './config.ts';
import type { Db } from './db.ts';
import { bad, messageOf, statusOf } from './errors.ts';
import type { Limit } from './http.ts';
import type { ChannelThreadRow, ComputerRow, UserRow } from './rows.ts';
import { BOX_BOT, botMark, createTelegram, type Route, type RouteTunnels, type TgMessage, type TgUpdate } from './route-telegram.ts';
import { safeEqual, sha256, token as newToken, type Secrets } from './secrets.ts';

export { ROUTE_MARK } from './route-telegram.ts';
export type { Route } from './route-telegram.ts';

export const ROUTE_PATH = /^\/_route\/([A-Za-z0-9_-]{32,64})$/;
const BOT_TOKEN = /^\d{1,20}:[\w-]{1,100}$/;
const SENDER = /^\d{1,20}$/;
const MAX_SENDERS = 20;
const THREAD_KEEP_MS = 30 * 86_400_000; // past its TTL a thread is still known, so a late reply hears why
const SWEEP_MS = 3_600_000;
const UPDATES = ['message', 'callback_query'];
const MARK = /^[\w-]{43}$/;
const TOO_MANY = 'Too many at once, so this wasn’t sent. Try again in a minute.';
const EXPIRED = 'That thread has expired, so this wasn’t sent. Start again with “on” and the computer’s name.';

type Later = (() => Promise<void>) | null;

export interface RouteAccounts {
  audit(userId: string | null, action: string, meta?: Record<string, unknown>): void;
  userById(id: unknown): UserRow | undefined;
  computer(id: unknown): ComputerRow | undefined;
  computers(userId: string): ComputerRow[];
}
export interface RouteInbox {
  on: boolean;
  first(userId: string, key: string): boolean;
  hold(user: UserRow, channel: string, body: Buffer | null, o: { verified: boolean }): boolean;
}

export interface RouteDeps {
  db: Db;
  cfg: GridConfig;
  secrets: Secrets;
  accounts: RouteAccounts;
  tunnels: RouteTunnels;
  inbox: RouteInbox;
  limit: Limit;
  log?: (m: string) => void;
}

// Past the secret: Telegram says who this is. Only a person on the list, in a private chat with
// the bot; in a group, others could read what comes back and steer what it does. A forward's from
// is who forwarded it, and its words are someone else's.
const listed = (m: TgMessage | undefined, route: Route): m is TgMessage => !!m?.from && !m.from.is_bot && m.chat?.type === 'private' && route.senders.includes(String(m.from.id));
const person = (m: TgMessage | undefined, route: Route): m is TgMessage => listed(m, route) && !m.forward_origin && !m.forward_date;

function parseSet(body: Record<string, unknown>): { bot: string; ids: string[] } {
  const bot = String(body['token'] || '').trim();
  if (!BOT_TOKEN.test(bot)) throw bad('That doesn’t look like a bot token: BotFather’s looks like 123456:ABC-DEF.');
  const ids = [...new Set(String(body['senders'] || '').split(/[\s,]+/).filter(Boolean))];
  if (!ids.length || !ids.every((x) => SENDER.test(x))) throw bad('Telegram user ids are numbers: @userinfobot tells you yours.');
  if (ids.length > MAX_SENDERS) throw bad(`At most ${MAX_SENDERS} people.`);
  return { bot, ids };
}

export function createRoutes({ db, cfg, secrets, accounts, tunnels, inbox, limit, log = () => {} }: RouteDeps) {
  const on = inbox.on && cfg.channels?.route === true;
  const tg = createTelegram({ db, cfg, secrets, tunnels });
  const { telegram, open, shared, say } = tg;

  async function set(user: UserRow, body: Record<string, unknown>): Promise<string> {
    const { bot, ids } = parseSet(body);
    const me = await telegram(bot, 'getMe', {});
    const name = typeof me?.['username'] === 'string' ? me['username'] : '';
    const had = open(user.id);
    const hadHash = tg.routeHash(user.id);
    const url = newToken('', 32);
    const secret = randomBytes(32).toString('hex');
    // Sealed first: a box that asks between here and Telegram's answer has to hear that it's held, or
    // it sets its own webhook over this one.
    tg.keep(user.id, JSON.stringify({ bot, name, secret, senders: ids }), sha256(url));
    try {
      await telegram(bot, 'setWebhook', { url: `${cfg.publicUrl}/_route/${url}`, secret_token: secret, allowed_updates: UPDATES });
    } catch (err) {
      if (had) tg.keep(user.id, JSON.stringify(had), hadHash);
      else tg.forget(user.id);
      throw err;
    }
    if (had && had.bot !== bot) await telegram(had.bot, 'deleteWebhook', {}).catch(() => {}); // another bot now: the old one stops calling
    accounts.audit(user.id, 'channel.route', { channel: 'telegram', senders: ids.length });
    return name;
  }

  async function remove(user: UserRow): Promise<void> {
    const r = open(user.id);
    // A webhook that moved is someone else's now.
    if (r && !(await tg.moved(user.id, r))) await telegram(r.bot, 'deleteWebhook', {}).catch((err: unknown) => log(`grid: route for ${user.handle}: ${messageOf(err)}`));
    tg.forget(user.id);
    db.run('DELETE FROM channel_threads WHERE user_id = ?', user.id);
    if (r) accounts.audit(user.id, 'channel.unroute', { channel: 'telegram' });
  }

  // Past the limit, what to do instead: the plain line. A message dropped without a word looks sent.
  function tooMany(user: UserRow, r: Route, m: TgMessage): Later {
    try {
      limit(`route|${user.id}`, 30);
      return null;
    } catch (err) {
      if (statusOf(err) !== 429) throw err;
      return () => say(r, m.chat.id, TOO_MANY, m.message_id);
    }
  }

  // A reply to something the grid sent: a follow-up for that thread's computer.
  function followUp(user: UserRow, r: Route, u: TgUpdate & { message: TgMessage }, text: string, up: number): Later {
    const m = u.message;
    const row = db.get<ChannelThreadRow>('SELECT t.* FROM channel_thread_msgs x JOIN channel_threads t ON t.id = x.thread_id WHERE x.user_id = ? AND x.chat = ? AND x.message = ?', user.id, String(m.chat.id), up);
    // Only the grid speaks on a bot of its own, so that was a thread, swept long ago.
    if (!row) return m.reply_to_message?.from?.is_bot && !shared(user.id) ? () => say(r, m.chat.id, EXPIRED, m.message_id) : null;
    const c = !tg.expired(row) ? accounts.computer(row.computer_id) : undefined;
    if (!c) return () => say(r, m.chat.id, EXPIRED, m.message_id);
    return tooMany(user, r, m) || (() => tg.forward(r, c, u, text, row, true));
  }

  // Decided at once, from what's in the database, before Telegram gets its 200. → what's left to do
  // after it, or null when the message isn't the grid's to act on.
  function decide(user: UserRow, r: Route, u: TgUpdate): Later {
    const m = u.message;
    if (typeof m?.text !== 'string' || !person(m, r)) return null;
    const msg = { ...u, message: m };
    const text = stripFormatting(m.text, 'telegram', { bot: r.name });
    const up = m.reply_to_message?.message_id;
    if (up) return followUp(user, r, msg, text, up);
    const hit = parseRoute(text, accounts.computers(user.id).map((c) => ({ id: c.id, name: c.name })));
    if (!hit) return null;
    if ('problems' in hit) return () => say(r, m.chat.id, `${hit.problems[0]?.text ?? ''} They share that name, so nothing was sent.`, m.message_id);
    const c = accounts.computer(hit.machine);
    if (!c || c.user_id !== user.id) return null;
    const busy = tooMany(user, r, m);
    if (busy) return busy;
    const thread = tg.newThread(user, c, m);
    return () => tg.forward(r, c, msg, hit.text, thread, false);
  }

  // Not a route, on a bot that does nothing else. Only to the people listed: nobody else needs to know
  // what this bot is, and a stranger's message shouldn't cost a send.
  function explain(user: UserRow, r: Route, u: TgUpdate | null): Later {
    const m = u?.message;
    if (!listed(m, r)) return null;
    const name = accounts.computers(user.id)[0]?.name || 'laptop';
    return tooMany(user, r, m) || (() => say(r, m.chat.id, `This bot only reaches your computers: say “on ${name} fix the login”. For your cloud wisp, use its own bot.`, m.message_id));
  }

  function sweep(): void {
    db.run('DELETE FROM channel_threads WHERE created_at < ?', Date.now() - THREAD_KEEP_MS);
  }
  const sweeper = setInterval(() => {
    try {
      sweep();
    } catch (err) {
      log(`grid: route sweep: ${messageOf(err)}`);
    }
  }, SWEEP_MS);
  sweeper.unref();

  return {
    on,
    sweep,
    set,
    remove,
    get: (userId: string): Route | null => (on ? open(userId) : null),
    shared,
    // A box asking for its URL says which bot it has. → whether the grid owns that bot's webhook: told
    // so, it leaves it alone. Another bot, or none named, has to set its own: told otherwise it would sit
    // deaf and show OK. gone: this box has let go of that bot. Nothing it says here reaches anything but
    // itself: a mark it can only make from the token.
    boxAsked(userId: string, channel: unknown, mark: unknown, gone = false): boolean {
      if (!on || channel !== 'telegram' || typeof mark !== 'string' || !MARK.test(mark)) return false;
      const had = secrets.open(userId, BOX_BOT);
      if (gone && had === mark) secrets.drop(userId, BOX_BOT);
      else if (!gone && had !== mark) secrets.seal(userId, BOX_BOT, mark);
      const r = open(userId);
      return !!r && safeEqual(mark, botMark(r.bot));
    },
    // For the account page: never the token or the secret.
    async view(userId: string): Promise<{ set: boolean; bot: string; senders: string[]; shared?: boolean; moved?: boolean } | null> {
      if (!on) return null;
      const r = open(userId);
      if (!r) return { set: false, bot: '', senders: [] };
      return { set: true, bot: r.name, senders: r.senders, shared: shared(userId), moved: await tg.moved(userId, r) };
    },

    // Whose webhook this is, if the secret says it's Telegram. → { user, route }, or null when nobody
    // has that URL, or false for a bad secret.
    check(urlToken: string, secret: unknown): { user: UserRow; route: Route } | null | false {
      const row = on ? db.get<{ user_id: string }>('SELECT user_id FROM channel_routes WHERE token_hash = ?', sha256(urlToken)) : undefined;
      const user = row ? accounts.userById(row.user_id) : undefined;
      const r = user && !user.disabled ? open(user.id) : null;
      if (!user || !r) return null;
      return typeof secret === 'string' && safeEqual(secret, r.secret) ? { user, route: r } : false;
    },

    // An update that passed check. Everything but the forward happens here, before the 200, in one
    // transaction: if it throws, Telegram retries and finds nothing done. A retry of one that went
    // through stops at inbox.first, routed or not. → what's left to do after the 200, if anything.
    take(user: UserRow, r: Route, raw: Buffer | null): Later {
      let u: TgUpdate | null = null;
      try {
        const v: unknown = raw ? JSON.parse(raw.toString('utf8')) : null;
        u = typeof v === 'object' && v !== null ? (v as TgUpdate) : null;
      } catch {
        // not JSON: not a route, and the box decides what it is
      }
      return db.tx(() => {
        if (raw && Number.isInteger(u?.update_id) && !inbox.first(user.id, `route:telegram:${String(u?.update_id)}`)) return null;
        const next = u && decide(user, r, u);
        if (next) return next;
        if (!shared(user.id)) return explain(user, r, u);
        inbox.hold(user, 'telegram', raw, { verified: true });
        return null;
      });
    },

    // A computer's report: that thread's chat, and only from the computer it was sent to. dev is a
    // device token's: a Box secret never gets this far (trust.ts: box → grid:report is denied).
    async reply(dev: DeviceOf, body: Record<string, unknown> | null): Promise<void> {
      const row = tg.threadOf(body?.['thread']);
      const c = row ? accounts.computer(row.computer_id) : undefined;
      if (!row || !c || c.user_id !== dev.user.id || c.device_id !== dev.device.id) throw bad('No such thread.', 404);
      const r = open(dev.user.id);
      if (!r) throw bad('No such thread.', 404);
      const text = body?.['text'];
      if (typeof text !== 'string' || !text.trim()) throw bad('text is needed.');
      limit(`routereply|${row.id}`, 20);
      await say(r, row.chat, text, row.message, row);
    },

    stop: (): void => clearInterval(sweeper),
  };
}

export type Routes = ReturnType<typeof createRoutes>;
