// Discord, two-way, on a computer: mention the bot, DM it, or use /wisp, and a task starts and answers
// in a thread. A gateway connection on ws.js: wisp dials out, nothing has to reach this machine. Off
// by default, with the user's own bot, and no privileged intent: a mention, a DM and a slash command
// carry their text without one, which also means a plain reply in a thread doesn't, so there you
// mention the bot or use /wisp.
//
// Only people linked by a code shown in wisp may speak, by their stable user id. A guild is a place
// others can read: a stranger gets silence, even from /wisp's autocomplete, a stranger's DM gets one
// line, and lists and refusals carry none of your names. A message can't ask for more than Edits, a
// tool approval stays in wisp, and nothing posted pings anyone or shows a link as something else.
//
// Not on a Cloud box: it sleeps, and this socket would go with it.

import { handleOf } from '../crew.js';
import { truncate } from '../util.js';
import { CODE, Channel, KIND, sleep } from './channel.js';
import { Linking, Turns, converse, firstPart, inBox, surface } from './conversation.js';
import { stripFormatting } from './grammar.js';
import { RateLimit, Seen, allowed, defuse, gate, needsWisp, scrubOut } from './policy.js';
import { openWs } from './ws.js';

const CAP = 'edits';
const FALLBACK = 'plan';
const NAME = 'Discord';
const MAX_TEXT = 2000;
const MAX_IDS = 20; // messages of a task a reply can point at
const MAX_BUTTONS = 25;
const BACKOFF_MAX_MS = 5 * 60_000;
const TRIES = 3;
const EPOCH = 1420070400000n; // what a snowflake counts from
const GUILDS = 1 << 0;
const GUILD_MESSAGES = 1 << 9;
const DIRECT_MESSAGES = 1 << 12;
const INTENTS = GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES; // MESSAGE_CONTENT is the privileged one
const SUPPRESS_EMBEDS = 1 << 2; // an embed fetches a URL an agent wrote
const EPHEMERAL = 1 << 6;
const OP = { dispatch: 0, heartbeat: 1, identify: 2, resume: 6, reconnect: 7, invalid: 9, hello: 10, ack: 11 };
const IN = { command: 2, component: 3, autocomplete: 4 };
const OUT = { message: 4, deferred: 5, update: 6, choices: 8 };
const THREAD_TYPES = new Set([10, 11, 12]);
// Refusals that may mean it's a thread already, and may not: neither one settles it (#threadFor).
const NOT_A_THREAD_HERE = 50024;
const HAS_A_THREAD = 160004;
const FORM = 50035;
const REPLY_ID = 19; // a message type: a reply
const VIEW = 1 << 10;
const SEND = 1 << 11;
const HISTORY = 1 << 16;
const THREADS = 2 ** 35;
const IN_THREADS = 2 ** 38;
export const PERMISSIONS = String(VIEW + SEND + HISTORY + THREADS + IN_THREADS);
export const NOT_ON_A_BOX = 'Discord can’t run on a cloud computer yet: it sleeps when it’s idle, and the connection to Discord would die with it. Set it up on a computer that stays on.';
const STRANGER = 'This wisp only answers people linked to it. To link, send `link` and the code shown in wisp → Settings → Phone → Discord, here.';
const NO_LIST = 'That list isn’t shown here: see it in wisp, or ask in a DM.';
const NO_THREAD = 'Do that in a task’s thread, or as a reply to its message.';
const FIX = 'Check the token in wisp → Settings → Phone → Discord.';
// Close codes that won't change by trying again.
const FATAL = {
  4004: `Discord refused the token. ${FIX}`,
  4010: 'Discord refused the shard wisp sent. Update wisp.',
  4011: 'This bot is in too many servers for one connection: Discord wants sharding, which wisp doesn’t do.',
  4012: 'Discord no longer takes this gateway version. Update wisp.',
  4013: 'Discord refused the intents wisp asked for. Update wisp.',
  4014: 'Discord won’t give this bot the intents it asked for: check them in the Developer Portal → Bot.',
};
const START_AGAIN = new Set([1000, 1001, 4007, 4009]); // the session is over: identify, not resume

