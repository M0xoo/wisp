// Telegram: a bot message with buttons; reply to the message to answer in your own words or send a
// follow-up. Linked to one chat with a one-time code. With allowStart on, /new [@project] <task>
// starts a task and /projects lists where it can run.
//
// With telegram.options on as well (it sits under allowStart), a message says what you'd type in the
// launcher: it goes through the channel layer (policy.js, grammar.js, lists.js), and plain text starts
// a task. Off, every path here is the one it always was.

import { truncate } from '../util.js';
import { Channel, CODE, KIND, sleep } from './channel.js';
import { findProject, parseMessage, stripFormatting } from './grammar.js';
import { LISTS, refusal } from './lists.js';
import { RateLimit, Seen, STALE_S, capMode, defuse, gate, scrubOut } from './policy.js';

const MAX_TG_IDS = 20;
const COMMANDS = [
  ['new', 'Start a task: options, then what to do'],
  ['help', 'What you can say here'],
  ['projects', 'Where a task can run'],
  ['models', 'Harnesses and models'],
  ['crew', 'Your crew and what they’re on'],
  ['machines', 'Your machines and who’s online'],
  ['status', 'What’s running and waiting'],
];

export class Telegram extends Channel {
  constructor(hub) {
    super(hub, 'telegram');
    this.seen = new Seen();
    this.limit = new RateLimit();
    this.bot = null; // { token, name }: who this bot is, for "@wispbot …" in a group
    this.listed = ''; // the token whose commands Telegram has
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

  async api(method, body, signal) {
    const base = (process.env.WISP_TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, '');
    const r = await fetch(`${base}/bot${this.cfg.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal || AbortSignal.timeout(15_000),
    });
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
    while (!signal.aborted) {
      try {
        const updates = await this.api('getUpdates', { offset: hub.tgOffset, timeout: hub.tgLongPoll, allowed_updates: ['message', 'callback_query'] }, signal);
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

  async #from(u) {
    const t = this.cfg;
    const hub = this.hub;
    const say = (text, extra = {}) => this.api('sendMessage', { chat_id: t.chatId, text, ...extra });
    if (u.callback_query) {
      const q = u.callback_query;
      if (!t.chatId || String(q.message?.chat?.id) !== String(t.chatId)) return;
      const [k, sessionId, ref, i] = String(q.data || '').split(':');
      const result = KIND[k] ? await hub.act({ sessionId, kind: KIND[k], ref, index: Number(i) }) : 'Unknown button.';
      await this.api('answerCallbackQuery', { callback_query_id: q.id, text: truncate(this.options ? defuse(scrubOut(result).text) : result, 190) }).catch(() => {});
      await this.api('editMessageReplyMarkup', { chat_id: t.chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return;
    }
    const m = u.message;
    if (!m?.text) return;
    if (!t.chatId) {
      // Linking: only the chat that sends the code shown in wisp's settings gets attached.
      if (t.linkCode && m.text.replace(/^\/(start|link)\s*/, '').trim() === t.linkCode) {
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
    if (sessionId) {
      const thread = await hub.phone.threadCtx(sessionId);
      const p = parseMessage(text, { ...ctx, thread });
      if (p.command !== 'new') return this.#inThread(sessionId, p, ctx, { m, say, list, cap });
    }
    const p = parseMessage(text, ctx);
    if (p.command && p.command !== 'new') {
      hub.phone.count?.('list', p.command);
      if (LISTS[p.command]) return list(p, ctx);
      return say('Reply to the task’s message to do that.'); // stop, done, /btw
    }
    if (replyTo && !sessionId && p.command !== 'new') return say('That message isn’t linked to a task any more. Send it without replying to start a new one.');
    if (p.problems.length) {
      hub.phone.count?.('refused', p.problems[0].kind);
      return say(refusal(p.problems));
    }
    if (!p.prompt) return say(p.crew ? `Tell ${p.crew.name} what to do after the name.` : 'What should it do? Say it after the options.');
    const asked = capMode(p.mode, cap, 'plan');
    if (asked.refused) {
      hub.phone.count?.('refused', 'mode');
      return say(`${asked.refused}\n\nNothing started.`);
    }
    if (!p.crew && !p.project && !ctx.defaultProject) return say('No projects yet. Open a folder in wisp first.');
    const thread = { channel: this.name, chat: m.chat.id, message: m.message_id, ack: null };
    let out;
    try {
      out = await hub.phone.startParsed(p, { channel: this.name, name: 'Telegram', sender: m.from?.first_name || '', cap, thread, ctx });
    } catch (err) {
      return say(`Couldn’t start it: ${truncate(err.message, 300)}`);
    }
    const sent = await say(out.ack);
    this.acked(thread, sent?.message_id);
  }

  async #inThread(sessionId, p, ctx, { m, say, list, cap }) {
    const hub = this.hub;
    const phone = hub.phone;
    if (LISTS[p.command] && p.command !== 'status') return list(p, ctx);
    if (p.command === 'stop') return say(await phone.stop(sessionId));
    if (p.command === 'status') return say(await phone.status(sessionId));
    if (p.command === 'done') return say(await hub.act({ sessionId, kind: 'done', ref: '', index: 0 }));
    if (p.problems.length) return say(refusal(p.problems));
    const later = (text) => say(text).catch(() => {});
    const sender = m.from?.first_name || '';
    if (p.crew) {
      if (!p.prompt) return say(`Tell ${p.crew.name} what to do after the name.`);
      const thread = { channel: this.name, chat: m.chat.id, message: m.message_id, ack: null };
      try {
        const out = await phone.mention(sessionId, p, { name: 'Telegram', sender, cap, thread, ctx });
        const sent = await say(out.ack);
        this.acked(thread, sent?.message_id);
      } catch (err) {
        await say(`Couldn’t ask them: ${truncate(err.message, 300)}`);
      }
      return;
    }
    const btw = p.command === 'btw';
    if (!p.prompt) return say(btw ? 'Type your question after /btw.' : 'What should it do? Say it after the options.');
    const asked = capMode(p.mode, cap, p.mode);
    if (asked.refused) return say(asked.refused);
    // Only the follow-up itself: a reply that fails to reach Telegram mustn't say it wasn't sent, or
    // it gets sent twice.
    const line = await phone.run(sessionId, p, { name: 'Telegram', sender, cap, later, btw }).catch((err) => `Couldn’t send that: ${truncate(err.message, 300)}`);
    await say(line);
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
