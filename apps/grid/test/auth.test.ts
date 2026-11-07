// Sign-in providers (auth/providers.ts) and ID tokens (auth/jwt.ts) against fake OpenID Connect and
// GitHub servers on loopback: PKCE, state, nonce and the signature are checked, GitHub's numeric id
// is who you are, and a bad token is refused with a message.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import http from 'node:http';
import { verifyIdToken, type Jwk } from '../src/auth/jwt.ts';
import { createProviders, newFlow, type RemoteProvider } from '../src/auth/providers.ts';
import type { GridConfig } from '../src/config.ts';
import { listen } from './helpers.ts';

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwkOf = (k: KeyObject, kid: string, alg: string): Jwk => ({ ...k.export({ format: 'jwk' }), kid, alg, use: 'sig' });

function token(claims: Record<string, unknown>, { kid = 'k1', alg = 'RS256', key = rsa.privateKey, badSig = false }: { kid?: string; alg?: string; key?: KeyObject; badSig?: boolean } = {}): string {
  const head = b64({ alg, kid, typ: 'JWT' });
  const body = b64(claims);
  const data = Buffer.from(`${head}.${body}`);
  let sig = (alg === 'ES256' ? cryptoSign('sha256', data, { key, dsaEncoding: 'ieee-p1363' }) : cryptoSign('sha256', data, key)).toString('base64url');
  if (badSig) sig = sig.slice(0, -4) + (sig.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  return `${head}.${body}.${sig}`;
}

type Json = Record<string, unknown>;
const send = (res: http.ServerResponse, s: number, o: unknown): void => {
  res.writeHead(s, { 'content-type': 'application/json' });
  res.end(JSON.stringify(o));
};
const form = (req: http.IncomingMessage): Promise<string> => new Promise((r) => {
  let t = '';
  req.on('data', (d: Buffer) => (t += d));
  req.on('end', () => r(t));
});

// The issuer: discovery, keys, and a token endpoint that checks the PKCE verifier and secret.
const op = { base: '', tamper: null as Json | null, badSig: false, challenge: '', nonce: '' };
const oidcSrv = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', op.base);
  if (u.pathname === '/.well-known/openid-configuration') return send(res, 200, { issuer: op.base, authorization_endpoint: `${op.base}/authorize`, token_endpoint: `${op.base}/token`, jwks_uri: `${op.base}/jwks` });
  if (u.pathname === '/jwks') return send(res, 200, { keys: [jwkOf(rsa.publicKey, 'k1', 'RS256')] });
  if (u.pathname !== '/token') return send(res, 404, {});
  const f = new URLSearchParams(await form(req));
  if (createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') !== op.challenge || f.get('client_secret') !== 'oidc-secret') return send(res, 400, { error: 'invalid_grant' });
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: op.base, aud: 'oidc-client', sub: 'oidc-user-1', email: 'Grace@Corp.test', email_verified: true, name: 'Grace', nonce: op.nonce, iat: now, exp: now + 300, ...(op.tamper ?? {}) };
  send(res, 200, { access_token: 'at', id_token: token(claims, { badSig: op.badSig }), token_type: 'Bearer' });
});

const gh = { base: '', orgs: false };
const ghSrv = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', gh.base);
  if (u.pathname === '/login/oauth/access_token') {
    const j: unknown = JSON.parse((await form(req)) || '{}');
    return (j as Json)['code'] === 'gh1' ? send(res, 200, { access_token: 'gho_x', token_type: 'bearer' }) : send(res, 200, { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' });
  }
  if (req.headers.authorization !== 'Bearer gho_x') return send(res, 401, { message: 'Bad credentials' });
  if (u.pathname === '/user') return send(res, 200, { id: 4242, login: 'Octo-Cat', name: 'Octo Cat', avatar_url: 'https://x/a.png' });
  if (u.pathname === '/user/emails') return send(res, 200, [{ email: 'other@github.test', primary: false, verified: true }, { email: 'Octo@GitHub.test', primary: true, verified: true }]);
  if (u.pathname === '/user/orgs') return send(res, 200, [{ login: 'Wisp-Org' }]);
  send(res, 404, {});
});

