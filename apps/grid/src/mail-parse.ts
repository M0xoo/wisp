// Reading and writing a mail message for mail.ts. A message is read as latin1, one char per byte,
// until a part says what its bytes are. Strict where it decides who a message is from: two parsers
// that disagree on that are how a forged sender gets in.

import { headerFields } from './dkim.ts';
import { bad } from './errors.ts';

const TEXT_MAX = 64 * 1024; // of what's kept of a message: the held row has 256 KB
const HTML_MAX = 128 * 1024;
const LINE_MAX = 78; // RFC 5322's soft limit, for a header wisp folds
export const REFS_MAX = 20;
export const MSG_ID = /^<[\x21-\x3b\x3d\x3f-\x7e]{1,250}>$/;
const ADDRESS = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

type Header = [name: string, value: string];

function splitPart(s: string): [string, string] {
  const at = /\r?\n\r?\n/.exec(s);
  if (at) return [s.slice(0, at.index), s.slice(at.index + at[0].length)];
  return /^\r?\n/.test(s) ? ['', s.replace(/^\r?\n/, '')] : [s, ''];
}

// [[lower-case name, value]], folded lines put back. A space before the colon doesn't change the name.
function headerList(head: string): Header[] {
  const out: Header[] = [];
  for (const line of head.split(/\r?\n/)) {
    const last = out[out.length - 1];
    if (/^[ \t]/.test(line) && last) last[1] += ` ${line.trim()}`;
    else {
      const c = line.indexOf(':');
      if (c > 0) out.push([line.slice(0, c).trim().toLowerCase(), line.slice(c + 1).trim()]);
    }
  }
  return out;
}

const first = (list: Header[], name: string): string => list.find(([n]) => n === name)?.[1] ?? '';

// `text/plain; charset="x"` → { value, charset: 'x' }.
function withParams(v: string): { value: string; [param: string]: string } {
  const [value = '', ...rest] = String(v).split(';');
  const params: Record<string, string> = {};
  for (const p of rest) {
    const m = /^\s*([\w*-]+)\s*=\s*(?:"([^"]*)"|([^\s;]*))/.exec(p);
    if (m?.[1]) params[m[1].toLowerCase()] = m[2] ?? m[3] ?? '';
  }
  return { ...params, value: value.trim().toLowerCase() };
}

