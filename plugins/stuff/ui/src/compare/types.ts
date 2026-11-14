// The shapes Compare reads: a run is a task (v1 summary) with its turns as `runtime.turns` returns
// them (v1's stored turn: server/runner.js, the TS reference's runtime api). Kept apart from
// src/types.ts (stuff-A's) so the two never edit one file; switch to @wisp/protocol's generated
// types with one edit here.

/** What a harness reported for one turn (v1 turn.stats), as stored. */
export interface TurnStats {
  readonly durationMs?: number;
  readonly costUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cachedInputTokens?: number;
  /** Claude's modelUsage: every model the turn used */
  readonly models?: readonly { readonly model?: string; readonly input?: number; readonly output?: number; readonly cacheRead?: number; readonly cacheWrite?: number }[];
  /** the conversation's counters after this turn: present means the turn's own numbers are its own */
  readonly totals?: Readonly<Record<string, unknown>> & { readonly costUsd?: number };
  /** a turn that only moves the counters (a resumed conversation's starting point) */
  readonly baseline?: boolean;
  readonly turns?: number;
}

/** A turn's share of its account's plan window (server/budget.js addShare). */
export interface PlanShare {
  readonly agent?: string;
  readonly account?: string;
  readonly window: string;
  readonly used: number;
  readonly resetsAt?: number;
}

export interface TurnChange {
  readonly file?: string;
  readonly edits?: readonly { readonly before?: string; readonly after?: string }[];
  readonly reverted?: boolean;
}

export interface RunTurn {
  readonly id: string;
  readonly status: 'running' | 'done' | 'error' | 'stopped' | 'held' | (string & {});
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly agent?: string;
  readonly account?: string;
  readonly model?: string;
  readonly prompt?: string;
  readonly by?: string;
  readonly stats?: TurnStats | null;
  readonly plan?: readonly PlanShare[];
  readonly activity?: readonly { readonly kind: string }[];
  /** activity the runner dropped from a long turn, still counted as steps */
  readonly trimmed?: number;
  readonly changes?: readonly TurnChange[];
  readonly presentation?: { readonly blocks?: readonly unknown[] } | null;
  /** copied from another task: a fork's first turns, a shared task's */
  readonly forked?: boolean | string;
  readonly shared?: boolean | Readonly<Record<string, unknown>>;
}

/** Try it two ways: what differed between the runs (session.trial). */
export interface Trial {
  readonly differs?: readonly { readonly key: string; readonly values: readonly string[] }[];
  readonly variant?: { readonly subagentModel?: string; readonly skills?: string };
}

/** One run of a compared task: its summary fields Compare uses, and its turns. */
export interface Run {
  readonly id: string;
  readonly agent: string;
  readonly model?: string;
  readonly effort?: string;
  readonly account?: string;
  readonly state: 'running' | 'waiting' | 'review' | 'done' | (string & {});
  readonly status?: string;
  readonly createdAt: number;
  readonly groupId?: string | null;
  readonly turns: readonly RunTurn[];
  readonly trial?: Trial | null;
  /** the run's live line while it works (summary.live) */
  readonly live?: string;
}

/** One run's numbers (runMetrics). */
export interface Metrics {
  readonly id?: string;
  readonly agent?: string;
  readonly createdAt?: number;
  readonly live: boolean;
  readonly time: number | null;
  readonly cost: number | null;
  readonly costPartial?: boolean;
  readonly tokens: number | null;
  readonly cache?: number | null;
  readonly steps?: number | null;
  readonly plan?: readonly { readonly window: string; readonly used: number }[];
  readonly files?: number;
  readonly add?: number;
  readonly del?: number;
  readonly tests: { readonly passed: number; readonly failed: number } | null;
  readonly asks?: number;
  readonly followUps: number;
  readonly unfinished: boolean;
}
