// Mail on a grid: a message to a user's secret address starts work on their box, and the reply goes
// back by email. Off unless grid.json has `mail`, and that needs `channels` (grid/inbox.js): mail
// comes in like any channel's message, held, and delivered to a box that may be asleep.
//
// Two things sit here because a box can't be trusted with them:
//   - Who a message is from. The provider's webhook is checked at this edge, and only this file
//     writes the x-wisp-mail-* headers a box goes by. They reach it over the proxy secret, beside
//     the message and never in it, so nothing a sender writes can pass for a verdict. 'pass' means
//     proved: the provider didn't fail DMARC, and a DKIM signature this grid verified itself
//     (grid/dkim.js) has d= equal to the From's domain. A message here can start an agent on someone's
//     computer, so whatever can't be proved is refused, whichever mail provider it came from.
//   - Who a box can write to. The Box secret can be read by anything on the box, so sending takes no
//     address: only a held thread, which exists once its box accepted a proved message (a 2xx), at a
//     rate, to the address that message came from. A stranger's refused mail holds nothing, so no one
//     can make themselves a target by writing in.
// The allowed sender itself is the box's own setting (server/channels/email.js).
//
// A provider is a row of INBOUND: read(raw) → null (refused), { confirm: url }, or { recipients,
// verdict, content, source, exact, named }: verdict is 'unproved' or why not, content the message,
// exact whether those are its bytes as sent, named who the provider read as its From, if it says. A
// sender is a row of OUTBOUND: send({ from, to, raw }). SES over SNS is the one of each:
//   - It signs the whole message, not a timestamp, and it's the provider with a DMARC verdict of its own.
//   - Trust comes from AWS's key, fetched from sns.<region>.amazonaws.com, or pinned in grid.json
//     (inbound.keys), and from the topic: anyone can get SNS to sign for their own topic, so a
//     signature proves nothing until TopicArn is ours. Nothing is compared to a shared secret here.
//   - SNS carries at most 150 KB of mail. Past that SES bounces it; attachments aren't kept anyway.

import { createHash, createHmac, createPublicKey, createVerify, randomBytes } from 'node:crypto';
import { scrubOut } from '../server/channels/policy.js';
import { headerFields, verifyDkim } from './dkim.js';

export const MAIL_PATH = /^\/_mail\/([a-z]+)$/;
export const FROM_HEADER = 'x-wisp-mail-from';
export const DMARC_HEADER = 'x-wisp-mail-dmarc';
export const ID_HEADER = 'x-wisp-mail-id';

const WEBHOOK_MAX = 512 * 1024;
const SIGNED_MAX_AGE_MS = 15 * 60_000; // SNS's own retries are over in seconds
const TEXT_MAX = 64 * 1024; // of what's kept of a message: the held row has 256 KB
const HTML_MAX = 128 * 1024;
const REPLY_MAX = 40 * 1024; // bytes: the box stops at 30 000 of them, and adds a line
const SUBJECT_MAX = 200;
const LINE_MAX = 78; // RFC 5322's soft limit, for a header wisp folds
const REFS_MAX = 20;
const THREADS_MAX = 100; // per user
const CERTS_MAX = 8;
const DEFAULTS = { sendPerHour: 30, threadDays: 7 };
const HOUR_MS = 60 * 60_000;

const refused = (message, status) => Object.assign(new Error(message), { status });
const MSG_ID = /^<[\x21-\x3b\x3d\x3f-\x7e]{1,250}>$/;
const ADDRESS = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

// --- reading a message ----------------------------------------------------------------------------
// A message is read as latin1, one char per byte, until a part says what its bytes are.

function splitPart(s) {
  const at = /\r?\n\r?\n/.exec(s);
  if (at) return [s.slice(0, at.index), s.slice(at.index + at[0].length)];
  return /^\r?\n/.test(s) ? ['', s.replace(/^\r?\n/, '')] : [s, ''];
}

// [[lower-case name, value]], folded lines put back. A space before the colon doesn't change the name.
function headerList(head) {
  const out = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) out.at(-1)[1] += ` ${line.trim()}`;
    else {
      const c = line.indexOf(':');
      if (c > 0) out.push([line.slice(0, c).trim().toLowerCase(), line.slice(c + 1).trim()]);
    }
  }
  return out;
}

const first = (list, name) => list.find(([n]) => n === name)?.[1] ?? '';

