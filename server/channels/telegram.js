// Telegram: a bot message with buttons; reply to the message to answer in your own words or send a
// follow-up. Linked to one chat with a one-time code. With allowStart on, /new [@project] <task>
// starts a task and /projects lists where it can run.
//
// With telegram.options on as well (it sits under allowStart), a message says what you'd type in the
// launcher: it goes through the channel layer (policy.js, grammar.js, lists.js), and plain text starts
// a task. Off, every path here is the one it always was.
//
// On a computer it polls. A cloud wisp sleeps, and nothing polls while it does: there it sets a
// webhook to the grid's held inbox (grid/inbox.js), which wakes it, and never polls while one is set
// (Telegram answers getUpdates with a 409). With no hub on that grid it polls as it always did.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { truncate } from '../util.js';
import { boxGrid, channelUrl, rotateUrl } from './box.js';
import { Channel, CODE, KIND, lostLine, resend, sleep } from './channel.js';
import { converse } from './conversation.js';
import { findProject, stripFormatting } from './grammar.js';
import { LISTS, refusal } from './lists.js';
import { RateLimit, Seen, STALE_S, defuse, gate, scrubOut } from './policy.js';

const MAX_TG_IDS = 20;
const HOOK_RETRY_MS = 30_000;
const NOT_REMOVED = 'Couldn’t remove the webhook';
const SEEN_UPDATES = 100; // kept with the webhook: a box's memory ends when it sleeps
const UPDATES = ['message', 'callback_query'];
const COMMANDS = [
  ['new', 'Start a task: options, then what to do'],
  ['help', 'What you can say here'],
  ['projects', 'Where a task can run'],
  ['models', 'Harnesses and models'],
  ['crew', 'Your crew and what they’re on'],
  ['machines', 'Your machines and who’s online'],
  ['status', 'What’s running and waiting'],
];
const FORWARD_FIELDS = ['forward_origin', 'forward_from', 'forward_from_chat', 'forward_sender_name', 'forward_date', 'is_automatic_forward'];

// A forward's text is someone else's, but it arrives as the linked person's message, so it must not
// run as theirs. The old fields count too: Bot API 7.0 replaced them, and old payloads still have them.
const forwarded = (m) => FORWARD_FIELDS.some((f) => m[f] != null && m[f] !== false);

export class Telegram extends Channel {
  constructor(hub) {
    super(hub, 'telegram');
    this.seen = new Seen();
    this.limit = new RateLimit();
    this.bot = null; // { token, name }: who this bot is, for "@wispbot …" in a group
    this.listed = ''; // the token whose commands Telegram has
    this.wire = Promise.resolve(); // webhook calls, one at a time
    this.takingDown = new Set(); // bots a deleteWebhook is on its way for
  }

  get cfg() {
    return this.hub.cfg.telegram;
  }

  get ready() {
    const t = this.cfg;
    return !!(t?.enabled && t.token);
  }

  // Sending needs a linked chat as well.
  get linked() {
    return !!(this.ready && this.cfg.chatId);
  }

  // The new way in: the switch, under allowStart, on a hub that can act on it.
  get options() {
    const t = this.cfg;
    return !!(t?.options && t.allowStart && this.hub.phone?.context);
  }

