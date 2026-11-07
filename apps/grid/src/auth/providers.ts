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
import type { Identity } from '../accounts.ts';
import type { GridConfig, ProviderConfig } from '../config.ts';
import { b64u, token } from '../secrets.ts';
import { verifyIdToken, type JwkSet } from './jwt.ts';

const challenge = (verifier: string): string => b64u(createHash('sha256').update(verifier).digest());

type JsonObj = Record<string, unknown>;
const obj = (v: unknown): JsonObj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as JsonObj) : {});
const s = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

async function getJson(url: string, opts: RequestInit & { headers?: Record<string, string> } = {}): Promise<unknown> {
  const r = await fetch(url, { ...opts, headers: { accept: 'application/json', 'user-agent': 'wisp-grid', ...opts.headers } });
  const text = await r.text();
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`${new URL(url).host} answered with something that isn’t JSON (HTTP ${r.status}).`);
  }
  if (!r.ok) {
    const o = obj(j);
    throw new Error(s(o['error_description']) || s(obj(o['error'])['message']) || s(o['message']) || s(o['error']) || `${new URL(url).host}: HTTP ${r.status}`);
  }
  return j;
}

export interface StartArgs {
  redirectUri: string;
  state: string;
  verifier: string;
  nonce: string;
}
export interface FinishArgs {
  code: string;
  redirectUri: string;
  verifier: string;
  nonce: string;
}
export interface RemoteProvider {
  id: string;
  label: string;
  kind: 'oidc' | 'oauth';
  start(a: StartArgs): Promise<string>;
  finish(a: FinishArgs): Promise<Identity>;
}
export interface DevProvider {
  id: 'dev';
  label: string;
  kind: 'dev';
}
export type Provider = RemoteProvider | DevProvider;
export type Providers = Map<string, Provider>;

interface OidcOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  label: string;
  scope?: string | undefined;
}

function oidc(id: string, { issuer, clientId, clientSecret, label, scope = 'openid email profile' }: OidcOptions): RemoteProvider {
  let meta: JsonObj | null = null;
  let keys: JwkSet | null = null;
  const discovery = async (): Promise<JsonObj> => (meta ||= obj(await getJson(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)));
  const jwks = async (fresh = false): Promise<JwkSet> => {
    if (!keys || fresh) keys = obj(await getJson(s((await discovery())['jwks_uri']))) as JwkSet;
    return keys;
  };
  return {
    id,
    label,
    kind: 'oidc',
    async start({ redirectUri, state, verifier, nonce }) {
      const d = await discovery();
      const u = new URL(s(d['authorization_endpoint']));
      u.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope, state, nonce, code_challenge: challenge(verifier), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
      return u.toString();
    },
    async finish({ code, redirectUri, verifier, nonce }) {
      const d = await discovery();
      const t = obj(
        await getJson(s(d['token_endpoint']), {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret, code_verifier: verifier }).toString(),
        }),
      );
      if (!t['id_token']) throw new Error(`${label} didn’t send an ID token.`);
      const c = await verifyIdToken(t['id_token'], { jwks: () => jwks(), refresh: () => jwks(true), issuer: [s(d['issuer']), issuer], audience: clientId, nonce });
      const verified = c['email_verified'] === true || c['email_verified'] === 'true';
      return { provider: id, subject: String(c['sub']), email: c['email'] ? String(c['email']).toLowerCase() : '', emailVerified: verified, name: s(c['name']), login: s(c['preferred_username']), avatar: s(c['picture']) };
    },
  };
}

const primaryEmail = (emails: unknown): JsonObj | undefined => {
  const list = Array.isArray(emails) ? emails.map(obj) : [];
  return list.find((e) => e['primary'] && e['verified']) || list.find((e) => e['verified']);
};

function github(cfg: ProviderConfig & { wantOrgs: boolean }): RemoteProvider {
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
      const t = obj(
        await getJson(`${authBase}/login/oauth/access_token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: redirectUri, code_verifier: verifier }),
        }),
      );
      if (!t['access_token']) throw new Error(s(t['error_description']) || 'GitHub didn’t send an access token.');
      const auth = { authorization: `Bearer ${s(t['access_token'])}`, 'x-github-api-version': '2022-11-28' };
      const [rawUser, emails] = await Promise.all([getJson(`${apiBase}/user`, { headers: auth }), getJson(`${apiBase}/user/emails`, { headers: auth }).catch(() => [])]);
      const user = obj(rawUser);
      const primary = primaryEmail(emails);
      const orgList = cfg.wantOrgs ? await getJson(`${apiBase}/user/orgs`, { headers: auth }).catch(() => []) : null;
      const orgs = Array.isArray(orgList) ? orgList.map((o) => String(obj(o)['login']).toLowerCase()) : undefined;
      return { provider: 'github', subject: String(user['id']), email: primary ? String(primary['email']).toLowerCase() : '', emailVerified: !!primary, name: s(user['name']) || s(user['login']), login: s(user['login']), avatar: s(user['avatar_url']), orgs };
    },
  };
}

const dev = (): DevProvider => ({ id: 'dev', label: 'Dev sign-in (any email)', kind: 'dev' });

/** The providers in the config, ready to use. wantOrgs: an allow list names GitHub orgs. */
export function createProviders(cfg: Pick<GridConfig, 'auth'>): Providers {
  const out: Providers = new Map();
  const wantOrgs = (cfg.auth.allow?.githubOrgs || []).length > 0;
  for (const [id, p] of Object.entries(cfg.auth.providers || {})) {
    const secret = p.clientSecret ?? '';
    if (id === 'github') out.set(id, github({ ...p, wantOrgs }));
    else if (id === 'google') out.set(id, oidc(id, { issuer: p.issuer || 'https://accounts.google.com', clientId: p.clientId, clientSecret: secret, label: 'Google' }));
    else if (id.startsWith('oidc:')) {
      if (!p.issuer) throw new Error(`auth.providers.${id}: issuer is missing.`);
      out.set(id, oidc(id, { issuer: p.issuer, clientId: p.clientId, clientSecret: secret, label: p.label || id.slice(5), scope: typeof p['scope'] === 'string' ? p['scope'] : undefined }));
    } else throw new Error(`auth.providers.${id}: unknown provider (github, google, or oidc:<name>).`);
  }
  if (cfg.auth.dev) out.set('dev', dev());
  return out;
}

export const newFlow = (): { state: string; verifier: string; nonce: string } => ({ state: token('', 24), verifier: token('', 48), nonce: token('', 24) });
