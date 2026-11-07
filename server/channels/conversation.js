// What a message does once it's through a channel's door, written once. A channel hands in `c`, what
// differs for it, and the channels keep only their wire and who may speak.
//
//   c: { phone, hub, ctx, name, sender, cap, fallback?, about?, approvals, say, list, refuse,
//        thread(): where a task started here answers, noThread: the line for `stop` out of a thread,
//        stale?(p): a line when the message points at something gone, acked?(thread, sent),
//        quiet?(line): status with less in it, runLine?(line): so a follow-up's answer, later?(text),
//        beforeRun?(sessionId): → undo, failed?(what, err), btwHelp? }

import { randomInt, timingSafeEqual } from 'node:crypto';
import { truncate } from '../util.js';
import { parseMessage } from './grammar.js';
import { LISTS, refusal } from './lists.js';
import { capMode, hideNames } from './policy.js';

const LINK_TRIES = 5; // wrong codes before the code changes

export const inBox = (env = process.env) => !!env.WISP_GRID_URL;
export const newLinkCode = () => String(randomInt(100000, 999999));
export const firstPart = (line) => `${String(line).split(':')[0].replace(/\.$/, '')}.`;

const failedLine = (what, err) => `Couldn’t ${what}: ${truncate(err.message, 300)}`;

// say, refuse and list for a place others can read, or not (open). There a list is one fixed line,
// help has nothing of yours in its example, a refusal has no choices, and anything else said loses
// names you didn't write there. typed: what this message said, and what's already known there.
export function surface({ ctx, post, open, typed, noList }) {
  const say = (t) => post(open ? t : hideNames(t, ctx, typed));
  return {
    say,
    refuse: (problems) => say(refusal(open ? problems : problems.map((x) => ({ ...x, choices: [] })))),
    list: (p, c) => {
      if (open) return say(LISTS[p.command](c, p.arg));
      if (p.command === 'help') return post(LISTS.help({}));
      if (p.command !== 'status') return post(noList);
      return post(`${c.tasks.filter((s) => s.state === 'running').length} running, ${c.tasks.filter((s) => s.state === 'waiting').length} waiting: see them in wisp.`);
    },
  };
}

// text: the message, through stripFormatting. sessionId: the task its thread belongs to, if any.
// threadText: the same message as it reads in that thread.
export async function converse(c, text, sessionId = null, threadText = text) {
  if (sessionId) {
    const p = parseMessage(threadText, { ...c.ctx, thread: await c.phone.threadCtx(sessionId) });
    if (p.command !== 'new') return inThread(c, sessionId, p);
  }
  return start(c, parseMessage(text, c.ctx));
}

async function start(c, p) {
  const { phone, ctx, say } = c;
  if (p.command && p.command !== 'new') {
    phone.count?.('list', p.command);
    if (LISTS[p.command]) return c.list(p, ctx);
    return say(c.noThread); // stop, done, /btw
  }
  const stale = c.stale?.(p);
  if (stale) return say(stale);
  if (p.problems.length) {
    phone.count?.('refused', p.problems[0].kind);
    return c.refuse(p.problems);
  }
  if (!p.prompt) return say(p.crew ? `Tell ${p.crew.name} what to do after the name.` : 'What should it do? Say it after the options.');
  const asked = capMode(p.mode, c.cap, c.fallback ?? 'plan');
  if (asked.refused) {
    phone.count?.('refused', 'mode');
    return say(`${asked.refused}\n\nNothing started.`);
  }
  if (!p.crew && !p.project && !ctx.defaultProject) return say('No projects yet. Open a folder in wisp first.');
  const thread = await c.thread(p);
  let out;
  try {
    out = await phone.startParsed(p, { channel: c.channel, name: c.name, sender: c.sender, cap: c.cap, ...(c.fallback && { fallback: c.fallback }), ...(c.about && { about: c.about }), thread, ctx });
  } catch (err) {
    return say((c.failed || failedLine)('start it', err));
  }
  const sent = await say(out.ack);
  c.acked?.(thread, sent);
}

