// ID tokens (OpenID Connect): verify the signature against the provider's published keys (JWKS),
// then the claims. RS256 and ES256, with node:crypto only.

import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';

const ALGS: Record<string, { hash: string; kty: string; dsaEncoding?: 'ieee-p1363' }> = {
  RS256: { hash: 'sha256', kty: 'RSA' },
  ES256: { hash: 'sha256', kty: 'EC', dsaEncoding: 'ieee-p1363' },
};
const SKEW_S = 60;

export interface Jwk extends JsonWebKey {
  kid?: string;
  kty?: string;
}
export interface JwkSet {
  keys?: Jwk[];
}
/** The claims of an ID token: only what verifyIdToken checked is known to be of its type. */
export type Claims = Record<string, unknown>;

const part = (s: string): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // falls through to the same refusal
  }
  throw new Error('The sign-in token is malformed.');
};

export interface VerifyOptions {
  /** resolves the key set */
  jwks: () => Promise<JwkSet>;
  /** fetches it again (a key the cache doesn't know) */
  refresh?: () => Promise<JwkSet>;
  issuer: string | string[];
  audience: string;
  nonce?: string;
  now?: number;
}

async function keyFor(kid: unknown, jwks: VerifyOptions['jwks'], refresh: VerifyOptions['refresh']): Promise<Jwk> {
  let set = await jwks();
  let jwk = set.keys?.find((k) => k.kid === kid);
  if (!jwk && refresh) {
    set = await refresh();
    jwk = set.keys?.find((k) => k.kid === kid);
  }
  if (!jwk) throw new Error('The sign-in token was signed with a key the provider doesn’t publish.');
  return jwk;
}

function checkClaims(c: Claims, { issuer, audience, nonce, now = Date.now() }: VerifyOptions): void {
  const t = Math.floor(now / 1000);
  const issuers = ([] as string[]).concat(issuer);
  if (!issuers.includes(String(c['iss']))) throw new Error('The sign-in token comes from another issuer.');
  const aud = ([] as unknown[]).concat(c['aud']);
  if (!aud.includes(audience)) throw new Error('The sign-in token is for another app.');
  if (aud.length > 1 && c['azp'] && c['azp'] !== audience) throw new Error('The sign-in token is for another app.');
  const exp = c['exp'];
  const iat = c['iat'];
  if (typeof exp !== 'number' || exp + SKEW_S < t) throw new Error('The sign-in token has expired.');
  if (typeof iat === 'number' && iat - SKEW_S > t) throw new Error('The sign-in token is from the future: check this server’s clock.');
  if (nonce !== undefined && c['nonce'] !== nonce) throw new Error('The sign-in token doesn’t belong to this sign-in.');
}

export async function verifyIdToken(idToken: unknown, opts: VerifyOptions): Promise<Claims> {
  const parts = String(idToken || '').split('.');
  const [h, p, sig] = parts;
  if (parts.length !== 3 || h === undefined || p === undefined || sig === undefined) throw new Error('The sign-in token is malformed.');
  const header = part(h);
  const alg = ALGS[String(header['alg'])];
  if (!alg) throw new Error(`The sign-in token uses ${String(header['alg'])}, which isn’t accepted.`);
  const jwk = await keyFor(header['kid'], opts.jwks, opts.refresh);
  if (jwk.kty !== alg.kty) throw new Error('The sign-in token’s key doesn’t match its algorithm.');
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const ok = verify(alg.hash, Buffer.from(`${h}.${p}`), alg.dsaEncoding ? { key, dsaEncoding: alg.dsaEncoding } : key, Buffer.from(sig, 'base64url'));
  if (!ok) throw new Error('The sign-in token’s signature is wrong.');
  const c = part(p);
  checkClaims(c, opts);
  return c;
}
