// Sign-in providers. Each one turns "send the browser here" and "it came back with a code" into an
// identity: { provider, subject, email, emailVerified, name, login, avatar, orgs? }.
//
//   google       OpenID Connect at accounts.google.com (a preset of oidc)
//   github       OAuth 2 + the REST API (GitHub has no OIDC for users); subject = the numeric id,
//                never the login, which can change
//   oidc:<name>  any OpenID Connect issuer: GitLab, Microsoft, Keycloak, Authentik, your company's
//   dev          `wisp grid dev` only: type any email (no password). Never in production.
//
// Every redirect carries state and PKCE (S256); OIDC adds a nonce checked in the ID token.

import { createHash } from 'node:crypto';
import { b64u, token } from '../secrets.js';
import { verifyIdToken } from './jwt.js';

const challenge = (verifier) => b64u(createHash('sha256').update(verifier).digest());

async function getJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { accept: 'application/json', 'user-agent': 'wisp-grid', ...opts.headers } });
  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`${new URL(url).host} answered with something that isn’t JSON (HTTP ${r.status}).`);
  }
  if (!r.ok) throw new Error(j.error_description || j.error?.message || j.message || j.error || `${new URL(url).host}: HTTP ${r.status}`);
  return j;
}

function oidc(id, { issuer, clientId, clientSecret, label, scope = 'openid email profile', fetchDiscovery }) {
  let meta = null;
  let keys = null;
  const discovery = async () => (meta ||= await (fetchDiscovery || getJson)(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`));
  const jwks = async (fresh = false) => {
    if (!keys || fresh) keys = await getJson((await discovery()).jwks_uri);
    return keys;
  };
  return {
    id,
    label,
    kind: 'oidc',
    async start({ redirectUri, state, verifier, nonce }) {
      const d = await discovery();
      const u = new URL(d.authorization_endpoint);
      u.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope, state, nonce, code_challenge: challenge(verifier), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
      return u.toString();
    },
    async finish({ code, redirectUri, verifier, nonce }) {
      const d = await discovery();
      const t = await getJson(d.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret, code_verifier: verifier }).toString(),
      });
      if (!t.id_token) throw new Error(`${label} didn’t send an ID token.`);
      const c = await verifyIdToken(t.id_token, { jwks: () => jwks(), refresh: () => jwks(true), issuer: [d.issuer, issuer], audience: clientId, nonce });
      const verified = c.email_verified === true || c.email_verified === 'true';
      return { provider: id, subject: String(c.sub), email: c.email ? String(c.email).toLowerCase() : '', emailVerified: verified, name: c.name || '', login: c.preferred_username || '', avatar: c.picture || '' };
    },
  };
}

function github(cfg) {
  const authBase = (cfg.authBase || 'https://github.com').replace(/\/$/, '');
  const apiBase = (cfg.apiBase || 'https://api.github.com').replace(/\/$/, '');
  return {
    id: 'github',
    label: 'GitHub',
    kind: 'oauth',
    async start({ redirectUri, state, verifier }) {
      const scope = ['read:user', 'user:email', ...(cfg.wantOrgs ? ['read:org'] : [])].join(' ');
      const u = new URL(`${authBase}/login/oauth/authorize`);
      u.search = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectUri, scope, state, code_challenge: challenge(verifier), code_challenge_method: 'S256', allow_signup: 'true', prompt: 'select_account' }).toString();
      return u.toString();
    },
    async finish({ code, redirectUri, verifier }) {
      const t = await getJson(`${authBase}/login/oauth/access_token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: redirectUri, code_verifier: verifier }),
      });
      if (!t.access_token) throw new Error(t.error_description || 'GitHub didn’t send an access token.');
      const auth = { authorization: `Bearer ${t.access_token}`, 'x-github-api-version': '2022-11-28' };
      const [user, emails] = await Promise.all([getJson(`${apiBase}/user`, { headers: auth }), getJson(`${apiBase}/user/emails`, { headers: auth }).catch(() => [])]);
      const primary = (Array.isArray(emails) ? emails : []).find((e) => e.primary && e.verified) || (Array.isArray(emails) ? emails : []).find((e) => e.verified);
      const orgs = cfg.wantOrgs ? (await getJson(`${apiBase}/user/orgs`, { headers: auth }).catch(() => [])).map((o) => String(o.login).toLowerCase()) : undefined;
      return { provider: 'github', subject: String(user.id), email: primary ? String(primary.email).toLowerCase() : '', emailVerified: !!primary, name: user.name || user.login, login: user.login, avatar: user.avatar_url || '', orgs };
    },
  };
}

function dev() {
  return { id: 'dev', label: 'Dev sign-in (any email)', kind: 'dev' };
}

// The providers in the config, ready to use. wantOrgs: an allow list names GitHub orgs.
export function createProviders(cfg) {
  const out = new Map();
  const wantOrgs = (cfg.auth.allow?.githubOrgs || []).length > 0;
  for (const [id, p] of Object.entries(cfg.auth.providers || {})) {
    if (id === 'github') out.set(id, github({ ...p, wantOrgs }));
    else if (id === 'google') out.set(id, oidc(id, { issuer: p.issuer || 'https://accounts.google.com', clientId: p.clientId, clientSecret: p.clientSecret, label: 'Google' }));
    else if (id.startsWith('oidc:')) {
      if (!p.issuer) throw new Error(`auth.providers.${id}: issuer is missing.`);
      out.set(id, oidc(id, { issuer: p.issuer, clientId: p.clientId, clientSecret: p.clientSecret, label: p.label || id.slice(5), scope: p.scope }));
    } else throw new Error(`auth.providers.${id}: unknown provider (github, google, or oidc:<name>).`);
  }
  if (cfg.auth.dev) out.set('dev', dev());
  return out;
}

export const newFlow = () => ({ state: token('', 24), verifier: token('', 48), nonce: token('', 24) });
