// Slack, two-way, on a computer: `@wisp in api with opus plan: fix it` in a channel, or a DM to the
// bot, starts a task and answers in a thread. Socket Mode: wisp dials out, nothing has to reach this
// machine. Off by default, with the user's own app (slackManifest) and two tokens.
//
// Only people linked by a code shown in wisp may speak, by their stable user id. In a channel others
// can read what's said, so lists and refusals there carry none of your names, and a stranger gets
// silence; a stranger's DM gets one line. A message can't ask for more than Edits, and a tool approval
// stays in wisp.
//
// Every envelope is acked the moment it arrives (Slack resends after 3 s), then the work runs behind,
// one at a time per thread. Not on a Cloud box: it sleeps, and this socket would go with it.

import { truncate } from '../util.js';
import { Channel, sleep } from './channel.js';
import { Linking, Turns, converse, firstPart, inBox, surface } from './conversation.js';
import { stripFormatting } from './grammar.js';
import { RateLimit, Seen, defuse, gate, scrubOut } from './policy.js';
import { openWs } from './ws.js';

const CAP = 'edits';
const FALLBACK = 'plan';
const NAME = 'Slack';
const MAX_TEXT = 3900; // Slack's advice: past 4000 a message is split or cut
const BACKOFF_MAX_MS = 5 * 60_000;
const HELLO_MS = 30_000;
const POST_TRIES = 3;
export const NOT_ON_A_BOX = 'Slack can’t run on a cloud computer yet: it sleeps when it’s idle, and the connection to Slack would die with it. Set it up on a computer that stays on.';
const STRANGER = 'This wisp only answers people linked to it. To link, send `link` and the code shown in wisp → Settings → Phone → Slack, here.';
const NO_LIST = 'That list isn’t shown in a channel: see it in wisp, or ask here in a DM.';
const NO_THREAD = 'Do that in a task’s thread.';
// What won't change by trying again: new tokens or a new app setting are needed.
const FOR_GOOD = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'no_permission', 'missing_scope', 'not_allowed_token_type', 'org_login_required', 'team_access_not_granted', 'link_disabled']);
const FIX = 'Check the tokens in wisp → Settings → Phone → Slack.';