  async api(method, body, signal, token = this.cfg.token) {
    const base = (process.env.WISP_TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, '');
    const r = await resend(() => fetch(`${base}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal || AbortSignal.timeout(15_000),
    }), method === 'sendMessage' ? undefined : 1); // the poll has its own way back; a tap's answer is past its moment
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`Telegram: ${j.description || r.status}`);
    return j.result;
  }

  async publish(msg, s) {
    const buttons = (s ? msg.actions : []).map((a) => [{ text: truncate(a.label, 60), callback_data: `${CODE[a.kind]}:${s.id}:${a.ref}:${a.index}` }]);
    const reply = this.options ? this.hub.threadOf(s) : null; // a task started here answers in its thread
    const sent = await this.api('sendMessage', {
      chat_id: this.cfg.chatId,
      text: truncate(`${msg.title}\n\n${msg.text}${s ? '\n\n↩ Reply to this message to answer or follow up.' : ''}`, 4000),
      ...(buttons.length && { reply_markup: { inline_keyboard: buttons } }),
      ...(reply && { reply_to_message_id: reply, allow_sending_without_reply: true }),
    });
    if (s && sent?.message_id) this.link(s.id, sent.message_id);
  }

  // The offset outlives restarts (every settings change restarts the loop), or Telegram would
  // hand back updates already handled and a /new would start its task twice.
  async start(signal) {
    const hub = this.hub;
    if (this.options && this.listed !== this.cfg.token) {
      this.listed = this.cfg.token;
      this.api('setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) }).catch(() => {});
    }
    if (await this.#hooked(signal)) return;
    while (!signal.aborted) {
      try {
        const updates = await this.api('getUpdates', { offset: hub.tgOffset, timeout: hub.tgLongPoll, allowed_updates: UPDATES }, signal);
        if (hub.status.telegram?.error) this.mark({ ok: true, error: '' });
        for (const u of updates) {
          if (u.update_id < hub.tgOffset) continue;
          hub.tgOffset = u.update_id + 1;
          await this.#from(u).catch((err) => console.warn(`wisp: telegram: ${err.message}`));
        }
      } catch (err) {
        if (signal.aborted) return;
        this.mark({ ok: false, error: err.message });
        await sleep(5000, signal);
      }
    }
  }

  // --- webhook: a cloud wisp whose grid has the hub ---------------------------------------------

  // True when a webhook takes care of inbound, or wisp is trying to get one up (either way, no
  // polling). False: poll. A computer with no webhook left over in its config never gets past line one.
  async #hooked(signal) {
    const box = boxGrid();
    if (!box && !this.cfg.hook) return false;
    const timed = () => AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    while (!signal.aborted) {
      try {
        let found = null;
        if (box) {
          try {
            found = await channelUrl(box, this.name);
          } catch (err) {
            if (!this.cfg.hook) return false; // no webhook to get in the way: poll while the grid can't be reached
            throw new Error(`the grid: ${err.message}`);
          }
        }
        if (!found) {
          // No hub here (a grid that turned it off, a config moved to a computer): what's left of it goes first.
          if (!this.cfg.hook) return false;
          await this.api('deleteWebhook', {}, timed());
          if (signal.aborted) return true;
          delete this.cfg.hook;
          this.hub.store.saveConfig();
          this.mark({ webhook: false });
          return false;
        }
        if (found.dropped) await this.dropped(found.dropped);
        // The grid owns the webhook (grid/route.js): one call here would take it back.
        if (found.held) {
          if (!this.cfg.hook?.held) this.cfg.hook = { held: true, seen: this.cfg.hook?.seen || [] };
          this.hub.store.saveConfig();
          this.mark({ ok: true, error: '', webhook: true });
          return true;
        }
        await this.#setHook(found.url, timed);
        if (!signal.aborted) this.mark({ ok: true, error: '', webhook: true });
        return true;
      } catch (err) {
        if (signal.aborted) return true;
        this.mark({ ok: false, error: `Couldn’t set the webhook: ${err.message}`, webhook: false });
        await sleep(this.hub.hookRetryMs ?? HOOK_RETRY_MS, signal);
      }
    }
    return true;
  }

  // In order: a switch flipped while Telegram answers mustn't cross with what's on its way.
  #inTurn(fn) {
    const run = this.wire.then(fn, fn);
    this.wire = run.catch(() => {});
    return run;
  }

  // Only when Telegram doesn't already have it. A new URL keeps the secret and the seen list: messages
  // held at the grid carry the secret they came with, so a new one would have the box refuse them all.
  #setHook(url, timed) {
    return this.#inTurn(async () => {
      const token = this.cfg.token;
      const had = this.cfg.hook;
      if (had?.url === url && (await this.api('getWebhookInfo', {}, timed())).url === url) return;
      const secret = had?.secret || randomBytes(32).toString('hex');
      // Not cut off by the switch: Telegram may have taken it, and then it has to be undone.
      await this.api('setWebhook', { url, secret_token: secret, allowed_updates: UPDATES }, AbortSignal.timeout(15_000), token);
      if (this.ready && this.cfg.token === token) {
        this.cfg.hook = { url, secret, seen: had?.seen || [] };
        this.hub.store.saveConfig();
        this.#unmark(token); // this bot's webhook is wanted again
      } else await this.api('deleteWebhook', {}, undefined, token); // switched off meanwhile: update() saw no webhook to remove
    });
  }

  // Switched off, unlinked or another bot: Telegram stops calling. token: the bot it was set on, gone
  // from the config by now, so it's kept in unhooking until Telegram says done. Until then each
  // message would wake the box for a 409.
  unhook(token) {
    this.cfg.unhooking = [...new Set([...(this.cfg.unhooking || []), token])];
    this.mark({ webhook: false });
    return this.#takeDown(token);
  }

  // Every start, on or off (remote.js): what a failed unhook left.
  retryUnhook() {
    return Promise.all((this.cfg?.unhooking || []).map((token) => this.#takeDown(token)));
  }

  async #takeDown(token) {
    if (this.takingDown.has(token)) return;
    this.takingDown.add(token);
    try {
      await this.#inTurn(() => this.api('deleteWebhook', {}, undefined, token));
      this.#unmark(token);
      if (this.hub.status.telegram?.error?.startsWith(NOT_REMOVED)) this.mark({ ok: true, error: '' });
    } catch (err) {
      this.mark({ ok: false, error: `${NOT_REMOVED}: ${err.message}`, webhook: false });
    } finally {
      this.takingDown.delete(token);
    }
  }

  #unmark(token) {
    if (!this.cfg.unhooking?.includes(token)) return;
    this.cfg.unhooking = this.cfg.unhooking.filter((t) => t !== token);
    if (!this.cfg.unhooking.length) delete this.cfg.unhooking;
    this.hub.store.saveConfig();
  }

  // A leaked URL: the grid drops it, then Telegram is told the new one. Until then its calls get a 404
  // and it keeps the updates, so nothing is lost. If that fails the old URL is dead, so #hooked takes over.
  async rotate() {
    const box = boxGrid();
    if (!box || !this.ready || !this.cfg.hook || this.cfg.hook.held) return { status: 409, body: { error: 'Telegram has no webhook here.' } };
    const { url } = await rotateUrl(box, this.name);
    try {
      await this.#setHook(url, () => AbortSignal.timeout(15_000));
    } catch (err) {
      this.hub.start();
      return { status: 502, body: { error: `Rotated, but Telegram didn’t take the new URL yet: ${err.message}` } };
    }
    return { status: 200, body: { ok: true } };
  }

  // A message the grid held. Only Telegram knows this secret, and only a retry repeats an update.
  // verified: the grid owns the webhook and checked its own secret (grid/route.js). Only its delivery
  // can say so (routes/channels.js), and at worst that lets this box talk to itself.
  async inbound(raw, headers = {}, { verified = false } = {}) {
    if (verified && this.ready) this.cfg.hook ||= { held: true, seen: [] };
    const hook = this.ready && this.cfg.hook;
    if (!hook || (!verified && !hook.secret)) return { status: 409, body: { error: 'Telegram isn’t on here.' } };
    if (!verified) {
      const got = Buffer.from(String(headers['x-telegram-bot-api-secret-token'] ?? ''));
      const want = Buffer.from(hook.secret);
      if (got.length !== want.length || !timingSafeEqual(got, want)) return { status: 403, body: { error: 'Wrong secret token.' } };
    }
    let u;
    try {
      u = JSON.parse(raw.toString('utf8'));
    } catch {}
    if (!Number.isInteger(u?.update_id)) return { status: 400, body: { error: 'Not an update.' } };
    // A stranger's message really came from Telegram, so its secret is good: this 403 is what tells
    // the grid nobody wanted it, and it's a stranger's wake it stops paying for (grid/inbox.js).
    const stranger = !this.#ours(u) && { status: 403, body: { error: 'Not from the linked chat.' } };
    if (hook.seen?.includes(u.update_id)) return stranger || { status: 200, body: { ok: true, duplicate: true } };
    hook.seen = [...(hook.seen || []), u.update_id].slice(-SEEN_UPDATES);
    this.hub.store.saveConfig();
    await this.#from(u).catch((err) => console.warn(`wisp: telegram: ${err.message}`));
    return stranger || { status: 200, body: { ok: true } };
  }

  // From the linked chat, or, before there is one, the code that links it.
  #ours(u) {
    if (!this.cfg.chatId) return this.#linksIt(u.message);
    return String((u.callback_query?.message ?? u.message)?.chat?.id) === String(this.cfg.chatId);
  }

  #linksIt(m) {
    return !!this.cfg.linkCode && m?.text?.replace(/^\/(start|link)\s*/, '').trim() === this.cfg.linkCode;
  }

  async dropped(n) {
    this.mark({ dropped: n });
    if (!this.linked) return;
    await this.api('sendMessage', { chat_id: this.cfg.chatId, text: lostLine(n) }).catch(() => {});
  }

  async #from(u) {
    const t = this.cfg;
    const hub = this.hub;
    const say = (text, extra = {}) => this.api('sendMessage', { chat_id: t.chatId, text: scrubOut(text).text, ...extra });
    if (u.callback_query) {
      const q = u.callback_query;
      if (!t.chatId || String(q.message?.chat?.id) !== String(t.chatId)) return;
      const [k, sessionId, ref, i] = String(q.data || '').split(':');
      const result = KIND[k] ? await hub.act({ sessionId, kind: KIND[k], ref, index: Number(i) }) : 'Unknown button.';
      await this.api('answerCallbackQuery', { callback_query_id: q.id, text: truncate(this.options ? defuse(scrubOut(result).text) : scrubOut(result, { note: false }).text, 190) }).catch(() => {});
      await this.api('editMessageReplyMarkup', { chat_id: t.chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return;
    }
    const m = u.message;
    if (!m?.text) return;
    if (forwarded(m)) {
      const g = gate({ sender: m.chat.id, senders: [t.chatId], limit: this.limit, rateKey: m.from?.id });
      const line = g.ok ? 'Forwarded, so nothing started. Say it in your own words to run it.' : g.reply;
      if (line) await say(line, { reply_to_message_id: m.message_id });
      return;
    }
    if (!t.chatId) {
      // Linking: only the chat that sends the code shown in wisp's settings gets attached.
      if (this.#linksIt(m)) {
        Object.assign(t, { chatId: m.chat.id, chatName: m.chat.title || [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') || m.chat.username || '', linkCode: '' });
        hub.store.saveConfig();
        this.mark({ ok: true, error: '' });
        await say('✓ Linked to wisp. Questions and finished tasks will show up here.');
      }
      return;
    }
    if (this.options) return this.#withOptions(m);
    if (String(m.chat.id) !== String(t.chatId)) return;
    const cmd = m.text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
    if (cmd && ['new', 'projects', 'help', 'start'].includes(cmd[1].toLowerCase())) return this.#command(cmd[1].toLowerCase(), cmd[2].trim(), m, say);
    const replyTo = m.reply_to_message?.message_id;
    const sessionId = replyTo && this.#sessionOf(replyTo);
    if (!sessionId) return say(t.allowStart ? 'Reply to one of wisp’s messages to answer it or follow up, or send /new <task> to start one.' : 'Reply to one of wisp’s messages to answer it or send a follow-up.');
    const later = (text) => say(text, { reply_to_message_id: m.message_id }).catch(() => {});
    await say(await hub.act({ sessionId, kind: 'text', text: m.text, later }), { reply_to_message_id: m.message_id });
  }

  #sessionOf(messageId) {
    return this.hub.store.all().find((x) => x.remote?.tg?.includes(messageId))?.id || this.hub.tgElsewhere.get(messageId);
  }

  async #command(name, arg, m, say) {
    const t = this.cfg;
    const hub = this.hub;
    const off = 'Starting tasks from Telegram is off. Turn it on in wisp → Phone → Telegram.';
    const projects = hub.store.config.projects;
    if (name === 'help' || name === 'start')
      return say(
        t.allowStart
          ? 'Send /new <task> to start a task in your default project, or /new @project <task> to pick one (/projects lists them). Reply to wisp’s messages to answer or follow up.'
          : `Reply to wisp’s messages to answer or follow up. ${off}`,
      );
    if (!t.allowStart) return say(off);
    // Telegram keeps updates for a day: don't start what was sent while wisp was off.
    if (name === 'new' && m.date && Date.now() / 1000 - m.date > STALE_S) return say('That /new arrived while wisp was offline, so it didn’t start. Send it again to run it now.', { reply_to_message_id: m.message_id });
    if (name === 'projects') {
      if (!projects.length) return say('No projects yet. Open a folder in wisp first.');
      const def = hub.defaultProject();
      const where = (id) => (hub.store.config.machines || []).find((x) => x.id === id)?.name || id;
      const lines = projects.map((p) => `• ${p.name}${p.machine ? ` (on ${where(p.machine)})` : ''}${p === def ? '  ← default' : ''}`);
      return say(truncate(`Projects:\n${lines.join('\n')}\n\n/new @name <task> runs in one of them.`, 4000));
    }
    let prompt = arg;
    let project = hub.defaultProject();
    const at = arg.match(/^@(\S+)\s*([\s\S]*)$/);
    if (at) {
      project = findProject(projects, at[1]);
      if (!project) return say(`No project matches “${truncate(at[1], 60)}”. Send /projects to see them.`);
      prompt = at[2].trim();
    }
    if (!prompt) return say('What should it do? Send /new <task>, or /new @project <task>.');
    if (!project) return say('No projects yet. Open a folder in wisp first.');
    let s;
    try {
      s = await hub.launch({ project, prompt });
    } catch (err) {
      return say(`Couldn’t start it: ${truncate(err.message, 300)}`, { reply_to_message_id: m.message_id });
    }
    const sent = await say(truncate(`▶ Started in ${project.name}: ${s?.title || prompt}\n\nwisp will message you when it needs you or is done. Reply to this message to follow up.`, 4000), { reply_to_message_id: m.message_id });
    if (s?.id && sent?.message_id) this.link(s.id, sent.message_id);
  }

  // --- with telegram.options on: the grammar, through the channel layer --------------------------

  // Who this bot is, asked once: in a group people write "@wispbot in api fix it".
  async #botName() {
    if (this.bot?.token === this.cfg.token) return this.bot.name;
    const me = await this.api('getMe', {}).catch(() => null);
    this.bot = { token: this.cfg.token, name: me?.username || '' };
    return this.bot.name;
  }

  async #withOptions(m) {
    const t = this.cfg;
    const hub = this.hub;
    const sender = String(m.chat.id);
    const here = { reply_to_message_id: m.message_id };
    const say = async (text, extra = here) => this.api('sendMessage', { chat_id: t.chatId, text: truncate(defuse(scrubOut(text).text), 4000), ...extra });
    // A list only holds what you named yourself, and its @names are there to be copied. Status holds
    // titles agents wrote, so that one goes through say.
    const list = (p, c) => (p.command === 'status' ? say : (text, extra) => this.api('sendMessage', { chat_id: t.chatId, text: truncate(text, 4000), ...extra }))(LISTS[p.command](c, p.arg), {});
    const g = gate({ sender, senders: [t.chatId], id: `${sender}:${m.message_id}`, at: m.date, seen: this.seen, limit: this.limit, rateKey: m.from?.id });
    if (!g.ok) {
      hub.phone.count?.('refused', g.why);
      if (g.reply) await say(g.reply);
      return;
    }
    // Only a private chat is one person. In a group anyone there can steer wisp, so no Full auto.
    const solo = m.chat.type ? m.chat.type === 'private' : Number(m.chat.id) > 0;
    const cap = solo ? 'auto' : 'edits';
    const text = stripFormatting(m.text, 'telegram', { bot: m.text.startsWith('@') ? await this.#botName() : '' });
    const ctx = await hub.phone.context();
    const replyTo = m.reply_to_message?.message_id;
    const sessionId = replyTo && this.#sessionOf(replyTo);
    return converse(
      {
        phone: hub.phone,
        hub,
        ctx,
        channel: this.name,
        name: 'Telegram',
        sender: m.from?.first_name || '',
        cap,
        approvals: this.approvalsHere,
        say,
        list,
        refuse: (problems) => say(refusal(problems)),
        thread: () => ({ channel: this.name, chat: m.chat.id, message: m.message_id, ack: null }),
        noThread: 'Reply to the task’s message to do that.',
        stale: (p) => (replyTo && !sessionId && p.command !== 'new' ? 'That message isn’t linked to a task any more. Send it without replying to start a new one.' : ''),
        acked: (thread, sent) => this.acked(thread, sent?.message_id),
      },
      text,
      sessionId,
    );
  }

  // The first reply went out: a reply to it reaches the task, whenever that started.
  acked(thread, messageId) {
    if (!messageId) return;
    thread.ack = messageId;
    this.hub.phone.threadSaved?.();
    if (thread.session) this.link(thread.session, messageId);
  }

  // A task or a crew job began for this thread (a queued job, maybe after a restart), or err: it
  // couldn't. Replies reach it, and its report comes back here.
  threadStarted(s, thread, by, err) {
    if (err) {
      const line = `${by ? `${by.name} couldn’t start: ` : 'Couldn’t start: '}${truncate(err.message, 300)}`;
      this.api('sendMessage', { chat_id: this.cfg.chatId, text: defuse(scrubOut(line).text), ...((thread.ack || thread.message) && { reply_to_message_id: thread.ack || thread.message, allow_sending_without_reply: true }) }).catch(() => {});
      return;
    }
    thread.session = s.id;
    this.hub.markStarted(s.id, this.name, by?.name);
    for (const id of [thread.message, thread.ack]) if (id) this.link(s.id, id);
  }

  // Replies to a Telegram message reach the session it belongs to.
  link(sessionId, messageId) {
    const hub = this.hub;
    const s = hub.store.get(sessionId);
    if (s) {
      s.remote = { ...s.remote, tg: [...(s.remote?.tg || []), messageId].slice(-MAX_TG_IDS) };
      hub.store.save(s);
      return;
    }
    hub.tgElsewhere.set(messageId, sessionId);
    if (hub.tgElsewhere.size > 200) hub.tgElsewhere.delete(hub.tgElsewhere.keys().next().value);
    const away = hub.away.get(sessionId);
    if (away) away.last = messageId;
  }
}
