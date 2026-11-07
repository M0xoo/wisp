// The harness contract of wisp.runtime (`runtime.harness@1`): what each CLI module (wisp.claude,
// wisp.codex, …) contributes, what a turn hands it, and the events it reports back. The port of
// v1's adapter shape (server/adapters/index.js), field for field; v1 names are kept so the parity
// tests (gate G6) compare like with like.

import type { Json } from '@wisp/kernel';
import type { Attachment, FileChange, Mode } from './index.ts';

/** `runtime.harness@1`: one per CLI (wisp.claude, wisp.codex, …). The port of v1's adapter shape. */
export interface Harness {
  id: string;
  name: string;
  models: HarnessModel[];
  efforts?: string[];
  /** how the agent sees wisp's ask tool; null = it can't take MCP, ask with a question block */
  askTool: string | null;
  approveTool?: string;
  sideGate?: boolean;
  fork?: boolean;
  /** it reports its own version per run (`cli` events): the runtime never takes detect's version for it */
  reportsCli?: boolean;
  /** resumeCommand({ sessionId }) names the new conversation (terminal sessions resume it later) */
  sessionIds?: boolean;
  /** the program it runs, as detect() last found it (harness watch pins it) */
  bin?(): string;
  detect(): Promise<HarnessFound>;
  setup?(platform: string): { tip: string; command?: string; url?: string };
  modelOverride?(o: { model: string; mode: Mode }): { label: string; note: string } | null;
  permission?(tool: string, input: unknown, cwd: string): { tool: string; action: string; detail: string; why?: string };
  resumeCommand?(o: ResumeOptions): { argv: string[]; typesPrompt?: boolean };
  trust?(dir: string): Promise<void>;
  /** whether the CLI kept conversation `id` (one that quit at a start-up question never saved it) */
  hasSession?(id: string, cwd: string, env?: Record<string, string | undefined>): Promise<boolean>;
  /** the newest conversation the CLI kept for this folder, or null (bring-in) */
  latestSession?(cwd: string, env?: Record<string, string | undefined>): Promise<string | null>;
  run(o: HarnessRun): HarnessHandle;
  /** signing in from wisp (v1 agent-login.js LOGINS), read by wisp.accounts */
  login?: HarnessLogin;
  /** several accounts: the folder the CLI keeps its login in (v1 accounts.js HOMES) */
  accounts?: HarnessAccounts;
  /** signing in with an API key pasted into wisp instead of a login (v1 agent-login.js KEYS) */
  keys?: HarnessKeys;
  /** the folders it keeps on disk, for This Mac → harness disk (v1 harness-disk.js) */
  folders?(o: { home: string; platform: string; env: Record<string, string | undefined>; tmps: string[]; uid?: number; lib(...parts: string[]): string[] }): HarnessFolders;
  /** a read of the account's usage windows that spends nothing (Codex's app-server; v1 live-limits.js) */
  liveLimits?(env: Record<string, string>, o: { timeoutMs: number; signal?: AbortSignal }): Promise<unknown>;
}

export interface HarnessModel {
  id: string;
  label: string;
  hint?: string;
  efforts?: string[];
}

export interface HarnessFound {
  available: boolean;
  version?: string;
  error?: string;
  models?: HarnessModel[];
  /** thinking levels this install reports (its --help, its catalog): wins over `Harness.efforts` */
  efforts?: string[];
  /** opencode: a provider is signed in (`opencode auth list`) */
  hasKey?: boolean;
  /** installed but its CLI says it's signed out, and no key in the env signs it in */
  signedIn?: false;
}

export interface ResumeOptions {
  resumeId?: string;
  model: string;
  effort: string;
  cwd: string;
  trusted: boolean;
  prompt?: string;
  sessionId?: string;
  mode?: Mode;
  systemPrompt?: string;
  dirs?: string[];
}

export interface HarnessHandle {
  stop(): void;
  done: Promise<void>;
  /** the root of the run's process tree (This Mac), once spawned */
  readonly pid?: number;
}

export interface HarnessLogin {
  /** the CLI (`WISP_<ID>_BIN` in `binEnv` overrides it, as the adapters do) */
  bin: string;
  binEnv: string;
  args: string[];
  /** the CLI's sign-out arguments, or a function that signs out where the CLI has no such command */
  logout: string[] | ((o: { home: string; platform: string }) => Promise<void>);
  status: string[];
  /** env vars that sign the CLI in without a login */
  keys: string[];
  /** true, false, or null when the answer isn't one we know (then nothing is hidden) */
  signedIn(out: string, code: number | null): boolean | null;
  /** what a run says when it's signed out, from real runs on an empty HOME */
  authFailed: RegExp;
  /** the login only asks on a terminal (Linux: script(1)) */
  tty?: boolean;
  extraEnv?: Record<string, string>;
  /** who a login is, from what `status` printed or what the CLI keeps: { email, plan } */
  whoIs?(statusOut: string, env: Record<string, string | undefined>): Promise<{ email?: string; plan?: string }>;
  /** not a harness (gh): a tool wisp signs in to for another feature */
  tool?: boolean;
}