// `text/plain; charset="x"` → { value, charset: 'x' }.
function withParams(v) {
  const [value, ...rest] = String(v).split(';');
  const params = {};
  for (const p of rest) {
    const m = /^\s*([\w*-]+)\s*=\s*(?:"([^"]*)"|([^\s;]*))/.exec(p);
    if (m) params[m[1].toLowerCase()] = m[2] ?? m[3];
  }
  return { value: value.trim().toLowerCase(), ...params };
}

function unencode(s, cte) {
  const how = String(cte).trim().toLowerCase();
  if (how === 'base64') return Buffer.from(s.replace(/\s+/g, ''), 'base64');
  if (how === 'quoted-printable') return Buffer.from(s.replace(/=\r?\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  return Buffer.from(s, 'latin1');
}

function decodeText(buf, charset = 'utf-8') {
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

// =?charset?B|Q?…?=, in a subject. Spaces between two of them are folding.
const encodedWords = (s) =>
  String(s)
    .replace(/(\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?\s]+)\?([bq])\?([^?\s]*)\?=/gi, (_, cs, how, data) => decodeText(how.toLowerCase() === 'b' ? Buffer.from(data, 'base64') : unencode(data.replace(/_/g, ' '), 'quoted-printable'), cs));

// One part and what's inside it. Text in a part with a filename is an attachment, whatever its type.
function walk(s, out, depth) {
  const [head, body] = splitPart(s);
  walkPart(headerList(head), body, out, depth);
}

function walkPart(list, body, out, depth = 0) {
  const type = withParams(first(list, 'content-type') || 'text/plain');
  const place = withParams(first(list, 'content-disposition'));
  if (type.value.startsWith('multipart/') && type.boundary && depth < 8) {
    const mark = `--${type.boundary}`;
    const parts = [];
    let cur = null;
    for (const line of body.split(/(?<=\n)/)) {
      const t = line.replace(/\s+$/, '');
      if (t === mark || t === `${mark}--`) {
        if (cur !== null) parts.push(cur);
        cur = t === mark ? '' : null;
        if (t !== mark) break;
      } else if (cur !== null) cur += line;
    }
    if (cur !== null) parts.push(cur);
    for (const p of parts.slice(0, 50)) walk(p.replace(/\r?\n$/, ''), out, depth + 1);
    return;
  }
  const attached = place.value === 'attachment' || !!(place.filename || type.name);
  if (attached || !(type.value === 'text/plain' || type.value === 'text/html')) {
    out.attachments++;
    return;
  }
  const key = type.value === 'text/plain' ? 'text' : 'html';
  out[key] ||= decodeText(unencode(body, first(list, 'content-transfer-encoding')), type.charset);
}

// The one mailbox in a From's value, or ''. Strict on purpose: two parsers must not be able to disagree
// on who that was. So one address, no groups, no comments, and a quoted name is only ever a name; one
// with an angle bracket in it reads as an address to somebody, so that's nobody.
function mailbox(from) {
  const names = from.match(/"(?:[^"\\]|\\.)*"/g) || [];
  if (names.some((n) => /[<>]/.test(n))) return '';
  const value = names.reduce((v, n) => v.replace(n, ''), from).trim();
  const m = /^[^<>,;:()@"]*<([^<>\s]+)>$/.exec(value) || /^([^<>\s]+)$/.exec(value);
  const addr = m?.[1].toLowerCase() ?? '';
  return ADDRESS.test(addr) ? addr : '';
}

function senderOf(list) {
  const froms = list.filter(([n]) => n === 'from');
  if (froms.length !== 1) return '';
  // What wisp reads from a message appears once, or a copy added above a signed one could be read
  // in its place: a signature covers the lowest instance, and `first` takes the highest.
  return ONCE.some((name) => list.filter(([n]) => n === name).length > 1) ? '' : mailbox(froms[0][1]);
}

const ONCE = ['subject', 'date', 'message-id', 'in-reply-to', 'references'];
const ids = (v) => (String(v).match(/<[^\s<>]+>/g) || []).filter((x) => MSG_ID.test(x));

// Written by a machine: it must never get an answer, or two of them mail each other all week.
function automatic(list) {
  const auto = first(list, 'auto-submitted').toLowerCase();
  return (!!auto && auto !== 'no') || /^(bulk|junk|list|auto_reply)$/i.test(first(list, 'precedence')) || list.some(([n]) => n === 'list-id' || n === 'x-autoreply' || n === 'x-autorespond');
}

// raw (a Buffer) → what the rest of wisp reads of a message.
export function parseMail(raw) {
  const section = headerFields(Buffer.from(raw).toString('latin1'));
  const list = (section?.fields ?? []).map((f) => [f.name, f.raw.slice(f.raw.indexOf(':') + 1).split('\r\n').map((l) => l.trim()).join(' ').trim()]);
  const out = { text: '', html: '', attachments: 0 };
  if (section) walkPart(list, section.body, out);
  const claimed = list.filter(([n]) => n === 'message-id');
  const messageId = claimed.length === 1 && MSG_ID.test(claimed[0][1]) ? claimed[0][1] : '';
  return {
    from: senderOf(list),
    subject: encodedWords(first(list, 'subject')).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500),
    messageId,
    date: first(list, 'date'),
    inReplyTo: ids(first(list, 'in-reply-to'))[0] || '',
    references: ids(first(list, 'references')).slice(-REFS_MAX),
    auto: automatic(list),
    text: out.text.slice(0, TEXT_MAX),
    html: out.html.slice(0, HTML_MAX),
    attachments: out.attachments,
  };
}

// --- writing one -----------------------------------------------------------------------------------

const asciiHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);