async function inThread(c, sessionId, p) {
  const { phone, hub, ctx, say } = c;
  const quiet = c.quiet || ((line) => line);
  if (LISTS[p.command] && p.command !== 'status') return c.list(p, ctx);
  if (p.command === 'stop') return say(await phone.stop(sessionId));
  if (p.command === 'status') return say(quiet(await phone.status(sessionId)));
  if (p.command === 'done') return say(await hub.act({ sessionId, kind: 'done', ref: '', index: 0 }));
  if (p.problems.length) return c.refuse(p.problems);
  if (p.crew) {
    if (!p.prompt) return say(`Tell ${p.crew.name} what to do after the name.`);
    const thread = await c.thread(p);
    try {
      const out = await phone.mention(sessionId, p, { name: c.name, sender: c.sender, cap: c.cap, ...(c.fallback && { fallback: c.fallback }), ...(c.about && { about: c.about }), thread, ctx });
      const sent = await say(out.ack);
      c.acked?.(thread, sent);
    } catch (err) {
      await say((c.failed || failedLine)('ask them', err));
    }
    return;
  }
  const btw = p.command === 'btw';
  if (!p.prompt) return say(btw ? c.btwHelp || 'Type your question after /btw.' : 'What should it do? Say it after the options.');
  const asked = capMode(p.mode, c.cap, p.mode);
  if (asked.refused) return say(asked.refused);
  const later = c.later || ((text) => say(text).catch(() => {}));
  const undo = btw ? null : c.beforeRun?.(sessionId);
  // Only the follow-up itself: a reply that fails to arrive mustn't say it wasn't sent, or it gets
  // sent twice.
  let line;
  try {
    line = await phone.run(sessionId, p, { name: c.name, sender: c.sender, cap: c.cap, later, btw, ...(c.about && { about: c.about }), approvals: c.approvals });
    if (!line.startsWith('✓')) undo?.(); // refused: no turn is coming
    line = c.runLine ? c.runLine(line) : line;
  } catch (err) {
    undo?.();
    line = (c.failed || failedLine)('send that', err);
  }
  await say(line);
}

const same = (a, b) => {
  const [x, y] = [Buffer.from(String(a)), Buffer.from(String(b))];
  return x.length === y.length && timingSafeEqual(x, y);
};

// `link <code>` in a private message. cfg: the channel's { senders, linkCode }. where: where wisp
// shows the code. A code links one person, and guessing changes it.
export class Linking {
  constructor(channel, { limit, where, done }) {
    Object.assign(this, { channel, limit, where, done, wrong: 0 });
  }

  attempt(user, code, say) {
    const c = this.channel.cfg;
    const hub = this.channel.hub;
    if ((c.senders || []).includes(user)) return say('You’re already linked.');
    if (!this.limit().hit(user).ok) return undefined;
    if (!code || !c.linkCode || !same(code, c.linkCode)) {
      // Guessing is slow per person; this makes it slow for a whole workspace.
      if (++this.wrong >= LINK_TRIES) {
        this.wrong = 0;
        c.linkCode = newLinkCode();
        hub.store.saveConfig();
        hub.onChange();
      }
      return say(`That isn’t the code. wisp shows it in ${this.where}.`);
    }
    this.wrong = 0;
    c.senders = [...(c.senders || []), user];
    c.linkCode = newLinkCode(); // one person, one code
    hub.store.saveConfig();
    hub.onChange();
    hub.phone.count?.('linked');
    return say(this.done);
  }
}

// The work behind an ack: one at a time per key, side by side across keys; and, per key, what's being
// answered now, so a quick task's report comes after its first reply.
export class Turns {
  chains = new Map();
  answering = new Map();

  queue(key, fn, onError) {
    const work = (this.chains.get(key) || Promise.resolve())
      .then(fn)
      .catch(onError)
      .finally(() => {
        if (this.chains.get(key) === work) this.chains.delete(key);
      });
    this.chains.set(key, work);
    return work;
  }

  hold(key, work) {
    this.answering.set(key, work);
    return work.finally(() => this.answering.get(key) === work && this.answering.delete(key));
  }

  settled(key) {
    return this.answering.get(key)?.catch(() => {});
  }
}
