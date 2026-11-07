// Fakes for the connectors tests, all in-process: a stdio MCP server behind the proc service (it names
// a tool after $TOKEN, so a test sees the env reach it), a Streamable HTTP server and an OAuth server
// behind the net service. Nothing listens on a port and nothing spawns.

import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Child, Disposable, SpawnOptions } from '@wisp/kernel';
import plugin from '../src/index.ts';
import manifest from '../wisp-plugin.json' with { type: 'json' };
import { TestHost } from './kit/host.ts';

export const tmp = (name: string): string => mkdtempSync(path.join(tmpdir(), `wisp-conn-${name}-`));

export async function until<T>(fn: () => T | Promise<T>, what = 'condition', ms = 3000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** The stdio MCP server v1's tests wrote to a file, as a Child: answers initialize and tools/list. */
export function fakeMcpChild(env: Record<string, string | undefined>): Child {
  const out = new Set<(b: Uint8Array) => void>();
  const enc = new TextEncoder();
  let done: (r: { code: number | null; signal: string | null }) => void = () => {};
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => (done = r));
  let buf = '';
  const reply = (id: unknown, result: unknown): void => {
    const line = enc.encode(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
    queueMicrotask(() => out.forEach((f) => f(line)));
  };
  const on = (set: Set<(b: Uint8Array) => void>) => (fn: (b: Uint8Array) => void): Disposable => (set.add(fn), { dispose: () => void set.delete(fn) });
  return {
    pid: 4242,
    onStdout: on(out),
    onStderr: on(new Set()),
    write(data) {
      buf += typeof data === 'string' ? data : new TextDecoder().decode(data);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i)) as { id?: unknown; method?: string };
        buf = buf.slice(i + 1);
        if (m.method === 'initialize') reply(m.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
        if (m.method === 'tools/list') reply(m.id, { tools: [{ name: `echo_${env['TOKEN'] || 'none'}` }, { name: 'add' }] });
      }
    },
    closeStdin: () => done({ code: 0, signal: null }),
    resize: () => {},
    kill: () => done({ code: null, signal: 'SIGTERM' }),
    exited,
  };
}

export interface Spawned {
  bin: string;
  args: readonly string[];
  env: Record<string, string | undefined>;
}

export type Handler = (url: URL, init: { method: string; headers: Record<string, string>; body: string }) => Response | Promise<Response>;

/** Routes the net service's fetch to handlers by origin; anything else is a refused connection. */
export class FakeNet {
  readonly handlers = new Map<string, Handler>();
  readonly seen: { url: string; method: string; headers: Record<string, string> }[] = [];
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const method = init.method ?? 'GET';
    this.seen.push({ url, method, headers });
    const h = this.handlers.get(u.origin);
    if (!h) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    return h(u, { method, headers, body: init.body == null ? '' : String(init.body) });
  }
}

const json = (code: number, body: unknown, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json', ...headers } });

/** Streamable HTTP: JSON for initialize, an event stream for tools/list, a session id, a bearer header. */
export function remoteServer(net: FakeNet, origin = 'http://remote.test'): { url: string; seen: { method: string; auth?: string; session?: string; version?: string }[] } {
  const seen: { method: string; auth?: string; session?: string; version?: string }[] = [];
  net.handlers.set(origin, (_u, req) => {
    const h = req.headers;
    seen.push({ method: req.method, ...(h['authorization'] && { auth: h['authorization'] }), ...(h['mcp-session-id'] && { session: h['mcp-session-id'] }), ...(h['mcp-protocol-version'] && { version: h['mcp-protocol-version'] }) });
    if (req.method === 'DELETE') return new Response(null, { status: 200 });
    if (h['authorization'] !== 'Bearer t0k') return new Response(null, { status: 401 });
    const m = JSON.parse(req.body) as { id?: unknown; method?: string };
    if (m.method === 'initialize') return json(200, { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'r', version: '1' } } }, { 'mcp-session-id': 'sess-1' });
    if (m.id == null) return new Response(null, { status: 202 });
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'search' }] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
  return { url: `${origin}/mcp`, seen };
}

