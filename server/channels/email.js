// Email on a cloud wisp: a message to your secret address starts a task or follows one up, and the
// answer comes back as a reply. The grid takes the mail, checks the provider's signature, and holds it
// (grid/mail.js); this is the rest of the door. There's no email without a grid: a computer has no
// address, and nothing here runs on one.
//
// Who a message is from comes only from the x-wisp-mail-* headers: the grid wrote those, and they
// reach this code beside the message, never in it. A verdict of 'pass' (the grid verified a DKIM
// signature by the From's own domain) and the one allowed sender, or a 403 and silence: an answer to a
// forged From would land on the person it was forged from, and that 403 is what tells the grid nobody
// wanted the wake.
//
// Only what a person just wrote is read: quotes and signatures go first, so a command in an earlier
// message can't run again. A reply to a task follows that task and never reads the subject, and a
// reply to nothing wisp knows starts nothing. Attachments aren't read yet: the first reply says so.
//
// Mode is Plan unless asked, Edits at most, and Full auto is refused. Tool approvals stay in wisp.

import { bad, truncate } from '../util.js';
import { boxGrid, channelUrl, mailReply, rotateUrl } from './box.js';
import { Channel } from './channel.js';
import { parseMessage, stripFormatting } from './grammar.js';
import { LISTS, refusal } from './lists.js';
import { RateLimit, capMode, gate, scrubOut } from './policy.js';

const FROM = 'x-wisp-mail-from';
const DMARC = 'x-wisp-mail-dmarc';
const ID = 'x-wisp-mail-id';
const CAP = 'edits';
const FALLBACK = 'plan';
const NAME = 'Email';
const SEEN_MAX = 200; // kept in config: a box's memory ends when it sleeps
const IDS_MAX = 50;
const REPLY_MAX = 30_000;
const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const REPLY_LINE = '↩ Reply above this line to answer or follow up.';
export const NOT_ON_A_BOX = 'Email only works on a cloud computer.';

