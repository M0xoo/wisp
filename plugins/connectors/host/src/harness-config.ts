// What the harnesses already have in their own config, by name (v1 server/connectors.js): skipped when
// a turn's servers are made (Codex would merge two definitions into one broken server, Claude would
// list every tool twice), and offered for import in Settings. Files are read async and kept by mtime,
// so a turn's lookup is a memory read (ADR-0011: nothing on the hot path blocks).

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Connector, FoundServer, Transport } from '@wisp-plugin/connectors-api';
import { slug } from './model.ts';

type Servers = Record<string, unknown>;
type Shaped = { transport: Transport; command?: string; args?: string[]; url?: string; env?: Record<string, unknown>; headers?: Record<string, unknown> };

/** Where the configs are: the user's home and the env that moves them (CLAUDE_CONFIG_DIR, CODEX_HOME, …). */
export interface Where {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Just enough TOML for Codex's [mcp_servers.<name>] tables: strings, string arrays, inline tables. */
export function codexServers(text: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  let cur: Record<string, unknown> | null = null;
  let sub: string | null = null;
  const str = (raw: string): string => {
    const v = raw.trim();
    if (v.startsWith('"')) {
      try {
        return String(JSON.parse(/^"(?:[^"\\]|\\.)*"/.exec(v)?.[0] ?? '""'));
      } catch {
        return '';
      }
    }
    if (v.startsWith("'")) return v.slice(1, v.indexOf("'", 1));
    return v;
  };
  const strings = (v: string): string[] => [...v.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => (m[1] !== undefined ? String(JSON.parse(`"${m[1]}"`)) : (m[2] ?? '')));
  const table = (v: string): Record<string, string> => Object.fromEntries([...v.matchAll(/([A-Za-z0-9_-]+|"[^"]+")\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g)].map((m) => [String(m[1]).replace(/"/g, ''), str(String(m[2]))]));
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const head = /^\[\s*mcp_servers\.("[^"]+"|[A-Za-z0-9_-]+)(?:\.(env|http_headers))?\s*\]/.exec(line);
    if (head) {
      const name = String(head[1]).replace(/"/g, '');
      cur = out[name] ||= {};
      sub = head[2] || null;
      continue;
    }
    if (line.startsWith('[')) {
      cur = null;
      continue;
    }
    if (!cur) continue;
    const kv = /^([A-Za-z0-9_"-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = String(kv[1]).replace(/"/g, '');
    const val = String(kv[2]);
    if (sub) (cur[sub] = rec(cur[sub]))[key] = str(val);
    else if (key === 'args') cur['args'] = strings(val);
    else if (key === 'env' || key === 'http_headers') cur[key] = table(val);
    else if (key === 'command' || key === 'url' || key === 'bearer_token') cur[key] = str(val);
  }
  return out;
}

/** Each config file, read once per change of its mtime. */
export class ConfigFiles {
  readonly #cache = new Map<string, { mtime: number; text: string }>();

  async text(file: string): Promise<string> {
    let mtime: number;
    try {
      mtime = (await stat(file)).mtimeMs;
    } catch {
      this.#cache.delete(file);
      return '';
    }
    const hit = this.#cache.get(file);
    if (hit && hit.mtime === mtime) return hit.text;
    const text = await readFile(file, 'utf8').catch(() => '');
    this.#cache.set(file, { mtime, text });
    return text;
  }

  async json(file: string): Promise<Record<string, unknown> | null> {
    const t = await this.text(file);
    if (!t) return null;
    try {
      return rec(JSON.parse(t));
    } catch {
      return null;
    }
  }
}

export interface Source {
  agent: string;
  label: string;
  servers: Servers;
}

/** Each source: the harness it belongs to, and its servers as { name: { command, args, env, url, headers } }. */
export async function sources(files: ConfigFiles, w: Where, cwd: string | null): Promise<Source[]> {
  const { home, env } = w;
  const claudeFile = env['CLAUDE_CONFIG_DIR'] ? path.join(env['CLAUDE_CONFIG_DIR'], '.claude.json') : path.join(home, '.claude.json');
  const [claude, opencode, codexText, copilot, cursor, project] = await Promise.all([
    files.json(claudeFile),
    files.json(path.join(env['XDG_CONFIG_HOME'] || path.join(home, '.config'), 'opencode', 'opencode.json')),
    files.text(path.join(env['CODEX_HOME'] || path.join(home, '.codex'), 'config.toml')),
    files.json(path.join(env['COPILOT_HOME'] || path.join(home, '.copilot'), 'mcp-config.json')),
    files.json(path.join(home, '.cursor', 'mcp.json')),
    cwd ? files.json(path.join(cwd, '.mcp.json')) : Promise.resolve(null),
  ]);
  const fromOpencode = Object.fromEntries(
    Object.entries(rec(opencode?.['mcp'])).map(([n, raw]) => {
      const s = rec(raw);
      const cmd = Array.isArray(s['command']) ? s['command'].map(String) : [];
      return [n, s['type'] === 'remote' ? { url: s['url'], headers: s['headers'] } : { command: cmd[0], args: cmd.slice(1), env: s['environment'] }];
    }),
  );
  const codex = codexServers(codexText);
  for (const s of Object.values(codex)) {
    s['headers'] = { ...rec(s['http_headers']), ...(s['bearer_token'] ? { Authorization: `Bearer ${String(s['bearer_token'])}` } : {}) };
  }
  const projects = rec(claude?.['projects']);
  return [
    { agent: 'claude', label: 'Claude Code', servers: { ...rec(claude?.['mcpServers']), ...(cwd ? rec(rec(projects[cwd])['mcpServers']) : {}), ...rec(project?.['mcpServers']) } },
    { agent: 'codex', label: 'Codex', servers: codex },
    { agent: 'copilot', label: 'Copilot', servers: rec(copilot?.['mcpServers']) },
    { agent: 'opencode', label: 'OpenCode', servers: fromOpencode },
    { agent: 'cursor', label: 'Cursor', servers: rec(cursor?.['mcpServers']) },
  ];
}

/** harness id → the server names its own config already has. */
export async function ownNames(files: ConfigFiles, w: Where, cwd: string | null): Promise<Record<string, Set<string>>> {
  return Object.fromEntries((await sources(files, w, cwd)).map((s) => [s.agent, new Set(Object.keys(s.servers))]));
}

function shape(raw: unknown): Shaped | null {
  const s = rec(raw);
  const url = typeof s['url'] === 'string' ? s['url'] : typeof s['serverUrl'] === 'string' ? s['serverUrl'] : '';
  if (url) return { transport: 'remote', url, headers: rec(s['headers']) };
  if (typeof s['command'] !== 'string' || !s['command']) return null;
  return { transport: 'local', command: s['command'], args: Array.isArray(s['args']) ? s['args'].map(String) : [], env: rec(s['env']) };
}

/** A found server with values, for the import itself (never sent to the page). */
export interface FoundWithValues extends Omit<FoundServer, 'env' | 'headers'> {
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

/** Servers in the harnesses' own configs that aren't connectors yet, with their secret values. */
export async function foundWithValues(files: ConfigFiles, w: Where, list: readonly Connector[]): Promise<FoundWithValues[]> {
  const have = new Set(list.map((c) => c.name));
  const out = new Map<string, FoundWithValues>();
  for (const src of await sources(files, w, null)) {
    for (const [raw, s] of Object.entries(src.servers)) {
      const name = slug(raw);
      const sh = shape(s);
      if (!name || name === 'wisp' || !sh || have.has(name)) continue;
      const was = out.get(name);
      if (was) {
        if (!was.from.includes(src.label)) was.from.push(src.label);
        continue;
      }
      const secrets = Object.fromEntries(Object.entries((sh.transport === 'local' ? sh.env : sh.headers) ?? {}).map(([k, v]) => [k, String(v ?? '')]));
      out.set(name, {
        name,
        from: [src.label],
        transport: sh.transport,
        ...(sh.transport === 'local' ? { command: sh.command ?? '', args: sh.args ?? [], env: secrets } : { url: sh.url ?? '', headers: secrets }),
      });
    }
  }
  return [...out.values()];
}

/** The same for the page: key names only. */
export async function foundServers(files: ConfigFiles, w: Where, list: readonly Connector[]): Promise<FoundServer[]> {
  return (await foundWithValues(files, w, list)).map(({ env, headers, ...f }) => ({
    ...f,
    ...(env && { env: Object.keys(env) }),
    ...(headers && { headers: Object.keys(headers) }),
  }));
}
