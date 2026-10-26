// Connectors: MCP servers you add once in Settings, handed to every task's agent whatever the
// harness. The config keeps what they are (config.connectors); their env values and headers live
// in secrets.json, and reach the server through server/mcp-connector.js, a stdio proxy each
// harness starts by id, so a token never sits in a CLI's arguments.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanSecrets } from './secret-scan.js';
import { bad, clip, newId, VERSION } from './util.js';

export const PROXY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-connector.js');
// Copilot names tools <server>-<tool>, so a dash in the name would read as a split.
const NAME = /^[a-z0-9_]{1,40}$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
// Harnesses that take a server per turn; cursor and antigravity only read their own config.
export const REACH = ['claude', 'codex', 'copilot', 'opencode', 'grok'];
const PROBE_MS = 60_000; // npx may download the server first

export const ns = (id) => `connector:${id}`;

// "npx -y @x/server --root '/a b'" → ['npx', '-y', '@x/server', '--root', '/a b'].
export function splitCommand(line) {
  const out = [];
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

// A name from anything: "GitHub MCP" → "github_mcp".
export const slug = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);

const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
};

// What the page sees: never a secret's value, only which keys are set.
export function connectorView(c, secrets) {
  const has = (k) => secrets.get(ns(c.id), k) != null;
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
    // Signed in with OAuth (server/connector-auth.js): where, and since when.
    signedIn: c.oauth && has('oauth:access') ? { host: hostOf(c.oauth.issuer), at: c.oauth.signedInAt || null } : null,
    addedAt: c.addedAt,
  };
}

// Secret fields in a body: { KEY: 'value' } sets it, '' or null keeps a saved one.
function secretFields(input, label) {
  if (input == null) return [];
  const list = Array.isArray(input) ? input.map((x) => [x?.key, x?.value]) : Object.entries(input);
  const out = [];
  for (const [k, v] of list) {
    const key = String(k || '').trim();
    if (!key) continue;
    if (!KEY.test(key)) throw bad(`${label} name "${clip(key, 40)}" may only have letters, digits, _ and -`);
    if (out.some((x) => x.key === key)) throw bad(`${label} ${key} is there twice`);
    out.push({ key, value: v == null || v === '' ? null : String(v) });
  }
  return out;
}

