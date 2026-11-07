// ntfy: a notification with up to 3 buttons. A tap makes the ntfy app POST a signed answer to
// <topic>-reply, which wisp polls. No free text (ntfy has no reply box).

import { truncate } from '../util.js';
import { Channel, CODE, KIND, sleep } from './channel.js';
import { Seen } from './policy.js';

export class Ntfy extends Channel {
  constructor(hub) {
    super(hub, 'ntfy');
  }

  get ready() {
    const n = this.hub.cfg.ntfy;
    return !!(n?.enabled && n.topic);
  }

  #where() {
    const n = this.hub.cfg.ntfy;
    const server = String(n.server || 'https://ntfy.sh').replace(/\/+$/, '');
    return { server, topic: n.topic, headers: n.token ? { authorization: `Bearer ${n.token}` } : {} };
  }

  async publish(msg, s) {
    const { server, topic, headers } = this.#where();
    const actions = (s ? msg.actions : []).slice(0, 3).map((a) => {
      const k = CODE[a.kind];
      return { action: 'http', label: truncate(a.label, 40), url: `${server}/${topic}-reply`, method: 'POST', headers, body: JSON.stringify({ s: s.id, k, r: a.ref, i: a.index, sig: this.hub.sign(s.id, a.kind, a.ref, a.index) }), clear: true };
    });
    const r = await fetch(server, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ topic, title: truncate(msg.title, 200), message: truncate(msg.text, 3000), tags: ['wisp'], ...(actions.length && { actions }) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`ntfy: ${r.status} ${(await r.text().catch(() => '')).slice(0, 120)}`);
  }

  // A tap: it says what to do, signed. Anything else on the topic is ignored.
  async #tap(m) {
    if (m.event !== 'message') return;
    let p = null;
    try {
      p = JSON.parse(m.message);
    } catch {}
    if (!this.hub.verify(p)) return; // not ours, or forged
    await this.hub.act({ sessionId: p.s, kind: KIND[p.k], ref: p.r, index: Number(p.i) }).catch(() => {});
  }

  // Polls from where the last run stopped, so a tap sent while wisp was down or its cloud box asleep
  // still lands (ntfy keeps them for hours). since is the last message's id, or at first the time.
  async start(signal) {
    const keep = (since) => {
      this.hub.cfg.ntfy.since = since;
      this.hub.store.saveConfig();
    };
    if (!this.hub.cfg.ntfy.since) keep(String(Math.floor(Date.now() / 1000)));
    const seen = new Seen(); // ntfy can send a message of the same second again: going back to it would loop
    while (!signal.aborted) {
      try {
        const { server, topic, headers } = this.#where();
        const r = await fetch(`${server}/${topic}-reply/json?poll=1&since=${this.hub.cfg.ntfy.since}`, { headers, signal });
        if (!r.ok) throw new Error(`ntfy: ${r.status}`);
        for (const line of (await r.text()).split('\n')) {
          if (!line.trim()) continue;
          const m = JSON.parse(line);
          if (!seen.first(m.id)) continue;
          await this.#tap(m); // first: a crash here repeats a tap, which only says it was already answered, rather than losing it
          if (signal.aborted) return; // reconfigured meanwhile: this id isn't for the new topic
          if (m.id) keep(m.id);
        }
        if (this.hub.status.ntfy?.error) this.mark({ ok: true, error: '' });
      } catch (err) {
        if (signal.aborted) return;
        this.mark({ ok: false, error: err.message });
      }
      await sleep(this.hub.ntfyPollMs, signal);
    }
  }
}
