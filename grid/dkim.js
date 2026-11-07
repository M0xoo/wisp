// DKIM (RFC 6376, RFC 8463), checked here. A mail provider's verdict never says which domain signed,
// and an Authentication-Results line can be written by anyone, so who a message is from rests on a
// signature this file verified itself, against the key in the signer's own DNS.
//
// Built-ins only. verifyDkim never throws and never lets a doubt through: a lookup that fails, a key
// it can't read or a tag it doesn't like is { ok: false }, and the caller refuses what isn't proved.
// Bytes stay bytes: a message is read as latin1, one char per byte, so a hash sees what was signed.

import { createHash, createPublicKey, createVerify, verify as verifyRaw } from 'node:crypto';
import { Resolver } from 'node:dns/promises';

const SIGNATURES_MAX = 5;
const DNS_TIMEOUT_MS = 5000;
const RSA_MIN_BITS = 1024;
const KINDS = { 'rsa-sha256': 'rsa', 'ed25519-sha256': 'ed25519' };
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex'); // what comes before p= as DER
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const SELECTOR = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
const DOMAIN = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const FIELD = /^[\x21-\x39\x3b-\x7e]+[ \t]*:/;
const FWS = /[ \t\r\n]+/g;
const CRLF = '\r\n';

const dns = new Resolver({ timeout: 2000, tries: 2 });
const lookupTxt = (name) => dns.resolveTxt(name);

// The one reading of a header section, for DKIM and for who a message is from: two parsers that split
// a section differently are how a second From hides. So a section ends at the first CRLFCRLF and nowhere
// else, and null, unprovable, is what's left of anything another parser could read another way: a bare
// CR or LF, a fold that's only whitespace, a line that's no header, no end to the section.
// { fields: [{ name (lower case), raw (with its folds) }], body } or null.
export function headerFields(s) {
  const end = s.indexOf(`${CRLF}${CRLF}`);
  if (end < 0) return null;
  const head = s.slice(0, end);
  if (/(?<!\r)\n|\r(?!\n)/.test(head)) return null;
  const fields = [];
  for (const line of head ? head.split(CRLF) : []) {
    if (/^[ \t]/.test(line)) {
      if (!fields.length || !line.trim()) return null;
      fields.at(-1).raw += `${CRLF}${line}`;
    } else {
      if (!FIELD.test(line)) return null;
      fields.push({ name: line.slice(0, line.indexOf(':')).trim().toLowerCase(), raw: line });
    }
  }
  return { fields, body: s.slice(end + 4) };
}

// `a=1; b=2` → Map, or null: a tag twice voids the list (RFC 6376, 3.2).
function tagList(s) {
  const tags = new Map();
  for (const part of s.split(';')) {
    if (!part.trim()) continue;
    const eq = part.indexOf('=');
    const name = part.slice(0, Math.max(eq, 0)).trim();
    if (!/^[a-z][a-z0-9_]*$/i.test(name) || tags.has(name)) return null;
    tags.set(name, part.slice(eq + 1).trim());
  }
  return tags;
}

function relaxedField(raw) {
  const c = raw.indexOf(':');
  const value = raw.slice(c + 1).replace(/\r\n(?=[ \t])/g, '').replace(/[ \t]+/g, ' ').replace(/^ | $/g, '');
  return `${raw.slice(0, c).replace(/[ \t]+$/, '').toLowerCase()}:${value}`;
}

function simpleBody(body) {
  let end = body.length;
  while (end >= 2 && body[end - 2] === '\r' && body[end - 1] === '\n') end -= 2;
  return `${body.slice(0, end)}${CRLF}`;
}

function relaxedBody(body) {
  const lines = body.split(CRLF).map((l) => l.replace(/[ \t]+/g, ' ').replace(/ $/, ''));
  while (lines.length && !lines.at(-1)) lines.pop();
  return lines.length ? `${lines.join(CRLF)}${CRLF}` : '';
}

// The signature's own field with b= emptied, and only b=: bh= stays.
function withoutB(raw) {
  const c = raw.indexOf(':') + 1;
  const parts = raw.slice(c).split(';').map((p) => (/^[ \t\r\n]*b[ \t\r\n]*=/.test(p) ? p.slice(0, p.indexOf('=') + 1) : p));
  return raw.slice(0, c) + parts.join(';');
}

const sha256 = (s) => createHash('sha256').update(s).digest();
const bytes = (s) => Buffer.from(s, 'latin1');

async function askDns(name, resolveTxt) {
  let timer;
  const late = new Promise((_, no) => {
    timer = setTimeout(no, DNS_TIMEOUT_MS, new Error('timed out'));
  });
  try {
    return await Promise.race([resolveTxt(name), late]);
  } finally {
    clearTimeout(timer);
  }
}

function readKey(kind, p) {
  const der = Buffer.from(p, 'base64');
  if (kind === 'ed25519') return der.length === 32 ? createPublicKey({ key: Buffer.concat([ED25519_SPKI, der]), format: 'der', type: 'spki' }) : null;
  try {
    return createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    return createPublicKey({ key: der, format: 'der', type: 'pkcs1' });
  }
}

