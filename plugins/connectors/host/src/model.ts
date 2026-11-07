// What a connector is and how a body becomes one (v1 server/connectors.js, the pure part). Every check
// keeps v1's words: the page shows them as they are.

import { randomUUID } from 'node:crypto';
import type { Connector, ConnectorView, Transport } from '@wisp-plugin/connectors-api';
import { scanSecrets } from './secret-scan.ts';

// Copilot names tools <server>-<tool>, so a dash in the name would read as a split.
const NAME = /^[a-z0-9_]{1,40}$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/** An error the HTTP adapter answers with `status` and its message (v1 util.bad). */
export class Bad extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
    this.code = status === 404 ? 'not_found' : status >= 500 ? 'unavailable' : 'invalid';
  }
}
export const bad = (msg: string, status = 400): Bad => new Bad(msg, status);

export const newId = (): string => randomUUID().replace(/-/g, '').slice(0, 12);

export function clip(s: unknown, n = 80): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Secret keys of a connector, as the secrets service names them. */
export const secretKey = (id: string, k: string): string => `connector:${id}:${k}`;
export const secretPrefix = (id: string): string => `connector:${id}:`;

/** "npx -y @x/server --root '/a b'" → ['npx', '-y', '@x/server', '--root', '/a b']. */
export function splitCommand(line: unknown): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = '';
  let any = false;
  for (const ch of String(line || '').trim()) {
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      any = true;
    } else if (/\s/.test(ch)) {
      if (cur || any) out.push(cur);
      cur = '';
      any = false;
    } else cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

/** A name from anything: "GitHub MCP" → "github_mcp". */
export const slug = (s: unknown): string =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);

export const hostOf = (u: string | undefined): string => {
  try {
    return new URL(String(u)).host;
  } catch {
    return '';
  }
};

/** What the page sees: never a secret's value, only which keys are set. `has(k)`: is `env:KEY` set. */
export function connectorView(c: Connector, has: (k: string) => boolean): Omit<ConnectorView, 'own' | 'testing'> {
  return {
    id: c.id,
    name: c.name,
    transport: c.transport,
    command: c.command || '',
    args: c.args || [],
    url: c.url || '',
    env: (c.env || []).map((key) => ({ key, set: has(`env:${key}`) })),
    headers: (c.headers || []).map((key) => ({ key, set: has(`header:${key}`) })),
    enabled: c.enabled !== false,
    test: c.test || null,
    // Signed in with OAuth: where, and since when.
    signedIn: c.oauth && has('oauth:access') ? { host: hostOf(c.oauth.issuer), at: c.oauth.signedInAt || null } : null,
    addedAt: c.addedAt,
  };
}

interface Field {
  key: string;
  value: string | null;
}

// Secret fields in a body: { KEY: 'value' } sets it, '' or null keeps a saved one.
function secretFields(input: unknown, label: string): Field[] {
  if (input == null) return [];
  const list: [unknown, unknown][] = Array.isArray(input)
    ? input.map((x: unknown) => {
        const o = (x && typeof x === 'object' ? x : {}) as { key?: unknown; value?: unknown };
        return [o.key, o.value];
      })
    : Object.entries(input as Record<string, unknown>);
  const out: Field[] = [];
  for (const [k, v] of list) {
    const key = String(k || '').trim();
    if (!key) continue;
    if (!KEY.test(key)) throw bad(`${label} name "${clip(key, 40)}" may only have letters, digits, _ and -`);
    if (out.some((x) => x.key === key)) throw bad(`${label} ${key} is there twice`);
    out.push({ key, value: v == null || v === '' ? null : String(v) });
  }
  return out;
}

export type Body = Record<string, unknown>;