// A plain-text message, every line of it decided here. A stray line break in a header would write a
// header of the sender's choosing, so what can't hold one is refused, and a subject is flattened.
export function composeMail({ from, to, subject, text, messageId, inReplyTo, references = [], date = new Date() }) {
  for (const h of [from, to, messageId, inReplyTo, ...references]) if (/[\r\n]/.test(h)) throw refused('A line break in a header.', 400);
  const flat = String(subject).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${asciiHeader(flat)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${messageId}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${references.join(' ')}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-replied',
    'X-Auto-Response-Suppress: All',
    '',
    Buffer.from(String(text)).toString('base64').replace(/.{76}/g, '$&\r\n'),
  ].join('\r\n');
}

// --- SES over SNS --------------------------------------------------------------------------------

const SIGNED = { Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'], SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'] };

function onSns(url, region) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === `sns.${region}.amazonaws.com` && !u.port && !u.username && !u.password ? u : null;
  } catch {
    return null;
  }
}

async function fetchKey(url) {
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`it said ${r.status}`);
  return r.text();
}

// SES's verdict in one word, and it's never 'pass': SES can refuse a message, not prove one. It says
// GRAY for a domain with no policy or p=none, gmail.com among them, aligned or not; its dkimVerdict
// never says which domain signed; and its DMARC PASS can rest on SPF, whose domain is the envelope's.
// So PASS and GRAY are 'unproved' until the webhook finds a signature by the From's own domain.
export function sesVerdict(receipt) {
  const dmarc = receipt?.dmarcVerdict?.status;
  if (dmarc === 'PASS' || dmarc === 'GRAY') return 'unproved';
  if (dmarc === 'FAIL') return 'fail';
  return dmarc ? 'failed' : 'none';
}

export function sesInbound({ topicArn, keys = [] }, { fetchCert = fetchKey, now = () => Date.now() } = {}) {
  const region = topicArn.split(':')[3];
  const pinned = keys.map((k) => createPublicKey(k));
  const certs = new Map();

  async function keysFor(url) {
    if (pinned.length) return pinned;
    if (!certs.has(url)) {
      certs.set(url, createPublicKey(await fetchCert(url)));
      if (certs.size > CERTS_MAX) certs.delete(certs.keys().next().value);
    }
    return [certs.get(url)];
  }

  // Everything that costs nothing comes first: a forged request never gets as far as a fetch.
  async function verified(raw) {
    const j = JSON.parse(raw.toString('utf8'));
    const names = SIGNED[j?.Type];
    if (!names || j.TopicArn !== topicArn || j.SignatureVersion !== '2' || typeof j.Signature !== 'string') return null;
    if (!(Math.abs(now() - Date.parse(j.Timestamp)) <= SIGNED_MAX_AGE_MS)) return null;
    const cert = onSns(j.SigningCertURL, region);
    if (!cert || !cert.pathname.endsWith('.pem')) return null;
    const present = names.filter((n) => n !== 'Subject' || j.Subject !== undefined);
    if (present.some((n) => typeof j[n] !== 'string')) return null;
    const text = present.map((n) => `${n}\n${j[n]}\n`).join('');
    for (const key of await keysFor(cert.href)) if (createVerify('RSA-SHA256').update(text, 'utf8').verify(key, j.Signature, 'base64')) return j;
    return null;
  }

  return {
    async read(raw) {
      let j;
      try {
        j = await verified(raw);
      } catch {
        return null; // unreadable, or no key to check it by: fail closed
      }
      if (!j) return null;
      if (j.Type === 'SubscriptionConfirmation') return onSns(j.SubscribeURL, region) ? { confirm: j.SubscribeURL } : null;
      let m;
      try {
        m = JSON.parse(j.Message);
      } catch {
        return null;
      }
      const action = m?.receipt?.action;
      if (m?.notificationType !== 'Received' || action?.type !== 'SNS' || typeof m.content !== 'string' || !Array.isArray(m.receipt.recipients)) return null;
      const exact = action.encoding === 'BASE64'; // UTF8 may have changed bytes a signature covers
      return { recipients: m.receipt.recipients.map(String), verdict: sesVerdict(m.receipt), source: String(m.mail?.source ?? ''), content: Buffer.from(m.content, exact ? 'base64' : 'utf8'), exact, named: m.mail?.commonHeaders?.from };
    },
    // SNS waits for this GET before it sends anything.
    confirm: (url) => fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) }),
  };
}

