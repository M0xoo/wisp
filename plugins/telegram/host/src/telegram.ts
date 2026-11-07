// size-ok: v1 telegram.js's one class (wire, poll, webhook, inbound), its commands and Settings split out
// Telegram: a bot message with buttons; reply to the message to answer in your own words or send a
// follow-up. Linked to one chat with a one-time code. With allowStart on, /new [@project] <task>
// starts a task and /projects lists where it can run (commands.ts).
//
// With telegram.options on as well (it sits under allowStart), a message says what you'd type in the
// launcher: it goes through the channel layer (options.ts), and plain text starts a task. Off, every
// path here is the one it always was.
//
// On a computer it polls. A cloud wisp sleeps, and nothing polls while it does: there it sets a
// webhook to the grid's held inbox, which wakes it, and never polls while one is set (Telegram answers
// getUpdates with a 409). With no hub on that grid it polls as it always did. The port of v1
// server/channels/telegram.js; what v1 kept in s.remote.tg is the hub's thread row.

import type { Json } from '@wisp/kernel';
import type { ChannelHub, InboundResult, Msg, SessionView, Thread } from '@wisp-plugin/channels-api';
import { CODE, Channel, KIND, RateLimit, Seen, defuse, errText, gate, lostLine, newLinkCode, resend, same, scrubOut, sleep, truncate } from '@wisp-plugin/channels-api/kit';
import { command } from './commands.ts';
import { withOptions } from './options.ts';
import { tgUpdate, tgView } from './settings.ts';
import type { TgConfig, TgMessage, TgThread, TgUpdate } from './types.ts';

