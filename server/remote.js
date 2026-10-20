// Phone: push "needs you" moments to ntfy or Telegram and take the answers back. Both run on
// outbound connections only (wisp polls them), so nothing has to reach this machine.
//
//   ntfy      notification with up to 3 buttons. A tap makes the ntfy app POST a signed answer to
//             <topic>-reply, which wisp polls. No free text (ntfy has no reply box).
//   Telegram  a bot message with buttons; reply to the message to answer in your own words or
//             send a follow-up. Linked to one chat with a one-time code. With allowStart on,
//             /new [@project] <task> starts a task and /projects lists where it can run.

import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { bad, truncate } from './util.js';

const KIND = { a: 'answer', r: 'reply', d: 'done' };
const CODE = { answer: 'a', reply: 'r', done: 'd' };
const MAX_TG_IDS = 20;
const STALE_S = 10 * 60;
const sleep = (ms, signal) => new Promise((r) => (signal?.aborted ? r() : (setTimeout(r, ms).unref?.(), signal?.addEventListener('abort', r, { once: true }))));
// /new @name: exact name, then name prefix, then anywhere in the name or path.
export function findProject(projects, q) {
  const n = String(q || '').toLowerCase();
  if (!n) return null;
  const name = (p) => String(p.name || '').toLowerCase();
  return projects.find((p) => name(p) === n) || projects.find((p) => name(p).startsWith(n)) || projects.find((p) => name(p).includes(n) || String(p.path || '').toLowerCase().includes(n)) || null;
}
export const mask = (t) => (t ? `••••${String(t).slice(-4)}` : '');

export class Remote {
  // act({ sessionId, kind: answer|reply|done|text, ref, index, text, later? }) → a short result line;
  // later(text) sends one more message afterwards (a /btw answer).
  // launch({ project, prompt }) → the new session's summary (a task started with /new).
  constructor({ store, act, launch = async () => null, onChange = () => {} }) {
    Object.assign(this, { store, act, launch, onChange });
    this.status = { ntfy: null, telegram: null };
    this.tgElsewhere = new Map(); // Telegram message id -> session id, for sessions on a machine (server/machines.js)
    this.ac = null;
    this.ntfyPollMs = 4000;
    this.tgLongPoll = 25;
    this.tgOffset = 0;
  }

  get cfg() {
    return (this.store.config.remote ||= {});
  }

  get secret() {
    if (!this.cfg.secret) {
      this.cfg.secret = randomBytes(16).toString('hex');
      this.store.saveConfig();
    }
    return this.cfg.secret;
  }

  get on() {
    const c = this.cfg;
    return !!((c.ntfy?.enabled && c.ntfy.topic) || (c.telegram?.enabled && c.telegram.token));
  }

  start() {
    this.stop();
    const ac = (this.ac = new AbortController());
    const c = this.cfg;
    if (c.ntfy?.enabled && c.ntfy.topic) this.#ntfyLoop(ac.signal);
    if (c.telegram?.enabled && c.telegram.token) {
      if (!c.telegram.chatId && !c.telegram.linkCode) (c.telegram.linkCode = String(randomInt(100000, 999999))), this.store.saveConfig();
      this.#tgLoop(ac.signal);
    }
  }

  stop() {
    this.ac?.abort();
    this.ac = null;
  }

  // What the phone gets for a session that needs you, and the buttons under it.
  message(s, summary) {
    const where = `${summary?.project || ''}: ${s.title}`;
    if (s.ask) {
      return {
        title: `❓ ${where}`,
        text: [s.ask.question, s.ask.context && truncate(s.ask.context, 600)].filter(Boolean).join('\n\n'),
        actions: (s.ask.options || []).map((label, index) => ({ label, kind: 'answer', ref: s.ask.id, index })),
      };
    }
    const turn = s.turns.at(-1);
    const blocks = turn?.presentation?.blocks || [];
    const hero = blocks.find((b) => b?.type === 'hero');
    const q = blocks.findLast((b) => b?.type === 'question');
    const icon = { done: '✅', partial: '🟡', blocked: '⛔' }[hero?.status] || (turn?.status === 'error' ? '⛔' : '📝');
    const options = (q?.options || []).map((o) => (typeof o === 'string' ? { label: o } : o));
    return {
      title: `${icon} ${where}`,
      text: [hero?.title && hero.title !== s.title ? hero.title : '', hero?.summary || summary?.preview || 'Ready for review.', q?.question].filter(Boolean).join('\n\n'),
      actions: options.length ? options.map((o, index) => ({ label: o.label || String(o.reply || ''), kind: 'reply', ref: turn.id, index })) : [{ label: 'Mark done', kind: 'done', ref: turn?.id || '', index: 0 }],
    };
  }

