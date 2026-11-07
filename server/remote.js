// Phone: push "needs you" moments to ntfy or Telegram and take the answers back. All of it runs on
// outbound connections only (wisp polls them, or holds a socket open), so nothing has to reach this machine.
// On a cloud wisp Telegram comes through the grid instead, which holds messages while it sleeps
// (channels/box.js), and so does mail.
//
// This is the hub: the config, the public API and the fan-out. Each channel's wire is in
// server/channels/ (ntfy.js, telegram.js, github.js, slack.js, discord.js, email.js, routed.js), and what they all share is there too: policy.js (who may
// speak, what may leave), grammar.js and lists.js (what a message can say).

import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { KIND } from './channels/channel.js';
import { boxGrid } from './channels/box.js';
import { inBox, newLinkCode } from './channels/conversation.js';
import { Discord, NO_HUB as NO_DISCORD_HUB, PERMISSIONS, inviteUrl } from './channels/discord.js';
import { isPublicKey } from './channels/discord-sign.js';
import { Email } from './channels/email.js';
import { Github } from './channels/github.js';
import { ranInstead } from './channels/lists.js';
import { needsWisp, scrubOut, defuse } from './channels/policy.js';
import { Ntfy } from './channels/ntfy.js';
import { NO_HUB, Slack } from './channels/slack.js';
import { Routed } from './channels/routed.js';
import { Telegram } from './channels/telegram.js';
import { bad, truncate } from './util.js';

export { findProject } from './channels/grammar.js';
const MAX_HOPS = 5; // from a stalled helper up to the task with a thread
export const mask = (t) => (t ? `••••${String(t).slice(-4)}` : '');