// The app to create at api.slack.com/apps → From a manifest. Socket Mode, so no URLs. The app-level
// token it then needs (xapp-…) takes the connections:write scope.
export function slackManifest() {
  return {
    display_information: { name: 'wisp', description: 'Start and steer your wisp tasks from Slack.', background_color: '#1a1a1a' },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: 'wisp', always_online: true },
    },
    oauth_config: { scopes: { bot: ['app_mentions:read', 'chat:write', 'chat:write.customize', 'im:history'] } },
    settings: {
      event_subscriptions: { bot_events: ['app_mention', 'message.im'] },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

// Slack's markup for what leaves: `&<>` are its control characters, so escaping them is what stops
// <!channel>, <@U1> and <url|text> working at all. Mentions as plain words go through defuse first.
const escapeOut = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const slackText = (text) => truncate(escapeOut(defuse(scrubOut(text).text)), MAX_TEXT);

export class Slack extends Channel {
  constructor(hub) {
    super(hub, 'slack');
    this.seen = new Seen();
    this.limit = new RateLimit();
    this.strangers = new RateLimit({ max: 3 }); // a line each, and then silence
    this.tried = new Seen(); // ids a stranger's line or a link went out for: a retry isn't a second try
    this.linking = new Linking(this, { limit: () => this.strangers, where: 'Settings → Phone → Slack', done: '✓ Linked to wisp. Say what you’d type in wisp, here or with @wisp in a channel.' });
    this.me = null; // { user, bot, name, team }: who this bot is
    this.connected = false;
    this.customize = true; // chat:write.customize, until Slack says no
    this.turns = new Turns();
  }

  get cfg() {
    return this.hub.cfg.slack;
  }

  get ready() {
    const c = this.cfg;
    return !!(c?.enabled && c.appToken && c.botToken && !inBox());
  }

  // Tokens go in a header, and an error is only ever Slack's own short code.
  async api(method, body = {}, { token = this.cfg.botToken, tries = POST_TRIES, signal } = {}) {
    const base = (process.env.WISP_SLACK_API || 'https://slack.com/api').replace(/\/+$/, '');
    for (let left = tries; ; left--) {
      const r = await fetch(`${base}/${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });
      if (r.status === 429) {
        const retryAfter = Number(r.headers.get('retry-after')) || 1;
        if (left <= 1) throw Object.assign(new Error('Slack: ratelimited'), { code: 'ratelimited', retryAfter });
        await sleep(retryAfter * 1000, signal);
        continue;
      }
      const j = await r.json().catch(() => ({}));
      if (!j.ok) throw Object.assign(new Error(`Slack: ${j.error || r.status}`), { code: j.error || String(r.status) });
      return j;
    }
  }

  // --- the connection ---------------------------------------------------------------------------

  async start(signal) {
    let fails = 0;
    while (!signal.aborted) {
      let wait = 0;
      let again = false;
      try {
        const me = await this.api('auth.test', {}, { tries: 1, signal });
        this.me = { user: me.user_id, bot: me.bot_id, name: me.user || 'wisp', team: me.team || '' };
        const { url } = await this.api('apps.connections.open', {}, { token: this.cfg.appToken, tries: 1, signal });
        const end = await this.#listen(url, signal);
        if (end.heard) fails = 0;
        if (end.code) throw Object.assign(new Error(`Slack: ${end.code}`), { code: end.code });
        again = end.again;
      } catch (err) {
        if (signal.aborted) return;
        this.#down(FOR_GOOD.has(err.code) ? `${err.message}. ${FIX}` : err.message);
        if (FOR_GOOD.has(err.code)) return; // new tokens start this again; hammering them won't
        wait = (err.retryAfter || 0) * 1000;
      }
      if (signal.aborted) return;
      if (again) continue; // Slack asked for this: a new socket, now
      fails++;
      await sleep(Math.max(wait, Math.min(this.hub.slackBackoffMs * 2 ** (fails - 1), BACKOFF_MAX_MS)), signal);
    }
  }

  #down(error) {
    this.connected = false;
    this.mark({ ok: false, connected: false, error });
  }

  // One connection, until it ends. → { heard, again, code }: heard: Slack said hello; again: it asked
  // for a new one; code: a reason it won't come back.
  async #listen(url, signal) {
    const ws = await openWs(url, { signal });
    return new Promise((resolve) => {
      const end = { heard: false, again: false, code: '' };
      let alive = Date.now();
      const everyMs = this.hub.slackPingMs;
      const hello = setTimeout(() => ws.close(4000, 'no hello'), Math.min(HELLO_MS, everyMs * 2));
      hello.unref?.();
      // A laptop that slept leaves a socket that looks open: nothing from Slack for two beats ends it.
      const beat = setInterval(() => {
        if (Date.now() - alive > everyMs * 2) return ws.destroy('Slack stopped answering.');
        ws.ping();
      }, everyMs);
      beat.unref?.();
      ws.on('pong', () => (alive = Date.now()));
      ws.on('close', (code, reason) => {
        clearTimeout(hello);
        clearInterval(beat);
        if (!signal.aborted && !end.again && !end.code) this.#down(reason || 'The connection to Slack dropped.');
        this.connected = false;
        resolve(end);
      });
      ws.on('message', (text) => {
        alive = Date.now();
        let m;
        try {
          m = JSON.parse(text);
        } catch {
          return;
        }
        if (m.type === 'hello') {
          clearTimeout(hello);
          end.heard = true;
          this.connected = true;
          this.mark({ ok: true, connected: true, error: '' });
          return;
        }
        if (m.type === 'disconnect') {
          if (FOR_GOOD.has(m.reason)) end.code = m.reason;
          else end.again = true;
          ws.close();
          return;
        }
        if (m.envelope_id) ws.send(JSON.stringify({ envelope_id: m.envelope_id })); // first, always
        if (m.type === 'events_api') this.#behind(m.payload);
      });
    });
  }

  // The work, behind the ack: one at a time in a thread, side by side across threads.
  #behind(payload) {
    const e = payload?.event;
    if (!e) return;
    const key = `${e.channel}:${e.thread_ts || e.ts}`;
    this.turns.queue(key, () => this.#event(payload, e, key), (err) => {
      console.warn(`wisp: slack: ${err.message}`);
      this.mark({ error: err.message });
    });
  }

  // --- what a message does ----------------------------------------------------------------------

  async #event(payload, e, key) {
    const hub = this.hub;
    const c = this.cfg;
    if (e.type !== 'app_mention' && !(e.type === 'message' && e.channel_type === 'im')) return;
    if (e.subtype && e.subtype !== 'file_share') return; // an edit, a join, a bot's message
    if (e.bot_id || !e.user || e.user === this.me?.user) return;
    const dm = String(e.channel)[0] === 'D';
    const id = payload.event_id;
    const root = e.thread_ts || e.ts;
    const text = stripFormatting(e.text, 'slack', { bot: this.me?.user });
    const raw = (t) => this.#post(e.channel, root, t);
    const link = dm ? /^link(?:\s+(\S+))?$/i.exec(text) : null;
    if (link) return this.tried.first(id) ? this.linking.attempt(e.user, link[1], raw) : undefined;
    const seen = { first: (x) => this.seen.first(x) && (!e.client_msg_id || this.seen.first(`m:${e.client_msg_id}`)) };
    const g = gate({ sender: e.user, senders: c.senders || [], id, at: Number(e.ts), seen, limit: this.limit, dm, strangerLine: STRANGER });
    if (!g.ok) {
      hub.phone.count?.('refused', g.why);
      if (g.why === 'stranger' && (!this.tried.first(id) || !this.strangers.hit(e.user).ok)) return;
      if (g.reply) await raw(g.reply);
      return;
    }
    await this.turns.hold(key, this.#message({ e, dm, root, text }));
  }

  async #message({ e, dm, root, text: said }) {
    const phone = this.hub.phone;
    const ctx = await phone.context();
    const text = /^new(\s|$)/i.test(said) ? `/${said}` : said || 'help'; // Slack keeps a leading / for itself
    const { say, refuse, list } = surface({ ctx, post: (t) => this.#post(e.channel, root, t), open: dm, typed: text, noList: NO_LIST });
    const sessionId = e.thread_ts ? this.#threadOf(e.channel, root) : null;
    return converse(
      {
        phone,
        hub: this.hub,
        ctx,
        channel: this.name,
        name: NAME,
        sender: e.user,
        cap: CAP,
        fallback: FALLBACK,
        approvals: this.approvalsHere,
        say,
        list,
        refuse,
        thread: () => this.#thread(e, root),
        noThread: NO_THREAD,
        quiet: (line) => (dm ? line : firstPart(line)), // a title is past the first colon
        btwHelp: 'Type your question after btw.',
      },
      text,
      sessionId,
      /^btw(\s|$)/i.test(text) ? `/${text}` : text,
    );
  }

  #thread(e, root) {
    return { channel: this.name, chat: e.channel, ts: root };
  }

  // The newest task in this thread. A mention's job answers one question: a follow-up belongs to the
  // task it was asked on.
  #threadOf(chat, ts) {
    const same = (t) => t?.channel === chat && t.ts === ts;
    const here = this.hub.store.all().filter((s) => same(s.remote?.slack) && s.crew?.job !== 'mention');
    const away = [...this.hub.away].filter(([, a]) => same(a.slack)).map(([id, a]) => ({ id, createdAt: a.at }));
    return [...here, ...away].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]?.id || null;
  }

  // --- what leaves ------------------------------------------------------------------------------

  async #post(chat, ts, text, { by = '' } = {}) {
    const body = { channel: chat, thread_ts: ts, text: slackText(text), mrkdwn: true, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false }; // unfurling fetches URLs an agent wrote
    if (by && this.customize) {
      try {
        return await this.api('chat.postMessage', { ...body, username: by, icon_emoji: ':robot_face:' });
      } catch (err) {
        if (err.code !== 'missing_scope') throw err;
        this.customize = false; // plain, from now on
      }
    }
    return this.api('chat.postMessage', body);
  }

  reports(s) {
    return this.hub.startedFrom(s)?.channel === this.name;
  }

  // Only for a task started here: the hub asks, whatever the Phone events say.
  async publish(msg, s) {
    const t = s?.remote?.slack || this.hub.away.get(s?.id)?.slack;
    if (!t) return;
    await this.turns.settled(`${t.channel}:${t.ts}`); // a quick task's report comes after the first reply
    const by = this.hub.startedFrom(s)?.by;
    const wait = this.waiting(s);
    if (wait === '') return;
    await this.#post(t.channel, t.ts, wait ?? this.#report(msg, s, t, by), { by });
    this.hub.phone.count?.('report', 'full');
  }

  #report(msg, s, t, by) {
    const title = by && !msg.title.startsWith(`${by}: `) ? `${by}: ${msg.title}` : msg.title;
    const choices = (msg.actions || []).filter((a) => a.kind !== 'done').map((a) => a.label);
    const here = String(t.channel)[0] === 'D' ? 'Reply in this thread to answer or follow up.' : `Mention ${this.me?.name || 'wisp'} in this thread to answer or follow up.`;
    return [title, msg.text, choices.length ? `Choices: ${choices.join(' · ')}` : '', here].filter(Boolean).join('\n\n');
  }

  // A task or a crew job began for this thread (a queued job, maybe after a restart), or err: it
  // couldn't.
  threadStarted(s, thread, by, err) {
    const { chat, ts } = thread;
    if (err) {
      this.#post(chat, ts, `${by ? `${by.name} couldn’t start` : 'Couldn’t start'}: ${truncate(err.message, 300)}`).catch(() => {});
      return;
    }
    const hub = this.hub;
    const slack = { channel: chat, ts };
    hub.markStarted(s.id, this.name, by?.name);
    const local = hub.store.get(s.id);
    if (local) {
      local.remote = { ...local.remote, slack };
      hub.store.save(local);
    } else this.keepAway(s.id, by?.name, { slack });
  }
}
