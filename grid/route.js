// `on laptop` in a message to wisp on Cloud (grid.json: channels.route). The grid reads the place,
// the computer does the work, and the box is never asked: a prompt injection in a box must never
// reach a laptop, so nothing here takes its word for anything.
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
import { parseRoute, stripFormatting } from '../server/channels/grammar.js';
import { bad } from './accounts.js';
import { safeEqual, sha256, token as newToken } from './secrets.js';

export const ROUTE_PATH = /^\/_route\/([A-Za-z0-9_-]{32,64})$/;
export const ROUTE_MARK = 'x-wisp-route'; // what computerEdge drops from everything else
const SECRET_HEADER = 'x-telegram-bot-api-secret-token';
const BOT_TOKEN = /^\d{1,20}:[\w-]{1,100}$/;
const SENDER = /^\d{1,20}$/;
const MAX_SENDERS = 20;
const TEXT_MAX = 4000;
const THREAD_TTL_MS = 7 * 86_400_000; // a task can take a while to report
const THREAD_KEEP_MS = 30 * 86_400_000; // and past that it's still known, so a late reply hears why
const THREAD_MSGS = 40; // per thread, oldest gone first
const SWEEP_MS = 3_600_000;
const UPDATES = ['message', 'callback_query'];
const FETCH_MS = 15_000;
const PAGE_MS = 3_000; // the account page waits for this, so not long
const BOX_BOT = 'route:box-bot'; // the botMark of the bot this user's box says it has
const MARK = /^[\w-]{43}$/;
const TOO_MANY = 'Too many at once, so this wasn’t sent. Try again in a minute.';
const EXPIRED = 'That thread has expired, so this wasn’t sent. Start again with “on” and the computer’s name.';
const sealedAs = (channel) => `route:${channel}`;
// server/channels/box.js makes the same one from the box's token. A token is too long to guess from this.
const botMark = (token) => sha256(`wisp bot|${token}`);

