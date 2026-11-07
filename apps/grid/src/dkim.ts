// DKIM (RFC 6376, RFC 8463), checked here. A mail provider's verdict never says which domain signed,
// and an Authentication-Results line can be written by anyone, so who a message is from rests on a
// signature this file verified itself, against the key in the signer's own DNS.
//
// Built-ins only. verifyDkim never throws and never lets a doubt through: a lookup that fails, a key
// it can't read or a tag it doesn't like is { ok: false }, and the caller refuses what isn't proved.
// Bytes stay bytes: a message is read as latin1, one char per byte, so a hash sees what was signed.

import { createHash, createPublicKey, createVerify, verify as verifyRaw, type KeyObject } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { codeOf, messageOf } from './errors.ts';

const SIGNATURES_MAX = 5;
const DNS_TIMEOUT_MS = 5000;
const RSA_MIN_BITS = 1024;
// What wisp acts on: unsigned, a Subject could become the prompt, and a Date decide a message is fresh.
const MUST_SIGN = ['from', 'subject', 'date'];
const DNS_FAILED = 'DNS lookup failed';
const NO_SUCH_KEY = new Set(['ENOTFOUND', 'ENODATA']); // DNS answered: that's a result, not an outage
type Kind = 'rsa' | 'ed25519';
const KINDS: Readonly<Record<string, Kind>> = { 'rsa-sha256': 'rsa', 'ed25519-sha256': 'ed25519' };
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex'); // what comes before p= as DER
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const SELECTOR = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
const DOMAIN = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const FIELD = /^[\x21-\x39\x3b-\x7e]+[ \t]*:/;
const FWS = /[ \t\r\n]+/g;
const CRLF = '\r\n';

/** TXT records, as node:dns gives them: each record a list of strings. */
export type ResolveTxt = (name: string) => Promise<string[][]>;

const dns = new Resolver({ timeout: 2000, tries: 2 });
const lookupTxt: ResolveTxt = (name) => dns.resolveTxt(name);

export interface HeaderField {
  /** lower case */
  name: string;
  /** with its folds */
  raw: string;
}

// The one reading of a header section, for DKIM and for who a message is from: two parsers that split
// a section differently are how a second From hides. So a section ends at the first CRLFCRLF and nowhere
// else, and null, unprovable, is what's left of anything another parser could read another way: a bare
// CR or LF, a fold that's only whitespace, a line that's no header, no end to the section.
export function headerFields(s: string): { fields: HeaderField[]; body: string } | null {
  const end = s.indexOf(`${CRLF}${CRLF}`);
  if (end < 0) return null;
  const head = s.slice(0, end);
  if (/(?<!\r)\n|\r(?!\n)/.test(head)) return null;
  const fields: HeaderField[] = [];
  for (const line of head ? head.split(CRLF) : []) {
    if (/^[ \t]/.test(line)) {
      const last = fields[fields.length - 1];
      if (!last || !line.trim()) return null;
      last.raw += `${CRLF}${line}`;
    } else {
      if (!FIELD.test(line)) return null;
      fields.push({ name: line.slice(0, line.indexOf(':')).trim().toLowerCase(), raw: line });
    }
  }
  return { fields, body: s.slice(end + 4) };
}

type Tags = Map<string, string>;

// `a=1; b=2` → Map, or null: a tag twice voids the list (RFC 6376, 3.2).
function tagList(s: string): Tags | null {
  const tags: Tags = new Map();
  for (const part of s.split(';')) {
    if (!part.trim()) continue;
    const eq = part.indexOf('=');
    const name = part.slice(0, Math.max(eq, 0)).trim();
    if (!/^[a-z][a-z0-9_]*$/i.test(name) || tags.has(name)) return null;
    tags.set(name, part.slice(eq + 1).trim());
  }
  return tags;
}

function relaxedField(raw: string): string {
  const c = raw.indexOf(':');
  const value = raw.slice(c + 1).replace(/\r\n(?=[ \t])/g, '').replace(/[ \t]+/g, ' ').replace(/^ | $/g, '');
  return `${raw.slice(0, c).replace(/[ \t]+$/, '').toLowerCase()}:${value}`;
}

function simpleBody(body: string): string {
  let end = body.length;
  while (end >= 2 && body[end - 2] === '\r' && body[end - 1] === '\n') end -= 2;
  return `${body.slice(0, end)}${CRLF}`;
}

function relaxedBody(body: string): string {
  const lines = body.split(CRLF).map((l) => l.replace(/[ \t]+/g, ' ').replace(/ $/, ''));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.length ? `${lines.join(CRLF)}${CRLF}` : '';
}