// What the slash command looks like. Mode has no Full auto to pick.
export function slashCommand() {
  const named = (name, description) => ({ type: 3, name, description, autocomplete: true });
  return {
    name: 'wisp',
    type: 1,
    description: 'Start or steer a wisp task',
    contexts: [0, 1],
    options: [
      { type: 3, name: 'prompt', description: 'What to do, or help, status, stop', required: true },
      named('crew', 'A crew member'),
      named('project', 'Where it runs'),
      named('machine', 'Which computer'),
      named('model', 'Which model'),
      { type: 3, name: 'mode', description: 'How far it may go', choices: [{ name: 'Plan', value: 'plan' }, { name: 'Edits', value: 'edits' }] },
    ],
  };
}

// The options, as you'd have typed them, so they go through the same grammar as a message.
export function slashText({ prompt = '', crew, project, machine, model, mode } = {}) {
  const front = [crew && `@${crew}`, project && `in ${project}`, machine && `on ${machine}`, model && `with ${model}`, mode].filter(Boolean);
  return front.length ? `${front.join(' ')}: ${prompt}` : prompt;
}

export const inviteUrl = (appId) => `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(appId)}&scope=bot+applications.commands&permissions=${PERMISSIONS}`;

// A link shows what it says: `[text](url)` would show only the text, so no agent can dress one up.
const unmask = (text) => String(text).replace(/\]\(/g, ']\\(');
export const discordText = (text) => truncate(unmask(defuse(scrubOut(text).text)), MAX_TEXT);

export const snowflakeMs = (id) => Number((BigInt(id) >> 22n) + EPOCH);

// Requests sharing a major parameter share a limit, near enough.
const bucketOf = (method, path) => `${method} ${/^\/(channels|webhooks|interactions)\/[^/]+/.exec(path)?.[0] || path}`;

// Where an interaction's reply is edited.
const hookOf = (d) => ({ hook: d.token, app: d.application_id });

export class Discord extends Channel {
  constructor(hub) {
    super(hub, 'discord');
    this.seen = new Seen();
    this.limit = new RateLimit();
    this.strangers = new RateLimit({ max: 3 }); // a line each, and then silence
    this.tried = new Seen(); // ids a stranger's line or a link went out for: a replay isn't a second try
    this.linking = new Linking(this, { limit: () => this.strangers, where: 'Settings → Phone → Discord', done: '✓ Linked to wisp. Say what you’d type in wisp, here, with /wisp, or by mentioning the bot in a server.' });
    this.turns = new Turns();
    this.me = null; // { id, name }: who this bot is
    this.connected = false;
    this.guilds = new Set();
    this.session = null; // { id, url }: what a resume needs, with seq
    this.seq = null;
    this.identifiedAt = 0;
    this.commandsFor = ''; // the app whose /wisp is registered
    this.globalUntil = 0;
    this.paused = new Map(); // bucket -> when it opens again
  }

  get cfg() {
    return this.hub.cfg.discord;
  }

  get ready() {
    const c = this.cfg;
    return !!(c?.enabled && c.token && !inBox());
  }

  // Another bot: nothing about the last one holds.
  reset() {
    Object.assign(this, { me: null, session: null, seq: null, commandsFor: '', connected: false });
    this.guilds.clear();
  }

  // --- REST -------------------------------------------------------------------------------------