export function createRoutes({ db, cfg, secrets, accounts, tunnels, inbox, limit, log = () => {} }) {
  const on = inbox.on && cfg.channels?.route === true;
  const base = String(cfg.channels?.telegramApi || 'https://api.telegram.org').replace(/\/+$/, '');

  async function telegram(bot, method, body, ms = FETCH_MS) {
    const r = await fetch(`${base}/bot${bot}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw bad(`Telegram said: ${j.description || r.status}`);
    return j.result;
  }

  const open = (userId) => {
    const raw = secrets.open(userId, sealedAs('telegram'));
    return raw ? JSON.parse(raw) : null;
  };

  // Whether this user's box has proved it holds the bot routing uses.
  const shared = (userId) => {
    const r = open(userId);
    const box = r && secrets.open(userId, BOX_BOT);
    return !!box && safeEqual(box, botMark(r.bot));
  };

  const keep = (userId, sealed, tokenHash) => {
    secrets.seal(userId, sealedAs('telegram'), sealed);
    db.run('INSERT INTO channel_routes (user_id, channel, token_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, channel) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at', userId, 'telegram', tokenHash, Date.now());
  };

  // Whether something else set this bot's webhook. Telegram not answering says nothing either way.
  async function moved(userId, r) {
    const info = await telegram(r.bot, 'getWebhookInfo', {}, PAGE_MS).catch(() => null);
    if (typeof info?.url !== 'string') return false;
    const [, token] = info.url.startsWith(`${cfg.publicUrl}/_route/`) ? info.url.split('/_route/') : [];
    return !token || sha256(token) !== db.get('SELECT token_hash FROM channel_routes WHERE user_id = ? AND channel = ?', userId, 'telegram')?.token_hash;
  }

  const forget = (userId) => {
    secrets.drop(userId, sealedAs('telegram'));
    db.run('DELETE FROM channel_routes WHERE user_id = ?', userId);
  };

  async function set(user, { token, senders }) {
    const bot = String(token || '').trim();
    if (!BOT_TOKEN.test(bot)) throw bad('That doesn’t look like a bot token: BotFather’s looks like 123456:ABC-DEF.');
    const ids = [...new Set(String(senders || '').split(/[\s,]+/).filter(Boolean))];
    if (!ids.length || !ids.every((x) => SENDER.test(x))) throw bad('Telegram user ids are numbers: @userinfobot tells you yours.');
    if (ids.length > MAX_SENDERS) throw bad(`At most ${MAX_SENDERS} people.`);
    const me = await telegram(bot, 'getMe', {});
    const had = open(user.id);
    const hadHash = db.get('SELECT token_hash FROM channel_routes WHERE user_id = ? AND channel = ?', user.id, 'telegram')?.token_hash;
    const url = newToken('', 32);
    const secret = randomBytes(32).toString('hex');
    // Sealed first: a box that asks between here and Telegram's answer has to hear that it's held, or
    // it sets its own webhook over this one.
    keep(user.id, JSON.stringify({ bot, name: me?.username || '', secret, senders: ids }), sha256(url));
    try {
      await telegram(bot, 'setWebhook', { url: `${cfg.publicUrl}/_route/${url}`, secret_token: secret, allowed_updates: UPDATES });
    } catch (err) {
      if (had) keep(user.id, JSON.stringify(had), hadHash);
      else forget(user.id);
      throw err;
    }
    if (had && had.bot !== bot) await telegram(had.bot, 'deleteWebhook', {}).catch(() => {}); // another bot now: the old one stops calling
    accounts.audit(user.id, 'channel.route', { channel: 'telegram', senders: ids.length });
    return me?.username || '';
  }

  async function remove(user) {
    const r = open(user.id);
    // A webhook that moved is someone else's now.
    if (r && !(await moved(user.id, r))) await telegram(r.bot, 'deleteWebhook', {}).catch((err) => log(`grid: route for ${user.handle}: ${err.message}`));
    forget(user.id);
    db.run('DELETE FROM channel_threads WHERE user_id = ?', user.id);
    if (r) accounts.audit(user.id, 'channel.unroute', { channel: 'telegram' });
  }

  const expired = (thread) => thread.created_at < Date.now() - THREAD_TTL_MS;
  // A thread's token: all a computer holds of the chat.
  const threadRef = (id) => `${id}.${secrets.sign(`thread|${id}`)}`;
  const threadOf = (ref) => {
    const [id, sig, more] = String(ref || '').split('.');
    const row = id && sig && more === undefined && secrets.verify(`thread|${id}`, sig) ? db.get('SELECT * FROM channel_threads WHERE id = ?', id) : null;
    return row && !expired(row) ? row : null;
  };
  function newThread(user, c, m) {
    const id = newToken('', 12);
    db.run('INSERT INTO channel_threads (id, user_id, computer_id, channel, chat, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, user.id, c.id, 'telegram', String(m.chat.id), m.message_id, Date.now());
    return db.get('SELECT * FROM channel_threads WHERE id = ?', id);
  }
  const noteSent = (thread, messageId) => {
    if (!thread || !messageId) return;
    db.run('INSERT OR IGNORE INTO channel_thread_msgs (user_id, chat, message, thread_id, at) VALUES (?, ?, ?, ?, ?)', thread.user_id, thread.chat, messageId, thread.id, Date.now());
    db.run('DELETE FROM channel_thread_msgs WHERE thread_id = ? AND message NOT IN (SELECT message FROM channel_thread_msgs WHERE thread_id = ? ORDER BY at DESC, message DESC LIMIT ?)', thread.id, thread.id, THREAD_MSGS);
  };

  async function say(route, chat, text, replyTo, thread = null) {
    const sent = await telegram(route.bot, 'sendMessage', { chat_id: chat, text: String(text).slice(0, TEXT_MAX), ...(replyTo && { reply_to_message_id: replyTo, allow_sending_without_reply: true }) });
    noteSent(thread, sent?.message_id);
  }

  // Through the tunnel, one try. Whatever comes of it, the person hears, and nothing waits anywhere.
  async function forward(user, route, c, u, text, thread, follow) {
    const m = u.message;
    const fresh = !follow;
    const lost = (line) => {
      if (fresh) db.run('DELETE FROM channel_threads WHERE id = ?', thread.id);
      return say(route, m.chat.id, line, m.message_id);
    };
    const offline = `${c.name} is offline, so nothing was sent to it. Send this again when it’s back.`;
    if (!tunnels.online(c.id)) return lost(offline);
    const body = JSON.stringify({ channel: 'telegram', name: 'Telegram', text, sender: m.from.first_name || '', id: String(u.update_id), at: m.date, thread: threadRef(thread.id), ...(follow && { follow: true }) });
    let r;
    try {
      r = await tunnels.ask(c.id, { path: '/api/channels/routed', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), [ROUTE_MARK]: 'grid' }, body });
    } catch {
      // It may be running: the thread stays, or its report would have nowhere to go.
      return say(route, m.chat.id, `${c.name} didn’t answer, so this may or may not have started. Open wisp there to check.`, m.message_id, thread);
    }
    if (!r) return lost(offline);
    let j = {};
    try {
      j = JSON.parse(r.body);
    } catch {}
    const reply = typeof j.reply === 'string' ? j.reply : '';
    if (r.status === 404 && !reply) return lost(`${c.name} needs a newer wisp to take this.`);
    if (r.status >= 300) return lost(reply || `${c.name} couldn’t take this.`);
    if (reply) await say(route, m.chat.id, reply, m.message_id, thread);
  }

  // Past the secret: Telegram says who this is. Only a person on the list, in a private chat with
  // the bot; in a group, others could read what comes back and steer what it does. A forward's from
  // is who forwarded it, and its words are someone else's.
  const listed = (m, route) => !!m?.from && !m.from.is_bot && m.chat?.type === 'private' && route.senders.includes(String(m.from.id));
  const person = (m, route) => listed(m, route) && !m.forward_origin && !m.forward_date;

  // Past the limit, what to do instead: the plain line. A message dropped without a word looks sent.
  function tooMany(user, r, m) {
    try {
      limit(`route|${user.id}`, 30);
      return null;
    } catch (err) {
      if (err.status !== 429) throw err;
      return () => say(r, m.chat.id, TOO_MANY, m.message_id);
    }
  }

  // Decided at once, from what's in the database, before Telegram gets its 200. → what's left to do
  // after it, or null when the message isn't the grid's to act on.
  function decide(user, r, u) {
    const m = u.message;
    if (typeof m?.text !== 'string' || !person(m, r)) return null;
    const text = stripFormatting(m.text, 'telegram', { bot: r.name });
    const up = m.reply_to_message?.message_id;
    if (up) {
      const row = db.get('SELECT t.* FROM channel_thread_msgs x JOIN channel_threads t ON t.id = x.thread_id WHERE x.user_id = ? AND x.chat = ? AND x.message = ?', user.id, String(m.chat.id), up);
      // Only the grid speaks on a bot of its own, so that was a thread, swept long ago.
      if (!row) return m.reply_to_message.from?.is_bot && !shared(user.id) ? () => say(r, m.chat.id, EXPIRED, m.message_id) : null;
      const c = !expired(row) && accounts.computer(row.computer_id);
      if (!c) return () => say(r, m.chat.id, EXPIRED, m.message_id);
      const busy = tooMany(user, r, m);
      return busy || (() => forward(user, r, c, u, text, row, true));
    }
    const hit = parseRoute(text, accounts.computers(user.id).map((c) => ({ id: c.id, name: c.name })));
    if (!hit) return null;
    if (hit.problems) return () => say(r, m.chat.id, `${hit.problems[0].text} They share that name, so nothing was sent.`, m.message_id);
    const c = accounts.computer(hit.machine);
    if (!c || c.user_id !== user.id) return null;
    const busy = tooMany(user, r, m);
    if (busy) return busy;
    const thread = newThread(user, c, m);
    return () => forward(user, r, c, u, hit.text, thread, false);
  }

  // Not a route, on a bot that does nothing else. Only to the people listed: nobody else needs to know
  // what this bot is, and a stranger's message shouldn't cost a send.
  function explain(user, r, u) {
    const m = u?.message;
    if (!listed(m, r)) return null;
    const name = accounts.computers(user.id)[0]?.name || 'laptop';
    return tooMany(user, r, m) || (() => say(r, m.chat.id, `This bot only reaches your computers: say “on ${name} fix the login”. For your cloud wisp, use its own bot.`, m.message_id));
  }

  function sweep() {
    db.run('DELETE FROM channel_threads WHERE created_at < ?', Date.now() - THREAD_KEEP_MS);
  }
  const sweeper = setInterval(() => {
    try {
      sweep();
    } catch (err) {
      log(`grid: route sweep: ${err.message}`);
    }
  }, SWEEP_MS);
  sweeper.unref?.();

  return {
    on,
    sweep,
    set,
    remove,
    get: (userId) => (on ? open(userId) : null),
    shared,
    // A box asking for its URL says which bot it has. → whether the grid owns that bot's webhook: told
    // so, it leaves it alone. Another bot, or none named, has to set its own: told otherwise it would sit
    // deaf and show OK. gone: this box has let go of that bot. Nothing it says here reaches anything but
    // itself: a mark it can only make from the token.
    boxAsked(userId, channel, mark, gone = false) {
      if (!on || channel !== 'telegram' || !MARK.test(mark || '')) return false;
      const had = secrets.open(userId, BOX_BOT);
      if (gone && had === mark) secrets.drop(userId, BOX_BOT);
      else if (!gone && had !== mark) secrets.seal(userId, BOX_BOT, mark);
      const r = open(userId);
      return !!r && safeEqual(mark, botMark(r.bot));
    },
    // For the account page: never the token or the secret.
    async view(userId) {
      if (!on) return null;
      const r = open(userId);
      if (!r) return { set: false, bot: '', senders: [] };
      return { set: true, bot: r.name, senders: r.senders, shared: shared(userId), moved: await moved(userId, r) };
    },

    // Whose webhook this is, if the secret says it's Telegram. → { user, route }, or null when nobody
    // has that URL, or false for a bad secret.
    check(urlToken, secret) {
      const row = on && db.get('SELECT user_id FROM channel_routes WHERE token_hash = ?', sha256(urlToken));
      const user = row && accounts.userById(row.user_id);
      const r = user && !user.disabled && open(user.id);
      if (!r) return null;
      return typeof secret === 'string' && safeEqual(secret, r.secret) ? { user, route: r } : false;
    },

    // An update that passed check. Everything but the forward happens here, before the 200, in one
    // transaction: if it throws, Telegram retries and finds nothing done. A retry of one that went
    // through stops at inbox.first, routed or not. → what's left to do after the 200, if anything.
    take(user, r, raw) {
      let u = null;
      try {
        u = raw && JSON.parse(raw.toString('utf8'));
      } catch {}
      return db.tx(() => {
        if (raw && Number.isInteger(u?.update_id) && !inbox.first(user.id, `route:telegram:${u.update_id}`)) return null;
        const next = u && decide(user, r, u);
        if (next) return next;
        if (!shared(user.id)) return explain(user, r, u);
        inbox.hold(user, 'telegram', raw, { verified: true });
        return null;
      });
    },

    // A computer's report: that thread's chat, and only from the computer it was sent to.
    async reply(dev, body) {
      const row = threadOf(body?.thread);
      const c = row && accounts.computer(row.computer_id);
      if (!c || c.user_id !== dev.user.id || c.device_id !== dev.device.id) throw bad('No such thread.', 404);
      const r = open(dev.user.id);
      if (!r) throw bad('No such thread.', 404);
      if (typeof body.text !== 'string' || !body.text.trim()) throw bad('text is needed.');
      limit(`routereply|${row.id}`, 20);
      await say(r, row.chat, body.text, row.message, row);
    },

    stop: () => clearInterval(sweeper),
  };
}