export class Remote {
  // act({ sessionId, kind: answer|reply|done|text, ref, index, text, later? }) → a short result line;
  // later(text) sends one more message afterwards (a /btw answer).
  // launch({ project, prompt }) → the new session's summary (a task started with /new).
  // phone: the rest of services/phone.js, what the channel layer needs of wisp.
  constructor({ store, act, launch = async () => null, onChange = () => {}, ...phone }) {
    Object.assign(this, { store, act, launch, onChange, phone });
    this.status = { ntfy: null, telegram: null, github: null, slack: null, discord: null, email: null };
    this.tgElsewhere = new Map(); // Telegram message id -> session id, for sessions on a machine (server/machines.js)
    this.away = new Map(); // session id on a machine -> { channel, by, last }: what s.remote holds for one here
    this.channels = { ntfy: new Ntfy(this), telegram: new Telegram(this), github: new Github(this), slack: new Slack(this), discord: new Discord(this), email: new Email(this), routed: new Routed(this) };
    for (const channel of ['github', 'slack', 'discord', 'email']) for (const [id, a] of Object.entries(store.config?.remote?.[channel]?.away || {})) this.away.set(id, { channel, last: null, ...a });
    this.ac = null;
    this.ntfyPollMs = 4000;
    this.tgLongPoll = 25;
    this.ghPollMs = 60_000; // per repo
    this.slackBackoffMs = 1000; // the first wait after a lost connection; it doubles
    this.slackPingMs = 30_000;
    this.discordBackoffMs = 1000; // the same
    this.discordHelloMs = 30_000; // how long a new socket has to say hello, as Slack
    this.discordIdentifyMs = 5000; // Discord's limit between identifies
    this.discordInvalidMs = 1000; // the least it waits after an invalid session
    this.discordJitter = Math.random; // where in the first interval the first heartbeat falls
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

  // Answers under way, for /api/status: past a 2xx nothing else holds a box up for them.
  busy() {
    return Object.values(this.channels).reduce((n, c) => n + c.busy(), 0);
  }

  start() {
    this.stop();
    const ac = (this.ac = new AbortController());
    const c = this.cfg;
    const { ntfy, telegram, github, slack, discord, email } = this.channels;
    telegram.retryUnhook(); // before its start, and on or off: it's off that left one behind
    if (ntfy.ready) ntfy.start(ac.signal);
    if (telegram.ready) {
      if (!c.telegram.chatId && !c.telegram.linkCode) (c.telegram.linkCode = String(randomInt(100000, 999999))), this.store.saveConfig();
      telegram.start(ac.signal);
    }
    if (github.ready) github.start(ac.signal);
    if (slack.ready) slack.start(ac.signal);
    if (discord.ready) discord.start(ac.signal);
    else discord.syncKey().catch(() => {}); // off on a box: its key leaves the grid, and the next start tries again
    email.start(ac.signal); // on a box, on or off: Settings shows it whenever the grid has mail
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
    // A quick answer has no hero, only its text: that text is the report.
    const plain = blocks.find((b) => b?.type === 'markdown')?.text;
    const asked = turn?.model ?? s.model;
    const ran = ranInstead(asked, turn?.stats);
    return {
      title: `${icon} ${where}`,
      text: [hero?.title && hero.title !== s.title ? hero.title : '', hero?.summary || summary?.preview || (plain && truncate(plain, 1000)) || 'Ready for review.', ran && `Ran on ${ran}, not ${asked}.`, q?.question].filter(Boolean).join('\n\n'),
      actions: options.length ? options.map((o, index) => ({ label: o.label || String(o.reply || ''), kind: 'reply', ref: turn.id, index })) : [{ label: 'Mark done', kind: 'done', ref: turn?.id || '', index: 0 }],
    };
  }

  async notify(s, summary) {
    if (!this.on || !s || s.agent === 'wisp') return;
    const event = s.state === 'waiting' ? 'waiting' : 'finished';
    const chosen = (this.cfg.events || ['waiting', 'finished']).includes(event);
    const from = this.startedFrom(s);
    const lead = this.#heldUp(s);
    const own = this.#reporting().some((c) => c.reports(lead)); // reported there whatever the events say; send knows
    if (!this.channels.telegram.options) {
      if (chosen || own) await this.send(this.message(s, summary), s, { skip: chosen ? [] : ['ntfy', 'telegram'] });
      return;
    }
    // Work that came from a channel answers there, whatever the events say. Anything else, a
    // scheduled check-in included, goes only where the Phone events already send it.
    const skip = chosen || from?.channel === 'telegram' ? [] : ['telegram'];
    if (!chosen) skip.push('ntfy');
    if (skip.length === 2 && !own) return;
    const msg = this.message(s, summary);
    if (from?.by) msg.title = `${from.by}: ${msg.title}`;
    await this.send(msg, s, { skip });
  }

  async send(msg, s = null, { skip = [] } = {}) {
    const { ntfy, telegram } = this.channels;
    const out = this.#safe(msg);
    const jobs = [];
    const go = (c, about = s) => jobs.push(c.publish(out, about).then(() => c.mark({ ok: true }), (e) => c.mark({ ok: false, error: e.message })));
    if (ntfy.ready && !skip.includes('ntfy')) go(ntfy);
    if (telegram.linked && !skip.includes('telegram')) go(telegram);
    // Only what they started or followed up. Each defuses what it posts: others can read a report there.
    const lead = this.#heldUp(s);
    for (const c of this.#reporting()) if (c.reports(lead)) go(c, lead);
    await Promise.all(jobs);
    return jobs.length;
  }

  // The channels that answer where they were asked, and only there.
  #reporting() {
    const { github, slack, discord, email, routed } = this.channels;
    return [github, slack, discord, email, routed].filter((c) => c.ready);
  }

  // Who a task is reported as. An ask only wisp can answer, in a subagent, a side discussion or a
  // delegated crew job, has no thread of its own: it's said in the thread of the task it came from.
  #heldUp(s) {
    if (!needsWisp(s?.ask)) return s;
    let lead = s;
    for (let hops = 0; hops < MAX_HOPS && !this.#reporting().some((c) => c.reports(lead)); hops++) {
      const id = lead.parentId || lead.sideOf?.id || (lead.crew?.job === 'delegated' && lead.crew.from?.id);
      const up = id && (this.store.get(id) || (this.away.has(id) && { id })); // a task on a machine is only in away here
      if (!up) break;
      lead = up;
    }
    return lead === s ? s : { ...lead, ask: s.ask };
  }

