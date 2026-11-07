// @wisp-plugin/accounts-api: the contract of wisp.accounts, which owns signing in to each harness
// (v1 server/agent-login.js), a harness's several accounts (v1 server/accounts.js) and the harness
// list (v1 listAgents, GET /api/agents). Everything per harness reaches it through the harness
// contract (runtime.harness: `login`, `accounts`, `keys`), never by name (ADR-0003).
//
// wisp never switches accounts to get around a limit: the providers' terms forbid bypassing their
// limits (design/accounts.md). A limit asks you what to do.

// ---------- rows ----------

export type AccountKind = 'personal' | 'work';
export const KINDS: readonly AccountKind[] = ['personal', 'work'];
export type AccountState = 'ready' | 'limit' | 'signedOut';

/** One account as the page sees it (no folders). v1 `Accounts.view()`, field for field. */
export interface AccountView {
  id: string;
  label: string;
  email: string;
  plan: string;
  /** the CLI's own folder */
  default: boolean;
  kind: AccountKind;
  state: AccountState;
  /** when its usage limit ends (ms), while it's at one */
  until: number | null;
  why: string;
}

export type LoginState = 'idle' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

/** A sign-in as the page sees it (v1 agent-login view). `account` is '' for the CLI's own. */
export interface LoginView {
  agent: string;
  account: string;
  state: LoginState;
  url?: string;
  code?: string;
  /** the CLI waits for a code pasted back */
  needsInput?: boolean;
  /** a code was pasted and the CLI hasn't answered yet: the page shows a spinner */
  checking?: boolean;
  error?: string;
  /** its last few lines */
  output?: string;
  startedAt?: number;
}

/** What the CLI says about a login (v1 agent-login status). signedIn null: an answer we don't know. */
export interface LoginStatus {
  agent: string;
  account: string;
  signedIn: boolean | null;
  email?: string;
  plan?: string;
}

/** A key sign-in's providers (opencode Zen and Go): which have a key, never the key. */
export interface KeysView {
  agent: string;
  url: string;
  /** the env var that signs every provider in, when wisp's environment has it; '' otherwise */
  env: string;
  providers: { id: string; name: string; set: boolean }[];
}

/** One harness in the list (v1 listAgents): what detect() found, plus what other plugins add. */
export interface AgentRow {
  id: string;
  name: string;
  models: { id: string; label: string; hint?: string; efforts?: string[] }[];
  efforts: string[];
  /** can lead a team of subagents (it takes wisp's MCP server) */
  delegates: boolean;
  available: boolean;
  version?: string;
  error?: string;
  hasKey?: boolean;
  /** installed but signed out */
  signedIn?: false;
  /** how to get it on this OS, while it isn't found */
  setup?: { tip: string; command?: string; url?: string };
  /** its accounts, for a harness that can have several */
  accounts?: AccountView[];
  /** fields other plugins contribute through `accounts.agentRow` (budget, compare, harness watch) */
  [field: string]: unknown;
}

// ---------- commands (permissions in brackets; every one is `accounts:<group>`) ----------

export const COMMANDS = {
  agents: 'accounts.agents', // { fresh?: true | '<harness id>' } → AgentRow[]   [read]  (GET /agents)
  recheck: 'accounts.recheck', // {} → AgentRow[]   [read]  (detect again, here and on every machine)
  list: 'accounts.list', // { agent } → { accounts: AccountView[] }   [read]
  add: 'accounts.add', // { agent, label?, kind? } → { account, accounts, login: LoginView }   [write]
  update: 'accounts.update', // { agent, account, label?, move?: 'up' | 'down', kind? } → { accounts }   [write]
  remove: 'accounts.remove', // { agent, account } → { accounts }   [write]  (signs it out first)
  env: 'accounts.env', // { agent, account? } → Record<string, string>   [read, read-only]  (v1 sideEnv)
  signedOut: 'accounts.signedOut', // { agent, text } → { signedOut: boolean }   [read, read-only]  (v1 signedOutBy)
  loginGet: 'accounts.login.get', // { agent, account? } → LoginView & LoginStatus   [read]
  loginStart: 'accounts.login.start', // { agent, account? } → LoginView   [login]
  loginInput: 'accounts.login.input', // { agent, account?, code } → LoginView   [login]
  loginCancel: 'accounts.login.cancel', // { agent, account? } → LoginView   [login]
  logout: 'accounts.logout', // { agent, account? } → LoginStatus   [login]
  keysGet: 'accounts.keys.get', // { agent } → KeysView   [read]
  keysSet: 'accounts.keys.set', // { agent, provider, key } → KeysView   [keys]
  keysRemove: 'accounts.keys.remove', // { agent, provider } → KeysView   [keys]
  /** harness watch's Trust this version (host/src/watch.ts registers it) */
  watchTrust: 'accounts.watch.trust', // { agent } → {}   [write]
} as const;

export const PERMISSIONS = {
  read: 'accounts:read',
  write: 'accounts:write',
  login: 'accounts:login',
  keys: 'accounts:keys',
} as const;

// ---------- events (after commit; outside a command, at once) ----------

export const EVENTS = {
  /** an account was added (v1 broadcast('agents') after POST /agents/:id/accounts) */
  added: 'accounts.added', // { agent, account }
  /** renamed, moved, its kind set, signed in or out, at its limit */
  updated: 'accounts.updated', // { agent, account }
  removed: 'accounts.removed', // { agent, account }
  /** the harness list may look different: fetch it again (v1 broadcast('agents')) */
  agentsChanged: 'accounts.agents.changed', // {}
  /** a detection finished: every harness as found (wisp.router syncs its arms from it) */
  detected: 'accounts.detected', // { agents: AgentRow[] }
  /** a sign-in moved on (v1 broadcast('agent-login')); failed/cancelled disarms the runtime's card */
  login: 'accounts.login.changed', // LoginView
  /** its sign-in changed either way: login, logout, a key added or removed (v1 onDone) */
  signInChanged: 'accounts.signIn.changed', // { agent }
  /** a login or a key just landed (v1 onSignedIn): the runtime's sign-in card sends its request again */
  signedIn: 'accounts.signedIn', // { agent, account }
} as const;

// ---------- extension points ----------

/**
 * `accounts.agentRow@1`: fields another plugin adds to each harness in GET /agents (budget's
 * windows, compare, harness watch's pin). Return {} to add nothing; a field it leaves out is absent.
 */
export interface AgentRowField {
  plugin: string;
  fields(agent: string, row: AgentRow): Record<string, unknown> | Promise<Record<string, unknown>>;
}

export const POINTS = {
  agentRow: 'accounts.agentRow',
} as const;

// ---------- topics and settings ----------

/** account rows and the last detection, for clients that watch the harness list */
export const TOPIC = 'plugin:accounts:agents' as const;

export const SETTINGS = {
  /** your last pick per harness: { claude: '<account id>' } (v1 config.defaults.accounts) */
  pick: 'accounts',
} as const;
