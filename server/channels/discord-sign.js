// What Discord signs, read by the grid and by a cloud wisp, each with its own copy of the key:
// Ed25519 over timestamp + raw body, with the application's public key. Only node:crypto, so the
// grid gets this without the channel. A box can sleep past Discord's 3 s, so the grid answers first
// (edge), and the box checks the same bytes again rather than take the grid's word.

import { createPublicKey, verify } from 'node:crypto';

const PUBLIC_KEY = /^[0-9a-f]{64}$/i;
const SIGNATURE = /^[0-9a-f]{128}$/i;
const STAMP = /^\d{1,12}$/;
const MAX_AGE_S = 5 * 60;
const NOT_SIGNED = { status: 401, body: { error: 'invalid request signature' } };
const IN = { ping: 1, command: 2, component: 3, autocomplete: 4 };
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
// to the box. live: to the box only if it's up, and this is the answer if it isn't.
export function discordEdge({ key, raw, headers, now = Date.now() }) {
  if (!raw || !discordSigned(key, raw, headers)) return NOT_SIGNED;
  if (Math.abs(now / 1000 - Number(headers['x-signature-timestamp'])) > MAX_AGE_S) return NOT_SIGNED;
  let type;
  try {
    ({ type } = JSON.parse(raw.toString('utf8')));
  } catch {}
  if (type === IN.ping) return { status: 200, body: { type: 1 } };
  if (type === IN.command) return { status: 200, body: { type: 5 }, hold: true };
  if (type === IN.component) return { status: 200, body: { type: 6 }, hold: true };
  if (type === IN.autocomplete) return { status: 200, body: { type: 8, data: { choices: [] } }, live: true }; // never a wake for a keystroke
  return { status: 400, body: { error: 'Not an interaction wisp answers.' } };
}