  // What leaves: never a secret, on the channel layer or not. With it on, nobody pinged by agent text either.
  #safe(msg) {
    const on = this.channels.telegram.options;
    const clean = (t, o) => (on ? defuse(scrubOut(t, o).text) : scrubOut(t, o).text);
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
        webhook: mask(c.telegram?.hook?.secret),
      },
      github: { enabled: !!c.github?.enabled, publicReports: !!c.github?.publicReports, login: this.channels.github.login, repos: this.channels.github.watched, error: this.status.github?.error || '' },
      slack: {
        enabled: !!c.slack?.enabled,
        appToken: mask(c.slack?.appToken),
        botToken: mask(c.slack?.botToken),
        signingSecret: mask(c.slack?.signingSecret),
        connected: this.channels.slack.connected,
        team: this.channels.slack.me?.team || '',
        bot: this.channels.slack.me?.name || '',
        senders: c.slack?.senders?.length || 0,
        linkCode: c.slack?.botToken ? c.slack.linkCode || '' : '',
        box: inBox(),
        error: this.status.slack?.error || '',
      },
      discord: {
        enabled: !!c.discord?.enabled,
        token: mask(c.discord?.token),
        publicKey: c.discord?.publicKey || '', // public: Settings shows what it has
        endpoint: (inBox() && c.discord?.endpoint) || '',
        appId: c.discord?.appId || '',
        invite: c.discord?.appId ? inviteUrl(c.discord.appId) : '',
        connected: this.channels.discord.connected,
        bot: this.channels.discord.me?.name || '',
        guilds: this.channels.discord.guilds.size,
        senders: c.discord?.senders?.length || 0,
        linkCode: c.discord?.token ? c.discord.linkCode || '' : '',
        box: inBox(),
        noHub: inBox() && !boxGrid(),
        error: this.status.discord?.error || '',
      },
      email: this.channels.email.view(),
      status: this.status,
    };
  }

  // The link that adds your bot to a server, with exactly what it needs.
  discordInvite() {
    const appId = this.cfg.discord?.appId;
    if (!appId) throw bad('Give the Discord application ID first, or connect the bot once: wisp learns it then.');
    return { url: inviteUrl(appId), permissions: PERMISSIONS };
  }

  // PUT body: { events, ntfy: {…}, telegram: {…, unlink}, github: {…}, slack: {…, unlink}, discord: {…, unlink} }. Masked tokens mean "unchanged".
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
      c.ntfy = { enabled: !!n.enabled, server, topic: n.topic || '', token: n.token, ...(same && c.ntfy.since && { since: c.ntfy.since, seen: c.ntfy.seen }) };
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
      // Switched off, unlinked or another bot: its webhook goes too. Still linked and on, it stays.
      if (prev.hook && (relink || !c.telegram.enabled)) {
        delete c.telegram.hook;
        if (prev.token) this.channels.telegram.unhook(prev.token);
      }
    }
    if (body.github) {
      const prev = c.github || {};
      const enabled = !!(body.github.enabled ?? prev.enabled);
      // Switched on again: what was said while it was off isn't for it, not even to call it stale.
      c.github = { ...prev, enabled, publicReports: !!(body.github.publicReports ?? prev.publicReports), repos: enabled && !prev.enabled ? {} : prev.repos || {} };
    }
    if (body.slack) {
      const prev = c.slack || {};
      const enabled = !!(body.slack.enabled ?? prev.enabled);
      if (enabled && inBox() && !boxGrid()) throw bad(NO_HUB); // a sandbox: one task's box, with no way in. A grid with the hub off says so in status
      const token = (v, was) => (v === undefined ? was : keep(v, was)) || ''; // missing = unchanged
      const [appToken, botToken, signingSecret] = [token(body.slack.appToken, prev.appToken), token(body.slack.botToken, prev.botToken), token(body.slack.signingSecret, prev.signingSecret)];
      if (appToken && !/^xapp-\S+$/.test(appToken)) throw bad('The app-level token starts with xapp-.');
      if (botToken && !/^xoxb-\S+$/.test(botToken)) throw bad('The bot token starts with xoxb-.');
      if (signingSecret && !/^\S{16,}$/.test(signingSecret)) throw bad('That isn’t a signing secret: copy it from Basic Information → App Credentials.');
      const relink = body.slack.unlink || botToken !== (prev.botToken || ''); // another workspace, other people
      c.slack = { ...prev, enabled, appToken, botToken, signingSecret, senders: relink ? [] : prev.senders || [], linkCode: relink || !prev.linkCode ? newLinkCode() : prev.linkCode };
      if (relink) delete c.slack.linkGuess; // a code of the owner's: the day's guesses were at another
      this.channels.slack.customize = true;
      if (inBox()) this.channels.slack.connected = false; // no socket to close: Working again once it says so
    }
    if (body.discord) {
      const prev = c.discord || {};
      const enabled = !!(body.discord.enabled ?? prev.enabled);
      if (enabled && inBox() && !boxGrid()) throw bad(NO_DISCORD_HUB); // a sandbox: one task's box, with no way in
      const token = (body.discord.token === undefined ? prev.token : keep(body.discord.token, prev.token)) || ''; // missing = unchanged
      if (token && !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) throw bad('That doesn’t look like a bot token: copy it from the Developer Portal → Bot → Reset Token.');
      const changed = token !== (prev.token || ''); // another bot, other people, another application
      const appId = String(body.discord.appId ?? (changed ? '' : prev.appId) ?? '').trim();
      if (appId && !/^\d{5,25}$/.test(appId)) throw bad('The application ID is a long number: Developer Portal → General Information.');
      // Another bot, another key: only the paste that follows a first token keeps one.
      const publicKey = String(body.discord.publicKey ?? (changed && prev.token ? '' : prev.publicKey) ?? '').trim().toLowerCase();
      if (publicKey && !isPublicKey(publicKey)) throw bad('The public key is 64 hex characters: Developer Portal → General Information.');
      const relink = body.discord.unlink || changed;
      c.discord = { ...prev, enabled, token, publicKey, appId, senders: relink ? [] : prev.senders || [], linkCode: relink || !prev.linkCode ? newLinkCode() : prev.linkCode };
      if (relink) delete c.discord.linkGuess;
      if (changed) this.channels.discord.reset();
    }
    if (body.email) this.channels.email.update(body.email);
    this.store.saveConfig();
    this.start();
    return this.view();
  }
}