/** An MCP server behind OAuth: metadata, dynamic registration, PKCE, refresh. `valid` is the one token it takes. */
export function oauthServer(net: FakeNet, origin = 'http://oauth.test'): { url: string; st: { valid: string; codes: Map<string, string | null>; refreshed: number } } {
  const st = { valid: 'tok1', codes: new Map<string, string | null>(), refreshed: 0 };
  net.handlers.set(origin, (u, req) => {
    if (u.pathname === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['mcp'] });
    if (u.pathname === '/.well-known/oauth-authorization-server') return json(200, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register` });
    if (u.pathname === '/register') return json(201, { client_id: 'cid-1', ...(JSON.parse(req.body) as object) });
    if (u.pathname === '/authorize') {
      const code = `code-${st.codes.size}`;
      st.codes.set(code, u.searchParams.get('code_challenge'));
      if (u.searchParams.get('code_challenge_method') !== 'S256' || u.searchParams.get('scope') !== 'mcp') return json(400, { error: 'bad authorize' });
      return new Response(null, { status: 302, headers: { location: `${u.searchParams.get('redirect_uri')}?code=${code}&state=${u.searchParams.get('state')}` } });
    }
    if (u.pathname === '/token') {
      const f = new URLSearchParams(req.body);
      if (f.get('grant_type') === 'authorization_code') {
        const challenge = createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url');
        if (st.codes.get(f.get('code') ?? '') !== challenge) return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: st.valid, refresh_token: 'r1', expires_in: 3600 });
      }
      if (f.get('grant_type') === 'refresh_token' && f.get('refresh_token') === 'r1') {
        st.refreshed++;
        return json(200, { access_token: st.valid, expires_in: 3600 });
      }
      return json(400, { error: 'invalid_grant' });
    }
    if (u.pathname === '/mcp') {
      if (req.headers['authorization'] !== `Bearer ${st.valid}`) return new Response(null, { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` } });
      const m = JSON.parse(req.body) as { id?: unknown; method?: string };
      if (m.id == null) return new Response(null, { status: 202 });
      return json(200, { jsonrpc: '2.0', id: m.id, result: m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'o', version: '1' } } : { tools: [{ name: 'insights' }] } });
    }
    return new Response(null, { status: 404 });
  });
  return { url: `${origin}/mcp`, st };
}

export interface Booted {
  host: TestHost;
  net: FakeNet;
  spawned: Spawned[];
  sessions: Map<string, { id: string; agent: string; cwd: string; parentId?: string; ext: Record<string, unknown> }>;
}

/** wisp.connectors on the kit, with a fake proc (the fake MCP server) and net, and runtime.get. */
export async function boot(o: { secrets?: Record<string, string> } = {}): Promise<Booted> {
  const net = new FakeNet();
  const spawned: Spawned[] = [];
  const missing = new Set(['wisp-no-such-command-xyz']);
  const host = new TestHost({
    fetch: (url, init) => net.fetch(url, init),
    which: async (bin) => (missing.has(bin) ? null : `/usr/bin/${bin}`),
    spawn: (bin: string, args: readonly string[], opts?: SpawnOptions) => {
      const env = opts?.env ?? {};
      spawned.push({ bin, args, env });
      return fakeMcpChild(env);
    },
  });
  for (const [k, v] of Object.entries(o.secrets ?? {})) host.secrets.set(k, v);
  const sessions: Booted['sessions'] = new Map();
  await host.load({
    id: 'wisp.runtime',
    setup: (ctx) => ctx.command({ id: 'runtime.get', readOnly: true, run: (a: unknown) => sessions.get(String((a as { id?: unknown }).id)) ?? null }),
  });
  await host.load(plugin, manifest as Parameters<TestHost['load']>[1]);
  return { host, net, spawned, sessions };
}
