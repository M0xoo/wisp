// Signing in to a remote connector with OAuth, the way MCP specifies it: find the server's
// authorization server (protected resource metadata, then RFC 8414 / OpenID metadata), register
// wisp as a client on the fly (RFC 7591), send the browser to sign in with PKCE, and keep the
// tokens in secrets.json. wisp is the only one that writes them: the proxy asks for a fresh one
// (POST /internal/connectors/:id/token) instead of refreshing on its own.

import { createHash, randomBytes } from 'node:crypto';
import { bad, VERSION } from './util.js';

const TIMEOUT_MS = 15_000;
const PENDING_MS = 10 * 60_000; // a sign-in left open in the browser this long is forgotten
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function getJson(url) {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', 'mcp-protocol-version': '2025-06-18' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// RFC 8414 puts the path after the well-known part: https://h/.well-known/x/path.
const wellKnown = (base, name) => {
  const u = new URL(base);
  const p = u.pathname.replace(/\/+$/, '');
  return [...(p ? [`${u.origin}/.well-known/${name}${p}`] : []), `${u.origin}/.well-known/${name}`];
};

// Where to sign in for this MCP server: { issuer, authorize, token, register, scopes, resource }.
export async function discover(serverUrl) {
  let prm = null;
  // A 401 names its metadata in WWW-Authenticate; otherwise try the well-known places.
  try {
    const res = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wisp', version: VERSION } } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const m = /resource_metadata="([^"]+)"/.exec(res.headers.get('www-authenticate') || '');
    if (m) prm = await getJson(new URL(m[1], serverUrl).href);
    res.body?.cancel().catch(() => {});
  } catch {}
  for (const u of prm ? [] : wellKnown(serverUrl, 'oauth-protected-resource')) if ((prm = await getJson(u))) break;
  const issuer = prm?.authorization_servers?.[0] || new URL(serverUrl).origin;
  let meta = null;
  for (const u of [...wellKnown(issuer, 'oauth-authorization-server'), ...wellKnown(issuer, 'openid-configuration')]) if ((meta = await getJson(u))) break;
  // Servers from before metadata: the endpoints at their default paths (MCP 2025-03-26).
  const at = (p) => new URL(p, issuer).href;
  return {
    issuer,
    authorize: meta?.authorization_endpoint || at('/authorize'),
    token: meta?.token_endpoint || at('/token'),
    register: meta?.registration_endpoint || (meta ? null : at('/register')),
    scopes: prm?.scopes_supported || meta?.scopes_supported || [],
    resource: prm?.resource || serverUrl,
  };
}

async function postForm(url, form) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(form), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = Object.fromEntries(new URLSearchParams(text)); // GitHub-style form replies
  }
  if (!res.ok || body.error) throw bad(`The sign-in was refused: ${body.error_description || body.error || `HTTP ${res.status}`}`, 502);
  return body;
}

export function createConnectorAuth({ store, secrets, onSignedIn }) {
  const pending = new Map(); // state → { id, verifier, redirect, at }
  const ns = (id) => `connector:${id}`;

  const save = (c, tok) => {
    secrets.set(ns(c.id), 'oauth:access', tok.access_token);
    if (tok.refresh_token) secrets.set(ns(c.id), 'oauth:refresh', tok.refresh_token);
    c.oauth = { ...c.oauth, expiresAt: tok.expires_in ? Date.now() + Number(tok.expires_in) * 1000 : null, signedInAt: c.oauth.signedInAt || Date.now() };
    store.saveConfig();
  };

  return {
    // The page asks to sign in; it opens the URL this returns. redirect: where the browser comes
    // back to, on this wisp (the page's own origin, so it works through a grid too).
    async start(c, redirect) {
      if (c.transport !== 'remote') throw bad('Only a remote connector signs in; a local one takes env vars');
      const m = await discover(c.url);
      // Registered once per place the browser comes back to.
      if (c.oauth?.clientId && c.oauth.redirect === redirect && c.oauth.issuer === m.issuer) {
        c.oauth = { ...c.oauth, ...m };
      } else {
        if (!m.register) throw bad(`${new URL(m.issuer).host} doesn’t let apps register themselves, so wisp can’t sign in there. Add its API key as a header instead`);
        const res = await fetch(m.register, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ client_name: 'wisp', client_uri: 'https://trywisp.dev', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }).catch(() => null);
        const reg = res?.ok ? await res.json().catch(() => null) : null;
        if (!reg?.client_id) throw bad(`${new URL(m.issuer).host} didn’t register wisp${res ? ` (HTTP ${res.status})` : ''}. Add its API key as a header instead`, 502);
        if (reg.client_secret) secrets.set(ns(c.id), 'oauth:secret', reg.client_secret);
        else secrets.delete(ns(c.id), 'oauth:secret');
        c.oauth = { ...m, clientId: reg.client_id, redirect };
      }
      store.saveConfig();
      const verifier = b64url(randomBytes(32));
      const state = b64url(randomBytes(16));
      for (const [k, p] of pending) if (Date.now() - p.at > PENDING_MS) pending.delete(k);
      pending.set(state, { id: c.id, verifier, redirect, at: Date.now() });
      const u = new URL(c.oauth.authorize);
      const q = { response_type: 'code', client_id: c.oauth.clientId, redirect_uri: redirect, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state, resource: c.oauth.resource };
      if (c.oauth.scopes.length) q.scope = c.oauth.scopes.join(' ');
      for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
      return u.href;
    },

    // The browser came back: trade the code for tokens. Returns the connector.
    async finish({ state, code, error, error_description: why }) {
      const p = pending.get(state);
      if (!p) throw bad('This sign-in is too old or was already used. Start it again from Settings → Connectors');
      pending.delete(state);
      const c = (store.config.connectors || []).find((x) => x.id === p.id);
      if (!c?.oauth) throw bad('That connector is gone');
      if (error) throw bad(why || (error === 'access_denied' ? 'You didn’t allow it' : error));
      const secret = secrets.get(ns(c.id), 'oauth:secret');
      const tok = await postForm(c.oauth.token, { grant_type: 'authorization_code', code, redirect_uri: p.redirect, client_id: c.oauth.clientId, code_verifier: p.verifier, resource: c.oauth.resource, ...(secret && { client_secret: secret }) });
      if (!tok.access_token) throw bad('The sign-in gave no token', 502);
      c.oauth.signedInAt = null;
      save(c, tok);
      onSignedIn?.(c);
      return c;
    },

    // A token that works for the next minute at least, refreshed if it wouldn't; null: sign in again.
    async token(c, { force = false } = {}) {
      if (!c.oauth) return null;
      const access = secrets.get(ns(c.id), 'oauth:access');
      if (access && !force && (!c.oauth.expiresAt || c.oauth.expiresAt > Date.now() + 60_000)) return access;
      const refresh = secrets.get(ns(c.id), 'oauth:refresh');
      if (!refresh) return force ? null : access;
      try {
        const secret = secrets.get(ns(c.id), 'oauth:secret');
        const tok = await postForm(c.oauth.token, { grant_type: 'refresh_token', refresh_token: refresh, client_id: c.oauth.clientId, resource: c.oauth.resource, ...(secret && { client_secret: secret }) });
        save(c, tok);
        return tok.access_token;
      } catch {
        return null;
      }
    },

    signOut(c) {
      for (const k of ['oauth:access', 'oauth:refresh', 'oauth:secret']) secrets.delete(ns(c.id), k);
      delete c.oauth;
      store.saveConfig();
    },
  };
}