// Where a quote or a signature begins: everything after it goes. Wrapped over lines, as clients do.
const WROTE = /^(?:On|Le|Am|El|Il|Em|Op)\s[^\n]*(?:\n[^\n]*){0,2}?(?:(?:wrote|a écrit|escribió|ha scritto|escreveu|schreef)\s*|schrieb\b[^\n]*):\s*$/im;
const CUT = [
  /^-- ?$/m,
  /^_{10,}\s*$/m,
  /^-{2,}\s*(?:Original Message|Forwarded message|Message d['’]origine|Message transféré|Ursprüngliche Nachricht|Mensaje original|Messaggio originale)\b/im,
  /^(?:From|De|Von|Da)\s?:\s.*\n(?:.*\n){0,2}?(?:Sent|Date|Envoyé|Gesendet|Enviado|Inviato)\s?:\s/im,
  /^(?:Sent from|Envoyé de|Von meinem|Enviado desde|Inviato da|Get Outlook for)\b.*$/im,
  new RegExp(`^.*${REPLY_LINE.slice(2)}`, 'm'),
  WROTE,
];

// What the sender wrote themselves, in a plain-text message.
export function ownWords(text) {
  let t = String(text ?? '').replace(/\r\n?/g, '\n');
  for (const re of CUT) {
    const m = re.exec(t);
    if (m) t = t.slice(0, m.index);
  }
  return t
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
// Where a client's quote, or its signature, begins in HTML. All of it goes, to the end.
const HTML_CUT = /<blockquote\b|<[a-z]+\b[^>]*\b(?:class|id)\s*=\s*["']?[^"'>]*\b(?:gmail_quote|gmail_signature|yahoo_quoted|moz-cite-prefix|divRplyFwdMsg|appendonsend)\b/i;

function htmlText(html) {
  const s = String(html)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(head|style|script|title)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
  const at = HTML_CUT.exec(s);
  return (at ? s.slice(0, at.index) : s)
    .replace(/<br\b[^>]*>|<\/(?:p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? all;
      const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/^[ \t]+/gm, '');
}

// A message's text, whichever way it came: the plain part if it has one, else its HTML.
export const mailWords = (m) => ownWords(m?.text?.trim() ? m.text : htmlText(m?.html ?? ''));

const fromSubject = (s) => String(s ?? '').replace(/^(?:\s*(?:fwd?|tr|wg)\s*:)+/i, '').trim();
const isReply = (m) => !!(m.inReplyTo || m.references?.length || /^\s*(?:re|aw|sv)\s*:/i.test(m.subject || ''));

export class Email extends Channel {
  constructor(hub) {
    super(hub, 'email');
    this.limit = new RateLimit();
    this.offered = false; // this grid has mail
    this.answering = new Map(); // message being answered -> that work
  }

  get cfg() {
    return this.hub.cfg.email;
  }

  get ready() {
    const c = this.cfg;
    return !!(c?.enabled && c.sender && boxGrid());
  }

  view() {
    const c = this.cfg;
    return { offered: this.offered, enabled: !!c?.enabled, address: this.offered ? c?.address || '' : '', sender: c?.sender || '', error: this.hub.status.email?.error || '' };
  }

  update(body) {
    const prev = this.cfg || {};
    const sender = body.sender === undefined ? prev.sender || '' : String(body.sender).trim().toLowerCase();
    if (sender && !ADDRESS.test(sender)) throw bad('That doesn’t look like an email address.');
    const enabled = !!(body.enabled ?? prev.enabled);
    if (enabled && !boxGrid()) throw bad(NOT_ON_A_BOX);
    this.hub.cfg.email = { ...prev, enabled, sender };
  }

  // Asks the grid whether it has mail, and for this user's address. Once per start: nothing to keep up.
  async start(signal) {
    const box = boxGrid();
    if (!box) return;
    try {
      const found = await channelUrl(box, this.name);
      if (signal.aborted) return;
      this.offered = !!found;
      if (found) {
        this.#keepAddress(found.address);
        if (found.dropped) await this.dropped(found.dropped);
      }
      this.hub.onChange();
    } catch (err) {
      if (!signal.aborted && this.ready) this.mark({ ok: false, error: `Couldn’t reach the grid: ${err.message}` });
    }
  }

  #keepAddress(address) {
    if (this.cfg?.address === address) return;
    this.hub.cfg.email = { ...this.cfg, address };
    this.hub.store.saveConfig();
  }

  async rotate() {
    const box = boxGrid();
    if (!box || !this.offered) return { status: 409, body: { error: 'This cloud computer has no address.' } };
    const { address } = await rotateUrl(box, this.name);
    this.#keepAddress(address);
    this.hub.onChange();
    return { status: 200, body: { ok: true, address } };
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
    if (!this.ready) return { status: 409, body: { error: 'Email isn’t on here.' } };
    const [from, id] = [headers[FROM], headers[ID]];
    if (headers[DMARC] === 'unproved') return this.#refused('dkim', 'No signature proves who it’s from.');
    if (headers[DMARC] !== 'pass') return this.#refused('dmarc', 'No DMARC pass.');
    if (typeof from !== 'string' || !from || typeof id !== 'string' || !id) return this.#refused('dmarc', 'Nobody it’s certainly from.');
    let m;
    try {
      m = JSON.parse(raw.toString('utf8'));
    } catch {}
    if (!m || typeof m !== 'object') return { status: 400, body: { error: 'Not a message.' } };
    if (from !== this.cfg.sender) return this.#refused('stranger', 'Not the allowed sender.');
    const sent = Date.parse(m.date);
    if (Number.isNaN(sent)) return this.#refused('date', 'It has no date.');
    // The earlier of the two: a Date header is the sender's word, the grid's time its own.
    const at = Math.floor(Math.min(sent, taken > 0 ? taken : sent) / 1000);
    const g = gate({ sender: from, senders: [this.cfg.sender], id, at, seen: { first: (x) => this.#first(x) }, limit: this.limit });
    this.hub.store.saveConfig(); // before anything runs: a crash now loses a task, it can't run one twice
    if (!g.ok && g.why === 'duplicate') return { status: 200, body: { ok: true, duplicate: true } };
    this.mark({ ok: true, error: '', refused: '' });
    const thread = { id, subject: m.subject || '' };
    const after = () => {
      const work = (g.ok ? this.#run(m, thread) : g.reply ? this.#say(thread, g.reply) : Promise.resolve()).catch((err) => {
        console.warn(`wisp: email: ${err.message}`);
        this.mark({ ok: false, error: err.message });
      });
      this.answering.set(id, work);
      work.finally(() => this.answering.delete(id));
    };
    return { status: 200, body: { ok: true }, after };
  }

  // Silence for whoever sent it; Settings says why, so a real sender isn't left guessing.
  #refused(why, error) {
    this.mark({ refused: why });
    this.hub.phone.count?.('refused', why);
    return { status: 403, body: { error } };
  }

  // --- what a message does ----------------------------------------------------------------------

  async #run(m, at) {
    const phone = this.hub.phone;
    const ctx = await phone.context();
    const say = (t) => this.#say(at, t);
    const own = mailWords(m);
    const sessionId = this.#threadOf(m);
    if (sessionId) {
      at.sessionId = sessionId;
      this.#follow(sessionId, at);
      return this.#inThread(sessionId, parseMessage(stripFormatting(own), { ...ctx, thread: await phone.threadCtx(sessionId) }), ctx, at);
    }
    if (isReply(m)) return say('wisp can’t find the task this answers, so nothing ran. Send a new message to start one.');
    const subject = fromSubject(m.subject);
    const text = stripFormatting([subject, own].filter(Boolean).join('\n\n'));
    const p = parseMessage(text || 'help', ctx);
    if (p.command && p.command !== 'new') {
      phone.count?.('list', p.command);
      return say(LISTS[p.command] ? LISTS[p.command](ctx, p.arg) : 'There’s no task on this one yet.');
    }
    if (p.problems.length) return say(refusal(p.problems));
    if (!p.prompt) return say(p.crew ? `Tell ${p.crew.name} what to do after the name.` : 'What should it do? Say it after the options.');
    const asked = capMode(p.mode, CAP, FALLBACK);
    if (asked.refused) return say(`${asked.refused}\n\nNothing started.`);
    if (!p.crew && !p.project && !ctx.defaultProject) return say('No projects yet. Open a folder in wisp first.');
    let out;
    try {
      out = await phone.startParsed(p, { channel: this.name, name: NAME, sender: this.cfg.sender, cap: CAP, fallback: FALLBACK, thread: { channel: this.name, id: at.id, subject: at.subject, ids: [at.id, ...(m.references || [])].slice(-IDS_MAX) }, ctx });
    } catch (err) {
      return say(`Couldn’t start it: ${truncate(err.message, 300)}`);
    }
    at.sessionId = out.session?.id;
    await say(m.attachments ? `${out.ack}\n\nAttachments aren’t read yet: only the text of your message was.` : out.ack);
  }

  async #inThread(sessionId, p, ctx, at) {
    const hub = this.hub;
    const phone = hub.phone;
    const say = (t) => this.#say(at, t);
    if (LISTS[p.command] && p.command !== 'status') return say(LISTS[p.command](ctx, p.arg));
    if (p.command === 'stop') return say(await phone.stop(sessionId));
    if (p.command === 'status') return say(await phone.status(sessionId));
    if (p.command === 'done') return say(await hub.act({ sessionId, kind: 'done', ref: '', index: 0 }));
    if (p.problems.length) return say(refusal(p.problems));
    const sender = this.cfg.sender;
    if (p.crew) {
      if (!p.prompt) return say(`Tell ${p.crew.name} what to do after the name.`);
      const out = await phone.mention(sessionId, p, { name: NAME, sender, cap: CAP, fallback: FALLBACK, thread: { channel: this.name, id: at.id, subject: at.subject, ids: [at.id] }, ctx });
      return say(out.ack);
    }
    const btw = p.command === 'btw';
    if (!p.prompt) return say(btw ? 'Type your question after /btw.' : 'What should it do? Say it after the options.');
    const asked = capMode(p.mode, CAP, p.mode);
    if (asked.refused) return say(asked.refused);
    await say(await phone.run(sessionId, p, { name: NAME, sender, cap: CAP, later: (t) => say(t).catch(() => {}), btw, approvals: this.approvalsHere }));
  }

  // The task a message answers: any message it names that's part of one.
  #threadOf(m) {
    const refs = new Set([m.inReplyTo, ...(m.references || [])].filter(Boolean));
    if (!refs.size) return null;
    const newest = (list) => list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]?.id || null;
    const here = this.hub.store.all().filter((s) => s.crew?.job !== 'mention' && s.remote?.email?.ids?.some((x) => refs.has(x)));
    const away = [...this.hub.away].filter(([, a]) => a.email?.ids?.some((x) => refs.has(x))).map(([id, a]) => ({ id, createdAt: a.at }));
    return newest([...here, ...away]);
  }

  // The newest message of a task is what its next reply answers.
  #follow(sessionId, at) {
    this.#thread(sessionId, (t) => ({ ...t, id: at.id, subject: at.subject || t.subject, ids: [...t.ids, at.id].slice(-IDS_MAX) }));
  }

  #thread(sessionId, change) {
    const s = this.hub.store.get(sessionId);
    if (s?.remote?.email) {
      s.remote = { ...s.remote, email: change(s.remote.email) };
      this.hub.store.save(s);
      return;
    }
    const a = this.hub.away.get(sessionId);
    if (a?.email) this.keepAway(sessionId, a.by, { email: change(a.email) });
  }

  // --- what leaves ------------------------------------------------------------------------------

  // Only ever a reply: at.id is a message this box accepted, and the grid holds where it came from.
  async #say(at, text) {
    const box = boxGrid();
    const clean = truncate(scrubOut(text).text, REPLY_MAX);
    const subject = /^\s*re:/i.test(at.subject) ? at.subject : `Re: ${at.subject || 'your message'}`;
    const { messageId } = await mailReply(box, { replyTo: at.id, subject: scrubOut(subject, { note: false }).text, text: `${REPLY_LINE}\n\n${clean}` });
    if (at.sessionId && messageId) this.#thread(at.sessionId, (t) => ({ ...t, ids: [...t.ids, messageId].slice(-IDS_MAX) }));
    this.mark({ ok: true, error: '' });
  }

  reports(s) {
    return this.hub.startedFrom(s)?.channel === this.name;
  }

  // Only for a task that came by mail: the hub asks, whatever the Phone events say.
  async publish(msg, s) {
    const t = s?.remote?.email || this.hub.away.get(s?.id)?.email;
    if (!t) return;
    await this.answering.get(t.id)?.catch(() => {}); // a quick task's report comes after the first reply
    const wait = this.waiting(s);
    if (wait === '') return;
    await this.#say({ id: t.id, subject: t.subject, sessionId: s.id }, wait ?? this.#report(msg));
    this.hub.phone.count?.('report', 'full');
  }

  #report(msg) {
    const choices = (msg.actions || []).filter((a) => a.kind !== 'done').map((a) => a.label);
    return [msg.title, msg.text, choices.length ? `Choices: ${choices.join(' · ')}` : ''].filter(Boolean).join('\n\n');
  }

  // A task or a crew job began for this thread (a queued job, maybe after a restart), or err: it couldn't.
  threadStarted(s, thread, by, err) {
    const { channel, ...t } = thread;
    if (err) {
      this.#say(t, `${by ? `${by.name} couldn’t start` : 'Couldn’t start'}: ${truncate(err.message, 300)}`).catch(() => {});
      return;
    }
    const hub = this.hub;
    hub.markStarted(s.id, this.name, by?.name);
    const local = hub.store.get(s.id);
    if (local) {
      local.remote = { ...local.remote, email: t };
      hub.store.save(local);
    } else this.keepAway(s.id, by?.name, { email: t });
  }
}