  async notify(s, summary) {
    if (!this.on || !s || s.agent === 'wisp') return;
    const event = s.state === 'waiting' ? 'waiting' : 'finished';
    if (!(this.cfg.events || ['waiting', 'finished']).includes(event)) return;
    await this.send(this.message(s, summary), s);
  }

  async send(msg, s = null) {
    const c = this.cfg;
    const jobs = [];
    if (c.ntfy?.enabled && c.ntfy.topic) jobs.push(this.#ntfyPublish(msg, s).then(() => this.#mark('ntfy', { ok: true }), (e) => this.#mark('ntfy', { ok: false, error: e.message })));
    if (c.telegram?.enabled && c.telegram.token && c.telegram.chatId) jobs.push(this.#tgPublish(msg, s).then(() => this.#mark('telegram', { ok: true }), (e) => this.#mark('telegram', { ok: false, error: e.message })));
    await Promise.all(jobs);
    return jobs.length;
  }

  #mark(channel, st) {
    this.status[channel] = { ...this.status[channel], ...st, at: Date.now() };
    this.onChange();
  }

  // --- answers: signed, so a stranger who guesses the topic can't steer your agents ------------

  sign(sessionId, kind, ref, index) {
    return createHmac('sha256', this.secret).update(`${sessionId}.${kind}.${ref}.${index}`).digest('base64url').slice(0, 22);
  }

  verify(p) {
    if (!p || typeof p !== 'object' || !KIND[p.k] || typeof p.sig !== 'string') return false;
    const want = Buffer.from(this.sign(p.s, KIND[p.k], p.r, p.i));
    const got = Buffer.from(p.sig);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  // --- ntfy ------------------------------------------------------------------------------------

  #ntfy() {
    const n = this.cfg.ntfy;
    const server = String(n.server || 'https://ntfy.sh').replace(/\/+$/, '');
    return { server, topic: n.topic, headers: n.token ? { authorization: `Bearer ${n.token}` } : {} };
  }

  async #ntfyPublish(msg, s) {
    const { server, topic, headers } = this.#ntfy();
    const actions = (s ? msg.actions : []).slice(0, 3).map((a) => {
      const k = CODE[a.kind];
      return { action: 'http', label: truncate(a.label, 40), url: `${server}/${topic}-reply`, method: 'POST', headers, body: JSON.stringify({ s: s.id, k, r: a.ref, i: a.index, sig: this.sign(s.id, a.kind, a.ref, a.index) }), clear: true };
    });
    const r = await fetch(server, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ topic, title: truncate(msg.title, 200), message: truncate(msg.text, 3000), tags: ['wisp'], ...(actions.length && { actions }) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`ntfy: ${r.status} ${(await r.text().catch(() => '')).slice(0, 120)}`);
  }

