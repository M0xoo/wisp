// Phone: push "needs you" moments to ntfy or Telegram and take the answers back. Both run on
// outbound connections only (wisp polls them), so nothing has to reach this machine.
//
// This is the hub: the config, the public API and the fan-out. Each channel's wire is in
// server/channels/ (ntfy.js, telegram.js), and what they all share is there too: policy.js (who may
// speak, what may leave), grammar.js and lists.js (what a message can say).

import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { KIND } from './channels/channel.js';
import { scrubOut, defuse } from './channels/policy.js';
import { Ntfy } from './channels/ntfy.js';
import { Telegram } from './channels/telegram.js';
import { bad, truncate } from './util.js';

export { findProject } from './channels/grammar.js';
export const mask = (t) => (t ? `••••${String(t).slice(-4)}` : '');

export class Remote {
  // act({ sessionId, kind: answer|reply|done|text, ref, index, text, later? }) → a short result line;
  // later(text) sends one more message afterwards (a /btw answer).
  // launch({ project, prompt }) → the new session's summary (a task started with /new).
  // phone: the rest of services/phone.js, what the channel layer needs of wisp.
  constructor({ store, act, launch = async () => null, onChange = () => {}, ...phone }) {
    Object.assign(this, { store, act, launch, onChange, phone });
    this.status = { ntfy: null, telegram: null };
    this.tgElsewhere = new Map(); // Telegram message id -> session id, for sessions on a machine (server/machines.js)
    this.away = new Map(); // session id on a machine -> { channel, by, last }: what s.remote holds for one here
    this.channels = { ntfy: new Ntfy(this), telegram: new Telegram(this) };
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
    return Object.values(this.channels).some((c) => c.ready);
  }

  start() {
    this.stop();
    const ac = (this.ac = new AbortController());
    const c = this.cfg;
    const { ntfy, telegram } = this.channels;
    if (ntfy.ready) ntfy.start(ac.signal);
    if (telegram.ready) {
      if (!c.telegram.chatId && !c.telegram.linkCode) (c.telegram.linkCode = String(randomInt(100000, 999999))), this.store.saveConfig();
      telegram.start(ac.signal);
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
    const chosen = (this.cfg.events || ['waiting', 'finished']).includes(event);
    if (!this.channels.telegram.options) {
      if (chosen) await this.send(this.message(s, summary), s);
      return;
    }
    // Work that came from a channel answers there, whatever the events say. Anything else, a
    // scheduled check-in included, goes only where the Phone events already send it.
    const from = this.startedFrom(s);
    const skip = chosen || from ? [] : ['telegram'];
    if (!chosen) skip.push('ntfy');
    if (skip.length === 2) return;
    const msg = this.message(s, summary);
    if (from?.by) msg.title = `${from.by}: ${msg.title}`;
    await this.send(msg, s, { skip });
  }

  async send(msg, s = null, { skip = [] } = {}) {
    const { ntfy, telegram } = this.channels;
    const out = telegram.options ? this.#safe(msg) : msg;
    const jobs = [];
    const go = (c) => jobs.push(c.publish(out, s).then(() => c.mark({ ok: true }), (e) => c.mark({ ok: false, error: e.message })));
    if (ntfy.ready && !skip.includes('ntfy')) go(ntfy);
    if (telegram.linked && !skip.includes('telegram')) go(telegram);
    await Promise.all(jobs);
    return jobs.length;
  }

  // What leaves once the channel layer is on: no secrets, and nobody pinged by agent text.
  #safe(msg) {
    const clean = (t, o) => defuse(scrubOut(t, o).text);
    return { ...msg, title: clean(msg.title, { note: false }), text: clean(msg.text), actions: (msg.actions || []).map((a) => ({ ...a, label: clean(a.label, { note: false }) })) };
  }

  // Where a task that began in a channel came from: { channel, by }, or null.
  startedFrom(s) {
    if (s?.remote?.started) return { channel: s.remote.started, by: s.remote.by };
    return this.away.get(s?.id) || null;
  }

  // The message its reports go under.
  threadOf(s) {
    if (s?.remote?.started) return s.remote.tg?.at(-1) || null;
    return this.away.get(s?.id)?.last || null;
  }

  markStarted(id, channel, by) {
    const s = this.store.get(id);
    if (s) {
      s.remote = { ...s.remote, started: channel, ...(by && { by }) };
      this.store.save(s);
      return;
    }
    this.away.set(id, { channel, ...(by && { by }), last: null });
    if (this.away.size > 200) this.away.delete(this.away.keys().next().value);
  }

  // A task or crew job from a channel began, or couldn't (server/crew.js's threadStarted).
  threadStarted(s, thread, member, err) {
    try {
      this.channels[thread?.channel]?.threadStarted(s, thread, member, err);
    } catch (e) {
      console.warn(`wisp: phone: ${e.message}`);
    }
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

  // The project /new uses without an @name: the one picked in settings, else the last used.
  defaultProject() {
    const projects = this.store.config.projects;
    const id = this.cfg.telegram?.project;
    return (id && projects.find((p) => p.id === id)) || [...projects].sort((a, b) => (b.lastUsedAt || b.addedAt || 0) - (a.lastUsedAt || a.addedAt || 0))[0] || null;
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
        options: !!c.telegram?.options,
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
      const server = n.server || 'https://ntfy.sh';
      // since: where reading stopped. An id means nothing on another topic, and taps from while it was off weren't for wisp.
      const same = n.enabled && c.ntfy?.enabled && server === c.ntfy.server && (n.topic || '') === c.ntfy.topic;
      c.ntfy = { enabled: !!n.enabled, server, topic: n.topic || '', token: n.token, ...(same && c.ntfy.since && { since: c.ntfy.since }) };
    }
    if (body.telegram) {
      const { options: wasOn, ...prev } = c.telegram || {};
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
        ...((body.telegram.options ?? wasOn) && { options: true }), // absent when off: the config stays as it was
      };
    }
    this.store.saveConfig();
    this.start();
    return this.view();
  }
}
