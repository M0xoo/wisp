// Mail on a grid: a message to a user's secret address starts work on their box, and the reply goes
// back by email. Off unless grid.json has `mail`, and that needs `channels` (inbox.ts): mail comes in
// like any channel's message, held, and delivered to a box that may be asleep.
//
// Two things sit here because a box can't be trusted with them:
//   - Who a message is from. The provider's webhook is checked at this edge, and only this file
//     writes the x-wisp-mail-* headers a box goes by. They reach it over the proxy secret, beside
//     the message and never in it, so nothing a sender writes can pass for a verdict. 'pass' means
//     proved: the provider didn't fail DMARC, and a DKIM signature this grid verified itself
//     (dkim.ts) has d= equal to the From's domain. A message here can start an agent on someone's
//     computer, so whatever can't be proved is refused, whichever mail provider it came from.
//   - Who a box can write to. The Box secret can be read by anything on the box, so sending takes no
//     address: only a held thread, which exists once its box accepted a proved message (a 2xx), at a
//     rate, to the address that message came from. A stranger's refused mail holds nothing, so no one
//     can make themselves a target by writing in.
// The allowed sender itself is the box's own setting (the channels plugin's email channel).
//
// A provider is a row of INBOUND (mail-ses.ts): read(raw) → null (refused), { confirm: url }, or a
// message with its verdict. A sender is a row of OUTBOUND: send({ from, to, raw }).

import { randomBytes } from 'node:crypto';
import { scrubOut } from '@wisp-plugin/channels-api/kit';
import type { GridConfig, MailConfig } from './config.ts';
import type { Db } from './db.ts';
import { verifyDkim, type ResolveTxt } from './dkim.ts';
import { bad, messageOf } from './errors.ts';
import type { Req } from './http.ts';
import { REFS_MAX, composeMail, mailbox, parseMail, type Mail } from './mail-parse.ts';
import { sesInbound, sesSender, type InboundProvider, type Sender } from './mail-ses.ts';
import type { ChannelInboxRow, MailThreadRow, UserRow } from './rows.ts';

export { composeMail, mailbox, parseMail } from './mail-parse.ts';
export { sesInbound, sesSender, sesVerdict } from './mail-ses.ts';

export const MAIL_PATH = /^\/_mail\/([a-z]+)$/;
export const FROM_HEADER = 'x-wisp-mail-from';
export const DMARC_HEADER = 'x-wisp-mail-dmarc';
export const ID_HEADER = 'x-wisp-mail-id';

const WEBHOOK_MAX = 512 * 1024;
const REPLY_MAX = 40 * 1024; // bytes: the box stops at 30 000 of them, and adds a line
const SUBJECT_MAX = 200;
const THREADS_MAX = 100; // per user
const DEFAULTS = { sendPerHour: 30, threadDays: 7 };
const HOUR_MS = 60 * 60_000;
const AGAIN = 'again'; // no verdict yet: only ever becomes a 503, never a header

const INBOUND: Readonly<Record<string, (o: MailConfig['inbound']) => InboundProvider>> = { ses: (o) => sesInbound({ topicArn: o.topicArn, keys: o.keys ?? [] }) };
const OUTBOUND: Readonly<Record<string, (o: MailConfig['outbound']) => Sender>> = {
  ses: (o) => sesSender({ region: o.region, accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey, endpoint: typeof o['endpoint'] === 'string' ? o['endpoint'] : undefined }),
};

/** A dev grid has no real senders, so grid.json can name their keys. Nothing else skips DNS. */
export function dkimLookup(cfg: Pick<GridConfig, 'auth'>, inbound: Pick<MailConfig['inbound'], 'dkimKeys'>): ResolveTxt | undefined {
  const keys = cfg.auth?.dev ? inbound.dkimKeys : null;
  return keys ? async (name) => [[keys[name] ?? '']] : undefined;
}

// Whether the provider's own reading of From, if it gave one, is the one address we read.
const sameSender = (named: unknown, from: string): boolean => named == null || (Array.isArray(named) && named.length === 1 && mailbox(String(named[0])) === from);

