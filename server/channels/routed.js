// A message wisp Grid sent here through the tunnel (`on laptop`, grid/route.js): the grid verified
// who it's from and picked this computer, and this computer decides whether to take it. Only with
// Accept tasks from channels on, which only this computer can switch on (routes/settings.js), and it
// goes no further than here: this computer's own projects, no other machine, no crew. Plan unless
// asked, Edits at most.
//
// The computer never holds the bot. All it keeps of the chat is the thread the grid gave it
// (s.remote.routed), and its report goes back through the grid under that.

import { truncate } from '../util.js';
import { Channel } from './channel.js';
import { parseMessage } from './grammar.js';
import { refusal } from './lists.js';
import { RateLimit, Seen, capMode, defuse, gate, scrubOut } from './policy.js';

const CAP = 'edits';
const FALLBACK = 'plan';
const OFF = 'That computer doesn’t accept tasks from channels. Turn on Settings → Notifications → Accept tasks from channels on it.';
const clean = (t) => truncate(defuse(scrubOut(t).text), 4000);

export class Routed extends Channel {
  constructor(hub) {
    super(hub, 'routed');
    this.seen = new Seen();
    this.limit = new RateLimit();
  }

  // Sending needs a grid to send through. The switch is for what comes in: a task already running
  // still says how it went.
  get ready() {
    return !!this.hub.phone.onGrid?.();
  }

  get accepting() {
    return this.hub.store.config.defaults?.acceptChannels === 'on';
  }

  reports(s) {
    return !!s?.remote?.routed;
  }

  async publish(msg, s) {
    const wait = this.waiting(s);
    if (wait === '') return;
    await this.hub.phone.gridReply(s.remote.routed, clean(wait ?? `${msg.title}\n\n${msg.text}`));
  }

  threadStarted(s, thread, by) {
    if (!s) return;
    thread.session = s.id;
    this.hub.markStarted(s.id, this.name, by?.name);
    const local = this.hub.store.get(s.id);
    if (!local) return;
    local.remote = { ...local.remote, routed: thread.ref };
    this.hub.store.save(local);
  }

  // Only what's here: a message mustn't hop from this computer to one it can reach.
  async #here() {
    const ctx = await this.hub.phone.context();
    const projects = ctx.projects.filter((p) => !p.machine);
    return { ...ctx, projects, machines: [], crew: [], crewView: [], sandbox: false, defaultProject: ctx.defaultProject?.machine ? projects[0] || null : ctx.defaultProject };
  }

  // What the grid forwarded → { status, body: { reply?, off? } }. reply is what the grid says in the chat.
  async take({ channel, name, text, sender = '', id, at, thread, follow }) {
    const { phone } = this.hub;
    const said = (reply, status = 200) => ({ status, body: { reply: clean(reply) } });
    if (!this.accepting) {
      phone.count?.('refused', 'routed-off');
      return { status: 403, body: { off: true, reply: OFF } };
    }
    const g = gate({ sender: 'grid', senders: ['grid'], id, at, seen: this.seen, limit: this.limit, rateKey: String(sender) });
    if (!g.ok) {
      phone.count?.('refused', g.why);
      return g.reply ? said(g.reply, g.why === 'stale' ? 409 : 429) : { status: 200, body: {} };
    }
    const ctx = await this.#here();
    if (follow) return this.#follow(thread, text, ctx, { name, sender, said });
    const p = parseMessage(text, ctx);
    if (p.command && p.command !== 'new') return said('Only a task goes to a computer. Say that without “on”, to your cloud wisp.', 400);
    if (p.problems.length) return said(refusal(p.problems), 400);
    if (!p.prompt) return said('What should it do? Say it after the computer’s name.', 400);
    const asked = capMode(p.mode, CAP, FALLBACK);
    if (asked.refused) {
      phone.count?.('refused', 'mode');
      return said(`${asked.refused}\n\nNothing started.`, 403);
    }
    if (p.machine || (p.project || ctx.defaultProject)?.machine) return said('Only this computer can take this.', 403);
    if (!p.project && !ctx.defaultProject) return said('No projects on that computer yet. Open a folder in wisp there first.', 400);
    const started = { channel: this.name, ref: thread, ack: null };
    try {
      // tagged: a delegate has a mode of its own, and this message's cap has to hold for all of it.
      const out = await phone.startParsed({ ...p, tagged: [] }, { channel, name, sender, cap: CAP, fallback: FALLBACK, thread: started, ctx });
      return said(out.ack);
    } catch (err) {
      return said(`Couldn’t start it: ${truncate(err.message, 300)}`, 500);
    }
  }

  async #follow(thread, text, ctx, { name, sender, said }) {
    const hub = this.hub;
    const { phone } = hub;
    const s = hub.store.all().find((x) => x.remote?.routed === thread);
    if (!s) return said('That task isn’t on this computer any more.', 404);
    const p = parseMessage(text, { ...ctx, thread: await phone.threadCtx(s.id) });
    if (p.command === 'stop') return said(await phone.stop(s.id));
    if (p.command === 'status') return said(await phone.status(s.id));
    if (p.command === 'done') return said(await hub.act({ sessionId: s.id, kind: 'done', ref: '', index: 0 }));
    if (p.command && p.command !== 'btw') return said('Only a task goes to a computer. Say that without replying, to your cloud wisp.', 400);
    if (p.problems.length) return said(refusal(p.problems), 400);
    if (!p.prompt) return said('What should it do? Say it in your reply.', 400);
    const line = await phone.run(s.id, p, { name, sender, cap: CAP, approvals: false, btw: p.command === 'btw' }).catch((err) => `Couldn’t send that: ${truncate(err.message, 300)}`);
    return said(line);
  }
}
