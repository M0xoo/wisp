// X on a cloud wisp: a post that mentions the bot starts a task or follows one up, a DM does too, and
// the result comes back by DM. The grid takes the webhook, checks X's signature, knows who linked what
// and holds the post (grid/x.js); this is the rest of the door. There's no X without a grid: a computer
// has no webhook, and nothing here runs on one.
//
// Who a message is from comes only from the x-wisp-x-* headers: the grid wrote those, and they reach
// this code beside the message, never in it. It's off here until the owner turns it on in Settings on
// this box: a Grid setting alone isn't enough, because taking over an X account reaches this machine.
// Off, a post is dropped and a DM says how; a spell can force it off and never on.
//
// Mode is Plan unless asked, Edits at most, and Full auto is refused. Each task gets its own worktree.
// Tool approvals stay in wisp. `@project` isn't read, since it would tag a stranger: `in <project>`.
// Words go out by DM only, and only for a thread the grid knows this box accepted: the public line is
// the grid's, a fixed one, so a task that starts well says nothing more until its result. A refused
// message gets its line, since that's the only way the sender finds out.

import { bad, truncate } from '../util.js';
import { boxGrid, xReply, xState } from './box.js';
import { Channel } from './channel.js';
import { NOT_A_NAME, parseMessage } from './grammar.js';
import { LISTS, refusal } from './lists.js';
import { RateLimit, capMode, gate, scrubOut } from './policy.js';

const FROM = 'x-wisp-x-sender';
const CAP = 'edits';
const FALLBACK = 'plan';
const NAME = 'X';
const SEEN_MAX = 200; // kept in config: a box's memory ends when it sleeps
const REPLY_MAX = 30_000;
const OFF_LINE = 'X is off on your wisp, so that didn’t run. Turn it on in Settings → Phone → X, then send it again.';
const NO_COMPUTER = (word) => `Running on another computer from X isn’t available yet, so nothing started. To run it on your cloud computer, send it again without “on ${word}”.`;
export const NOT_ON_A_BOX = 'X only works on a cloud computer.';

// A place in `on <word>` that isn't this box. `on the login page` is a sentence; the grammar has
// already read a known machine, and says when a word isn't one.
function otherComputer(p) {
  if (p.machine || p.crew?.machine) return p.machine || p.crew.machine;
  const word = /^“on (\S+)” isn’t one of your machines/.exec(p.notes.find((n) => n.startsWith('“on ')) || '')?.[1];
  return word && !NOT_A_NAME.has(word.toLowerCase()) ? word : '';
}

export class X extends Channel {
  constructor(hub) {
    super(hub, 'x');
    this.limit = new RateLimit();
    this.grid = null; // what the grid said of this link; null: it has no X
    this.answering = new Map(); // thread being answered -> that work
  }

  get cfg() {
    return this.hub.cfg.x;
  }

  // A spell can only force this off: the value that matters here is the owner's own, below.
  get forcedOff() {
    return this.hub.store.config?.defaults?.acceptX === 'off';
  }

  get ready() {
    return !!(this.cfg?.enabled && !this.forcedOff && boxGrid());
  }

  view() {
    const g = this.grid;
    return { offered: !!g, enabled: !!this.cfg?.enabled && !this.forcedOff, forcedOff: this.forcedOff, linked: !!g?.linked, handle: g?.handle || '', bot: g?.bot || '', dmOpen: !!g?.dmOpen, paused: !!g?.paused, capped: !!g?.capped, account: g?.account || '', error: this.hub.status.x?.error || '' };
  }

  update(body) {
    const prev = this.cfg || {};
    const enabled = !!(body.enabled ?? prev.enabled);
    if (enabled && !boxGrid()) throw bad(NOT_ON_A_BOX);
    if (enabled && !prev.enabled && this.forcedOff) throw bad('A spell has X turned off here. Turn that spell off in Settings → Spells first.');
    this.hub.cfg.x = { ...prev, enabled };
  }

  // Asks the grid whether it has X, and about this link. Once per start, and when Phone opens.
  async start(signal) {
    await this.refresh(signal).catch((err) => {
      if (!signal?.aborted && this.ready) this.mark({ ok: false, error: `Couldn’t reach the grid: ${err.message}` });
    });
  }