op.base = await listen(oidcSrv);
gh.base = await listen(ghSrv);
after(() => {
  oidcSrv.close();
  ghSrv.close();
});

const cfgWith = (providers: Json, extra: Json = {}): Pick<GridConfig, 'auth'> => ({ auth: { dev: false, providers, signup: 'open', allow: {}, admins: [], seats: { min: 5, cap: 20, target: 0.7, everyHours: 24, holdDays: 7 }, ...extra } as GridConfig['auth'] });
const remote = (p: unknown): RemoteProvider => {
  assert.ok(p && typeof p === 'object' && 'start' in p, 'a provider that redirects');
  return p as RemoteProvider;
};
const corp = (): RemoteProvider => remote(createProviders(cfgWith({ 'oidc:corp': { issuer: op.base, clientId: 'oidc-client', clientSecret: 'oidc-secret', label: 'Corp SSO' } })).get('oidc:corp'));

async function oidcSignIn(p: RemoteProvider, { nonce }: { nonce?: string } = {}) {
  const f = newFlow();
  const at = new URL(await p.start({ redirectUri: 'http://grid/cb', ...f }));
  op.challenge = at.searchParams.get('code_challenge') ?? '';
  op.nonce = nonce ?? at.searchParams.get('nonce') ?? '';
  return { at, f, finish: () => p.finish({ code: 'c', redirectUri: 'http://grid/cb', verifier: f.verifier, nonce: f.nonce }) };
}

test('OpenID Connect: the redirect carries state, nonce and an S256 challenge; the identity comes from the checked token', async () => {
  const { at, f, finish } = await oidcSignIn(corp());
  assert.equal(at.origin + at.pathname, `${op.base}/authorize`);
  assert.equal(at.searchParams.get('state'), f.state);
  assert.equal(at.searchParams.get('nonce'), f.nonce);
  assert.equal(at.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(at.searchParams.get('code_challenge'), createHash('sha256').update(f.verifier).digest('base64url'));
  assert.deepEqual(await finish(), { provider: 'oidc:corp', subject: 'oidc-user-1', email: 'grace@corp.test', emailVerified: true, name: 'Grace', login: '', avatar: '' });
});

test('OpenID Connect: a forged signature, a wrong nonce, audience, issuer or an expired token is refused', async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const [what, set, msg] of [
    ['signature', { badSig: true }, /signature is wrong/],
    ['nonce', { tamper: { nonce: 'other' } }, /doesn’t belong to this sign-in/],
    ['audience', { tamper: { aud: 'someone-else' } }, /for another app/],
    ['issuer', { tamper: { iss: 'https://evil.example' } }, /another issuer/],
    ['expired', { tamper: { exp: now - 3600 } }, /expired/],
    ['future', { tamper: { iat: now + 3600 } }, /from the future/],
  ] as const) {
    Object.assign(op, { badSig: false, tamper: null }, set);
    const { finish } = await oidcSignIn(corp());
    await assert.rejects(finish(), msg, what);
  }
  Object.assign(op, { badSig: false, tamper: null });
});

test('OpenID Connect: a verifier that isn’t this flow’s gets nothing from the token endpoint', async () => {
  const p = corp();
  const { f } = await oidcSignIn(p);
  await assert.rejects(p.finish({ code: 'c', redirectUri: 'http://grid/cb', verifier: `${f.verifier}x`, nonce: f.nonce }), /invalid_grant/);
});

