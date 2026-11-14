// Settings → Connectors' pure helpers (v1 web/js/features/connectors.js): command lines, pasted
// configs, names, a row's status. No DOM, no client: tested as tables.

import type { ConnectorBody, ConnectorView, FoundServer, SecretField, Transport } from './types.ts';

/** "npx", ["-y", "a b"] → npx -y 'a b' */
export const quote = (a: string): string => (a === '' ? "''" : /[\s'"\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a);

export const commandLine = (c: { readonly command?: string | undefined; readonly args?: readonly string[] | undefined }): string =>
  [c.command ?? '', ...(c.args ?? [])]
    .filter((x, i) => i > 0 || x !== '')
    .map(quote)
    .join(' ');

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** How agents see its tools: lowercase, digits and _ (v1 normalised on blur). */
export const tidyName = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');

/** "a", "a and b", "a, b and c" (`and` from the catalogue). */
export function listOf(xs: readonly string[], and: string): string {
  if (xs.length < 2) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} ${and} ${xs.at(-1) ?? ''}`;
}

/** v1's names for harnesses the accounts rows don't name. */
const NAMES: Readonly<Record<string, string>> = { claude: 'Claude Code', codex: 'Codex', copilot: 'Copilot', opencode: 'opencode', grok: 'Grok' };
export const harnessName = (id: string, known: ReadonlyMap<string, string>): string => known.get(id) ?? NAMES[id] ?? id;

/** A form's fields, both transports kept so switching back finds what was typed. */
export interface Draft {
  name: string;
  transport: Transport;
  command: string;
  url: string;
  env: Pair[];
  headers: Pair[];
}

/** A secret field as the form holds it; `set`: a saved value the server keeps (never shown). */
export interface Pair {
  key: string;
  value: string;
  set: boolean;
  placeholder?: string;
}

export const emptyDraft = (): Draft => ({ name: '', transport: 'local', command: '', url: '', env: [], headers: [] });

export function draftOf(c: ConnectorView): Draft {
  return {
    name: c.name,
    transport: c.transport,
    command: c.line ?? commandLine(c),
    url: c.url,
    env: c.env.map((p) => ({ key: p.key, value: '', set: p.set })),
    headers: c.headers.map((p) => ({ key: p.key, value: '', set: p.set })),
  };
}

const fields = (ps: readonly Pair[]): SecretField[] => ps.filter((p) => p.key.trim() !== '').map((p) => ({ key: p.key.trim(), value: p.value }));

/** The body the server takes: '' keeps a saved secret; only the open transport's fields go. */
export function bodyOf(d: Draft): ConnectorBody {
  const name = d.name.trim();
  return d.transport === 'local' ? { name, transport: 'local', command: d.command.trim(), env: fields(d.env) } : { name, transport: 'remote', url: d.url.trim(), headers: fields(d.headers) };
}

/** The first field a save can't go without, or null. */
export function missing(d: Draft): 'name' | 'command' | 'url' | null {
  if (d.name.trim() === '') return 'name';
  if (d.transport === 'local') return d.command.trim() === '' ? 'command' : null;
  return d.url.trim() === '' ? 'url' : null;
}

type Server = Record<string, unknown>;
const isObj = (v: unknown): v is Server => typeof v === 'object' && v !== null && !Array.isArray(v);
const pairs = (o: unknown): Pair[] => (isObj(o) ? Object.entries(o).map(([key, value]) => ({ key, value: String(value), set: false })) : []);

function one(name: string, s: unknown): Draft | null {
  if (!isObj(s)) return null;
  const url = typeof s['url'] === 'string' ? s['url'] : typeof s['serverUrl'] === 'string' ? s['serverUrl'] : '';
  if (url) return { name, transport: 'remote', command: '', url, env: [], headers: pairs(s['headers']) };
  if (typeof s['command'] !== 'string' || s['command'] === '') return null;
  const args = Array.isArray(s['args']) ? s['args'].map(String) : [];
  return { name, transport: 'local', command: commandLine({ command: s['command'], args }), url: '', env: pairs(s['env']), headers: [] };
}

/** Pasted config: Claude's or Cursor's { mcpServers: { name: {…} } }, { name: {…} } or one {…}. */
export function parsePasted(text: string): Draft[] | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(j)) return null;
  if (j['command'] !== undefined || j['url'] !== undefined || j['serverUrl'] !== undefined) {
    const d = one('', j);
    return d ? [d] : [];
  }
  const servers = isObj(j['mcpServers']) ? j['mcpServers'] : isObj(j['servers']) ? j['servers'] : j;
  return Object.entries(servers)
    .map(([n, s]) => one(n, s))
    .filter((d): d is Draft => d !== null);
}

/** Starting points for the empty list: the form filled in, the secret left for you. */
export interface Example {
  readonly label: string;
  readonly draft: Draft;
}
export const EXAMPLES: readonly Example[] = [
  { label: 'Linear', draft: { ...emptyDraft(), name: 'linear', transport: 'remote', url: 'https://mcp.linear.app/mcp' } },
  { label: 'Jira', draft: { ...emptyDraft(), name: 'atlassian', transport: 'remote', url: 'https://mcp.atlassian.com/v1/mcp' } },
  { label: 'PostHog', draft: { ...emptyDraft(), name: 'posthog', transport: 'remote', url: 'https://mcp.posthog.com/mcp' } },
  {
    label: 'GitHub',
    draft: { ...emptyDraft(), name: 'github', transport: 'remote', url: 'https://api.githubcopilot.com/mcp/', headers: [{ key: 'Authorization', value: '', set: false, placeholder: 'Bearer ghp_…' }] },
  },
  { label: 'Filesystem', draft: { ...emptyDraft(), name: 'filesystem', command: 'npx -y @modelcontextprotocol/server-filesystem ~/Documents' } },
  { label: 'Postgres', draft: { ...emptyDraft(), name: 'postgres', command: 'npx -y @modelcontextprotocol/server-postgres postgresql://localhost/mydb' } },
];

/** What the row's status column says. */
export type Status = { kind: 'signing' } | { kind: 'signin' } | { kind: 'checking' } | { kind: 'unchecked' } | { kind: 'ok'; count: number } | { kind: 'failed'; error: string };

/** Signing in wins (the browser is open), then a sign-in the last check asked for, then the check. */
export function statusOf(c: ConnectorView, signing: boolean): Status {
  if (signing) return { kind: 'signing' };
  if (c.test?.auth === true && !c.testing) return { kind: 'signin' };
  if (c.testing) return { kind: 'checking' };
  if (!c.test) return { kind: 'unchecked' };
  if (c.test.ok) return { kind: 'ok', count: c.test.count ?? c.test.tools?.length ?? 0 };
  return { kind: 'failed', error: c.test.error ?? '' };
}

/** A sign-in started at `since` is over once the row says it signed in after it (5 s of clock skew), or after 10 min. */
export const SIGNING_MS = 10 * 60_000;
export function stillSigning(c: ConnectorView, since: number, now: number): boolean {
  if (now - since > SIGNING_MS) return false;
  return !(c.signed_in?.at !== null && c.signed_in?.at !== undefined && c.signed_in.at >= since - 5000);
}

/** The found card's sources: every harness a found server is in, once. */
export const sourcesOf = (found: readonly FoundServer[]): string[] => [...new Set(found.flatMap((f) => f.from))];

/** The one line the import review shows under a found server's name. */
export const foundLine = (f: FoundServer): string => (f.transport === 'local' ? commandLine(f) : (f.url ?? ''));

/** An issue source's starting point ('linear', 'jira'; the issue picker's Connect Linear… / Jira…), or undefined. */
export const exampleFor = (source: string): Example | undefined => EXAMPLES.find((x) => x.label.toLowerCase() === source);

/** Whether a connector is for that issue source: its name, URL or command says so, as wisp.issues reads it. */
export const isFor = (source: string, c: Pick<ConnectorView, 'name' | 'url' | 'command' | 'args'>): boolean =>
  (source === 'jira' ? /jira|atlassian/i : /linear/i).test([c.name, c.url, c.command, ...c.args].join(' '));