function unencode(s: string, cte: string): Buffer {
  const how = String(cte).trim().toLowerCase();
  if (how === 'base64') return Buffer.from(s.replace(/\s+/g, ''), 'base64');
  if (how === 'quoted-printable') return Buffer.from(s.replace(/=\r?\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  return Buffer.from(s, 'latin1');
}

function decodeText(buf: Buffer, charset = 'utf-8'): string {
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

// =?charset?B|Q?…?=, in a subject. Spaces between two of them are folding.
const encodedWords = (s: string): string =>
  String(s)
    .replace(/(\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?\s]+)\?([bq])\?([^?\s]*)\?=/gi, (_, cs: string, how: string, data: string) => decodeText(how.toLowerCase() === 'b' ? Buffer.from(data, 'base64') : unencode(data.replace(/_/g, ' '), 'quoted-printable'), cs));

interface Found {
  text: string;
  html: string;
  attachments: number;
}

// One part and what's inside it. Text in a part with a filename is an attachment, whatever its type.
function walk(s: string, out: Found, depth: number): void {
  const [head, body] = splitPart(s);
  walkPart(headerList(head), body, out, depth);
}

function multipart(body: string, boundary: string): string[] {
  const mark = `--${boundary}`;
  const parts: string[] = [];
  let cur: string | null = null;
  for (const line of body.split(/(?<=\n)/)) {
    const t = line.replace(/\s+$/, '');
    if (t === mark || t === `${mark}--`) {
      if (cur !== null) parts.push(cur);
      cur = t === mark ? '' : null;
      if (t !== mark) break;
    } else if (cur !== null) cur += line;
  }
  if (cur !== null) parts.push(cur);
  return parts;
}

function walkPart(list: Header[], body: string, out: Found, depth = 0): void {
  const type = withParams(first(list, 'content-type') || 'text/plain');
  const place = withParams(first(list, 'content-disposition'));
  const boundary = type['boundary'];
  if (type.value.startsWith('multipart/') && boundary && depth < 8) {
    for (const p of multipart(body, boundary).slice(0, 50)) walk(p.replace(/\r?\n$/, ''), out, depth + 1);
    return;
  }
  const attached = place.value === 'attachment' || !!(place['filename'] || type['name']);
  if (attached || !(type.value === 'text/plain' || type.value === 'text/html')) {
    out.attachments++;
    return;
  }
  const key = type.value === 'text/plain' ? 'text' : 'html';
  out[key] ||= decodeText(unencode(body, first(list, 'content-transfer-encoding')), type['charset']);
}

// The one mailbox in a From's value, or ''. Strict on purpose: two parsers must not be able to disagree
// on who that was. So one address, no groups, no comments, and a quoted name is only ever a name; one
// with an angle bracket in it reads as an address to somebody, so that's nobody.
export function mailbox(from: string): string {
  const names = from.match(/"(?:[^"\\]|\\.)*"/g) || [];
  if (names.some((n) => /[<>]/.test(n))) return '';
  const value = names.reduce((v, n) => v.replace(n, ''), from).trim();
  const m = /^[^<>,;:()@"]*<([^<>\s]+)>$/.exec(value) || /^([^<>\s]+)$/.exec(value);
  const addr = m?.[1]?.toLowerCase() ?? '';
  return ADDRESS.test(addr) ? addr : '';
}

const ONCE = ['subject', 'date', 'message-id', 'in-reply-to', 'references'];

function senderOf(list: Header[]): string {
  const froms = list.filter(([n]) => n === 'from');
  if (froms.length !== 1 || !froms[0]) return '';
  // What wisp reads from a message appears once, or a copy added above a signed one could be read
  // in its place: a signature covers the lowest instance, and `first` takes the highest.
  return ONCE.some((name) => list.filter(([n]) => n === name).length > 1) ? '' : mailbox(froms[0][1]);
}

const ids = (v: string): string[] => (String(v).match(/<[^\s<>]+>/g) || []).filter((x) => MSG_ID.test(x));

// Written by a machine: it must never get an answer, or two of them mail each other all week.
function automatic(list: Header[]): boolean {
  const auto = first(list, 'auto-submitted').toLowerCase();
  return (!!auto && auto !== 'no') || /^(bulk|junk|list|auto_reply)$/i.test(first(list, 'precedence')) || list.some(([n]) => n === 'list-id' || n === 'x-autoreply' || n === 'x-autorespond');
}

export interface Mail {
  from: string;
  subject: string;
  messageId: string;
  date: string;
  inReplyTo: string;
  references: string[];
  auto: boolean;
  text: string;
  html: string;
  attachments: number;
}

/** raw (the message's bytes) → what the rest of wisp reads of a message. */
export function parseMail(raw: Uint8Array | string): Mail {
  const section = headerFields(Buffer.from(raw).toString('latin1'));
  const list: Header[] = (section?.fields ?? []).map((f) => [f.name, f.raw.slice(f.raw.indexOf(':') + 1).split('\r\n').map((l) => l.trim()).join(' ').trim()]);
  const out: Found = { text: '', html: '', attachments: 0 };
  if (section) walkPart(list, section.body, out);
  const claimed = list.filter(([n]) => n === 'message-id');
  const one = claimed.length === 1 ? (claimed[0]?.[1] ?? '') : '';
  return {
    from: senderOf(list),
    subject: encodedWords(first(list, 'subject')).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500),
    messageId: MSG_ID.test(one) ? one : '',
    date: first(list, 'date'),
    inReplyTo: ids(first(list, 'in-reply-to'))[0] || '',
    references: ids(first(list, 'references')).slice(-REFS_MAX),
    auto: automatic(list),
    text: out.text.slice(0, TEXT_MAX),
    html: out.html.slice(0, HTML_MAX),
    attachments: out.attachments,
  };
}

const asciiHeader = (s: string): string => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);

// `Name: <id> <id>`, wrapped so no line gets long: a thread's ids can run to thousands of characters.
function foldIds(name: string, list: readonly string[]): string {
  const lines = [`${name}:`];
  for (const id of list) {
    const last = lines[lines.length - 1] ?? '';
    if (last.length + 1 + id.length > LINE_MAX && last !== `${name}:`) lines.push(` ${id}`);
    else lines[lines.length - 1] = `${last} ${id}`;
  }
  return lines.join('\r\n');
}

export interface Compose {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  inReplyTo: string;
  references?: readonly string[];
  date?: Date;
}

// A plain-text message, every line of it decided here. A stray line break in a header would write a
// header of the sender's choosing, so what can't hold one is refused, and a subject is flattened.
export function composeMail({ from, to, subject, text, messageId, inReplyTo, references = [], date = new Date() }: Compose): string {
  for (const h of [from, to, messageId, inReplyTo, ...references]) if (/[\r\n]/.test(h)) throw bad('A line break in a header.', 400);
  const flat = String(subject).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${asciiHeader(flat)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${messageId}`,
    `In-Reply-To: ${inReplyTo}`,
    foldIds('References', references),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-replied',
    'X-Auto-Response-Suppress: All',
    '',
    Buffer.from(String(text)).toString('base64').replace(/.{76}/g, '$&\r\n'),
  ].join('\r\n');
}