// The signature's own field with b= emptied, and only b=: bh= stays.
function withoutB(raw: string): string {
  const c = raw.indexOf(':') + 1;
  const parts = raw.slice(c).split(';').map((p) => (/^[ \t\r\n]*b[ \t\r\n]*=/.test(p) ? p.slice(0, p.indexOf('=') + 1) : p));
  return raw.slice(0, c) + parts.join(';');
}

const sha256 = (s: Buffer): Buffer => createHash('sha256').update(s).digest();
const bytes = (s: string): Buffer => Buffer.from(s, 'latin1');
const tag = (tags: Tags, name: string): string => tags.get(name) ?? '';

async function askDns(name: string, resolveTxt: ResolveTxt): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, no) => {
    timer = setTimeout(no, DNS_TIMEOUT_MS, new Error('timed out'));
  });
  try {
    return await Promise.race([resolveTxt(name), late]);
  } finally {
    clearTimeout(timer);
  }
}

function readKey(kind: Kind, p: string): KeyObject | null {
  const der = Buffer.from(p, 'base64');
  if (kind === 'ed25519') return der.length === 32 ? createPublicKey({ key: Buffer.concat([ED25519_SPKI, der]), format: 'der', type: 'spki' }) : null;
  try {
    return createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    return createPublicKey({ key: der, format: 'der', type: 'pkcs1' });
  }
}

// Why this key can't vouch for this signature, or ''.
function keyProblem(tags: Tags | null, kind: Kind, d: string, iDomain: string): string {
  if (!tags) return 'no usable key';
  const v = tags.get('v');
  if (v !== undefined && v !== 'DKIM1') return 'no usable key';
  if (!tags.has('p')) return 'no usable key';
  if ((tags.get('k') ?? 'rsa') !== kind) return 'key of another type';
  const list = (name: string): string[] | undefined => tags.get(name)?.split(':').map((x) => x.trim());
  if (tags.has('h') && !list('h')?.includes('sha256')) return 'key not for sha256';
  if (tags.has('s') && !list('s')?.some((x) => x === '*' || x === 'email')) return 'key not for email';
  const flags = list('t') ?? [];
  if (flags.includes('y')) return 'key in testing mode: no better than unsigned'; // RFC 6376, 3.6.1
  if (flags.includes('s') && iDomain !== d) return 't=s: i= has to be exactly d=';
  return '';
}

interface Checked {
  kind: Kind;
  headHow: string;
  bodyHow: string;
  names: string[];
  selector: string;
  iDomain: string;
  bh: string;
  b: string;
}

// Everything a signature says about itself, checked before any hashing or lookup: a problem, or what it says.
function readSignature(tags: Tags | null, d: string, now: () => number): string | Checked {
  if (!tags) return 'bad tag list';
  for (const t of ['a', 'b', 'bh', 'd', 'h', 's']) if (!tags.get(t)) return `missing tag ${t}=`;
  if (tags.get('v') !== '1') return 'v= is not 1';
  const kind = KINDS[tag(tags, 'a')];
  if (!kind) return `algorithm ${tag(tags, 'a')} refused`;
  if (tags.has('l')) return 'l= leaves part of the body unsigned';
  const c = /^(simple|relaxed)(?:\/(simple|relaxed))?$/.exec(tags.get('c') ?? 'simple');
  if (!c) return 'unknown canonicalization';
  const q = tags.get('q');
  if (q !== undefined && !q.split(':').map((x) => x.trim()).includes('dns/txt')) return 'q= is not dns/txt';
  const names = tag(tags, 'h').split(':').map((n) => n.trim().toLowerCase());
  for (const name of MUST_SIGN) if (!names.includes(name)) return `${name} is not in h=`;
  const selector = tag(tags, 's').toLowerCase();
  if (d.length > 253 || !DOMAIN.test(d) || !SELECTOR.test(selector)) return 'bad d= or s=';
  const i = tags.get('i') ?? `@${d}`;
  const iDomain = i.slice(i.lastIndexOf('@') + 1).toLowerCase();
  if (!i.includes('@') || !(iDomain === d || iDomain.endsWith(`.${d}`))) return 'i= is outside d=';
  const t = tags.get('t');
  const x = tags.get('x');
  if (x !== undefined) {
    if (!/^\d+$/.test(x) || (t !== undefined && Number(x) < Number(t))) return 'bad x=';
    if (Math.floor(now() / 1000) > Number(x)) return 'expired';
  }
  const bh = tag(tags, 'bh').replace(FWS, '');
  const b = tag(tags, 'b').replace(FWS, '');
  if (!BASE64.test(bh) || !BASE64.test(b)) return 'bad base64';
  return { kind, headHow: c[1] ?? 'simple', bodyHow: c[2] ?? 'simple', names, selector, iDomain, bh, b };
}