/** What of the inbox mail uses (inbox.ts). */
export interface MailInbox {
  read(req: Req, max: number): Promise<Buffer | null>;
  byAddress(local: string): { user_id: string } | null;
  hold(user: UserRow, channel: string, body: Buffer, o: { headers: Record<string, string> }): boolean;
  delivering(userId: string): Promise<void> | undefined;
  addressOf(user: UserRow): string;
}

export interface MailDeps {
  db: Db;
  cfg: GridConfig;
  inbox: MailInbox;
  accounts: { userById(id: unknown): UserRow | undefined };
  log?: (m: string) => void;
  resolveTxt?: ResolveTxt | undefined;
}

export function createMail({ db, cfg, inbox, accounts, log = () => {}, resolveTxt }: MailDeps) {
  if (!cfg.mail) throw new Error('createMail needs mail in grid.json.');
  const opts = { ...DEFAULTS, ...cfg.mail };
  const lookup = resolveTxt ?? dkimLookup(cfg, opts.inbound);
  const provider = (INBOUND[opts.inbound.provider] ?? INBOUND['ses'])?.(opts.inbound);
  const sender = (OUTBOUND[opts.outbound.provider] ?? OUTBOUND['ses'])?.(opts.outbound);
  if (!provider || !sender) throw new Error('mail: no such provider.');
  const domain = opts.domain.toLowerCase();
  const local = (rcpt: string): string => {
    const at = rcpt.lastIndexOf('@');
    return rcpt.slice(at + 1).toLowerCase() === domain ? rcpt.slice(0, at).toLowerCase() : '';
  };

  // What can't be answered, or that nobody would want woken for, stops here.
  const wanted = (m: Mail, source: string): boolean => !m.auto && !!source && source !== '<>' && !m.from.endsWith(`@${domain}`);

  // 'pass', or why not. d= has to be the From's domain exactly: relaxed alignment needs the public
  // suffix list, and that's a dependency. So a From on a subdomain of its signer is refused.
  // AGAIN when DNS didn't answer for the From's own domain: SNS has the message and we don't, so it
  // can bring it back. "No such key" is an answer, so a refusal. Only that domain: an outage elsewhere
  // can't prove anything anyway, and a sender mustn't get retries by adding a signature from a domain
  // that doesn't answer.
  async function proved(got: { verdict: string; exact: boolean; named: unknown; content: Buffer }, m: Mail): Promise<string> {
    if (got.verdict !== 'unproved' || !got.exact || !m.from || !sameSender(got.named, m.from)) return got.verdict;
    const domainOfFrom = m.from.slice(m.from.lastIndexOf('@') + 1);
    const signatures = await verifyDkim(got.content, lookup ? { resolveTxt: lookup } : {});
    const own = signatures.filter((s) => s.d === domainOfFrom);
    if (own.some((s) => s.ok)) return 'pass';
    return own.some((s) => s.dns) ? AGAIN : 'unproved';
  }

  // One recipient's copy.
  function take(user: UserRow, m: Mail, verdict: string): void {
    const headers = { [FROM_HEADER]: m.from, [DMARC_HEADER]: verdict, [ID_HEADER]: m.messageId };
    inbox.hold(user, 'email', Buffer.from(JSON.stringify({ messageId: m.messageId, subject: m.subject, text: m.text, html: m.html, date: m.date, inReplyTo: m.inReplyTo, references: m.references, attachments: m.attachments })), { headers });
  }

  const threadsLive = (): number => Date.now() - opts.threadDays * 24 * HOUR_MS;

  // The provider's webhook. A bad signature is an error, and a 503 asks for the message again while
  // DNS isn't answering. Anything else signed gets its 200, so the provider stops, and an address that
  // doesn't exist looks like any other.
  async function webhook(req: Req): Promise<{ status: number; body: Record<string, unknown> }> {
    const raw = await inbox.read(req, WEBHOOK_MAX);
    if (!raw) return { status: 413, body: { error: 'Too big.' } };
    const got = await provider?.read(raw);
    if (!got) return { status: 403, body: { error: 'Not signed.' } };
    if (got.confirm !== undefined) {
      await provider?.confirm(got.confirm).catch((err: unknown) => log(`grid: mail: couldn’t confirm the subscription: ${messageOf(err)}`));
      return { status: 200, body: { ok: true } };
    }
    const m = parseMail(got.content);
    const users = [...new Set(got.recipients.map(local).filter(Boolean))].map((rcpt) => {
      const hit = inbox.byAddress(rcpt);
      return hit ? accounts.userById(hit.user_id) : undefined;
    });
    const real = users.filter((u): u is UserRow => !!u && !u.disabled);
    // Last, so neither a stranger's guess at an address nor a forged webhook costs a DNS lookup.
    if (real.length && wanted(m, got.source)) {
      const verdict = await proved(got, m);
      if (verdict === AGAIN) return { status: 503, body: { error: 'Try again.' } };
      for (const user of real) take(user, m, verdict);
    }
    return { status: 200, body: { ok: true } };
  }

  // A message its box accepted: from here on the box may answer it (inbox.ts calls this on a 2xx).
  function delivered(row: Pick<ChannelInboxRow, 'headers' | 'body' | 'user_id'>): void {
    const h = JSON.parse(row.headers) as Record<string, string | undefined>;
    if (h[DMARC_HEADER] !== 'pass' || !h[FROM_HEADER] || !h[ID_HEADER]) return;
    let refs: unknown = [];
    try {
      refs = (JSON.parse(Buffer.from(row.body).toString('utf8')) as { references?: unknown }).references || [];
    } catch {
      // a body that isn't one of ours: no references
    }
    db.run('INSERT INTO mail_threads (user_id, message_id, to_addr, refs, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, message_id) DO UPDATE SET at = excluded.at', row.user_id, h[ID_HEADER], h[FROM_HEADER], JSON.stringify(refs), Date.now());
    db.run('DELETE FROM mail_threads WHERE user_id = ? AND (at < ? OR message_id NOT IN (SELECT message_id FROM mail_threads WHERE user_id = ? ORDER BY at DESC LIMIT ?))', row.user_id, threadsLive(), row.user_id, THREADS_MAX);
  }

  // A box answering a message it accepted. It says which message, never who to: the address comes
  // from the thread, and a body that tries to name one is refused rather than ignored.
  async function reply(user: UserRow, body: Record<string, unknown> | null): Promise<{ messageId: string }> {
    const b = body || {};
    if (['to', 'cc', 'bcc', 'from', 'replyToAddress'].some((k) => k in b)) throw bad('A reply goes to the sender of its thread, and nowhere else.', 400);
    await inbox.delivering(user.id); // this box's first answer can get here before its own 2xx is read
    const t = db.get<MailThreadRow>('SELECT * FROM mail_threads WHERE user_id = ? AND message_id = ? AND at >= ?', user.id, String(b['replyTo'] ?? ''), threadsLive());
    if (!t) throw bad('No such thread.', 404);
    const text = b['text'];
    if (typeof text !== 'string' || !text.trim()) throw bad('Nothing to send.', 400);
    if (Buffer.byteLength(text) > REPLY_MAX) throw bad('That’s too long for a reply.', 413);
    db.run('DELETE FROM mail_sent WHERE user_id = ? AND at < ?', user.id, Date.now() - HOUR_MS);
    if ((db.get<{ n: number }>('SELECT count(*) n FROM mail_sent WHERE user_id = ?', user.id)?.n ?? 0) >= opts.sendPerHour) throw bad('Too many replies this hour.', 429);
    db.run('INSERT INTO mail_sent (user_id, at) VALUES (?, ?)', user.id, Date.now());
    const from = inbox.addressOf(user);
    const messageId = `<${randomBytes(16).toString('hex')}@${domain}>`;
    // Here as well as on the box: an agent with the Box secret doesn't go through the box's code.
    const clean = scrubOut(text).text;
    const subj = scrubOut(String(b['subject'] ?? 'Re: your message').slice(0, SUBJECT_MAX), { note: false }).text;
    const raw = composeMail({ from: `wisp <${from}>`, to: t.to_addr, subject: subj, text: clean, messageId, inReplyTo: t.message_id, references: [...(JSON.parse(t.refs) as string[]), t.message_id].slice(-REFS_MAX) });
    try {
      await sender?.send({ from, to: t.to_addr, raw });
    } catch (err) {
      log(`grid: mail: a reply didn’t go: ${messageOf(err)}`);
      throw bad('The mail provider didn’t take it.', 502);
    }
    return { messageId };
  }

  return { domain, webhook, delivered, reply };
}

export type MailApi = ReturnType<typeof createMail>;