function applyLocal(c: Connector, b: Body): void {
  if (b['command'] !== undefined || b['args'] !== undefined) {
    // One field on the page: the whole command line. args alongside means it's already split.
    const args = b['args'];
    const parts = Array.isArray(args) ? [String(b['command'] || '').trim(), ...args.map(String)] : splitCommand(b['command']);
    const [command = '', ...rest] = parts.length ? parts : [''];
    c.command = command;
    c.args = rest;
  }
  c.args ||= [];
  if (!c.command) throw bad('What command starts the server? For example npx -y @modelcontextprotocol/server-filesystem ~/notes');
  delete c.url;
  delete c.oauth;
}

function applyRemote(c: Connector, b: Body, was: Connector | null): void {
  if (b['url'] !== undefined) c.url = String(b['url'] || '').trim();
  // A sign-in belongs to the server it was for.
  if (c.oauth && c.url !== was?.url) delete c.oauth;
  let u: URL | undefined;
  try {
    u = new URL(String(c.url));
  } catch {
    u = undefined;
  }
  if (!u || !/^https?:$/.test(u.protocol)) throw bad('The URL of a remote server starts with https://');
  delete c.command;
  delete c.args;
}

/** body → a connector (merged over `was`), plus the secrets to write ([key, value]). Throws a 400 with the reason. */
export function normalizeConnector(body: unknown, list: readonly Connector[], was: Connector | null = null, now = Date.now()): { connector: Connector; sets: [string, string][] } {
  const b = (body && typeof body === 'object' ? body : {}) as Body;
  const c: Connector = was ? structuredClone(was) : { id: newId(), name: '', transport: 'local', env: [], headers: [], enabled: true, addedAt: now };
  if (b['name'] !== undefined || !was) c.name = slug(b['name']);
  if (!c.name) throw bad('Give it a name');
  if (!NAME.test(c.name)) throw bad('A name is up to 40 lowercase letters, digits and _');
  if (c.name === 'wisp') throw bad('wisp is the name of wisp’s own tools: pick another one');
  if (list.some((x) => x.id !== c.id && x.name === c.name)) throw bad(`There’s already a connector called ${c.name}`);
  const t = b['transport'];
  const transport: unknown = t !== undefined && t !== null && t !== '' ? t : was ? c.transport : b['url'] ? 'remote' : 'local';
  if (transport !== 'local' && transport !== 'remote') throw bad('transport is local or remote');
  c.transport = transport satisfies Transport;
  if (b['enabled'] !== undefined) c.enabled = !!b['enabled'];
  if (c.transport === 'local') applyLocal(c, b);
  else applyRemote(c, b, was);
  // A token pasted into the command or the URL would sit in the store: it belongs in a secret.
  const leak = scanSecrets([c.command, ...(c.args || []), c.url].filter(Boolean).join('\n'))[0];
  if (leak) throw bad(`The ${c.transport === 'local' ? 'command' : 'URL'} has ${leak.what} in it. Put it in ${c.transport === 'local' ? 'an env var' : 'a header'} instead, where it’s kept as a secret`);
  const sets: [string, string][] = [];
  for (const [field, prefix, label] of [['env', 'env', 'Env var'], ['headers', 'header', 'Header']] as const) {
    if (b[field] === undefined) {
      c[field] ||= [];
      continue;
    }
    const fields = secretFields(b[field], label);
    c[field] = fields.map((f) => f.key);
    // A key with no value stays unset (an agent names the keys; the user fills them in).
    for (const f of fields) if (f.value !== null) sets.push([`${prefix}:${f.key}`, f.value]);
  }
  if (c.transport === 'local') c.headers = [];
  else c.env = [];
  return { connector: c, sets };
}

/** The secret keys a connector keeps (`env:K`, `header:K`, its OAuth ones): every other one of its goes. */
export function keptKeys(c: Connector): Set<string> {
  return new Set([...(c.env || []).map((k) => `env:${k}`), ...(c.headers || []).map((k) => `header:${k}`), ...(c.oauth ? ['oauth:access', 'oauth:refresh', 'oauth:secret'] : [])]);
}
