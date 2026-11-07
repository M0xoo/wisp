// Slack, two-way: `@wisp in api with opus plan: fix it` in a channel, or a DM to the bot, starts a
// task and answers in a thread. On a computer, Socket Mode: wisp dials out, nothing has to reach this
// machine. Off by default, with the user's own app (slackManifest) and two tokens.
//
// A cloud wisp sleeps, and a socket would go with it. There Slack posts HTTP events to its URL on the
// grid (grid/inbox.js), which answers Slack's 3 s, holds the event and wakes the box; inbound() checks
// the signature, with the signing secret and bot token in place of the app token. From there both
// ways are one path: #behind, #event, and gate, grammar and task.
//
// Only people linked by a code shown in wisp may speak, by their stable user id. In a channel others
// can read what's said, so lists and refusals there carry none of your names, and a stranger gets
// silence; a stranger's DM gets one line. A message can't ask for more than Edits, and a tool approval
// stays in wisp.
//
// Every envelope is acked the moment it arrives (Slack resends after 3 s), then the work runs behind,
// one at a time per thread.

import { randomInt, timingSafeEqual } from 'node:crypto';
import { slackOk } from '../hooks.js';
import { bad, truncate } from '../util.js';
import { boxGrid, channelUrl, rotateUrl } from './box.js';
import { Channel, lostLine, resend, sleep } from './channel.js';
import { parseMessage, stripFormatting } from './grammar.js';
import { LISTS, refusal } from './lists.js';
import { RateLimit, Seen, allowed, capMode, defuse, gate, hideNames, scrubOut } from './policy.js';
import { openWs } from './ws.js';

const CAP = 'edits';
const FALLBACK = 'plan';
const NAME = 'Slack';
const MAX_TEXT = 3900; // Slack's advice: past 4000 a message is split or cut
const BACKOFF_MAX_MS = 5 * 60_000;
const HELLO_MS = 30_000;
const POST_TRIES = 3;
const LINK_TRIES = 5; // wrong codes before the code changes
const SEEN_EVENTS = 200; // kept in the config: a box's memory ends when it sleeps
const CHALLENGE_MAX = 512;
export const NO_HUB = 'Slack can’t reach this computer: its grid doesn’t hold messages for it. Set Slack up on a computer that stays on.';
const STRANGER = 'This wisp only answers people linked to it. To link, send `link` and the code shown in wisp → Settings → Phone → Slack, here.';
const NO_LIST = 'That list isn’t shown in a channel: see it in wisp, or ask here in a DM.';
const NO_THREAD = 'Do that in a task’s thread.';
// What won't change by trying again: new tokens or a new app setting are needed.
const FOR_GOOD = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'no_permission', 'missing_scope', 'not_allowed_token_type', 'org_login_required', 'team_access_not_granted', 'link_disabled']);
const FIX = 'Check the tokens in wisp → Settings → Phone → Slack.';
const WRONG_SECRET = 'Slack’s signature doesn’t match the signing secret.';

export const inBox = (env = process.env) => !!env.WISP_GRID_URL;

// The app to create at api.slack.com/apps → From a manifest. On a computer Socket Mode, so no URLs,
// and the app-level token it then needs (xapp-…) takes the connections:write scope. url: a cloud
// wisp's own, where Slack posts its events instead.
export function slackManifest({ url = '' } = {}) {
  return {
    display_information: { name: 'wisp', description: 'Start and steer your wisp tasks from Slack.', background_color: '#1a1a1a' },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: 'wisp', always_online: true },
    },
    oauth_config: { scopes: { bot: ['app_mentions:read', 'chat:write', 'chat:write.customize', 'im:history'] } },
    settings: {
      event_subscriptions: { ...(url && { request_url: url }), bot_events: ['app_mention', 'message.im'] },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: !url,
      token_rotation_enabled: false,
    },
  };
}

// Slack's markup for what leaves: `&<>` are its control characters, so escaping them is what stops
// <!channel>, <@U1> and <url|text> working at all. Mentions as plain words go through defuse first.
const escapeOut = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const slackText = (text) => truncate(escapeOut(defuse(scrubOut(text).text)), MAX_TEXT);

export const newLinkCode = () => String(randomInt(100000, 999999));

const same = (a, b) => {
  const [x, y] = [Buffer.from(String(a)), Buffer.from(String(b))];
  return x.length === y.length && timingSafeEqual(x, y);
};
const firstPart = (line) => `${String(line).split(':')[0].replace(/\.$/, '')}.`;