// Why this key can't vouch for this signature, or ''.
function keyProblem(tags, kind, d, iDomain) {
  if (!tags) return 'no usable key';
  const v = tags.get('v');
  if (v !== undefined && v !== 'DKIM1') return 'no usable key';
  if (!tags.has('p')) return 'no usable key';
  if ((tags.get('k') ?? 'rsa') !== kind) return 'key of another type';
  const list = (name) => tags.get(name)?.split(':').map((x) => x.trim());
  if (tags.has('h') && !list('h').includes('sha256')) return 'key not for sha256';
  if (tags.has('s') && !list('s').some((x) => x === '*' || x === 'email')) return 'key not for email';
  const flags = list('t') ?? [];
  if (flags.includes('y')) return 'key in testing mode: no better than unsigned'; // RFC 6376, 3.6.1
  if (flags.includes('s') && iDomain !== d) return 't=s: i= has to be exactly d=';
  return '';
}

// One signature: why it fails, or ''. What costs nothing comes first, and the DNS lookup last of all.
async function problem(field, fields, body, tags, d, { resolveTxt, now }) {
  if (!tags) return 'bad tag list';
  for (const t of ['a', 'b', 'bh', 'd', 'h', 's']) if (!tags.get(t)) return `missing tag ${t}=`;
  if (tags.get('v') !== '1') return 'v= is not 1';
  const kind = KINDS[tags.get('a')];
  if (!kind) return `algorithm ${tags.get('a')} refused`;
  if (tags.has('l')) return 'l= leaves part of the body unsigned';
  const c = /^(simple|relaxed)(?:\/(simple|relaxed))?$/.exec(tags.get('c') ?? 'simple');
  if (!c) return 'unknown canonicalization';
  const [headHow, bodyHow] = [c[1], c[2] ?? 'simple'];
  if (tags.has('q') && !tags.get('q').split(':').map((x) => x.trim()).includes('dns/txt')) return 'q= is not dns/txt';
  const names = tags.get('h').split(':').map((n) => n.trim().toLowerCase());
  if (!names.includes('from')) return 'from is not in h=';
  const selector = tags.get('s').toLowerCase();
  if (d.length > 253 || !DOMAIN.test(d) || !SELECTOR.test(selector)) return 'bad d= or s=';
  const i = tags.get('i') ?? `@${d}`;
  const iDomain = i.slice(i.lastIndexOf('@') + 1).toLowerCase();
  if (!i.includes('@') || !(iDomain === d || iDomain.endsWith(`.${d}`))) return 'i= is outside d=';
  const [t, x] = [tags.get('t'), tags.get('x')];
  if (x !== undefined) {
    if (!/^\d+$/.test(x) || (t !== undefined && Number(x) < Number(t))) return 'bad x=';
    if (Math.floor(now() / 1000) > Number(x)) return 'expired';
  }
  const [bh, b] = [tags.get('bh').replace(FWS, ''), tags.get('b').replace(FWS, '')];
  if (!BASE64.test(bh) || !BASE64.test(b)) return 'bad base64';
  if (!sha256(bytes(bodyHow === 'relaxed' ? relaxedBody(body) : simpleBody(body))).equals(Buffer.from(bh, 'base64'))) return 'body hash mismatch';

  let txt;
  try {
    txt = await askDns(`${selector}._domainkey.${d}`, resolveTxt);
  } catch {
    return 'DNS lookup failed';
  }
  if (!Array.isArray(txt) || txt.length !== 1 || !Array.isArray(txt[0])) return 'no usable key';
  const record = tagList(txt[0].join(''));
  const wrong = keyProblem(record, kind, d, iDomain);
  if (wrong) return wrong;
  const p = record.get('p').replace(FWS, '');
  if (!p) return 'key revoked';
  if (!BASE64.test(p)) return 'no usable key';
  const key = readKey(kind, p);
  if (key?.asymmetricKeyType !== kind) return 'no usable key';
  if (kind === 'rsa' && key.asymmetricKeyDetails.modulusLength < RSA_MIN_BITS) return `RSA key under ${RSA_MIN_BITS} bits`;

  // Each name in h= takes the lowest instance left of it; a name with none left adds nothing.
  const left = new Map();
  for (const f of fields) if (f !== field) left.set(f.name, [...(left.get(f.name) ?? []), f]);
  const canon = headHow === 'relaxed' ? relaxedField : (raw) => raw;
  let data = '';
  for (const name of names) {
    const f = left.get(name)?.pop();
    if (f) data += `${canon(f.raw)}${CRLF}`;
  }
  data = bytes(data + canon(withoutB(field.raw)));
  const signature = Buffer.from(b, 'base64');
  const good = kind === 'rsa' ? createVerify('RSA-SHA256').update(data).verify(key, signature) : verifyRaw(null, sha256(data), key, signature);
  return good ? '' : 'signature mismatch';
}

// raw: the message's bytes. [{ d, ok, why }], one per signature tried, from the top: [] for a message
// with none, or whose headers can't be read one way. Lookups run together, so 5 s is the whole wait.
export async function verifyDkim(raw, { resolveTxt = lookupTxt, now = Date.now } = {}) {
  const section = headerFields(Buffer.from(raw).toString('latin1'));
  if (!section) return [];
  const signatures = section.fields.filter((f) => f.name === 'dkim-signature').slice(0, SIGNATURES_MAX);
  return Promise.all(
    signatures.map(async (field) => {
      const tags = tagList(field.raw.slice(field.raw.indexOf(':') + 1));
      const d = tags?.get('d')?.toLowerCase() ?? '';
      try {
        const why = await problem(field, section.fields, section.body, tags, d, { resolveTxt, now });
        return { d, ok: !why, why };
      } catch (err) {
        return { d, ok: false, why: `unreadable: ${err.message}` };
      }
    }),
  );
}