test('GitHub: the numeric id is who you are, the primary verified email, and orgs only when an allow list names some', async () => {
  const conf = { clientId: 'gh-client', clientSecret: 'gh-secret', authBase: gh.base, apiBase: gh.base };
  const p = remote(createProviders(cfgWith({ github: conf })).get('github'));
  const f = newFlow();
  const at = new URL(await p.start({ redirectUri: 'http://grid/cb', ...f }));
  assert.equal(at.searchParams.get('scope'), 'read:user user:email');
  assert.equal(at.searchParams.get('code_challenge_method'), 'S256');
  const idn = await p.finish({ code: 'gh1', redirectUri: 'http://grid/cb', verifier: f.verifier, nonce: f.nonce });
  assert.deepEqual(idn, { provider: 'github', subject: '4242', email: 'octo@github.test', emailVerified: true, name: 'Octo Cat', login: 'Octo-Cat', avatar: 'https://x/a.png', orgs: undefined });
  await assert.rejects(p.finish({ code: 'nope', redirectUri: 'http://grid/cb', verifier: f.verifier, nonce: f.nonce }), /code passed is incorrect/);
  const withOrgs = remote(createProviders(cfgWith({ github: conf }, { allow: { githubOrgs: ['wisp-org'] } })).get('github'));
  assert.match(await withOrgs.start({ redirectUri: 'http://grid/cb', ...f }), /scope=read%3Auser\+user%3Aemail\+read%3Aorg/);
  assert.deepEqual((await withOrgs.finish({ code: 'gh1', redirectUri: 'http://grid/cb', verifier: f.verifier, nonce: f.nonce })).orgs, ['wisp-org']);
});

test('createProviders: Google is an OIDC preset, dev only on a dev grid, and a bad entry fails at start', () => {
  const ps = createProviders(cfgWith({ google: { clientId: 'g', clientSecret: 's' } }, { dev: true }));
  assert.deepEqual([...ps.values()].map((p) => [p.id, p.kind, p.label]), [['google', 'oidc', 'Google'], ['dev', 'dev', 'Dev sign-in (any email)']]);
  assert.throws(() => createProviders(cfgWith({ gitlab: { clientId: 'x' } })), /unknown provider/);
  assert.throws(() => createProviders(cfgWith({ 'oidc:corp': { clientId: 'x' } })), /issuer is missing/);
  const a = newFlow();
  const b = newFlow();
  assert.notEqual(a.state, b.state);
  assert.ok(a.verifier.length >= 43, 'PKCE wants a verifier of 43+ characters');
});

test('ID tokens: ES256 verifies, an unknown kid refetches the keys once, and alg none or a mismatched key is refused', async () => {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: 'https://iss', aud: 'app', sub: 's', iat: now, exp: now + 60 };
  const ecJwks = { keys: [jwkOf(ec.publicKey, 'e1', 'ES256')] };
  const base = { issuer: 'https://iss', audience: 'app' };
  assert.equal((await verifyIdToken(token(claims, { kid: 'e1', alg: 'ES256', key: ec.privateKey }), { ...base, jwks: async () => ecJwks }))['sub'], 's');
  let fetched = 0;
  const c = await verifyIdToken(token(claims, { kid: 'e1', alg: 'ES256', key: ec.privateKey }), { ...base, jwks: async () => ({ keys: [] }), refresh: async () => (fetched++, ecJwks) });
  assert.equal(c['sub'], 's');
  assert.equal(fetched, 1);
  await assert.rejects(verifyIdToken(token(claims, { kid: 'nope' }), { ...base, jwks: async () => ecJwks }), /key the provider doesn’t publish/);
  await assert.rejects(verifyIdToken(token(claims, { kid: 'e1' }), { ...base, jwks: async () => ecJwks }), /doesn’t match its algorithm/);
  await assert.rejects(verifyIdToken(`${b64({ alg: 'none' })}.${b64(claims)}.`, { ...base, jwks: async () => ecJwks }), /none, which isn’t accepted/);
  await assert.rejects(verifyIdToken('a.b', { ...base, jwks: async () => ecJwks }), /malformed/);
  // Several audiences: azp has to be this app.
  await assert.rejects(verifyIdToken(token({ ...claims, aud: ['app', 'other'], azp: 'other' }, { kid: 'e1', alg: 'ES256', key: ec.privateKey }), { ...base, jwks: async () => ecJwks }), /for another app/);
});
