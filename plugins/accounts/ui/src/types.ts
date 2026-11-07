// What Settings → Agents and Settings → API keys read and write, until Rust generates the types
// (packages/protocol/src/generated/accounts/). Shapes follow v1 (GET /api/agents, /agents/:id/accounts,
// /agents/:id/login, /agents/:id/keys) and the TS reference (accounts-api), field for field. One file,
// so switching to the generated types is one edit.
//
// Everything is on one topic, `plugin:wisp.accounts:harnesses`:
//   accounts.harness  id = harness id ('claude')        one per harness wisp knows (v1 listAgents)
//   accounts.account  id = `${agent}/${account}`         an account of a harness that can have several
//   accounts.login    id = agent, or `${agent}@${acc}`   a sign-in and its state (v1 agent-login view)
//   accounts.key      id = `${agent}/${provider}`        a provider key (opencode Zen, Go): never the key
//   accounts.tool     id = 'git' | 'gh'                  not harnesses, but what Ship it needs
//   accounts.place    id = 'this'                        { grid }: this wisp runs on wisp Grid

import type { PeerId } from '@wisp/client';

export const TOPIC = 'plugin:wisp.accounts:harnesses' as const;
export const HARNESS = 'accounts.harness';
export const ACCOUNT = 'accounts.account';
export const LOGIN = 'accounts.login';
export const KEY = 'accounts.key';
export const TOOL = 'accounts.tool';
export const PLACE = 'accounts.place';

/** Settings (v1 config.defaults names after the dot). */
export const KEYS = {
  /** 'off' | 'on' (wisp's side runs) | 'all'; 'on' when unset (v1 server/lean.js) */
  leanRuns: 'claude.leanRuns',
  /** 'on' | 'off'; off unless on (v1 harness-watch) */
  harnessAsk: 'accounts.harnessAsk',
} as const;
export const LEAN = ['off', 'on', 'all'] as const;

/** Where a harness's program was, the first time wisp ran it and now (v1 server/harness-watch.js). */
export interface Pin {
  path: string;
  real: string;
  version?: string;
  sha256: string;
  /** when wisp pinned or saw it (ms) */
  at: number;
}

/** A harness's program changed since wisp pinned it. 'update': a newer version in the same folder. */
export interface HarnessChange {
  kind: 'update' | 'moved' | 'bytes';
  at: number;
  from: Pin;
  to: Pin;
  /** still hashing: nothing to say yet */
  checking?: boolean;
}

/** How a harness signs in: its CLI's own login, a key pasted into wisp, or not here. */
export type SignIn = 'cli' | 'key' | 'none';

export interface HarnessRow {
  id: string;
  name: string;
  /** the order wisp lists harnesses in */
  ord: number;
  available: boolean;
  version?: string;
  models: { id: string; label: string }[];
  /** installed but signed out (hidden from the picker) */
  signedIn?: false;
  error?: string;
  /** opencode: false while no paid provider has a key */
  hasKey?: boolean;
  /** how to get it on this OS, while it isn't found */
  setup?: { tip: string; command?: string; url?: string };
  signIn: SignIn;
  /** wisp can install it itself (opencode) */
  installable?: boolean;
  installing?: boolean;
  /** "Add another … account" calls it this (Claude, Codex); set only for harnesses that can have several */
  brand?: string;
  /** the account's provider in "sign in with your … account" (ChatGPT for Codex) */
  provider?: string;
  changed?: HarnessChange;
  /** when its program was last trusted (ms) */
  pinnedAt?: number;
}

export type AccountKind = 'personal' | 'work';
export const KINDS: readonly AccountKind[] = ['personal', 'work'];
export type AccountState = 'ready' | 'limit' | 'signedOut';

/** v1 Accounts.view(), plus the harness and the order. */
export interface AccountRow {
  agent: string;
  id: string;
  ord: number;
  label: string;
  email: string;
  plan: string;
  /** the CLI's own login: it can be signed out, never removed */
  default: boolean;
  kind: AccountKind;
  state: AccountState;
  /** when its usage limit ends (ms), while it's at one */
  until: number | null;
  why: string;
}

export type LoginState = 'idle' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

/** A sign-in (v1 agent-login view + status). `account` is '' for the CLI's own login. */
export interface LoginRow {
  agent: string;
  account: string;
  state: LoginState;
  url?: string;
  code?: string;
  /** the CLI waits for a code pasted back */
  needsInput?: boolean;
  /** a code was pasted and the CLI hasn't answered yet */
  checking?: boolean;
  error?: string;
  /** null: the CLI can't say */
  signedIn: boolean | null;
}

/** One provider's key (v1 KeysView, one row per provider): whether one is saved, never the key. */
export interface KeyRow {
  agent: string;
  /** the harness's name, for the group head */
  agentName: string;
  provider: string;
  name: string;
  /** where to get a key */
  url: string;
  /** the env var that signs every provider in, when wisp's environment has it; '' otherwise */
  env: string;
  set: boolean;
  /** the key's last 4 characters, for "…a3f9"; '' when none is saved */
  hint: string;
  savedAt: number | null;
  /** the last Test: did the provider take the key */
  test?: { at: number; ok: boolean; message: string };
}

export interface ToolRow {
  id: 'git' | 'gh';
  name: string;
  installed: boolean;
  setup?: { tip: string; command?: string; url?: string };
}

export interface PlaceRow {
  grid: boolean;
}

// ---------- command arguments (ids in commands.ts) ----------

export interface AgentArgs {
  peer: PeerId;
  agent: string;
}
/** `account`: '' for the CLI's own login */
export interface LoginArgs extends AgentArgs {
  account: string;
}
export interface LoginInputArgs extends LoginArgs {
  code: string;
}
/** `id` is made here so the row that shows at once is the row the server keeps */
export interface AddArgs extends AgentArgs {
  id: string;
  label: string;
  kind: AccountKind;
}
export interface UpdateArgs extends AgentArgs {
  account: string;
  label?: string;
  kind?: AccountKind;
  move?: 'up' | 'down';
}
export interface AccountArgs extends AgentArgs {
  account: string;
}
export interface ProviderArgs extends AgentArgs {
  provider: string;
}
export interface KeySetArgs extends ProviderArgs {
  key: string;
}
export type RecheckArgs = { peer: PeerId };

/** The login row's id: the plain harness id for the CLI's own login (v1 agent-login key). */
export const loginId = (agent: string, account = ''): string => (account && account !== 'default' ? `${agent}@${account}` : agent);
export const accountId = (agent: string, account: string): string => `${agent}/${account}`;
export const keyId = (agent: string, provider: string): string => `${agent}/${provider}`;