// The signer's key from DNS: a problem, or the key.
async function fetchKey(s: Checked, d: string, resolveTxt: ResolveTxt): Promise<string | KeyObject> {
  let txt: unknown;
  try {
    txt = await askDns(`${s.selector}._domainkey.${d}`, resolveTxt);
  } catch (err) {
    return NO_SUCH_KEY.has(codeOf(err)) ? 'no such key' : DNS_FAILED;
  }
  if (!Array.isArray(txt) || txt.length !== 1 || !Array.isArray(txt[0])) return 'no usable key';
  const record = tagList((txt[0] as unknown[]).join(''));
  const wrong = keyProblem(record, s.kind, d, s.iDomain);
  if (wrong || !record) return wrong || 'no usable key';
  const p = tag(record, 'p').replace(FWS, '');
  if (!p) return 'key revoked';
  if (!BASE64.test(p)) return 'no usable key';
  const key = readKey(s.kind, p);
  if (key?.asymmetricKeyType !== s.kind) return 'no usable key';
  if (s.kind === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) < RSA_MIN_BITS) return `RSA key under ${RSA_MIN_BITS} bits`;
  return key;
}

// What was signed: each name in h= takes the lowest instance left of it; a name with none left adds nothing.
function signedData(field: HeaderField, fields: HeaderField[], s: Checked): Buffer {
  const left = new Map<string, HeaderField[]>();
  for (const f of fields) if (f !== field) left.set(f.name, [...(left.get(f.name) ?? []), f]);
  const canon = s.headHow === 'relaxed' ? relaxedField : (raw: string) => raw;
  let data = '';
  for (const name of s.names) {
    const f = left.get(name)?.pop();
    if (f) data += `${canon(f.raw)}${CRLF}`;
  }
  return bytes(data + canon(withoutB(field.raw)));
}

// One signature: why it fails, or ''. What costs nothing comes first, and the DNS lookup last of all.
async function problem(field: HeaderField, fields: HeaderField[], body: string, tags: Tags | null, d: string, { resolveTxt, now }: { resolveTxt: ResolveTxt; now: () => number }): Promise<string> {
  const s = readSignature(tags, d, now);
  if (typeof s === 'string') return s;
  if (!sha256(bytes(s.bodyHow === 'relaxed' ? relaxedBody(body) : simpleBody(body))).equals(Buffer.from(s.bh, 'base64'))) return 'body hash mismatch';
  const key = await fetchKey(s, d, resolveTxt);
  if (typeof key === 'string') return key;
  const data = signedData(field, fields, s);
  const signature = Buffer.from(s.b, 'base64');
  const good = s.kind === 'rsa' ? createVerify('RSA-SHA256').update(data).verify(key, signature) : verifyRaw(null, sha256(data), key, signature);
  return good ? '' : 'signature mismatch';
}

export interface DkimResult {
  d: string;
  ok: boolean;
  why: string;
  dns?: true;
}

// raw: the message's bytes. One result per signature tried, from the top: [] for a message
// with none, or whose headers can't be read one way. dns: true marks DNS not answering (a timeout,
// SERVFAIL, a refusal), the one failure a later try could turn out differently; it never makes ok
// true. Lookups run together, so 5 s is the whole wait.
export async function verifyDkim(raw: Uint8Array | string, { resolveTxt = lookupTxt, now = Date.now }: { resolveTxt?: ResolveTxt; now?: () => number } = {}): Promise<DkimResult[]> {
  const section = headerFields(Buffer.from(raw).toString('latin1'));
  if (!section) return [];
  const signatures = section.fields.filter((f) => f.name === 'dkim-signature').slice(0, SIGNATURES_MAX);
  return Promise.all(
    signatures.map(async (field): Promise<DkimResult> => {
      const tags = tagList(field.raw.slice(field.raw.indexOf(':') + 1));
      const d = tags?.get('d')?.toLowerCase() ?? '';
      try {
        const why = await problem(field, section.fields, section.body, tags, d, { resolveTxt, now });
        return { d, ok: !why, why, ...(why === DNS_FAILED && { dns: true as const }) };
      } catch (err) {
        return { d, ok: false, why: `unreadable: ${messageOf(err)}` };
      }
    }),
  );
}