export interface HarnessAccounts {
  /** the env var that points the CLI at a login folder: CLAUDE_CONFIG_DIR, CODEX_HOME */
  env: string;
  /** the CLI's own folder (the default account) */
  home(env: Record<string, string | undefined>, userHome: string): string;
  /** names in its folder that belong to the login, never linked into another account's folder */
  own: string[];
  /** a conversation started on one account resumes on another (the transcripts are shared) */
  resumes: boolean;
  /** the provider's own way past a limit */
  extra: string;
  /** the short name accounts are labelled with: 'Claude' */
  label: string;
}

export interface HarnessKeys {
  env: string;
  url: string;
  providers: { id: string; name: string }[];
  /** where the CLI keeps keys */
  file(env: Record<string, string | undefined>, home: string): string;
  authFailed: RegExp;
}

export interface HarnessFolders {
  parts: { label: string; path: string }[];
  crash: string[];
  cwd?: string[];
  how: string;
}

/**
 * Everything a turn hands its harness. v1 `adapter.run({...})` took these, by the same names; each
 * is optional so a harness that has no use for one ignores it (cursor takes no MCP servers).
 */
export interface HarnessRun {
  prompt: string;
  attachments: Attachment[];
  cwd: string;
  dirs: string[];
  resumeId?: string;
  fork?: boolean;
  mode: Mode;
  model: string;
  effort: string;
  systemPrompt: string;
  mcpServers: Record<string, Json>;
  /** `rule`s from its own blocked events the user allowed, for this turn only */
  grants: string[];
  /** v1 runEnv: what every process of the run inherits (WISP_TASK) */
  env: Record<string, string>;
  /** the account it runs on (CLAUDE_CONFIG_DIR, CODEX_HOME); {} for the CLI's own */
  accountEnv?: Record<string, string>;
  /** the conversation's counters after its last turn (the last turn's stats.totals), to count this one alone */
  prior?: Json;
  /** a chat that ran elsewhere (bring-in): its counters' start is unknown, the first result is the baseline */
  unknownPrior?: boolean;
  /** a lead with a team delegates through wisp: the harness's own subagent tool is off */
  delegating?: boolean;
  /** a side run that only answers (the retro): no tools, no MCP, the CLI's base prompt swapped */
  lean?: boolean;
  /** a repo the user hasn't trusted: none of its hooks or MCP servers */
  untrusted?: boolean;
  /** without the CLI's nonessential traffic (v1 lean.js LEAN_ENV) */
  quiet?: boolean;
  /** the model its subagents run on ('' | 'haiku' | 'sonnet'; Claude Code) */
  subagentModel?: string;
  /** 'off': without its slash commands and skills */
  skills?: string;
  /** every write and command goes to the approve tool first (a side discussion's edits) */
  gate?: boolean;
  /** started from a channel with a mode cap: the sandbox keeps the shell off wisp's API */
  capped?: boolean;
  /** a task's turn: check what the CLI is and what the sign-in bills to (side runs skip it) */
  probe?: boolean;
  signal: AbortSignal;
  onEvent(e: HarnessEvent): void;
}

export type HarnessToolKind = 'read' | 'edit' | 'run' | 'search' | 'web' | 'agent' | 'plan' | 'tool' | 'wait' | 'ask' | 'answer' | 'background';

/** v1's file ops ('create' | 'write' | 'edit') next to v2's; the runtime maps them to FileChange */
export type HarnessChangeOp = FileChange['op'] | 'create' | 'write' | 'edit';

/** v1's result stats, by v1's names (the runtime maps them to TurnStats); harnesses add their own */
export interface HarnessStats {
  costUsd?: number;
  durationMs?: number;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  [k: string]: unknown;
}

/** Normalised events every harness emits (v1 server/adapters/index.js), field for field. */
export type HarnessEvent =
  | { type: 'session'; id: string }
  | { type: 'tool'; kind: HarnessToolKind; label: string; file?: string; detail?: string; id?: string; output?: string }
  | { type: 'tool_output'; id: string; text: string }
  | { type: 'tool_error'; name: string; text: string; id?: string }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text?: string }
  | { type: 'change'; file: string; op: HarnessChangeOp; edits: FileChange['edits']; early?: boolean; beforeFile?: string | null }
  | { type: 'blocked'; tool: string; detail: string; rule?: string }
  | { type: 'limits'; windows: { id: string; used: number; resetsAt?: number | null; ms?: number | null; [k: string]: unknown }[]; rejected?: boolean | string; overage?: boolean; credits?: number; [k: string]: unknown }
  | { type: 'billing'; kind: 'api' | 'profile' }
  /** the tools this run had (built-ins and MCP), for the account comparison */
  | { type: 'tools'; list: string[] }
  /** what the CLI was this turn: its version, its model catalog's hash */
  | { type: 'cli'; version?: string; catalog?: string; models?: Record<string, string> }
  /** background tasks still running: the CLI starts another turn when they finish */
  | { type: 'background'; tasks: string[] }
  | {
      type: 'result';
      text: string;
      isError: boolean;
      stopped?: boolean;
      stats?: HarnessStats;
      /** the CLI said it is signed out: the turn shows a sign-in card */
      authFailed?: boolean;
      stopReason?: string;
      /** background tasks left running (> 0: another result follows) */
      background?: number;
    };