// SES's v2 API, raw, signed by hand (SigV4): no SDK.
export function sesSender({ region, accessKeyId, secretAccessKey, endpoint }) {
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const hmac = (k, s) => createHmac('sha256', k).update(s).digest();
  const url = new URL('/v2/email/outbound-emails', endpoint || `https://email.${region}.amazonaws.com`);
  return {
    async send({ from, to, raw }) {
      const body = JSON.stringify({ FromEmailAddress: from, Destination: { ToAddresses: [to] }, Content: { Raw: { Data: Buffer.from(raw).toString('base64') } } });
      const stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, '');
      const day = stamp.slice(0, 8);
      const scope = `${day}/${region}/ses/aws4_request`;
      const signed = 'content-type;host;x-amz-date';
      const canon = ['POST', url.pathname, '', 'content-type:application/json', `host:${url.host}`, `x-amz-date:${stamp}`, '', signed, sha(body)].join('\n');
      const key = [day, region, 'ses', 'aws4_request'].reduce(hmac, `AWS4${secretAccessKey}`);
      const signature = hmac(key, ['AWS4-HMAC-SHA256', stamp, scope, sha(canon)].join('\n')).toString('hex');
      const r = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json', 'x-amz-date': stamp, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}` } });
      if (!r.ok) throw new Error(`SES said ${r.status}`);
    },
  };
}

const INBOUND = { ses: sesInbound };
const OUTBOUND = { ses: sesSender };

// --- the grid's side -------------------------------------------------------------------------------

// Whether the provider's own reading of From, if it gave one, is the one address we read.
const sameSender = (named, from) => named == null || (Array.isArray(named) && named.length === 1 && mailbox(String(named[0])) === from);

