// The shapes `wisp-agents/client` sends and gets back: v1's HTTP API, which v2 keeps. Each names the fields
// the SDK and the CLI read; a server may send more (a newer version, a plugin's fields), so each also
// takes any other key as unknown.

/** Any other field a server sends. */
export interface Extra {
  [key: string]: unknown;
}

/** What ~/.wisp/server.json says about the running server. */
export interface ServerInfo extends Extra {
  url?: string;
  port: number;
  pid?: number;
  version?: string;
  apiVersion?: number;
  /** v2: the bearer token local clients send */
  token?: string;
}

export interface Health extends Extra {
  ok: boolean;
  pid?: number;
  version?: string;
  apiVersion?: number;
}

export interface Defaults extends Extra {
  agent?: string;
  mode?: string;
  model?: string;
  /** the model remembered per agent (ids aren't portable between harnesses) */
  models?: Record<string, string>;
}

export interface Config extends Extra {
  defaults?: Defaults;
}

export type SessionState = 'running' | 'waiting' | 'review' | 'done';

export interface SessionSummary extends Extra {
  id: string;
  title: string;
  state: SessionState | (string & {});
  agent: string;
  project: string;
  question?: string | null;
  preview?: string;
}

export interface WaitResult extends SessionSummary {
  timedOut?: boolean;
}

/** A side question and, once it's done, its answer. */
export interface Btw extends Extra {
  id: string;
  question?: string;
  status: 'running' | 'done' | 'error' | (string & {});
  answer?: string;
  error?: string;
}

export interface Turn extends Extra {
  id: string;
  btw?: Btw[];
}

export interface Session extends SessionSummary {
  turns: Turn[];
}

export interface Presentation extends Extra {
  markdown: string;
  status?: string;
  blocks?: unknown[];
}

/** One session, or with compare/trial the group launched together. */
export interface Launched extends SessionSummary {
  group?: Array<SessionSummary>;
}

export interface SessionFilter {
  state?: string | undefined;
  cwd?: string | undefined;
  project?: string | undefined;
  archived?: boolean | undefined;
  limit?: number | null | undefined;
}

/** Another run of the same task: a harness, a model, or (a trial) one setting changed. */
export interface CompareRun {
  agent?: string | null | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  subagentModel?: string | undefined;
  skills?: 'off' | undefined;
}

export interface LaunchOptions {
  prompt: string;
  cwd?: string | undefined;
  /** more folders the same task works in (each git repo gets its own worktree and PR) */
  also?: string[] | undefined;
  agent?: string | undefined;
  mode?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  /** upload ids */
  attachments?: string[] | undefined;
  /** overrides the default (on in git repos) */
  worktree?: boolean | undefined;
  /** runs the same task on more harnesses at once, each in its own worktree */
  compare?: CompareRun[] | undefined;
  /** [{ name, agent, model, effort, use }] the lead can delegate to */
  subagents?: unknown[] | undefined;
  /** a saved team's id, instead of subagents */
  preset?: string | undefined;
  kind?: string | undefined;
  /** run it on one of the user's machines (id; '' or none = this computer) */
  machine?: string | undefined;
  /** go ahead although it takes a usage window past the Ask near the limit line (else 409 with `hold`) */
  confirmLimit?: boolean | undefined;
  /** Claude Code only: '' | haiku | sonnet */
  subagentModel?: string | undefined;
  /** Claude Code only */
  skills?: 'off' | undefined;
  /** Try it two ways: a compare of one setup with one change; Compare says what differed */
  trial?: boolean | undefined;
}

export interface ReplyOptions {
  attachments?: string[] | undefined;
  queue?: boolean | undefined;
  mode?: string | undefined;
  agent?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  confirmLimit?: boolean | undefined;
}

export interface ReplyResult extends Extra {
  answered?: boolean;
  interrupted?: boolean;
  queued?: boolean;
  /** "/btw …" as the text: a side question, not a follow-up */
  btw?: Btw;
}

export interface PullRequest extends Extra {
  number: number;
  url: string;
  draft?: boolean;
}

export interface MergeResult extends Extra {
  pr: PullRequest;
  /** the local base branch brought up to date */
  sync: { ok: boolean; text: string };
}

export interface Recipe extends Extra {
  id?: string;
  name: string;
  params: string[];
  prompt: string;
}

export interface UsageRow extends Extra {
  cost: number;
  turns: number;
  /** null: nothing finished yet */
  successRate: number | null;
}

export interface Usage extends Extra {
  days: number;
  total: UsageRow & { sessions: number; questions: number };
  projects: Array<UsageRow & { name: string }>;
  runners: Array<UsageRow & { agent: string; model?: string | null }>;
}

export interface CrewMember extends Extra {
  id: string;
  name: string;
  role?: string;
  paused?: boolean;
  cron?: string | null;
  cwd?: string;
  spell?: { name: string } | null;
}

export interface WispEvent {
  event: string;
  data: unknown;
}