export class Slack extends Channel {
  constructor(hub) {
    super(hub, 'slack');
    this.seen = new Seen();
    this.limit = new RateLimit();
    this.strangers = new RateLimit({ max: 3 }); // a line each, and then silence
    this.tried = new Seen(); // ids a stranger's line or a link went out for: a retry isn't a second try
    this.wrong = 0; // wrong link codes since the last good one
    this.me = null; // { user, bot, name, team }: who this bot is
    this.connected = false;
    this.customize = true; // chat:write.customize, until Slack says no
    this.chains = new Map(); // thread -> the work under way there
    this.answering = new Map(); // same, so a report comes after the first reply
  }

  get cfg() {
    return this.hub.cfg.slack;
  }

  get ready() {
    const c = this.cfg;
    if (!c?.enabled || !c.botToken) return false;
    return inBox() ? !!(boxGrid() && c.signingSecret) : !!c.appToken;
  }

  // Tokens go in a header, and an error is only ever Slack's own short code.
  async api(method, body = {}, { token = this.cfg.botToken, tries = POST_TRIES, signal } = {}) {
    const base = (process.env.WISP_SLACK_API || 'https://slack.com/api').replace(/\/+$/, '');
    for (let left = tries; ; left--) {
      const r = await resend(() => fetch(`${base}/${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      }), tries);
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

  async #whoAmI(signal) {
    const me = await this.api('auth.test', {}, { tries: 1, signal });
    this.me = { user: me.user_id, bot: me.bot_id, name: me.user || 'wisp', team: me.team || '' };
  }

  async start(signal) {
    if (inBox()) return this.#overHttp(signal);
    let fails = 0;
    while (!signal.aborted) {
      let wait = 0;
      let again = false;
      try {
        await this.#whoAmI(signal);
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

  // On a box nothing stays open: this is one look at the tokens and the way in. Slack calls when it
  // has something, and that wakes this box.
  async #overHttp(signal) {
    for (let fails = 0; !signal.aborted; fails++) {
      try {
        await this.#whoAmI(signal);
        if (!(await this.hookUrl())) return this.#down(NO_HUB);
        if (signal.aborted) return;
        this.connected = true;
        this.mark({ ok: true, connected: true, error: '' });
        return;
      } catch (err) {
        if (signal.aborted) return;
        this.#down(FOR_GOOD.has(err.code) ? `${err.message}. ${FIX}` : err.message);
        if (FOR_GOOD.has(err.code)) return;
        await sleep(Math.min(this.hub.slackBackoffMs * 2 ** fails, BACKOFF_MAX_MS), signal);
      }
    }
  }

  // This cloud wisp's URL for Slack's events, or '': its grid holds nothing for it.
  async hookUrl() {
    const box = boxGrid();
    if (!box) return '';
    const found = await channelUrl(box, this.name);
    if (found?.dropped) await this.dropped(found.dropped);
    return found?.url || '';
  }

  // The manifest to paste: a computer's, or on a box the one with its URL.
  async manifest() {
    if (!inBox()) return slackManifest();
    const url = await this.hookUrl().catch((err) => {
      throw bad(`The grid didn’t give this wisp its URL: ${err.message}.`, 502);
    });
    if (!url) throw bad(NO_HUB, 409);
    return slackManifest({ url });
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

  // The work, behind the ack: one at a time in a thread, side by side across threads. now: when it
  // arrived, for an event that waited at the grid. → done when it's been dealt with.
  #behind(payload, now) {
    const e = payload?.event;
    if (!e) return null;
    const key = `${e.channel}:${e.thread_ts || e.ts}`;
    const work = (this.chains.get(key) || Promise.resolve())
      .then(() => this.#event(payload, e, key, now))
      .catch((err) => {
        console.warn(`wisp: slack: ${err.message}`);
        this.mark({ error: err.message });
      })
      .finally(() => {
        if (this.chains.get(key) === work) this.chains.delete(key);
      });
    this.chains.set(key, work);
    return work;
  }

  // --- an event the grid held: a cloud wisp ---------------------------------------------------

  // at: when the grid took it, and only the grid can say (the proxy secret and its mark,
  // routes/channels.js). Slack's five minutes are judged from then, so a row that waited for a wake
  // isn't old, and a signed body sent again later is: the grid stamps its own time on that. Anything
  // later than now is treated as now. Past that signature an event's id stops a repeat, kept in the
  // config as a box forgets the rest when it sleeps.
  async inbound(raw, headers = {}, { at } = {}) {
    const c = this.cfg;
    if (!c?.enabled || !boxGrid()) return { status: 409, body: { error: 'Slack isn’t on here.' } };
    let j = null;
    try {
      j = JSON.parse(raw.toString('utf8'));
    } catch {}
    const checking = j?.type === 'url_verification';
    const now = Date.now();
    const taken = Math.min(Number.isFinite(at) && at > 0 ? at : now, now);
    if (c.signingSecret) {
      const wrong = slackOk(c.signingSecret, raw, headers, taken);
      if (wrong) {
        if (checking) this.mark({ ok: false, error: WRONG_SECRET }); // wisp is open: the likeliest slip in setup
        return { status: 403, body: { error: wrong } };
      }
    }
    if (checking) {
      if (typeof j.challenge !== 'string' || j.challenge.length > CHALLENGE_MAX) return { status: 400, body: { error: 'No challenge.' } };
      if (this.hub.status.slack?.error === WRONG_SECRET) this.mark({ ok: true, error: '' });
      return { status: 200, body: { challenge: j.challenge } }; // before a secret too: Slack checks the URL before it can be pasted, and echoing one word does nothing
    }
    if (!this.ready) return { status: 409, body: { error: 'Slack isn’t on here.' } };
    if (j?.type !== 'event_callback' || !j.event_id || !j.event) return { status: 400, body: { error: 'Not an event.' } };
    const e = j.event;
    try {
      if (!this.me) await this.#whoAmI(); // a mention names the bot, and this can beat start()
    } catch (err) {
      return { status: 503, body: { error: err.message } };
    }
    // It really came from Slack: this 403 tells the grid nobody here wanted it, so a stranger's wake
    // stops being paid for (grid/inbox.js).
    const ours = this.#ours(e);
    const stranger = !ours && { status: 403, body: { error: 'Not from someone linked.' } };
    const ids = [j.event_id, e.client_msg_id && `m:${e.client_msg_id}`].filter(Boolean);
    if (ids.some((id) => c.seen?.includes(id))) return stranger || { status: 200, body: { ok: true, duplicate: true } };
    c.seen = [...(c.seen || []), ...ids].slice(-SEEN_EVENTS);
    if (ours) c.spoke = { chat: e.channel, ts: e.thread_ts || e.ts };
    this.hub.store.saveConfig();
    await this.#behind(j, taken);
    return stranger || { status: 200, body: { ok: true } };
  }

  // Someone linked, or the code that links them.
  #ours(e) {
    const c = this.cfg;
    if (allowed(e.user, c.senders)) return true;
    if (e.bot_id || !e.user || String(e.channel)[0] !== 'D') return false;
    const code = /^link\s+(\S+)$/i.exec(stripFormatting(e.text, 'slack', { bot: this.me?.user }))?.[1];
    return !!code && !!c.linkCode && same(code, c.linkCode);
  }

  // Told in the last thread where someone linked spoke: there's no other place that's known to be theirs.
  async dropped(n) {
    this.mark({ dropped: n });
    const spoke = this.cfg?.spoke;
    if (spoke) await this.#post(spoke.chat, spoke.ts, lostLine(n)).catch(() => {});
  }

  // A leaked URL: the old one stops at the grid. Slack has no call for this with a bot token, so the
  // new one goes back to whoever asked, for the app's settings. Its secret and seen list stay.
  async rotate() {
    const box = boxGrid();
    if (!box || !this.ready) return { status: 409, body: { error: 'Slack isn’t on here.' } };
    const { url } = await rotateUrl(box, this.name);
    return { status: 200, body: { ok: true, url } };
  }

  // --- what a message does ----------------------------------------------------------------------

  async #event(payload, e, key, now) {
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
    if (link) return this.tried.first(id) ? this.#link(e.user, link[1], raw) : undefined;
    const seen = { first: (x) => this.seen.first(x) && (!e.client_msg_id || this.seen.first(`m:${e.client_msg_id}`)) };
    const g = gate({ sender: e.user, senders: c.senders || [], id, at: Number(e.ts), now, seen, limit: this.limit, dm, strangerLine: STRANGER });
    if (!g.ok) {
      hub.phone.count?.('refused', g.why);
      if (g.why === 'stranger' && (!this.tried.first(id) || !this.strangers.hit(e.user).ok)) return;
      if (g.reply) await raw(g.reply);
      return;
    }
    const work = this.#message({ e, dm, root, key, text });
    this.answering.set(key, work);
    await work.finally(() => this.answering.get(key) === work && this.answering.delete(key));
  }

  #link(user, code, say) {
    const c = this.cfg;
    if ((c.senders || []).includes(user)) return say('You’re already linked.');
    if (!this.strangers.hit(user).ok) return;
    if (!code || !c.linkCode || !same(code, c.linkCode)) {
      // Guessing is slow per person; this makes it slow for a whole workspace.
      if (++this.wrong >= LINK_TRIES) {
        this.wrong = 0;
        c.linkCode = newLinkCode();
        this.hub.store.saveConfig();
        this.hub.onChange();
      }
      return say('That isn’t the code. wisp shows it in Settings → Phone → Slack.');
    }
    this.wrong = 0;
    c.senders = [...(c.senders || []), user];
    c.linkCode = newLinkCode(); // one person, one code
    this.hub.store.saveConfig();
    this.hub.onChange();
    this.hub.phone.count?.('linked');
    return say('✓ Linked to wisp. Say what you’d type in wisp, here or with @wisp in a channel.');
  }

  async #message({ e, dm, root, key, text: said }) {
    const phone = this.hub.phone;
    const ctx = await phone.context();
    const text = /^new(\s|$)/i.test(said) ? `/${said}` : said || 'help'; // Slack keeps a leading / for itself
    const plain = (t) => this.#post(e.channel, root, t);
    const say = (t) => plain(dm ? t : hideNames(t, ctx, text));
    const refuse = (problems) => say(refusal(dm ? problems : problems.map((x) => ({ ...x, choices: [] }))));
    const list = (p, c) => {
      if (dm) return say(LISTS[p.command](c, p.arg));
      if (p.command === 'help') return plain(LISTS.help({})); // the grammar, with nothing of yours in its example
      if (p.command !== 'status') return plain(NO_LIST);
      return plain(`${c.tasks.filter((s) => s.state === 'running').length} running, ${c.tasks.filter((s) => s.state === 'waiting').length} waiting: see them in wisp.`);
    };
    const at = { e, dm, root, key };
    const sessionId = e.thread_ts ? this.#threadOf(e.channel, root) : null;
    if (sessionId) {
      const asked = /^btw(\s|$)/i.test(text) ? `/${text}` : text;
      const p = parseMessage(asked, { ...ctx, thread: await phone.threadCtx(sessionId) });
      if (p.command !== 'new') return this.#inThread(sessionId, p, ctx, at, { say, list, refuse });
    }
    const p = parseMessage(text, ctx);
    if (p.command && p.command !== 'new') {
      phone.count?.('list', p.command);
      if (LISTS[p.command]) return list(p, ctx);
      return say(NO_THREAD); // stop, done, /btw
    }
    if (p.problems.length) {
      phone.count?.('refused', p.problems[0].kind);
      return refuse(p.problems);
    }
    if (!p.prompt) return say(p.crew ? `Tell ${p.crew.name} what to do after the name.` : 'What should it do? Say it after the options.');
    const asked = capMode(p.mode, CAP, FALLBACK);
    if (asked.refused) {
      phone.count?.('refused', 'mode');
      return say(`${asked.refused}\n\nNothing started.`);
    }
    if (!p.crew && !p.project && !ctx.defaultProject) return say('No projects yet. Open a folder in wisp first.');
    let out;
    try {
      out = await phone.startParsed(p, { channel: this.name, name: NAME, sender: e.user, cap: CAP, fallback: FALLBACK, thread: this.#thread(e, root), ctx });
    } catch (err) {
      return say(`Couldn’t start it: ${truncate(err.message, 300)}`);
    }
    await say(out.ack).catch(this.owe(key, () => say(out.ack)));
  }

  async #inThread(sessionId, p, ctx, at, { say, list, refuse }) {
    const hub = this.hub;
    const phone = hub.phone;
    const { e, root, dm } = at;
    const quiet = (line) => (dm ? line : firstPart(line)); // a title is past the first colon
    if (LISTS[p.command] && p.command !== 'status') return list(p, ctx);
    if (p.command === 'stop') return say(await phone.stop(sessionId));
    if (p.command === 'status') return say(await phone.status(sessionId).then(quiet));
    if (p.command === 'done') return say(await hub.act({ sessionId, kind: 'done', ref: '', index: 0 }));
    if (p.problems.length) return refuse(p.problems);
    if (p.crew) {
      if (!p.prompt) return say(`Tell ${p.crew.name} what to do after the name.`);
      let out;
      try {
        out = await phone.mention(sessionId, p, { name: NAME, sender: e.user, cap: CAP, fallback: FALLBACK, thread: this.#thread(e, root), ctx });
      } catch (err) {
        return say(`Couldn’t ask them: ${truncate(err.message, 300)}`);
      }
      return say(out.ack);
    }
    const btw = p.command === 'btw';
    if (!p.prompt) return say(btw ? 'Type your question after btw.' : 'What should it do? Say it after the options.');
    const asked = capMode(p.mode, CAP, p.mode);
    if (asked.refused) return say(asked.refused);
    const later = (text) => say(text).catch(() => {});
    // Only the follow-up itself: a reply that fails to reach Slack mustn't say it wasn't sent, or it
    // gets sent twice.
    await say(await phone.run(sessionId, p, { name: NAME, sender: e.user, cap: CAP, later, btw, approvals: this.approvalsHere }).catch((err) => `Couldn’t send that: ${truncate(err.message, 300)}`));
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
    const key = `${t.channel}:${t.ts}`;
    await this.answering.get(key)?.catch(() => {}); // a quick task's report comes after the first reply
    await this.pay(key);
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
