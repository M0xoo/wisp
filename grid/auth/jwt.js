// ID tokens (OpenID Connect): verify the signature against the provider's published keys (JWKS),
// then the claims. RS256 and ES256, with node:crypto only.

import { createPublicKey, verify } from 'node:crypto';

const ALGS = {
  RS256: { hash: 'sha256', kty: 'RSA' },
  ES256: { hash: 'sha256', kty: 'EC', dsaEncoding: 'ieee-p1363' },
};
const SKEW_S = 60;

const part = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

// jwks() resolves the key set; refresh() fetches it again (a key the cache doesn't know).
export async function verifyIdToken(idToken, { jwks, refresh, issuer, audience, nonce, now = Date.now() }) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('The sign-in token is malformed.');
  const [h, p, sig] = parts;
  const header = part(h);
  const alg = ALGS[header.alg];
  if (!alg) throw new Error(`The sign-in token uses ${header.alg}, which isn’t accepted.`);
  let set = await jwks();
  let jwk = set.keys?.find((k) => k.kid === header.kid);
  if (!jwk && refresh) {
    set = await refresh();
    jwk = set.keys?.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error('The sign-in token was signed with a key the provider doesn’t publish.');
  if (jwk.kty !== alg.kty) throw new Error('The sign-in token’s key doesn’t match its algorithm.');
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const ok = verify(alg.hash, Buffer.from(`${h}.${p}`), alg.dsaEncoding ? { key, dsaEncoding: alg.dsaEncoding } : key, Buffer.from(sig, 'base64url'));
  if (!ok) throw new Error('The sign-in token’s signature is wrong.');
  const c = part(p);
  const t = Math.floor(now / 1000);
  const issuers = [].concat(issuer);
  if (!issuers.includes(c.iss)) throw new Error('The sign-in token comes from another issuer.');
  const aud = [].concat(c.aud);
  if (!aud.includes(audience)) throw new Error('The sign-in token is for another app.');
  if (aud.length > 1 && c.azp && c.azp !== audience) throw new Error('The sign-in token is for another app.');
  if (typeof c.exp !== 'number' || c.exp + SKEW_S < t) throw new Error('The sign-in token has expired.');
  if (typeof c.iat === 'number' && c.iat - SKEW_S > t) throw new Error('The sign-in token is from the future: check this server’s clock.');
  if (nonce !== undefined && c.nonce !== nonce) throw new Error('The sign-in token doesn’t belong to this sign-in.');
  return c;
}
