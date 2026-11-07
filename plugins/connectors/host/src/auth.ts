// Signing in to a remote connector with OAuth, the way MCP specifies it (v1 server/connector-auth.js):
// find the server's authorization server (protected resource metadata, then RFC 8414 / OpenID
// metadata), register wisp as a client on the fly (RFC 7591), send the browser to sign in with PKCE,
// and keep the tokens as secrets. wisp is the only one that writes them: the proxy asks for a fresh
// one (`connectors.token`) instead of refreshing on its own.

import { createHash, randomBytes } from 'node:crypto';
import type { Connector, OAuthMeta } from '@wisp-plugin/connectors-api';
import { bad } from './model.ts';

const TIMEOUT_MS = 15_000;
const PENDING_MS = 10 * 60_000; // a sign-in left open in the browser this long is forgotten
const b64url = (buf: Buffer): string => buf.toString('base64url');

type Fetch = (url: string, init?: RequestInit & { timeoutMs?: number }) => Promise<Response>;
type Obj = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

async function getJson(fetch: Fetch, url: string): Promise<Obj | null> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', 'mcp-protocol-version': '2025-06-18' }, timeoutMs: TIMEOUT_MS });
    if (!res.ok) return null;
    const j: unknown = await res.json();
    return j && typeof j === 'object' ? (j as Obj) : null;
  } catch {
    return null;
  }
}

// RFC 8414 puts the path after the well-known part: https://h/.well-known/x/path.
function wellKnown(base: string, name: string): string[] {
  const u = new URL(base);
  const p = u.pathname.replace(/\/+$/, '');
  return [...(p ? [`${u.origin}/.well-known/${name}${p}`] : []), `${u.origin}/.well-known/${name}`];
}

async function firstJson(fetch: Fetch, urls: string[]): Promise<Obj | null> {
  for (const u of urls) {
    const j = await getJson(fetch, u);
    if (j) return j;
  }
  return null;
}

/** Where to sign in for this MCP server. */
export async function discover(fetch: Fetch, serverUrl: string, version: string): Promise<OAuthMeta> {
  let prm: Obj | null = null;
  // A 401 names its metadata in WWW-Authenticate; otherwise try the well-known places.
  try {
    const res = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wisp', version } } }),
      timeoutMs: TIMEOUT_MS,
    });
    const m = /resource_metadata="([^"]+)"/.exec(res.headers.get('www-authenticate') || '');
    if (m?.[1]) prm = await getJson(fetch, new URL(m[1], serverUrl).href);
    await res.body?.cancel().catch(() => {});
  } catch {
    // unreachable now: the well-known places may still answer
  }
  prm ??= await firstJson(fetch, wellKnown(serverUrl, 'oauth-protected-resource'));
  const servers = prm?.['authorization_servers'];
  const issuer = (Array.isArray(servers) && str(servers[0])) || new URL(serverUrl).origin;
  const meta = await firstJson(fetch, [...wellKnown(issuer, 'oauth-authorization-server'), ...wellKnown(issuer, 'openid-configuration')]);
  // Servers from before metadata: the endpoints at their default paths (MCP 2025-03-26).
  const at = (p: string): string => new URL(p, issuer).href;
  const scopes = prm?.['scopes_supported'] ?? meta?.['scopes_supported'];
  return {
    issuer,
    authorize: str(meta?.['authorization_endpoint']) ?? at('/authorize'),
    token: str(meta?.['token_endpoint']) ?? at('/token'),
    register: str(meta?.['registration_endpoint']) ?? (meta ? null : at('/register')),
    scopes: Array.isArray(scopes) ? scopes.map(String) : [],
    resource: str(prm?.['resource']) ?? serverUrl,
  };
}

async function postForm(fetch: Fetch, url: string, form: Record<string, string>): Promise<Obj> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(form), timeoutMs: TIMEOUT_MS });
  const text = await res.text();
  let body: Obj;
  try {
    body = JSON.parse(text) as Obj;
  } catch {
    body = Object.fromEntries(new URLSearchParams(text)); // GitHub-style form replies
  }
  if (!res.ok || body['error']) throw bad(`The sign-in was refused: ${String(body['error_description'] || body['error'] || `HTTP ${res.status}`)}`, 502);
  return body;
}

/** What auth needs of the connectors plugin: its secrets and a way to save a connector's row. */
export interface AuthDeps {
  fetch: Fetch;
  now(): number;
  version: string;
  secret(id: string, k: string): Promise<string | undefined>;
  setSecret(id: string, k: string, v: string): Promise<void>;
  dropSecret(id: string, k: string): Promise<void>;
  find(id: string): Connector | undefined;
  save(c: Connector): void;
}

interface Pending {
  id: string;
  verifier: string;
  redirect: string;
  at: number;
}

const OAUTH_KEYS = ['oauth:access', 'oauth:refresh', 'oauth:secret'] as const;

export class ConnectorAuth {
  readonly #d: AuthDeps;
  readonly #pending = new Map<string, Pending>();

  constructor(d: AuthDeps) {
    this.#d = d;
  }