  async #ntfyLoop(signal) {
    let since = String(Math.floor(Date.now() / 1000));
    while (!signal.aborted) {
      try {
        const { server, topic, headers } = this.#ntfy();
        const r = await fetch(`${server}/${topic}-reply/json?poll=1&since=${since}`, { headers, signal });
        if (!r.ok) throw new Error(`ntfy: ${r.status}`);
        for (const line of (await r.text()).split('\n')) {
          if (!line.trim()) continue;
          const m = JSON.parse(line);
          if (m.id) since = m.id;
          if (m.event !== 'message') continue;
          let p = null;
          try {
            p = JSON.parse(m.message);
          } catch {}
          if (!this.verify(p)) continue; // not ours, or forged
          await this.act({ sessionId: p.s, kind: KIND[p.k], ref: p.r, index: Number(p.i) }).catch(() => {});
        }
        if (this.status.ntfy?.error) this.#mark('ntfy', { ok: true, error: '' });
      } catch (err) {
        if (signal.aborted) return;
        this.#mark('ntfy', { ok: false, error: err.message });
      }
      await sleep(this.ntfyPollMs, signal);
    }
  }

  // --- Telegram --------------------------------------------------------------------------------

  async #tg(method, body, signal) {
    const base = (process.env.WISP_TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, '');
    const r = await fetch(`${base}/bot${this.cfg.telegram.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal || AbortSignal.timeout(15_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`Telegram: ${j.description || r.status}`);
    return j.result;
  }

  async #tgPublish(msg, s) {
    const buttons = (s ? msg.actions : []).map((a) => [{ text: truncate(a.label, 60), callback_data: `${CODE[a.kind]}:${s.id}:${a.ref}:${a.index}` }]);
    const sent = await this.#tg('sendMessage', {
      chat_id: this.cfg.telegram.chatId,
      text: truncate(`${msg.title}\n\n${msg.text}${s ? '\n\n↩ Reply to this message to answer or follow up.' : ''}`, 4000),
      ...(buttons.length && { reply_markup: { inline_keyboard: buttons } }),
    });
    if (s && sent?.message_id) this.#tgLink(s.id, sent.message_id);
  }

  // The offset outlives restarts (every settings change restarts the loop), or Telegram would
  // hand back updates already handled and a /new would start its task twice.
  async #tgLoop(signal) {
    while (!signal.aborted) {
      try {
        const updates = await this.#tg('getUpdates', { offset: this.tgOffset, timeout: this.tgLongPoll, allowed_updates: ['message', 'callback_query'] }, signal);
        if (this.status.telegram?.error) this.#mark('telegram', { ok: true, error: '' });
        for (const u of updates) {
          if (u.update_id < this.tgOffset) continue;
          this.tgOffset = u.update_id + 1;
          await this.#fromTelegram(u).catch((err) => console.warn(`wisp: telegram: ${err.message}`));
        }
      } catch (err) {
        if (signal.aborted) return;
        this.#mark('telegram', { ok: false, error: err.message });
        await sleep(5000, signal);
      }
    }
  }

  async #fromTelegram(u) {
    const t = this.cfg.telegram;
    const say = (text, extra = {}) => this.#tg('sendMessage', { chat_id: t.chatId, text, ...extra });
    if (u.callback_query) {
      const q = u.callback_query;
      if (!t.chatId || String(q.message?.chat?.id) !== String(t.chatId)) return;
      const [k, sessionId, ref, i] = String(q.data || '').split(':');
      const result = KIND[k] ? await this.act({ sessionId, kind: KIND[k], ref, index: Number(i) }) : 'Unknown button.';
      await this.#tg('answerCallbackQuery', { callback_query_id: q.id, text: truncate(result, 190) }).catch(() => {});
      await this.#tg('editMessageReplyMarkup', { chat_id: t.chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return;
    }
    const m = u.message;
    if (!m?.text) return;
    if (!t.chatId) {
      // Linking: only the chat that sends the code shown in wisp's settings gets attached.
      if (t.linkCode && m.text.replace(/^\/(start|link)\s*/, '').trim() === t.linkCode) {
        Object.assign(t, { chatId: m.chat.id, chatName: m.chat.title || [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') || m.chat.username || '', linkCode: '' });
        this.store.saveConfig();
        this.#mark('telegram', { ok: true, error: '' });
        await say('✓ Linked to wisp. Questions and finished tasks will show up here.');
      }
      return;
    }
    if (String(m.chat.id) !== String(t.chatId)) return;
    const cmd = m.text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
    if (cmd && ['new', 'projects', 'help', 'start'].includes(cmd[1].toLowerCase())) return this.#tgCommand(cmd[1].toLowerCase(), cmd[2].trim(), m, say);
    const replyTo = m.reply_to_message?.message_id;
    const sessionId = replyTo && (this.store.all().find((x) => x.remote?.tg?.includes(replyTo))?.id || this.tgElsewhere.get(replyTo));
    if (!sessionId) return say(t.allowStart ? 'Reply to one of wisp’s messages to answer it or follow up, or send /new <task> to start one.' : 'Reply to one of wisp’s messages to answer it or send a follow-up.');
    const later = (text) => say(text, { reply_to_message_id: m.message_id }).catch(() => {});
    await say(await this.act({ sessionId, kind: 'text', text: m.text, later }), { reply_to_message_id: m.message_id });
  }

  async #tgCommand(name, arg, m, say) {
    const t = this.cfg.telegram;
    const off = 'Starting tasks from Telegram is off. Turn it on in wisp → Phone → Telegram.';
    const projects = this.store.config.projects;
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
      const def = this.defaultProject();
      const where = (id) => (this.store.config.machines || []).find((x) => x.id === id)?.name || id;
      const lines = projects.map((p) => `• ${p.name}${p.machine ? ` (on ${where(p.machine)})` : ''}${p === def ? '  ← default' : ''}`);
      return say(truncate(`Projects:\n${lines.join('\n')}\n\n/new @name <task> runs in one of them.`, 4000));
    }
    let prompt = arg;
    let project = this.defaultProject();
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
      s = await this.launch({ project, prompt });
    } catch (err) {
      return say(`Couldn’t start it: ${truncate(err.message, 300)}`, { reply_to_message_id: m.message_id });
    }
    const sent = await say(truncate(`▶ Started in ${project.name}: ${s?.title || prompt}\n\nwisp will message you when it needs you or is done. Reply to this message to follow up.`, 4000), { reply_to_message_id: m.message_id });
    if (s?.id && sent?.message_id) this.#tgLink(s.id, sent.message_id);
  }

  // The project /new uses without an @name: the one picked in settings, else the last used.
  defaultProject() {
    const projects = this.store.config.projects;
    const id = this.cfg.telegram?.project;
    return (id && projects.find((p) => p.id === id)) || [...projects].sort((a, b) => (b.lastUsedAt || b.addedAt || 0) - (a.lastUsedAt || a.addedAt || 0))[0] || null;
  }

  // Replies to a Telegram message reach the session it belongs to.
  #tgLink(sessionId, messageId) {
    const s = this.store.get(sessionId);
    if (s) {
      s.remote = { ...s.remote, tg: [...(s.remote?.tg || []), messageId].slice(-MAX_TG_IDS) };
      this.store.save(s);
      return;
    }
    this.tgElsewhere.set(messageId, sessionId);
    if (this.tgElsewhere.size > 200) this.tgElsewhere.delete(this.tgElsewhere.keys().next().value);
  }

  // For the settings view: config with secrets masked, plus channel health.
  view() {
    const c = this.cfg;
    return {
      events: c.events || ['waiting', 'finished'],
      ntfy: { enabled: !!c.ntfy?.enabled, server: c.ntfy?.server || 'https://ntfy.sh', topic: c.ntfy?.topic || '', token: mask(c.ntfy?.token) },
      telegram: {
        enabled: !!c.telegram?.enabled,
        token: mask(c.telegram?.token),
        linked: !!c.telegram?.chatId,
        chatName: c.telegram?.chatName || '',
        linkCode: c.telegram?.chatId ? '' : c.telegram?.linkCode || '',
        allowStart: !!c.telegram?.allowStart,
        project: c.telegram?.project || '',
      },
      status: this.status,
    };
  }

  // PUT body: { events, ntfy: {…}, telegram: {…, unlink} }. Masked tokens mean "unchanged".
  update(body = {}) {
    const c = this.cfg;
    const keep = (v, prev) => (typeof v === 'string' && v.startsWith('••••') ? prev : v);
    if (Array.isArray(body.events)) c.events = body.events.filter((e) => e === 'waiting' || e === 'finished');
    if (body.ntfy) {
      const n = { ...c.ntfy, ...body.ntfy };
      n.token = keep(body.ntfy.token, c.ntfy?.token) || '';
      if (n.server && !/^https?:\/\/\S+$/.test(n.server)) throw bad('ntfy server must be an http(s) URL');
      if (n.topic && !/^[\w-]{1,64}$/.test(n.topic)) throw bad('ntfy topic: letters, digits, - and _ only');
      c.ntfy = { enabled: !!n.enabled, server: n.server || 'https://ntfy.sh', topic: n.topic || '', token: n.token };
    }
    if (body.telegram) {
      const prev = c.telegram || {};
      const token = (body.telegram.token === undefined ? prev.token : keep(body.telegram.token, prev.token)) || ''; // missing = unchanged
      const relink = body.telegram.unlink || token !== prev.token;
      if (token !== prev.token) this.tgOffset = 0; // another bot, another update counter
      const project = body.telegram.project ?? prev.project ?? '';
      if (project && !this.store.config.projects.some((p) => p.id === project)) throw bad('Unknown project');
      c.telegram = {
        ...prev,
        enabled: !!(body.telegram.enabled ?? prev.enabled),
        token,
        allowStart: !!(body.telegram.allowStart ?? prev.allowStart),
        project,
        ...(relink && { chatId: null, chatName: '', linkCode: token ? String(randomInt(100000, 999999)) : '' }),
      };
    }
    this.store.saveConfig();
    this.start();
    return this.view();
  }
}