const MAX_TG_IDS = 20;
const HOOK_RETRY_MS = 30_000;
const NOT_REMOVED = 'Couldn’t remove the webhook';
const SEEN_UPDATES = 100; // kept with the webhook: a box's memory ends when it sleeps
const UPDATES = ['message', 'callback_query'];
export const COMMANDS: readonly (readonly [string, string])[] = [
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
const forwarded = (m: TgMessage): boolean => FORWARD_FIELDS.some((f) => m[f] != null && m[f] !== false);

export interface TelegramOpts {
  /** the Bot API's base (WISP_TELEGRAM_API, read once at setup) */
  api: string;
}

type Extra = Record<string, unknown>;

export class Telegram extends Channel {
  readonly kind = 'phone' as const;
  readonly seen = new Seen();
  limit = new RateLimit();
  bot: { token: string; name: string } | null = null; // who this bot is, for "@wispbot …" in a group
  listed = ''; // the token whose commands Telegram has
  offset = 0; // getUpdates' offset: memory, as v1's hub.tgOffset was; a new token starts it over
  #wire: Promise<unknown> = Promise.resolve(); // webhook calls, one at a time
  readonly #takingDown = new Set<string>(); // bots a deleteWebhook is on its way for
  readonly #base: string;

  constructor(hub: ChannelHub, o: TelegramOpts) {
    super(hub, 'telegram');
    this.#base = o.api.replace(/\/+$/, '');
  }

  get t(): TgConfig {
    return this.cfg as TgConfig;
  }

  override get ready(): boolean {
    const t = this.hub.cfg['telegram'] as TgConfig | undefined;
    return !!(t?.enabled && t.token);
  }

  /** Sending needs a linked chat as well. */
  get linked(): boolean {
    return !!(this.ready && this.t.chatId);
  }

  get sending(): boolean {
    return this.linked;
  }

  /** The new way in: the switch, under allowStart. */
  get options(): boolean {
    const t = this.hub.cfg['telegram'] as TgConfig | undefined;
    return !!(t?.options && t.allowStart);
  }

  get layer(): boolean {
    return this.options;
  }

  async api<R = unknown>(method: string, body: unknown, signal?: AbortSignal, token = this.t.token ?? ''): Promise<R> {
    const r = await resend(
      () => this.hub.net.fetch(`${this.#base}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: signal || AbortSignal.timeout(15_000) }),
      method === 'sendMessage' ? undefined : 1, // the poll has its own way back; a tap's answer is past its moment
    );
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: R };
    if (!j.ok) throw new Error(`Telegram: ${j.description || r.status}`);
    return j.result as R;
  }

  /** sendMessage to the linked chat. */
  send(text: string, extra: Extra = {}): Promise<{ message_id?: number } | undefined> {
    return this.api('sendMessage', { chat_id: this.t.chatId, text, ...extra });
  }

  override async publish(msg: Msg, s: SessionView | null): Promise<void> {
    const buttons = (s ? msg.actions : []).map((a) => [{ text: truncate(a.label, 60), callback_data: `${CODE[a.kind]}:${s?.id}:${a.ref}:${a.index}` }]);
    const reply = this.options ? this.hub.threadOf(s) : null; // a task started here answers in its thread
    const sent = await this.send(truncate(`${msg.title}\n\n${msg.text}${s ? '\n\n↩ Reply to this message to answer or follow up.' : ''}`, 4000), {
      ...(buttons.length && { reply_markup: { inline_keyboard: buttons } }),
      ...(reply ? { reply_to_message_id: reply, allow_sending_without_reply: true } : {}),
    });
    if (s && sent?.message_id) this.link(s.id, sent.message_id);
  }

  // The offset outlives restarts (every settings change restarts the loop), or Telegram would hand
  // back updates already handled and a /new would start its task twice.
  override async start(signal: AbortSignal): Promise<void> {
    void this.retryUnhook(); // every start, on or off: it's off that left one behind
    if (!this.ready) return;
    const t = this.t;
    if (!t.chatId && !t.linkCode) {
      t.linkCode = newLinkCode(this.hub);
      this.hub.save();
    }
    if (this.options && this.listed !== t.token) {
      this.listed = t.token ?? '';
      this.api('setMyCommands', { commands: COMMANDS.map(([c, description]) => ({ command: c, description })) }).catch(() => {});
    }
    if (await this.#hooked(signal)) return;
    await this.#poll(signal);
  }

  async #poll(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const updates = await this.api<TgUpdate[]>('getUpdates', { offset: this.offset, timeout: Number(this.hub.tune['tgLongPoll'] ?? 25), allowed_updates: UPDATES }, signal);
        if (this.hub.status['telegram']?.error) this.mark({ ok: true, error: '' });
        for (const u of updates) {
          if (u.update_id < this.offset) continue;
          this.offset = u.update_id + 1;
          await this.from(u).catch((err: unknown) => this.hub.log.warn(`wisp: telegram: ${errText(err)}`));
        }
      } catch (err) {
        if (signal.aborted) return;
        this.mark({ ok: false, error: errText(err) });
        await sleep(5000, signal);
      }
    }
  }

  // --- webhook: a cloud wisp whose grid has the hub ---------------------------------------------

  // True when a webhook takes care of inbound, or wisp is trying to get one up (either way, no
  // polling). False: poll. A computer with no webhook left over in its config never gets past line one.
  async #hooked(signal: AbortSignal): Promise<boolean> {
    const box = this.hub.box.grid();
    if (!box && !this.t.hook) return false;
    const timed = (): AbortSignal => AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    while (!signal.aborted) {
      try {
        let found: { url?: string; dropped?: number; held?: boolean } | null = null;
        if (box) {
          try {
            found = await this.hub.box.channelUrl(box, this.name, this.hub.box.botMark(this.t.token ?? ''));
          } catch (err) {
            if (!this.t.hook) return false; // no webhook to get in the way: poll while the grid can't be reached
            throw new Error(`the grid: ${errText(err)}`);
          }
        }
        if (!found) {
          // No hub here (a grid that turned it off, a config moved to a computer): what's left of it goes first.
          if (!this.t.hook) return false;
          await this.api('deleteWebhook', {}, timed());
          if (signal.aborted) return true;
          delete this.t.hook;
          this.hub.save();
          this.mark({ webhook: false });
          return false;
        }
        if (found.dropped) await this.dropped(found.dropped);
        // The grid owns the webhook: one call here would take it back.
        if (found.held) {
          if (!this.t.hook?.held) this.t.hook = { held: true, seen: this.t.hook?.seen || [] };
          this.hub.save();
          this.mark({ ok: true, error: '', webhook: true });
          return true;
        }
        await this.#setHook(found.url ?? '', timed);
        if (!signal.aborted) this.mark({ ok: true, error: '', webhook: true });
        return true;
      } catch (err) {
        if (signal.aborted) return true;
        this.mark({ ok: false, error: `Couldn’t set the webhook: ${errText(err)}`, webhook: false });
        await sleep(Number(this.hub.tune['hookRetryMs'] ?? HOOK_RETRY_MS), signal);
      }
    }
    return true;
  }

  // In order: a switch flipped while Telegram answers mustn't cross with what's on its way.
  #inTurn<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#wire.then(fn, fn);
    this.#wire = run.catch(() => {});
    return run;
  }

  // Only when Telegram doesn't already have it. A new URL keeps the secret and the seen list: messages
  // held at the grid carry the secret they came with, so a new one would have the box refuse them all.
  #setHook(url: string, timed: () => AbortSignal): Promise<void> {
    return this.#inTurn(async () => {
      const token = this.t.token ?? '';
      const had = this.t.hook;
      if (had?.url === url && (await this.api<{ url?: string }>('getWebhookInfo', {}, timed())).url === url) return;
      const secret = had?.secret || this.hub.randomHex(32);
      // Not cut off by the switch: Telegram may have taken it, and then it has to be undone.
      await this.api('setWebhook', { url, secret_token: secret, allowed_updates: UPDATES }, AbortSignal.timeout(15_000), token);
      if (this.ready && this.t.token === token) {
        this.t.hook = { url, secret, seen: had?.seen || [] };
        this.hub.save();
        this.#unmark(token); // this bot's webhook is wanted again
      } else await this.api('deleteWebhook', {}, undefined, token); // switched off meanwhile: update() saw no webhook to remove
    });
  }

  // Switched off, unlinked or another bot: Telegram stops calling. token: the bot it was set on, gone
  // from the config by now, so it's kept in unhooking until Telegram says done.
  unhook(token: string): Promise<void> {
    this.t.unhooking = [...new Set([...(this.t.unhooking || []), token])];
    this.mark({ webhook: false });
    return this.#takeDown(token);
  }

  /** Every start, on or off: what a failed unhook left. */
  retryUnhook(): Promise<unknown> {
    const t = this.hub.cfg['telegram'] as TgConfig | undefined;
    return Promise.all((t?.unhooking || []).map((token) => this.#takeDown(token)));
  }

  async #takeDown(token: string): Promise<void> {
    if (this.#takingDown.has(token)) return;
    this.#takingDown.add(token);
    try {
      // The grid may have taken this bot since this box last asked: then it isn't this box's to take
      // down. Can't tell: it's tried again at the next start.
      if (!(await this.#gridHolds(token))) await this.#inTurn(() => this.api('deleteWebhook', {}, undefined, token));
      this.#unmark(token);
      if (this.hub.status['telegram']?.error?.startsWith(NOT_REMOVED)) this.mark({ ok: true, error: '' });
    } catch (err) {
      this.mark({ ok: false, error: `${NOT_REMOVED}: ${errText(err)}`, webhook: false });
    } finally {
      this.#takingDown.delete(token);
    }
  }

  async #gridHolds(token: string): Promise<boolean> {
    const box = this.hub.box.grid();
    if (!box) return false;
    const gone = !this.ready || this.t.token !== token;
    return !!(await this.hub.box.channelUrl(box, this.name, this.hub.box.botMark(token), { gone }))?.held;
  }

  #unmark(token: string): void {
    if (!this.t.unhooking?.includes(token)) return;
    this.t.unhooking = this.t.unhooking.filter((x) => x !== token);
    if (!this.t.unhooking.length) delete this.t.unhooking;
    this.hub.save();
  }

  // A leaked URL: the grid drops it, then Telegram is told the new one. Until then its calls get a 404
  // and it keeps the updates, so nothing is lost. If that fails the old URL is dead, so #hooked takes over.
  override async rotate(): Promise<{ status: number; body: Json }> {
    const box = this.hub.box.grid();
    const hook = this.t.hook;
    if (!box || !this.ready || !hook) return { status: 409, body: { error: 'Telegram has no webhook here.' } };
    // The grid may have taken this bot since this box last asked: a new URL would take it back.
    const found = await this.hub.box.channelUrl(box, this.name, this.hub.box.botMark(this.t.token ?? '')).catch((err: unknown) => ({ error: errText(err) }));
    if (found && 'error' in found) return { status: 502, body: { error: `Couldn’t ask the grid: ${found.error}` } };
    if (found?.held) {
      this.t.hook = { held: true, seen: hook.seen || [] };
      this.hub.save();
      return { status: 409, body: { error: 'The grid holds this bot’s webhook, so there’s no URL here to rotate.' } };
    }
    const { url } = await this.hub.box.rotateUrl(box, this.name);
    try {
      await this.#setHook(url ?? '', () => AbortSignal.timeout(15_000));
    } catch (err) {
      this.hub.start();
      return { status: 502, body: { error: `Rotated, but Telegram didn’t take the new URL yet: ${errText(err)}` } };
    }
    return { status: 200, body: { ok: true } };
  }

  // A message the grid held. Only Telegram knows this secret, and only a retry repeats an update.
  // verified: the grid owns the webhook and checked its own secret. Only its delivery can say so, and
  // at worst that lets this box talk to itself.
  override async inbound(raw: Uint8Array, headers: Readonly<Record<string, string | string[] | undefined>> = {}, { verified = false }: { at?: number; verified?: boolean } = {}): Promise<InboundResult> {
    if (verified && this.ready) this.t.hook ||= { held: true, seen: [] };
    const hook = this.ready ? this.t.hook : undefined;
    if (!hook || (!verified && !hook.secret)) return { status: 409, body: { error: 'Telegram isn’t on here.' } };
    if (!verified && !same(String(headers['x-telegram-bot-api-secret-token'] ?? ''), hook.secret ?? '')) return { status: 403, body: { error: 'Wrong secret token.' } };
    let u: TgUpdate | undefined;
    try {
      u = JSON.parse(new TextDecoder().decode(raw)) as TgUpdate;
    } catch {
      u = undefined;
    }
    if (!u || !Number.isInteger(u.update_id)) return { status: 400, body: { error: 'Not an update.' } };
    // A stranger's message really came from Telegram, so its secret is good: this 403 is what tells
    // the grid nobody wanted it, and it's a stranger's wake it stops paying for.
    const stranger = !this.#ours(u) ? { status: 403, body: { error: 'Not from the linked chat.' } } : null;
    if (hook.seen?.includes(u.update_id)) return stranger || { status: 200, body: { ok: true, duplicate: true } };
    hook.seen = [...(hook.seen || []), u.update_id].slice(-SEEN_UPDATES);
    this.hub.save();
    await this.from(u).catch((err: unknown) => this.hub.log.warn(`wisp: telegram: ${errText(err)}`));
    return stranger || { status: 200, body: { ok: true } };
  }

  // From the linked chat, or, before there is one, the code that links it.
  #ours(u: TgUpdate): boolean {
    if (!this.t.chatId) return this.#linksIt(u.message);
    return String((u.callback_query?.message ?? u.message)?.chat?.id) === String(this.t.chatId);
  }

  #linksIt(m: TgMessage | undefined): boolean {
    return !!this.t.linkCode && m?.text?.replace(/^\/(start|link)\s*/, '').trim() === this.t.linkCode;
  }

  override async dropped(n: number): Promise<void> {
    this.mark({ dropped: n });
    if (!this.linked) return;
    await this.send(lostLine(n)).catch(() => {});
  }

  async #tap(q: NonNullable<TgUpdate['callback_query']>): Promise<void> {
    const t = this.t;
    if (!t.chatId || String(q.message?.chat?.id) !== String(t.chatId)) return;
    const [k = '', sessionId = '', ref = '', i] = String(q.data || '').split(':');
    const kind = KIND[k];
    const result = kind ? await this.hub.act({ sessionId, kind, ref, index: Number(i) }) : 'Unknown button.';
    await this.api('answerCallbackQuery', { callback_query_id: q.id, text: truncate(this.options ? defuse(scrubOut(result).text) : scrubOut(result, { note: false }).text, 190) }).catch(() => {});
    await this.api('editMessageReplyMarkup', { chat_id: t.chatId, message_id: q.message?.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }

  /** One update, from the poll or the webhook. */
  async from(u: TgUpdate): Promise<unknown> {
    const t = this.t;
    const say = (text: string, extra: Extra = {}): Promise<{ message_id?: number } | undefined> => this.send(scrubOut(text).text, extra);
    if (u.callback_query) return this.#tap(u.callback_query);
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
        this.hub.save();
        this.mark({ ok: true, error: '' });
        await say('✓ Linked to wisp. Questions and finished tasks will show up here.');
      }
      return;
    }
    if (this.options) return withOptions(this, m);
    if (String(m.chat.id) !== String(t.chatId)) return;
    const cmd = /^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/.exec(m.text);
    const name = cmd?.[1]?.toLowerCase() ?? '';
    if (cmd && ['new', 'projects', 'help', 'start'].includes(name)) return command(this, name, (cmd[2] ?? '').trim(), m, say);
    const replyTo = m.reply_to_message?.message_id;
    const sessionId = replyTo ? this.sessionOf(replyTo) : undefined;
    if (!sessionId) return say(t.allowStart ? 'Reply to one of wisp’s messages to answer it or follow up, or send /new <task> to start one.' : 'Reply to one of wisp’s messages to answer it or send a follow-up.');
    const later = (text: string): void => void say(text, { reply_to_message_id: m.message_id }).catch(() => {});
    return say(await this.hub.act({ sessionId, kind: 'text', text: m.text, later }), { reply_to_message_id: m.message_id });
  }

  /** The task a Telegram message belongs to: one here (its thread row), or on a machine (memory). */
  sessionOf(messageId: number): string | undefined {
    return this.hub.findRemote((r) => !!r.tg?.includes(messageId))[0] || this.hub.tgElsewhere.get(messageId);
  }

  /** Who this bot is, asked once: in a group people write "@wispbot in api fix it". */
  async botName(): Promise<string> {
    if (this.bot?.token === this.t.token) return this.bot.name;
    const me = await this.api<{ username?: string }>('getMe', {}).catch(() => null);
    this.bot = { token: this.t.token ?? '', name: me?.username || '' };
    return this.bot.name;
  }

  /** The first reply went out: a reply to it reaches the task, whenever that started. */
  acked(thread: TgThread | null, messageId: number | undefined): void {
    if (!messageId || !thread) return;
    thread.ack = messageId;
    this.hub.phone.threadSaved();
    if (thread.session) this.link(thread.session, messageId);
  }

  // A task or a crew job began for this thread (a queued job, maybe after a restart), or err: it
  // couldn't. Replies reach it, and its report comes back here.
  threadStarted(s: SessionView | null, raw: Thread, by: { name: string } | null, err?: Error): void {
    const thread = raw as TgThread;
    if (err || !s) {
      const line = `${by ? `${by.name} couldn’t start: ` : 'Couldn’t start: '}${truncate(err?.message ?? '', 300)}`;
      const to = thread.ack || thread.message;
      this.send(defuse(scrubOut(line).text), to ? { reply_to_message_id: to, allow_sending_without_reply: true } : {}).catch(() => {});
      return;
    }
    thread.session = s.id;
    this.hub.markStarted(s.id, this.name, by?.name);
    for (const id of [thread.message, thread.ack]) if (id) this.link(s.id, id);
  }

  /** Replies to a Telegram message reach the session it belongs to. */
  link(sessionId: string, messageId: number): void {
    const hub = this.hub;
    if (!sessionId.includes('@')) {
      const r = hub.remoteOf(sessionId);
      hub.setRemote(sessionId, { ...r, tg: [...(r?.tg || []), messageId].slice(-MAX_TG_IDS) });
      return;
    }
    hub.tgElsewhere.set(messageId, sessionId);
    if (hub.tgElsewhere.size > 200) {
      const first = hub.tgElsewhere.keys().next().value;
      if (first !== undefined) hub.tgElsewhere.delete(first);
    }
    const away = hub.away.get(sessionId);
    if (away) away.last = messageId;
  }

  override view(): Json {
    return tgView(this);
  }

  update(body: Record<string, unknown>): Promise<void> {
    return tgUpdate(this, body);
  }
}
