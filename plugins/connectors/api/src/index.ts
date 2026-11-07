// @wisp-plugin/connectors-api: the contract of wisp.connectors, the user's MCP servers (added once in
// Settings → Connectors) handed to every task's agent whatever the harness. The port of v1's
// server/connectors.js, connector-auth.js, mcp-connector.js and routes/connectors.js.
//
// Secret values (env vars, headers, OAuth tokens) never leave wisp.connectors except to the proxy a
// harness starts for one connector (`connectors.spec`): the page and the agent see key names only.

import type { Json, ServiceRef } from '@wisp/kernel';

export type ConnectorId = string;
export type Transport = 'local' | 'remote';

/** The outcome of starting it once and listing its tools (Settings shows it on the row). */
export interface ProbeResult {
  at: number;
  ok: boolean;
  tools?: string[];
  count?: number;
  error?: string;
  /** refused for want of a sign-in: the row offers Sign in */
  auth?: boolean;
}

/** Where a remote connector signs in (OAuth metadata, no secrets). */
export interface OAuthMeta {
  issuer: string;
  authorize: string;
  token: string;
  register: string | null;
  scopes: string[];
  resource: string;
  clientId?: string;
  redirect?: string;
  expiresAt?: number | null;
  signedInAt?: number | null;
}

/** A connector as wisp keeps it: what it is. env and headers are key names; their values are secrets. */
export interface Connector {
  id: ConnectorId;
  name: string;
  transport: Transport;
  command?: string;
  args?: string[];
  url?: string;
  env: string[];
  headers: string[];
  enabled: boolean;
  addedAt: number;
  test?: ProbeResult | null;
  oauth?: OAuthMeta;
}

/** What the page sees of one: never a secret's value, only which keys are set. */
export interface ConnectorView {
  id: ConnectorId;
  name: string;
  transport: Transport;
  command: string;
  args: string[];
  url: string;
  env: { key: string; set: boolean }[];
  headers: { key: string; set: boolean }[];
  enabled: boolean;
  test: ProbeResult | null;
  signedIn: { host: string; at: number | null } | null;
  addedAt: number;
  /** harnesses that keep their own server by this name */
  own: string[];
  testing: boolean;
}

/** A server in a harness's own config that isn't a connector yet (key names only). */
export interface FoundServer {
  name: string;
  from: string[];
  transport: Transport;
  command?: string;
  args?: string[];
  url?: string;
  env?: string[];
  headers?: string[];
}

/** GET /api/connectors */
export interface ConnectorsView {
  connectors: ConnectorView[];
  found: FoundServer[];
  reach: string[];
}

/** What the proxy needs to run one connector: the only answer that carries secret values. */
export interface ProxySpec {
  connector: Connector;
  env: Record<string, string>;
  headers: Record<string, string>;
  /** a signed-in connector's access token, when it has one */
  access: string | null;
}

/** The ask a sign-in card is (wisp.mcp opens it, as ask_user's; `connectors.works` answers it). */
export interface SigninAsk {
  question: string;
  context: string;
  options: string[];
  connector: { id: ConnectorId; name: string; kind: 'keys' | 'signin'; keys: { key: string; field: 'env' | 'headers'; set: boolean }[] };
}

/** Harnesses that take a server per turn; cursor and antigravity only read their own config. */
export const REACH = ['claude', 'codex', 'copilot', 'opencode', 'grok'] as const;

// ---------- commands (ids are permissions: `connectors:<verb>`) ----------

export const COMMANDS = {
  list: 'connectors.list', // {} → ConnectorsView   (read-only)
  add: 'connectors.add', // body → ConnectorsView
  update: 'connectors.update', // { id, ...body } → ConnectorsView
  remove: 'connectors.remove', // { id } → ConnectorsView
  test: 'connectors.test', // { id } → ConnectorsView   (starts it and lists its tools)
  import: 'connectors.import', // { names, dismiss } → ConnectorsView & { skipped }
  signin: 'connectors.signin', // { id, origin } → { url }
  signout: 'connectors.signout', // { id } → ConnectorsView
  oauthFinish: 'connectors.oauthFinish', // { query: Record<string,string> } → { name }
  token: 'connectors.token', // { id, force? } → { token }   (the proxy's fresh OAuth token)
  spec: 'connectors.spec', // { id } → ProxySpec   (the proxy only)
  forTurn: 'connectors.forTurn', // { agent, mode, cwd } → Record<string, Json> mcpServers   (read-only)
  agentList: 'connectors.agent.list', // {} → { text }           wisp_connectors
  agentAdd: 'connectors.agent.add', // body → { text }            wisp_connector_add
  agentSignin: 'connectors.agent.signin', // { name, why } → { text } | { ask: SigninAsk }   wisp_connector_signin
} as const;

export interface ForTurnArgs {
  agent: string;
  mode: 'plan' | 'edits' | 'auto';
  cwd?: string;
}

export type McpServers = Record<string, Json>;

// ---------- events ----------

export const EVENTS = {
  changed: 'connectors.changed', // {}   Settings should look again (v1 broadcast('connectors'))
  /** it works now: a task waiting on its sign-in or keys (wisp_connector_signin) carries on with `text` */
  works: 'connectors.works', // { id, name, count, text }
  /** an agent added one (counts only, for telemetry) */
  agentAdded: 'connectors.agentAdded', // { agent, transport }
} as const;

/** The topic Settings → Connectors watches (v1 broadcast 'connectors'). */
export const TOPIC = 'plugin:wisp.connectors:list' as const;

// ---------- the bridge the edge provides ----------

/**
 * `connectors.bridge@1`, provided by the edge: how a harness starts the proxy for one connector and
 * what it speaks to wisp with. `launcher` is the command line before the connector's id (the
 * published bin: `[node, wisp.js, 'connector']`); `token` is a token whose caller may run
 * `connectors.spec` and `connectors.token` only (v1 agent-token.js connectorToken).
 */
export interface ConnectorBridge {
  launcher(): { command: string; args: string[] };
  url(): string;
  token(): string;
}

export const BRIDGE: ServiceRef<ConnectorBridge> = {
  id: 'connectors.bridge',
  major: 1,
  permissions: { launcher: 'connectors:bridge', url: 'connectors:bridge', token: 'connectors:bridge' },
  readOnly: ['launcher', 'url', 'token'],
};
