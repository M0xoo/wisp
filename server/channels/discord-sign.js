// What Discord signs, read by the grid and by a cloud wisp, each with its own copy of the key:
// Ed25519 over timestamp + raw body, with the application's public key. Only node:crypto and the
// grammar's stripFormatting (which imports nothing of wisp's), so the grid gets this without the channel. A box can sleep past Discord's 3 s, so the grid answers first
// (edge), and the box checks the same bytes again rather than take the grid's word.

import { createHmac, createPublicKey, verify } from 'node:crypto';
import { stripFormatting } from './grammar.js';

const PUBLIC_KEY = /^[0-9a-f]{64}$/i;
const SIGNATURE = /^[0-9a-f]{128}$/i;
const STAMP = /^\d{1,12}$/;
const MAX_AGE_S = 5 * 60;
const NOT_SIGNED = { status: 401, body: { error: 'invalid request signature' } };
const IN = { ping: 1, command: 2, component: 3, autocomplete: 4 };
const ephemeral = (content) => ({ status: 200, body: { type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } } });
const NOT_LINKED = ephemeral('This wisp only answers people linked to it.');
const NOT_LINKED_DM = ephemeral('This wisp only answers people linked to it. To link, use `/wisp` here with `link` and the code shown in wisp → Settings → Phone → Discord.'); // the box's own line
const BUSY = ephemeral('wisp is busy. Try again in a minute.');
const NO_CHOICES = { type: 8, data: { choices: [] } };
const PER_MINUTE = { command: 120, autocomplete: 300, link: 3 }; // apart: typing mustn't use up what /wisp has; link is per sender
const LINK = /^link\s+\d{6}$/i;

// How a box tells its grid who's linked, without saying who: keyed by the application's public key,
// which both have, so the same person is another hash on every other box.
export const linkedHash = (id, key) => createHmac('sha256', Buffer.from(String(key || ''), 'hex')).update(`discord:${id}`).digest('hex');

// The y of every point of small order, sign bit clear (libsodium's list). Node 22's verify doesn't
// check, and with one of these as the key, a single fixed signature verifies any message.
const SMALL_ORDER = new Set([
  '00'.repeat(32),
  `01${'00'.repeat(31)}`,
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  `ec${'ff'.repeat(30)}7f`,
  `ed${'ff'.repeat(30)}7f`,
  `ee${'ff'.repeat(30)}7f`,
]);

// 32 bytes of hex that can be a key at all.
export function isPublicKey(key) {
  if (typeof key !== 'string' || !PUBLIC_KEY.test(key)) return false;
  const y = Buffer.from(key, 'hex');
  y[31] &= 0x7f; // x's sign: either way it's the same point of small order
  return !SMALL_ORDER.has(y.toString('hex'));
}

// Does this body carry the signature of the key? Whatever's wrong with it, the answer is no.
export function discordSigned(key, raw, headers) {
  const sig = headers['x-signature-ed25519'];
  const stamp = headers['x-signature-timestamp'];
  if (typeof sig !== 'string' || !SIGNATURE.test(sig) || typeof stamp !== 'string' || !STAMP.test(stamp) || !isPublicKey(key)) return false;
  try {
    const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(key, 'hex').toString('base64url') }, format: 'jwk' });
    return verify(null, Buffer.concat([Buffer.from(stamp), raw]), publicKey, Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
}

// The grid's answer to a request (a row of CHANNELS in grid/inbox.js): before any wake, and the same
// words Discord would get from a box. A signature this old is someone replaying one. hold: it goes
// to the box. live: to the box only if it's up, and this is the answer if it isn't. bucket and
// perMinute: its budget; busy: the answer past a cap, as Discord wants a valid one even then.
//
// linked (the box's hashes; null from a box that sent none): anyone can run a command, and a wake for
// them would use up the ones the owner's /wisp needs (grid/inbox.js), so a stranger is answered here
// and goes no further, on no budget of the owner's. The one thing a stranger may wake the box for is a
// link code, in a DM (`/wisp link 123456`, nothing else in it), on a small budget of their own.
const linkAttempt = (d) => {
  const options = d?.data?.name === 'wisp' && Array.isArray(d.data.options) ? d.data.options : [];
  if (options.some((o) => o?.name !== 'prompt' && o?.value)) return false; // slashText puts these in front
  const prompt = options.find((o) => o?.name === 'prompt')?.value;
  return typeof prompt === 'string' && LINK.test(stripFormatting(prompt, 'discord'));
};

export function discordEdge({ key, raw, headers, linked = null, now = Date.now() }) {
  if (!raw || !discordSigned(key, raw, headers)) return NOT_SIGNED;
  if (Math.abs(now / 1000 - Number(headers['x-signature-timestamp'])) > MAX_AGE_S) return NOT_SIGNED;
  let d = null;
  try {
    d = JSON.parse(raw.toString('utf8'));
  } catch {}
  const type = d?.type;
  if (type === IN.ping) return { status: 200, body: { type: 1 } };
  const who = d?.member?.user?.id ?? d?.user?.id;
  const stranger = !!linked && !linked.includes(linkedHash(who, key));
  const budget = { bucket: 'command', perMinute: PER_MINUTE.command, busy: BUSY };
  if (type === IN.command) {
    if (!stranger) return { status: 200, body: { type: 5 }, hold: true, ...budget };
    if (d.guild_id) return NOT_LINKED;
    if (!linkAttempt(d)) return NOT_LINKED_DM;
    return { status: 200, body: { type: 5 }, hold: true, bucket: `link:${linkedHash(who, key)}`, perMinute: PER_MINUTE.link, busy: BUSY };
  }
  if (type === IN.component) return stranger ? { status: 200, body: { type: 6 } } : { status: 200, body: { type: 6 }, hold: true, ...budget };
  if (type === IN.autocomplete) {
    const none = { status: 200, body: NO_CHOICES };
    return stranger ? none : { ...none, live: true, bucket: 'autocomplete', perMinute: PER_MINUTE.autocomplete, busy: none }; // never a wake for a keystroke
  }
  return { status: 400, body: { error: 'Not an interaction wisp answers.' } };
}