  async #turn(bucket, signal) {
    const until = Math.max(this.globalUntil, this.paused.get(bucket) || 0);
    if (until > Date.now()) await sleep(until - Date.now(), signal);
    else this.paused.delete(bucket);
  }

  // What Discord says of a bucket's limit, so it isn't hit in the first place.
  #learn(bucket, headers) {
    if (headers.get('x-ratelimit-remaining') !== '0') return;
    const after = Number(headers.get('x-ratelimit-reset-after'));
    if (after) this.paused.set(bucket, Date.now() + after * 1000);
    if (this.paused.size > 500) this.paused.clear();
  }

  // The token goes in a header, and an error is only ever Discord's own short words.
  async rest(method, path, body, { tries = TRIES, signal } = {}) {
    const base = (process.env.WISP_DISCORD_API || 'https://discord.com/api/v10').replace(/\/+$/, '');
    const bucket = bucketOf(method, path);
    for (let left = tries; ; left--) {
      await this.#turn(bucket, signal);
      const r = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bot ${this.cfg.token}`, 'content-type': 'application/json', 'user-agent': 'DiscordBot (https://trywisp.dev, 1)' },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });
      this.#learn(bucket, r.headers);
      const j = await r.json().catch(() => ({}));
      if (r.status === 429) {
        const retryAfter = Number(j.retry_after) || Number(r.headers.get('retry-after')) || 1;
        const until = Date.now() + retryAfter * 1000;
        if (j.global || r.headers.get('x-ratelimit-global')) this.globalUntil = until;
        else this.paused.set(bucket, until);
        if (left <= 1) throw Object.assign(new Error('Discord: rate limited'), { code: 'ratelimited', retryAfter });
        continue;
      }
      if (r.status === 401) throw Object.assign(new Error(`Discord: ${j.message || 'unauthorized'}`), { code: 'revoked' });
      if (!r.ok) throw Object.assign(new Error(`Discord: ${j.message || r.status}`), { code: j.code ?? r.status });
      return j;
    }
  }

  // --- the connection ---------------------------------------------------------------------------

  async start(signal) {
    let fails = 0;
    while (!signal.aborted) {
      let wait = 0;
      try {
        const url = this.session?.url || (await this.#gateway(signal));
        const end = await this.#listen(url, signal);
        if (end.fatal) return this.#down(end.fatal); // new settings start this again
        if (end.ready) fails = 0;
        if (end.now) continue; // Discord asked for this
        wait = end.wait;
      } catch (err) {
        if (signal.aborted) return;
        if (err.code === 'revoked') return this.#down(`${err.message}. ${FIX}`);
        this.#down(err.message);
        wait = (err.retryAfter || 0) * 1000;
      }
      if (signal.aborted) return;
      fails++;
      await sleep(Math.max(wait, Math.min(this.hub.discordBackoffMs * 2 ** (fails - 1), BACKOFF_MAX_MS)), signal);
    }
  }

  #down(error) {
    this.connected = false;
    this.mark({ ok: false, connected: false, error });
  }

  async #gateway(signal) {
    const g = await this.rest('GET', '/gateway/bot', undefined, { tries: 1, signal });
    const left = g.session_start_limit;
    if (left && left.remaining === 0) throw Object.assign(new Error('Discord: too many connections today. wisp will wait.'), { retryAfter: left.reset_after / 1000 });
    return g.url;
  }

  // One connection, until it ends. → { ready, now, wait, fatal }: ready: it got as far as a session;
  // now: Discord asked for a new one; wait: not before this long; fatal: why it won't come back.
  async #listen(url, signal) {
    const ws = await openWs(`${url.replace(/\/+$/, '')}/?v=10&encoding=json`, { signal });
    return new Promise((resolve) => {
      const end = { ready: false, now: false, wait: 0, fatal: '' };
      const send = (op, d) => ws.send(JSON.stringify({ op, d }));
      let timer = null;
      let acked = true;
      let every = 0;
      // A laptop that slept leaves a socket that looks open: no ack by the next beat ends it.
      const beat = () => {
        if (!acked) return ws.destroy('Discord stopped answering.');
        acked = false;
        send(OP.heartbeat, this.seq);
        timer = setTimeout(beat, every);
        timer.unref?.();
      };
      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        this.connected = false;
        if (FATAL[code]) end.fatal = FATAL[code];
        if (START_AGAIN.has(code)) this.session = null;
        if (!signal.aborted && !end.fatal && !end.now && !end.wait) this.#down(reason || 'The connection to Discord dropped.');
        resolve(end);
      });
      ws.on('message', (text) => {
        let m;
        try {
          m = JSON.parse(text);
        } catch {
          return;
        }
        if (m.op === OP.hello) {
          every = m.d.heartbeat_interval;
          timer = setTimeout(beat, every * this.hub.discordJitter());
          timer.unref?.();
          if (this.session) send(OP.resume, { token: this.cfg.token, session_id: this.session.id, seq: this.seq });
          else this.#identify(ws, send);
        } else if (m.op === OP.ack) acked = true;
        else if (m.op === OP.heartbeat) send(OP.heartbeat, this.seq);
        else if (m.op === OP.reconnect) {
          end.now = true;
          ws.close(4000);
        } else if (m.op === OP.invalid) {
          if (!m.d) this.session = null;
          end.wait = this.hub.discordInvalidMs * (1 + Math.random() * 4); // Discord asks for 1 to 5 s
          ws.close(4000);
        } else if (m.op === OP.dispatch) {
          if (m.s) this.seq = m.s;
          this.#dispatch(m.t, m.d, end);
        }
      });
    });
  }

  // One identify per five seconds, as Discord allows.
  #identify(ws, send) {
    const wait = Math.max(0, this.identifiedAt + this.hub.discordIdentifyMs - Date.now());
    const go = () => {
      if (!ws.open) return;
      this.identifiedAt = Date.now();
      send(OP.identify, { token: this.cfg.token, intents: INTENTS, properties: { os: process.platform, browser: 'wisp', device: 'wisp' } });
    };
    if (wait) setTimeout(go, wait).unref?.();
    else go();
  }

  #dispatch(t, d, end) {
    if (t === 'READY') {
      end.ready = true;
      this.session = { id: d.session_id, url: d.resume_gateway_url };
      this.me = { id: d.user.id, name: d.user.username };
      this.guilds = new Set((d.guilds || []).map((g) => g.id));
      if (d.application?.id && d.application.id !== this.cfg.appId) {
        this.cfg.appId = d.application.id; // Discord's word over what was saved or typed
        this.hub.store.saveConfig();
      }
      this.#live();
      this.#register();
    } else if (t === 'RESUMED') {
      end.ready = true;
      this.#live();
    } else if (t === 'GUILD_CREATE') {
      this.guilds.add(d.id);
      this.hub.onChange();
    } else if (t === 'GUILD_DELETE') {
      this.guilds.delete(d.id);
      this.hub.onChange();
    } else if (t === 'MESSAGE_CREATE') {
      this.turns.queue(d.channel_id, () => this.#fromMessage(d), this.#oops);
    } else if (t === 'INTERACTION_CREATE') {
      this.#fromInteraction(d).catch(this.#oops);
    }
  }

  #live() {
    this.connected = true;
    this.mark({ ok: true, connected: true, error: '' });
  }

  #oops = (err) => {
    console.warn(`wisp: discord: ${err.message}`);
    this.mark({ error: err.message });
  };

  #register() {
    const app = this.cfg.appId;
    if (!app || this.commandsFor === app) return;
    this.commandsFor = app;
    this.rest('PUT', `/applications/${app}/commands`, [slashCommand()]).catch((err) => {
      this.commandsFor = '';
      this.#oops(err);
    });
  }

  // --- who may speak ----------------------------------------------------------------------------

  // A message, or a slash command. → true to go on; say: how to answer whoever's stopped here.
  async #door({ id, user, dm, say }) {
    const g = gate({ sender: user, senders: this.cfg.senders || [], id, at: snowflakeMs(id) / 1000, seen: this.seen, limit: this.limit, dm, strangerLine: STRANGER });
    if (g.ok) return true;
    this.hub.phone.count?.('refused', g.why);
    if (g.why === 'stranger' && (!this.tried.first(id) || !this.strangers.hit(user).ok)) return false;
    if (g.reply) await say(g.reply);
    return false;
  }

  async #fromMessage(m) {
    if (m.author?.bot || m.webhook_id || !m.author?.id || m.author.id === this.me?.id) return;
    if (m.type !== 0 && m.type !== REPLY_ID) return; // a join, a pin, a thread starting
    const dm = !m.guild_id;
    if (!dm && !(m.mentions || []).some((u) => u.id === this.me?.id)) return; // without one, its text doesn't come
    const target = { chat: m.channel_id, reply: m.id };
    const text = stripFormatting(m.content, 'discord', { bot: this.me?.id });
    const raw = (t) => this.#say(target, t);
    const link = dm ? /^link(?:\s+(\S+))?$/i.exec(text) : null;
    if (link) return this.tried.first(m.id) ? this.linking.attempt(m.author.id, link[1], raw) : undefined;
    if (!(await this.#door({ id: m.id, user: m.author.id, dm, say: raw }))) return;
    return this.#work({ user: m.author.id, dm, text, target, anchor: m.id, ref: m.message_reference?.message_id, inThread: false });
  }

  async #fromInteraction(d) {
    const user = d.member?.user || d.user;
    if (!user?.id || user.bot) return;
    if (d.type === IN.autocomplete) return this.#autocomplete(d, user.id);
    const dm = !d.guild_id;
    if (d.type === IN.component) return this.#fromButton(d, user.id, dm);
    if (d.type !== IN.command || d.data?.name !== 'wisp') return;
    const options = Object.fromEntries((d.data.options || []).map((o) => [o.name, o.value]));
    const text = stripFormatting(slashText(options), 'discord');
    const link = dm ? /^link(?:\s+(\S+))?$/i.exec(text) : null;
    if (link) {
      if (!this.tried.first(d.id)) return;
      await this.#respond(d, OUT.deferred, { flags: EPHEMERAL });
      const target = hookOf(d);
      return this.turns.queue(d.channel_id, () => this.linking.attempt(user.id, link[1], (t) => this.#say(target, t)), this.#oops);
    }
    // A stranger in a guild gets no answer at all: Discord shows them, and only them, that it failed.
    if (!(await this.#door({ id: d.id, user: user.id, dm, say: (t) => this.#respond(d, OUT.message, { content: discordText(t), flags: EPHEMERAL | SUPPRESS_EMBEDS, allowed_mentions: { parse: [] } }) }))) return;
    await this.#respond(d, OUT.deferred); // Discord gives this three seconds
    const inThread = THREAD_TYPES.has(d.channel?.type);
    this.turns.queue(d.channel_id, () => this.#work({ user: user.id, dm, text, target: { chat: d.channel_id, ...hookOf(d) }, anchor: null, ref: null, inThread }), this.#oops);
  }

  #respond(d, type, data) {
    return this.rest('POST', `/interactions/${d.id}/${d.token}/callback`, { type, ...(data && { data }) });
  }

  // Only people linked get your names back; anyone else, an empty list.
  async #autocomplete(d, user) {
    if (!allowed(user, this.cfg.senders || [])) return this.#respond(d, OUT.choices, { choices: [] });
    const o = (d.data?.options || []).find((x) => x.focused);
    const ctx = await this.hub.phone.context();
    const pairs = {
      crew: () => (ctx.crew || []).map((m) => [m.name, handleOf(m.name)]),
      project: () => (ctx.projects || []).map((p) => [p.name, p.name]),
      machine: () => ['here', ...(ctx.machines || []).filter((m) => m.usable).map((m) => m.name)].map((n) => [n, n]),
      model: () => [...new Set((ctx.agents || []).filter((a) => a.available).flatMap((a) => (a.models || []).filter((m) => m.id).map((m) => m.id)))].map((n) => [n, n]),
    }[o?.name];
    const typed = String(o?.value || '').toLowerCase();
    const hits = (pairs?.() || []).filter(([name]) => name.toLowerCase().includes(typed)).slice(0, 25);
    return this.#respond(d, OUT.choices, { choices: hits.map(([name, value]) => ({ name: truncate(name, 100), value: truncate(value, 100) })) });
  }

  // A button: signed by wisp, pressed by someone linked. A stranger's press gets no answer.
  async #fromButton(d, user, dm) {
    if (!(await this.#door({ id: d.id, user, dm, say: async () => {} }))) return;
    await this.#respond(d, OUT.update);
    const [k, s, r, i, sig, ...more] = String(d.data?.custom_id || '').split(':');
    const say = (t) => this.#say({ chat: d.channel_id }, t);
    this.turns.queue(d.channel_id, async () => {
      if (more.length || !this.hub.verify({ k, s, r, i: Number(i), sig })) return say('That button doesn’t work any more.');
      const local = this.hub.store.get(s);
      if (needsWisp(local?.ask)) return say('That’s waiting for an approval, which only wisp can give: answer it there.');
      // A reply starts a turn, and a button can't say which mode: that's for words, which are capped.
      if (KIND[k] === 'reply' && (!local || local.mode === 'auto')) return say('Say that in words here, so it runs in Edits at most.');
      const result = await this.hub.act({ sessionId: s, kind: KIND[k], ref: r, index: Number(i) });
      await this.rest('PATCH', this.#original(hookOf(d)), { components: [] }).catch(() => {});
      await say(result);
    }, this.#oops);
  }

  // --- what a message does ----------------------------------------------------------------------

  async #work(w) {
    const hub = this.hub;
    const phone = hub.phone;
    const key = w.target.chat;
    let finish;
    const done = new Promise((r) => (finish = r));
    this.turns.hold(key, done);
    try {
      const ctx = await phone.context();
      const text = /^new(\s|$)/i.test(w.text) ? `/${w.text}` : w.text || 'help';
      const { say, refuse, list } = surface({ ctx, post: (t) => this.#say(w.target, t), open: w.dm, typed: text, noList: NO_LIST });
      const sessionId = this.#sessionFor(key, w.ref);
      await converse(
        {
          phone,
          hub,
          ctx,
          channel: this.name,
          name: NAME,
          sender: w.user,
          cap: CAP,
          fallback: FALLBACK,
          approvals: this.approvalsHere,
          say,
          list,
          refuse,
          thread: (p) => this.#threadFor(w, p, sessionId, done),
          acked: (thread, sent) => this.#acked(thread, sent),
          noThread: NO_THREAD,
          quiet: (line) => (w.dm ? line : firstPart(line)), // a title is past the first colon
          btwHelp: 'Type your question after btw.',
        },
        text,
        sessionId,
        /^btw(\s|$)/i.test(text) ? `/${text}` : text,
      );
    } finally {
      finish();
    }
  }

  // Where a task answers. In a guild its own thread, on the message that asked for it, or on the
  // slash command's reply; where a thread can't be made, replies to its messages.
  async #threadFor(w, p, sessionId, done) {
    const base = { channel: this.name, chat: w.target.chat, thread: false, ids: w.anchor ? [w.anchor] : [] };
    if (w.dm) return base;
    // A task found by a reply may live in a plain channel: only one that has this thread stays in it.
    const held = sessionId && (this.hub.store.get(sessionId)?.remote?.discord || this.hub.away.get(sessionId)?.discord);
    if (w.inThread || (held?.thread && held.channel === w.target.chat)) return { ...base, thread: true };
    let anchor = w.anchor;
    if (w.target.hook) anchor = (await this.#say(w.target, '▶ On it.'))?.id;
    if (!anchor) return base;
    try {
      const t = await this.rest('POST', `/channels/${w.target.chat}/messages/${anchor}/threads`, { name: truncate(scrubOut(p.prompt.split('\n')[0], { note: false }).text, 90) || 'wisp', auto_archive_duration: 1440 });
      Object.assign(w.target, { chat: t.id, reply: null });
      this.turns.hold(t.id, done);
      return { channel: this.name, chat: t.id, thread: true, ids: [] };
    } catch (err) {
      // Replies then, unless Discord says this is a thread: a task with `thread` takes every mention
      // in its channel, so a guess would hand it the whole of a plain channel.
      const thread = (err.code === NOT_A_THREAD_HERE || err.code === HAS_A_THREAD) && (await this.#isThread(w.target.chat));
      return { ...base, thread, ids: [anchor] };
    }
  }

  #isThread(chat) {
    return this.rest('GET', `/channels/${chat}`, undefined, { tries: 1 }).then((c) => THREAD_TYPES.has(c.type), () => false);
  }

  // The task in this thread, or the one a reply points at. A mention's job answers one question: a
  // follow-up belongs to the task it was asked on.
  #sessionFor(chat, ref) {
    const hit = (t) => t && ((t.thread && t.channel === chat) || (ref && t.ids?.includes(ref)));
    const here = this.hub.store.all().filter((s) => hit(s.remote?.discord) && s.crew?.job !== 'mention');
    const away = [...this.hub.away].filter(([, a]) => hit(a.discord)).map(([id, a]) => ({ id, createdAt: a.at }));
    return [...here, ...away].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]?.id || null;
  }

  // --- what leaves ------------------------------------------------------------------------------

  // An interaction names its own application: what's saved may be another bot's.
  #original({ hook, app }) {
    return `/webhooks/${app || this.cfg.appId}/${hook}/messages/@original`;
  }

  // To an interaction's reply once, then to the place itself. No post pings anyone or embeds a URL.
  async #say(target, text, { components } = {}) {
    const body = { content: discordText(text), allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS, ...(components?.length && { components }) };
    if (target.hook) {
      const path = this.#original(target);
      target.hook = null;
      return this.rest('PATCH', path, body);
    }
    const to = `/channels/${target.chat}/messages`;
    const reply = target.reply && { message_reference: { message_id: target.reply, fail_if_not_exists: false } };
    return this.rest('POST', to, { ...body, ...reply }).catch((err) => {
      if (err.code !== FORM || !components?.length) throw err;
      const { components: _, ...plain } = body; // something Discord won't take in a button: the words still go
      return this.rest('POST', to, { ...plain, ...reply });
    });
  }

  reports(s) {
    return this.hub.startedFrom(s)?.channel === this.name;
  }

  // Only for a task started here: the hub asks, whatever the Phone events say.
  async publish(msg, s) {
    const t = s?.remote?.discord || this.hub.away.get(s?.id)?.discord;
    if (!t) return;
    await this.turns.settled(t.channel); // a quick task's report comes after the first reply
    const by = this.hub.startedFrom(s)?.by;
    const components = this.#buttons(msg, s);
    const sent = await this.#say({ chat: t.channel, reply: t.thread ? null : t.ids?.at(-1) }, this.#report(msg, s, t, by, components), { components });
    if (sent?.id) this.#link(s.id, sent.id);
    this.hub.phone.count?.('report', 'full');
  }

  #buttons(msg, s) {
    if (needsWisp(s.ask)) return []; // words, and an answer in wisp
    const buttons = (msg.actions || []).slice(0, MAX_BUTTONS).map((a) => ({
      type: 2,
      style: a.kind === 'done' ? 2 : 1,
      label: truncate(a.label || 'OK', 80),
      custom_id: `${CODE[a.kind]}:${s.id}:${a.ref}:${a.index}:${this.hub.sign(s.id, a.kind, a.ref, a.index)}`,
    }));
    if (buttons.some((b) => b.custom_id.length > 100)) return [];
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) rows.push({ type: 1, components: buttons.slice(i, i + 5) });
    return rows;
  }

  #report(msg, s, t, by, components) {
    const title = by && !msg.title.startsWith(`${by}: `) ? `${by}: ${msg.title}` : msg.title;
    const choices = components.length ? [] : (msg.actions || []).filter((a) => a.kind !== 'done').map((a) => a.label);
    const here = t.thread ? `Mention ${this.me?.name || 'wisp'} here, or use /wisp, to answer or follow up.` : 'Reply to this message to answer or follow up.';
    const how = needsWisp(s.ask) ? 'This one is a tool approval: answer it in wisp.' : here;
    return [title, msg.text, choices.length && !needsWisp(s.ask) ? `Choices: ${choices.join(' · ')}` : '', how].filter(Boolean).join('\n\n');
  }

  // The first reply went out: a reply to it reaches the task, whenever that started.
  #acked(thread, sent) {
    if (!sent?.id) return;
    thread.ids = [...(thread.ids || []), sent.id].slice(-MAX_IDS);
    this.hub.phone.threadSaved?.();
    if (thread.session) this.#link(thread.session, sent.id);
  }

  #link(sessionId, id) {
    const hub = this.hub;
    const s = hub.store.get(sessionId);
    const was = s?.remote?.discord || hub.away.get(sessionId)?.discord;
    if (!was) return;
    const discord = { ...was, ids: [...(was.ids || []), id].slice(-MAX_IDS) };
    if (s) {
      s.remote = { ...s.remote, discord };
      hub.store.save(s);
    } else this.keepAway(sessionId, hub.away.get(sessionId)?.by, { discord });
  }

  // A task or a crew job began for this thread (a queued job, maybe after a restart), or err: it
  // couldn't.
  threadStarted(s, thread, by, err) {
    const { chat, ids = [] } = thread;
    if (err) {
      this.#say({ chat, reply: thread.thread ? null : ids.at(-1) }, `${by ? `${by.name} couldn’t start` : 'Couldn’t start'}: ${truncate(err.message, 300)}`).catch(() => {});
      return;
    }
    thread.session = s.id;
    const hub = this.hub;
    const discord = { channel: chat, thread: !!thread.thread, ids };
    hub.markStarted(s.id, this.name, by?.name);
    const local = hub.store.get(s.id);
    if (local) {
      local.remote = { ...local.remote, discord };
      hub.store.save(local);
    } else this.keepAway(s.id, by?.name, { discord });
  }
}