export function createMail({ db, cfg, inbox, accounts, log = () => {}, resolveTxt }) {
  const opts = { ...DEFAULTS, ...cfg.mail };
  const provider = INBOUND[opts.inbound.provider](opts.inbound);
  const sender = OUTBOUND[opts.outbound.provider](opts.outbound);
  const domain = opts.domain.toLowerCase();
  const local = (rcpt) => {
    const at = rcpt.lastIndexOf('@');
    return rcpt.slice(at + 1).toLowerCase() === domain ? rcpt.slice(0, at).toLowerCase() : '';
  };

  // What can't be answered, or that nobody would want woken for, stops here.
  const wanted = (m, source) => !m.auto && !!source && source !== '<>' && !m.from.endsWith(`@${domain}`);

  // 'pass', or why not. d= has to be the From's domain exactly: relaxed alignment needs the public
  // suffix list, and that's a dependency. So a From on a subdomain of its signer is refused.
  async function proved(got, m) {
    if (got.verdict !== 'unproved' || !got.exact || !m.from || !sameSender(got.named, m.from)) return got.verdict;
    const domainOfFrom = m.from.slice(m.from.lastIndexOf('@') + 1);
    const signatures = await verifyDkim(got.content, { resolveTxt });
    return signatures.some((s) => s.ok && s.d === domainOfFrom) ? 'pass' : 'unproved';
  }

  // One recipient's copy.
  function take(user, m, verdict) {
    const headers = { [FROM_HEADER]: m.from, [DMARC_HEADER]: verdict, [ID_HEADER]: m.messageId };
    inbox.hold(user, 'email', Buffer.from(JSON.stringify({ messageId: m.messageId, subject: m.subject, text: m.text, html: m.html, date: m.date, inReplyTo: m.inReplyTo, references: m.references, attachments: m.attachments })), headers);
  }

  const threadsLive = () => Date.now() - opts.threadDays * 24 * HOUR_MS;

  return {
    domain,

    // The provider's webhook. Only a bad signature is an error: anything signed gets its 200, so the
    // provider stops, and an address that doesn't exist looks like any other.
    async webhook(req) {
      const raw = await inbox.read(req, WEBHOOK_MAX);
      if (!raw) return { status: 413, body: { error: 'Too big.' } };
      const got = await provider.read(raw);
      if (!got) return { status: 403, body: { error: 'Not signed.' } };
      if (got.confirm) {
        await provider.confirm(got.confirm).catch((err) => log(`grid: mail: couldn’t confirm the subscription: ${err.message}`));
        return { status: 200, body: { ok: true } };
      }
      const m = parseMail(got.content);
      const users = [...new Set(got.recipients.map(local).filter(Boolean))].map((rcpt) => {
        const hit = inbox.byAddress(rcpt);
        return hit && accounts.userById(hit.user_id);
      });
      const real = users.filter((u) => u && !u.disabled);
      // Last, so neither a stranger's guess at an address nor a forged webhook costs a DNS lookup.
      if (real.length && wanted(m, got.source)) {
        const verdict = await proved(got, m);
        for (const user of real) take(user, m, verdict);
      }
      return { status: 200, body: { ok: true } };
    },

    // A message its box accepted: from here on the box may answer it (grid/inbox.js calls this on a 2xx).
    delivered(row) {
      const h = JSON.parse(row.headers);
      if (h[DMARC_HEADER] !== 'pass' || !h[FROM_HEADER] || !h[ID_HEADER]) return;
      let refs = [];
      try {
        refs = JSON.parse(Buffer.from(row.body).toString('utf8')).references || [];
      } catch {}
      db.run('INSERT INTO mail_threads (user_id, message_id, to_addr, refs, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, message_id) DO UPDATE SET at = excluded.at', row.user_id, h[ID_HEADER], h[FROM_HEADER], JSON.stringify(refs), Date.now());
      db.run('DELETE FROM mail_threads WHERE user_id = ? AND (at < ? OR message_id NOT IN (SELECT message_id FROM mail_threads WHERE user_id = ? ORDER BY at DESC LIMIT ?))', row.user_id, threadsLive(), row.user_id, THREADS_MAX);
    },

    // A box answering a message it accepted. It says which message, never who to: the address comes
    // from the thread, and a body that tries to name one is refused rather than ignored.
    async reply(user, body) {
      const { replyTo, subject, text } = body || {};
      if (['to', 'cc', 'bcc', 'from', 'replyToAddress'].some((k) => k in (body || {}))) throw refused('A reply goes to the sender of its thread, and nowhere else.', 400);
      await inbox.delivering(user.id); // this box's first answer can get here before its own 2xx is read
      const t = db.get('SELECT * FROM mail_threads WHERE user_id = ? AND message_id = ? AND at >= ?', user.id, String(replyTo ?? ''), threadsLive());
      if (!t) throw refused('No such thread.', 404);
      if (typeof text !== 'string' || !text.trim()) throw refused('Nothing to send.', 400);
      if (Buffer.byteLength(text) > REPLY_MAX) throw refused('That’s too long for a reply.', 413);
      db.run('DELETE FROM mail_sent WHERE user_id = ? AND at < ?', user.id, Date.now() - HOUR_MS);
      if (db.get('SELECT count(*) n FROM mail_sent WHERE user_id = ?', user.id).n >= opts.sendPerHour) throw refused('Too many replies this hour.', 429);
      db.run('INSERT INTO mail_sent (user_id, at) VALUES (?, ?)', user.id, Date.now());
      const from = inbox.addressOf(user);
      const messageId = `<${randomBytes(16).toString('hex')}@${domain}>`;
      // Here as well as on the box: an agent with the Box secret doesn't go through the box's code.
      const clean = scrubOut(text).text;
      const subj = scrubOut(String(subject ?? 'Re: your message').slice(0, SUBJECT_MAX), { note: false }).text;
      const raw = composeMail({ from: `wisp <${from}>`, to: t.to_addr, subject: subj, text: clean, messageId, inReplyTo: t.message_id, references: [...JSON.parse(t.refs), t.message_id].slice(-REFS_MAX) });
      try {
        await sender.send({ from, to: t.to_addr, raw });
      } catch (err) {
        log(`grid: mail: a reply didn’t go: ${err.message}`);
        throw refused('The mail provider didn’t take it.', 502);
      }
      return { messageId };
    },
  };
}