  async #saveTokens(c: Connector, tok: Obj): Promise<void> {
    const d = this.#d;
    await d.setSecret(c.id, 'oauth:access', String(tok['access_token']));
    if (tok['refresh_token']) await d.setSecret(c.id, 'oauth:refresh', String(tok['refresh_token']));
    const oauth = c.oauth as OAuthMeta;
    c.oauth = { ...oauth, expiresAt: tok['expires_in'] ? d.now() + Number(tok['expires_in']) * 1000 : null, signedInAt: oauth.signedInAt || d.now() };
    d.save(c);
  }

  async #register(c: Connector, m: OAuthMeta, redirect: string): Promise<OAuthMeta> {
    const d = this.#d;
    if (!m.register) throw bad(`${new URL(m.issuer).host} doesn’t let apps register themselves, so wisp can’t sign in there. Add its API key as a header instead`);
    const res = await d
      .fetch(m.register, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ client_name: 'wisp', client_uri: 'https://trywisp.dev', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
        timeoutMs: TIMEOUT_MS,
      })
      .catch(() => null);
    const reg = res?.ok ? ((await res.json().catch(() => null)) as Obj | null) : null;
    const clientId = str(reg?.['client_id']);
    if (!clientId) throw bad(`${new URL(m.issuer).host} didn’t register wisp${res ? ` (HTTP ${res.status})` : ''}. Add its API key as a header instead`, 502);
    if (reg?.['client_secret']) await d.setSecret(c.id, 'oauth:secret', String(reg['client_secret']));
    else await d.dropSecret(c.id, 'oauth:secret');
    return { ...m, clientId, redirect };
  }

  /** The page asks to sign in; it opens the URL this returns. redirect: where the browser comes back to. */
  async start(c: Connector, redirect: string): Promise<string> {
    const d = this.#d;
    if (c.transport !== 'remote') throw bad('Only a remote connector signs in; a local one takes env vars');
    const m = await discover(d.fetch, c.url ?? '', d.version);
    // Registered once per place the browser comes back to.
    if (c.oauth?.clientId && c.oauth.redirect === redirect && c.oauth.issuer === m.issuer) c.oauth = { ...c.oauth, ...m };
    else c.oauth = await this.#register(c, m, redirect);
    d.save(c);
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(16));
    for (const [k, p] of this.#pending) if (d.now() - p.at > PENDING_MS) this.#pending.delete(k);
    this.#pending.set(state, { id: c.id, verifier, redirect, at: d.now() });
    const o = c.oauth;
    const u = new URL(o.authorize);
    const q: Record<string, string> = { response_type: 'code', client_id: o.clientId ?? '', redirect_uri: redirect, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state, resource: o.resource };
    if (o.scopes.length) q['scope'] = o.scopes.join(' ');
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    return u.href;
  }

  /** The browser came back: trade the code for tokens. Returns the connector. */
  async finish(q: Record<string, string>): Promise<Connector> {
    const d = this.#d;
    const p = this.#pending.get(q['state'] ?? '');
    if (!p) throw bad('This sign-in is too old or was already used. Start it again from Settings → Connectors');
    this.#pending.delete(q['state'] ?? '');
    const c = d.find(p.id);
    if (!c?.oauth) throw bad('That connector is gone');
    if (q['error']) throw bad(q['error_description'] || (q['error'] === 'access_denied' ? 'You didn’t allow it' : q['error']));
    const secret = await d.secret(c.id, 'oauth:secret');
    const tok = await postForm(d.fetch, c.oauth.token, { grant_type: 'authorization_code', code: q['code'] ?? '', redirect_uri: p.redirect, client_id: c.oauth.clientId ?? '', code_verifier: p.verifier, resource: c.oauth.resource, ...(secret && { client_secret: secret }) });
    if (!tok['access_token']) throw bad('The sign-in gave no token', 502);
    c.oauth.signedInAt = null;
    await this.#saveTokens(c, tok);
    return c;
  }

  /** A token that works for the next minute at least, refreshed if it wouldn't; null: sign in again. */
  async token(c: Connector, { force = false }: { force?: boolean } = {}): Promise<string | null> {
    const d = this.#d;
    if (!c.oauth) return null;
    const access = (await d.secret(c.id, 'oauth:access')) ?? null;
    if (access && !force && (!c.oauth.expiresAt || c.oauth.expiresAt > d.now() + 60_000)) return access;
    const refresh = await d.secret(c.id, 'oauth:refresh');
    if (!refresh) return force ? null : access;
    try {
      const secret = await d.secret(c.id, 'oauth:secret');
      const tok = await postForm(d.fetch, c.oauth.token, { grant_type: 'refresh_token', refresh_token: refresh, client_id: c.oauth.clientId ?? '', resource: c.oauth.resource, ...(secret && { client_secret: secret }) });
      await this.#saveTokens(c, tok);
      return String(tok['access_token']);
    } catch {
      return null;
    }
  }

  async signOut(c: Connector): Promise<void> {
    for (const k of OAUTH_KEYS) await this.#d.dropSecret(c.id, k);
    delete c.oauth;
    this.#d.save(c);
  }
}
