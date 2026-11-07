// `on laptop` in a message to wisp on Cloud (grid.json: channels.route). The grid reads the place,
// the computer does the work, and the box is never asked: a prompt injection in a box must never
// reach a laptop, so nothing here takes its word for anything.
//
// That's why the grid owns the webhook. Everywhere else a box makes Telegram's secret_token itself,
// so anything on that box could post a message with it and any sender id it liked. Here the person
// gives the account page the bot's token (grid's own origin: session and CSRF, out of a box page's
// reach, never the Box secret) and the grid calls setWebhook with a URL and a secret of its own, both
// sealed. A box holding the same bot token can point the webhook elsewhere, which stops routing, but
// Telegram never gives a secret_token back, so it can't sign a message.
//
//   Telegram → POST <grid>/_route/<token> → secret, then 200 → an allowed person, in private,
//   naming one of this user's computers (the shared grammar) → through that computer's tunnel,
//   POST /api/channels/routed, which answers only if it switched on Accept tasks from channels.
//
// Anything else goes to the box as it always has, through the held inbox, marked verified since it
// no longer carries a secret the box knows. Nothing is held for a computer: offline, it's a line back.
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
const THREAD_MSGS = 40; // per thread, oldest gone first
const SWEEP_MS = 3_600_000;
const UPDATES = ['message', 'callback_query'];
const FETCH_MS = 15_000;
const sealedAs = (channel) => `route:${channel}`;

export function createRoutes({ db, cfg, secrets, accounts, tunnels, inbox, limit, log = () => {} }) {
  const on = inbox.on && cfg.channels?.route === true;
  const base = String(cfg.channels?.telegramApi || 'https://api.telegram.org').replace(/\/+$/, '');

  async function telegram(bot, method, body) {
    const r = await fetch(`${base}/bot${bot}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(FETCH_MS) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw bad(`Telegram said: ${j.description || r.status}`);
    return j.result;
  }

  const open = (userId) => {
    const raw = secrets.open(userId, sealedAs('telegram'));
    return raw ? JSON.parse(raw) : null;
  };

  async function set(user, { token, senders }) {
    const bot = String(token || '').trim();
    if (!BOT_TOKEN.test(bot)) throw bad('That doesn’t look like a bot token: BotFather’s looks like 123456:ABC-DEF.');
    const ids = [...new Set(String(senders || '').split(/[\s,]+/).filter(Boolean))];
    if (!ids.length || !ids.every((x) => SENDER.test(x))) throw bad('Telegram user ids are numbers: @userinfobot tells you yours.');
    if (ids.length > MAX_SENDERS) throw bad(`At most ${MAX_SENDERS} people.`);
    const me = await telegram(bot, 'getMe', {});
    const had = open(user.id);
    const url = newToken('', 32);
    const secret = randomBytes(32).toString('hex');
    await telegram(bot, 'setWebhook', { url: `${cfg.publicUrl}/_route/${url}`, secret_token: secret, allowed_updates: UPDATES });
    if (had && had.bot !== bot) await telegram(had.bot, 'deleteWebhook', {}).catch(() => {}); // another bot now: the old one stops calling
    secrets.seal(user.id, sealedAs('telegram'), JSON.stringify({ bot, name: me?.username || '', secret, senders: ids }));
    db.run('INSERT INTO channel_routes (user_id, channel, token_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, channel) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at', user.id, 'telegram', sha256(url), Date.now());
    accounts.audit(user.id, 'channel.route', { channel: 'telegram', senders: ids.length });
    return me?.username || '';
  }

  async function remove(user) {
    const r = open(user.id);
    if (r) await telegram(r.bot, 'deleteWebhook', {}).catch((err) => log(`grid: route for ${user.handle}: ${err.message}`));
    secrets.drop(user.id, sealedAs('telegram'));
    db.run('DELETE FROM channel_routes WHERE user_id = ?', user.id);
    db.run('DELETE FROM channel_threads WHERE user_id = ?', user.id);
    if (r) accounts.audit(user.id, 'channel.unroute', { channel: 'telegram' });
  }

  // A thread's token: all a computer holds of the chat.
  const threadRef = (id) => `${id}.${secrets.sign(`thread|${id}`)}`;
  const threadOf = (ref) => {
    const [id, sig, more] = String(ref || '').split('.');
    return id && sig && more === undefined && secrets.verify(`thread|${id}`, sig) ? db.get('SELECT * FROM channel_threads WHERE id = ?', id) : null;
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
  const person = (m, route) => !!m?.from && !m.from.is_bot && m.chat?.type === 'private' && !m.forward_origin && !m.forward_date && route.senders.includes(String(m.from.id));

  // → false when it isn't the grid's to act on.
  async function route(user, r, u) {
    const m = u.message;
    if (typeof m?.text !== 'string' || !person(m, r)) return false;
    const up = m.reply_to_message?.message_id;
    if (up) {
      const row = db.get('SELECT t.* FROM channel_thread_msgs x JOIN channel_threads t ON t.id = x.thread_id WHERE x.user_id = ? AND x.chat = ? AND x.message = ?', user.id, String(m.chat.id), up);
      const c = row && accounts.computer(row.computer_id);
      if (!c) return false;
      limit(`route|${user.id}`, 30);
      await forward(user, r, c, u, stripFormatting(m.text, 'telegram', { bot: r.name }), row, true);
      return true;
    }
    const computers = accounts.computers(user.id).map((c) => ({ id: c.id, name: c.name }));
    const hit = parseRoute(stripFormatting(m.text, 'telegram', { bot: r.name }), computers);
    if (!hit) return false;
    if (hit.problems) {
      await say(r, m.chat.id, `${hit.problems[0].text} They share that name, so nothing was sent.`, m.message_id);
      return true;
    }
    limit(`route|${user.id}`, 30);
    const c = accounts.computer(hit.machine);
    if (!c || c.user_id !== user.id) return false;
    await forward(user, r, c, u, hit.text, newThread(user, c, m), false);
    return true;
  }

  function sweep() {
    db.run('DELETE FROM channel_threads WHERE created_at < ?', Date.now() - THREAD_TTL_MS);
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
    // Whether the grid owns the webhook of the bot a box has. A bot's id is public and the first part of
    // its token, so a box can say which it means and learn nothing else. Another bot, or none named, has
    // to set its own: told otherwise it would sit deaf and show OK.
    held: (userId, channel, bot) => on && channel === 'telegram' && !!bot && open(userId)?.bot.split(':')[0] === bot,
    // For the account page: never the token or the secret.
    view(userId) {
      if (!on) return null;
      const r = open(userId);
      return { set: !!r, bot: r?.name || '', senders: r?.senders || [] };
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

    // An update that passed check, after the 200 has gone. A retry stops at inbox.first, routed or not.
    async take(user, r, raw) {
      let u = null;
      try {
        u = raw && JSON.parse(raw.toString('utf8'));
      } catch {}
      if (raw && Number.isInteger(u?.update_id) && !inbox.first(user.id, `route:telegram:${u.update_id}`)) return;
      let done = false;
      try {
        done = !!u && (await route(user, r, u));
      } catch (err) {
        // Nothing the person said in a log, and a message that failed here isn't handed to the box.
        done = true;
        log(`grid: route for ${user.handle}: ${err.status === 429 ? 'too many' : err.message}`);
      }
      if (!done) await inbox.hold(user, 'telegram', raw, { verified: true });
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