// body → a connector (merged over `was`), plus the secrets to write. Throws a 400 with the reason.
export function normalizeConnector(body, list, was = null) {
  const b = body || {};
  const c = was ? structuredClone(was) : { id: newId(), enabled: true, addedAt: Date.now() };
  if (b.name !== undefined || !was) c.name = slug(b.name);
  if (!c.name) throw bad('Give it a name');
  if (!NAME.test(c.name)) throw bad('A name is up to 40 lowercase letters, digits and _');
  if (c.name === 'wisp') throw bad('wisp is the name of wisp’s own tools: pick another one');
  if (list.some((x) => x.id !== c.id && x.name === c.name)) throw bad(`There’s already a connector called ${c.name}`);
  if (b.transport !== undefined) c.transport = b.transport;
  c.transport ||= b.url ? 'remote' : 'local';
  if (!['local', 'remote'].includes(c.transport)) throw bad('transport is local or remote');
  if (b.enabled !== undefined) c.enabled = !!b.enabled;
  if (c.transport === 'local') {
    if (b.command !== undefined || b.args !== undefined) {
      // One field on the page: the whole command line. args alongside means it's already split.
      const parts = Array.isArray(b.args) ? [String(b.command || '').trim(), ...b.args.map(String)] : splitCommand(b.command);
      [c.command, ...c.args] = parts.length ? parts : [''];
      c.args ||= [];
    }
    if (!c.command) throw bad('What command starts the server? For example npx -y @modelcontextprotocol/server-filesystem ~/notes');
    delete c.url;
    delete c.oauth;
  } else {
    if (b.url !== undefined) c.url = String(b.url || '').trim();
    // A sign-in belongs to the server it was for.
    if (c.oauth && c.url !== was?.url) delete c.oauth;
    let u;
    try {
      u = new URL(c.url);
    } catch {}
    if (!u || !/^https?:$/.test(u.protocol)) throw bad('The URL of a remote server starts with https://');
    delete c.command;
    delete c.args;
  }
  // A token pasted into the command or the URL would sit in config.json: it belongs in a secret.
  const leak = scanSecrets([c.command, ...(c.args || []), c.url].filter(Boolean).join('\n'))[0];
  if (leak) throw bad(`The ${c.transport === 'local' ? 'command' : 'URL'} has ${leak.what} in it. Put it in ${c.transport === 'local' ? 'an env var' : 'a header'} instead, where it’s kept as a secret`);
  const sets = [];
  for (const [field, prefix, label] of [['env', 'env', 'Env var'], ['headers', 'header', 'Header']]) {
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

// Write a connector's secrets, and drop the ones it no longer has.
export function storeSecrets(secrets, c, sets) {
  for (const [k, v] of sets) secrets.set(ns(c.id), k, v);
  const keep = new Set([...(c.env || []).map((k) => `env:${k}`), ...(c.headers || []).map((k) => `header:${k}`), ...(c.oauth ? ['oauth:access', 'oauth:refresh', 'oauth:secret'] : [])]);
  for (const k of Object.keys(secrets.data[ns(c.id)] || {})) if (!keep.has(k)) secrets.delete(ns(c.id), k);
}

// --- What the harnesses already have in their own config, by name ---

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const readText = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};

// Just enough TOML for Codex's [mcp_servers.<name>] tables: strings, string arrays, inline tables.
export function codexServers(text) {
  const out = {};
  let cur = null;
  let sub = null;
  const str = (v) => {
    v = v.trim();
    if (v.startsWith('"')) {
      try {
        return JSON.parse(v.match(/^"(?:[^"\\]|\\.)*"/)[0]);
      } catch {
        return '';
      }
    }
    if (v.startsWith("'")) return v.slice(1, v.indexOf("'", 1));
    return v;
  };
  const strings = (v) => [...v.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => (m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2]));
  const table = (v) => Object.fromEntries([...v.matchAll(/([A-Za-z0-9_-]+|"[^"]+")\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g)].map((m) => [m[1].replace(/"/g, ''), str(m[2])]));
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const head = line.match(/^\[\s*mcp_servers\.("[^"]+"|[A-Za-z0-9_-]+)(?:\.(env|http_headers))?\s*\]/);
    if (head) {
      const name = head[1].replace(/"/g, '');
      cur = out[name] ||= {};
      sub = head[2] || null;
      continue;
    }
    if (line.startsWith('[')) {
      cur = null;
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^([A-Za-z0-9_"-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1].replace(/"/g, '');
    const val = kv[2];
    if (sub) (cur[sub] ||= {})[key] = str(val);
    else if (key === 'args') cur.args = strings(val);
    else if (key === 'env' || key === 'http_headers') cur[key] = table(val);
    else if (key === 'command' || key === 'url' || key === 'bearer_token') cur[key] = str(val);
  }
  return out;
}

const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const copilotHome = () => process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');

// Each source: the harness it belongs to, and its servers as { name: { command, args, env, url, headers } }.
function sources(cwd) {
  const home = os.homedir();
  const claude = readJson(process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json')) || {};
  const opencode = readJson(path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode', 'opencode.json')) || {};
  const fromOpencode = Object.fromEntries(
    Object.entries(opencode.mcp || {}).map(([n, s]) => [n, s?.type === 'remote' ? { url: s.url, headers: s.headers } : { command: (s?.command || [])[0], args: (s?.command || []).slice(1), env: s?.environment }]),
  );
  const codex = codexServers(readText(path.join(codexHome(), 'config.toml')));
  for (const s of Object.values(codex)) {
    s.headers = { ...s.http_headers, ...(s.bearer_token && { Authorization: `Bearer ${s.bearer_token}` }) };
  }
  return [
    { agent: 'claude', label: 'Claude Code', servers: { ...claude.mcpServers, ...(cwd && claude.projects?.[cwd]?.mcpServers), ...(cwd && readJson(path.join(cwd, '.mcp.json'))?.mcpServers) } },
    { agent: 'codex', label: 'Codex', servers: codex },
    { agent: 'copilot', label: 'Copilot', servers: readJson(path.join(copilotHome(), 'mcp-config.json'))?.mcpServers || {} },
    { agent: 'opencode', label: 'OpenCode', servers: fromOpencode },
    { agent: 'cursor', label: 'Cursor', servers: readJson(path.join(home, '.cursor', 'mcp.json'))?.mcpServers || {} },
  ];
}

// harness id → the server names its own config already has (skipped when injecting: Codex would
// merge two definitions into one broken server, Claude would list every tool twice).
export function ownNames(cwd) {
  return Object.fromEntries(sources(cwd).map((s) => [s.agent, new Set(Object.keys(s.servers || {}))]));
}

const shape = (s) => {
  const url = typeof s?.url === 'string' ? s.url : typeof s?.serverUrl === 'string' ? s.serverUrl : '';
  if (url) return { transport: 'remote', url, headers: s.headers && typeof s.headers === 'object' ? s.headers : {} };
  if (typeof s?.command !== 'string' || !s.command) return null;
  return { transport: 'local', command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [], env: s.env && typeof s.env === 'object' ? s.env : {} };
};

// Servers in the harnesses' own configs that aren't connectors yet, for the import list. With
// values (for the import itself) or without (for the page: key names only).
export function foundServers(list, { values = false } = {}) {
  const have = new Set(list.map((c) => c.name));
  const out = new Map();
  for (const src of sources(null)) {
    for (const [raw, s] of Object.entries(src.servers || {})) {
      const name = slug(raw);
      const sh = shape(s);
      if (!name || name === 'wisp' || !sh || have.has(name)) continue;
      const was = out.get(name);
      if (was) {
        if (!was.from.includes(src.label)) was.from.push(src.label);
        continue;
      }
      const secrets = sh.transport === 'local' ? sh.env : sh.headers;
      out.set(name, {
        name,
        from: [src.label],
        transport: sh.transport,
        ...(sh.transport === 'local' ? { command: sh.command, args: sh.args } : { url: sh.url }),
        [sh.transport === 'local' ? 'env' : 'headers']: values ? Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, String(v ?? '')])) : Object.keys(secrets),
      });
    }
  }
  return [...out.values()];
}

// --- Per turn ---

// The connectors one turn gets, as mcpServers entries: each starts the proxy by id. Plan mode gets
// none (their tools would run outside a read-only sandbox, already approved); a harness that has a
// server by that name in its own config keeps its own.
// bridge: wisp's own URL and token, for the proxy to ask for a signed-in connector's fresh token.
const proxyEnv = (home, bridge) => ({ ELECTRON_RUN_AS_NODE: '1', WISP_HOME: home, ...(bridge && { WISP_URL: bridge.url, WISP_TOKEN: bridge.token }) });

export function turnServers(list, { agent, mode, cwd, home, bridge }) {
  if (mode === 'plan' || !REACH.includes(agent)) return {};
  const on = (list || []).filter((c) => c.enabled !== false);
  if (!on.length) return {};
  const own = ownNames(cwd)[agent] || new Set();
  return Object.fromEntries(
    on
      .filter((c) => !own.has(c.name))
      .map((c) => [
        c.name,
        {
          command: process.execPath,
          args: [PROXY, c.id],
          // Inside the desktop app execPath is Electron; this makes it run the proxy as Node.
          env: proxyEnv(home, bridge),
        },
      ]),
  );
}

// --- Test: start it through the proxy, the way an agent would, and list its tools ---

export function probe(c, home, bridge) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PROXY, c.id], { env: { ...process.env, ...proxyEnv(home, bridge) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const tools = [];
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve({ at: Date.now(), ...result });
    };
    // The row already names it: "wisp: " and "<name>: " in front say nothing more.
    const tidy = (t) => t.replace(/^wisp: /, '').replace(`${c.name}: `, '').replace(/^./, (x) => x.toUpperCase());
    const failed = (fallback) => {
      const tail = err.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' · ');
      const error = clip(tidy(tail || fallback), 300);
      // Refused for want of a sign-in: the row offers Sign in.
      finish({ ok: false, error, ...(/needs sign-in|HTTP 40[13]/i.test(error) && { auth: true }) });
    };
    const timer = setTimeout(() => failed('It didn’t answer within a minute'), PROBE_MS);
    const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
    child.on('error', (e) => failed(e.message));
    child.on('exit', (code) => failed(`It stopped before answering (exit ${code})`));
    child.stdin.on('error', () => {});
    child.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    child.stdout.on('data', (d) => {
      out += d;
      let i;
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i).trim();
        out = out.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          if (m.error) return failed(tidy(m.error.message || 'It refused to start'));
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/list', params: {} });
        } else if (m.id >= 2) {
          if (m.error) return failed(tidy(m.error.message || 'It wouldn’t list its tools'));
          tools.push(...(m.result?.tools || []).map((t) => t.name).filter(Boolean));
          // A long list comes in pages; three are plenty to show.
          if (m.result?.nextCursor && m.id < 4) send({ id: m.id + 1, method: 'tools/list', params: { cursor: m.result.nextCursor } });
          else finish({ ok: true, tools: tools.slice(0, 200), count: tools.length });
        } else if (m.method && m.id != null) {
          send({ id: m.id, error: { code: -32601, message: 'wisp is only listing tools' } });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wisp', version: VERSION } } });
  });
}