  async refresh(signal) {
    const box = boxGrid();
    if (!box) return this.view();
    const grid = await xState(box);
    if (signal?.aborted) return this.view();
    const had = !!this.grid;
    this.grid = grid;
    if (had !== !!grid) this.hub.onChange();
    return this.view();
  }

  async dropped(n) {
    this.mark({ dropped: n });
  }

  // True the first time; kept, as a box forgets everything when it sleeps.
  #first(id) {
    const seen = this.cfg.seen || [];
    if (seen.includes(id)) return false;
    this.cfg.seen = [...seen, id].slice(-SEEN_MAX);
    return true;
  }

  async inbound(raw, headers = {}, { at: taken } = {}) {
    if (!boxGrid()) return { status: 409, body: { error: 'X isn’t on here.' } };
    const from = headers[FROM];
    if (typeof from !== 'string' || !from) return this.#refused('sender', 'Nobody it’s certainly from.');
    let m;
    try {
      m = JSON.parse(raw.toString('utf8'));
    } catch {}
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || typeof m.text !== 'string' || typeof m.thread !== 'string') return { status: 400, body: { error: 'Not a message.' } };
    // A 2xx: the thread is what lets this answer. It's the person who's told, and it's the owner's.
    if (!this.ready) {
      this.#note('off');
      return { status: 200, body: { ok: true, off: true }, after: () => this.#later(m, this.#say(m.thread, OFF_LINE)) };
    }
    const at = Math.floor(Math.min(m.at > 0 ? m.at : Infinity, taken > 0 ? taken : Infinity) / 1000) || 0;
    const g = gate({ sender: from, senders: [from], id: m.id, at, seen: { first: (x) => this.#first(x) }, limit: this.limit });
    this.hub.store.saveConfig(); // before anything runs: a crash now loses a task, it can't run one twice
    if (!g.ok && g.why === 'duplicate') return { status: 200, body: { ok: true, duplicate: true } };
    this.mark({ ok: true, error: '', refused: '' });
    return { status: 200, body: { ok: true }, after: () => this.#later(m, g.ok ? this.#run(m, from) : g.reply ? this.#say(m.thread, g.reply) : Promise.resolve()) };
  }

  // Work that follows the grid's hearing of the 2xx. A task's report waits for this (publish).
  #later(m, work) {
    const out = work.catch((err) => {
      console.warn(`wisp: x: ${err.message}`);
      this.mark({ ok: false, error: err.message });
    });
    this.answering.set(m.thread, out);
    return out.finally(() => this.answering.delete(m.thread));
  }

  // Silence for whoever sent it; Settings says why, so a real sender isn't left guessing.
  #refused(why, error) {
    this.#note(why);
    return { status: 403, body: { error } };
  }

  #note(why) {
    this.mark({ refused: why });
    this.hub.phone.count?.('refused', why);
  }

  // --- what a message does ----------------------------------------------------------------------

  async #run(m, sender) {
    const phone = this.hub.phone;
    const ctx = { ...(await phone.context()), atProject: false };
    const say = (t) => this.#say(m.thread, t);
    if (m.follow) {
      const sessionId = this.#sessionOf(m.thread);
      if (!sessionId) return say('wisp can’t find the task this follows, so nothing ran. Mention me in a new post to start one.');
      return this.#inThread(sessionId, parseMessage(m.text, { ...ctx, thread: await phone.threadCtx(sessionId) }), ctx, m, sender);
    }
    const p = parseMessage(m.text || 'help', ctx);
    if (p.command && p.command !== 'new') {
      phone.count?.('list', p.command);
      return say(LISTS[p.command] ? LISTS[p.command](ctx, p.arg) : 'There’s no task on this one yet.');
    }
    const elsewhere = otherComputer(p);
    if (elsewhere) return this.#refuse(say, 'computer', NO_COMPUTER(elsewhere));
    if (p.problems.length) return say(refusal(p.problems));
    if (!p.prompt) return say(p.crew ? `Tell ${p.crew.name} what to do after the name.` : 'What should it do? Say it after the options.');
    const asked = capMode(p.mode, CAP, FALLBACK);
    if (asked.refused) return this.#refuse(say, 'mode', `${asked.refused}\n\nNothing started.`);
    if (!p.crew && !p.project && !ctx.defaultProject) return say('No projects yet. Open a folder in wisp first.');
    try {
      await phone.startParsed(p, { channel: this.name, name: NAME, sender: '', cap: CAP, fallback: FALLBACK, worktree: true, thread: { channel: this.name, thread: m.thread }, ctx });
    } catch (err) {
      await say(`Couldn’t start it: ${truncate(err.message, 300)}`);
    }
  }

  #refuse(say, why, line) {
    this.#note(why);
    return say(line);
  }

  async #inThread(sessionId, p, ctx, m) {
    const hub = this.hub;
    const phone = hub.phone;
    const say = (t) => this.#say(m.thread, t);
    if (LISTS[p.command] && p.command !== 'status') return say(LISTS[p.command](ctx, p.arg));
    if (p.command === 'stop') return say(await phone.stop(sessionId));
    if (p.command === 'status') return say(await phone.status(sessionId));
    if (p.command === 'done') return say(await hub.act({ sessionId, kind: 'done', ref: '', index: 0 }));
    if (p.problems.length) return say(refusal(p.problems));
    if (p.crew) {
      if (!p.prompt) return say(`Tell ${p.crew.name} what to do after the name.`);
      await phone.mention(sessionId, p, { name: NAME, cap: CAP, fallback: FALLBACK, thread: { channel: this.name, thread: m.thread }, ctx });
      return;
    }
    const btw = p.command === 'btw';
    if (!p.prompt) return say(btw ? 'Type your question after /btw.' : 'What should it do? Say it after the options.');
    const asked = capMode(p.mode, CAP, p.mode);
    if (asked.refused) return this.#refuse(say, 'mode', asked.refused);
    const line = await phone.run(sessionId, p, { name: NAME, cap: CAP, later: (t) => say(t).catch(() => {}), btw, approvals: this.approvalsHere });
    if (!line.startsWith('✓') || btw) await say(line); // a follow-up that went needs no DM: its result is one
  }

  // The task of a thread. Newest first: a thread has one, unless it was moved.
  #sessionOf(thread) {
    return this.hub.store.all?.().filter((s) => s.crew?.job !== 'mention' && s.remote?.x?.thread === thread).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]?.id || null;
  }

  // --- what leaves ------------------------------------------------------------------------------

  // Only ever into a thread, and the grid scrubs it again: an agent with the Box secret isn't this code.
  async #say(thread, text) {
    const out = await xReply(boxGrid(), { thread, text: truncate(scrubOut(text).text, REPLY_MAX) });
    this.mark({ ok: true, error: '' });
    return out;
  }

  reports(s) {
    return this.hub.startedFrom(s)?.channel === this.name;
  }

  // Only for a task that came from X: the hub asks, whatever the Phone events say.
  async publish(msg, s) {
    const t = s?.remote?.x;
    if (!t) return;
    await this.answering.get(t.thread)?.catch(() => {}); // a quick task's report comes after any first line
    const wait = this.waiting(s);
    if (wait === '') return;
    await this.#say(t.thread, wait ?? this.#report(msg));
    this.hub.phone.count?.('report', 'full');
  }

  #report(msg) {
    const choices = (msg.actions || []).filter((a) => a.kind !== 'done').map((a) => a.label);
    return [msg.title, msg.text, choices.length ? `Choices: ${choices.join(' · ')}` : ''].filter(Boolean).join('\n\n');
  }

  // A task or a crew job began for this thread (a queued job, maybe after a restart), or err: it couldn't.
  threadStarted(s, thread, by, err) {
    if (err) {
      this.#say(thread.thread, `${by ? `${by.name} couldn’t start` : 'Couldn’t start'}: ${truncate(err.message, 300)}`).catch(() => {});
      return;
    }
    const hub = this.hub;
    hub.markStarted(s.id, this.name, by?.name);
    const local = hub.store.get(s.id);
    if (local) {
      local.remote = { ...local.remote, x: { thread: thread.thread } };
      hub.store.save(local);
    }
  }
}
