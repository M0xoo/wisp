// @wisp-plugin/budget-api: the contract of wisp.budget, the plugin that knows how much of each
// account's usage windows is gone (Claude's 5-hour and weekly ones, Codex's), from what the CLI
// reports on every run (`turn.limits`), and holds back work nobody started by hand when a window is
// past Automations stop at (v1 server/budget.js, app.reserve; design/budget.md).
//
// Other plugins read it through `budgetService` (hold, resetAt, windows, …), add their own hold to
// `budget.reserve` (the machine's load), and react to `budget.reset` (a window reset early: later
// pulls forward, crew and automations release what they skipped) and `budget.drain`.

import type { ServiceRef } from '@wisp/kernel';
import type { Banked, BankedCredit, LimitsReport } from './limits.ts';

export * from './windows.ts';
export * from './limits.ts';
export * from './receipt.ts';
export * from './work.ts';
export { toolSet } from './tools.ts';
export { compareRows, compareSentence, countChanges, differsWords, runMetrics, variantWords } from './compare-metrics.ts';
export type { CompareRow, RunMetrics } from './compare-metrics.ts';
export { planShares } from './plan-shares.ts';

export const PLUGIN_ID = 'wisp.budget';

// ---------- shapes ----------

/**
 * Work held back (v1 app.reserve.check): a plan window past Automations stop at, or another
 * source's reason (the machine's load: `load: true`). `until`: when it can go (every window past
 * the line has reset), when known.
 */
export interface Hold {
  agent: string;
  account: string;
  until?: number;
  why: string;
  load?: boolean;
  window?: string;
  label?: string;
  used?: number;
  stop?: number;
  /** other sources' own fields */
  [k: string]: unknown;
}

/** `budget.reserve@1`: another plugin's reason to hold unattended work (wisp.machine: memory, CPU, run slots). */
export interface ReserveSource {
  id: string;
  /** read-only and fast: called on every check */
  hold(agent: string, account: string): Hold | null;
}

/** An account's window as it stands now: a window whose reset has passed reads as fresh (0%, no time). */
export interface WindowNow {
  id: string;
  label: string;
  used: number;
  resetsAt: number | null;
  ms: number | null;
}

export interface WindowView extends WindowNow {
  /** when it runs out at this pace, if before the reset */
  hitAt: number | null;
  /** it reset early (a banked reset) at this time, this period */
  earlyAt?: number;
}

/** Drain watch: a window whose last two hours of runs took twice its usual share per unit of work. */
export interface Drain {
  id: string;
  label: string;
  ratio: number;
  since: number;
  runs: number;
  units: number;
  du: number;
  usual: number;
  failed: { runs: number; du: number };
}

/** Window changes (`windowNotice`): a window that appeared, went, changed length or moved its reset. */
export interface WindowNotice {
  window: string;
  kind: 'new' | 'gone' | 'length' | 'reset';
  at: number;
  ms: number | null;
  resetsAt: number | null;
  wasMs?: number | null;
  wasWindow?: string;
  wasResetsAt?: number;
  label: string;
  wasLabel?: string;
}

/** Past your plan: runs on this account billed beyond the plan in the last 7 days. */
export interface OverageView {
  runs: number;
  at: number;
  kind: OverageKind;
  sid?: string;
}
export type OverageKind = 'extra' | 'credits' | 'api' | 'profile';

/** Where an account's longest window went this period (v1 whereItWent, whereSubagents). */
export interface WhereView {
  window: string;
  label: string;
  used: number;
  tasks: { id: string; title: string; used: number }[];
  more: number;
  traced: number;
  subagents?: { type: string; calls: number; model: string; output: number; used: number; instead?: string }[];
}

/** One account of a harness, for Settings → Usage and the harness list (v1 Budget.view). */
export interface AccountView {
  account: string;
  at: number | null;
  windows: WindowView[];
  drain?: Drain;
  notices?: WindowNotice[];
  overage?: OverageView;
  banked?: Banked & { at: number | null };
  where?: WhereView;
}

/** A window's closed period, oldest first (v1 Budget.periods; read by the allowance view). */
export interface Period {
  resetsAt: number;
  ms: number | null;
  used: number;
  cut?: boolean;
}

/** An account wisp has readings for (the allowance view walks them). */
export interface AccountInfo {
  agent: string;
  account: string;
  at: number | null;
  /** when wisp first saw this account's windows */
  since: number | null;
}

export interface BankedDue {
  account: string;
  credit: BankedCredit;
  count: number;
}

/** What a report says of how the run is billed: past the plan, or null. */
export type Past = 'extra' | 'credits';

// ---------- the service ----------

export interface BudgetService {
  /** v1 app.reserve.check: a `budget.reserve` source's hold, else the plan's (Automations stop at), else null */
  hold(agent: string, account?: string): Hold | null;
  /** v1 app.reserve.plan: the plan's hold only */
  plan(agent: string, account?: string): Hold | null;
  /** when the account can run again after a limit: the latest reset among its full windows */
  resetAt(agent: string, account?: string): number | null;
  /** the line Automations stop at draws for this harness (0..1), or null when off */
  stopFor(agent: string): number | null;
  windows(agent: string, account?: string): WindowNow[];
  view(agent: string): AccountView[];
  periods(agent: string, account: string, window: string): Period[];
  accounts(): AccountInfo[];
  /** when the account's windows were last read (a run's report or a live read), or null */
  readingAt(agent: string, account?: string): number | null;
  /** Ask near the limit (the guard): what a unit of work takes of the window, from the runs so far */
  rate(agent: string, account: string, window: string): number | null;
  /** Ask near the limit: the line you said yes at for this window, while it hasn't reset; 0 when you haven't */
  acked(agent: string, account: string, window: string, resetsAt: number | null): number;
  drain(agent: string, account?: string): Drain | null;
  /** banked resets whose one phone note is due (the day before each expires) */
  bankedDue(agent: string): BankedDue[];
  // ---- writes ----
  /** a report that isn't a run's turn.limits (a live read: `read: true`, `banked`) → Past | null */
  record(agent: string, account: string, report: LimitsReport): Past | null;
  ack(agent: string, account: string, window: string, resetsAt: number | null, line: number): void;
  bankedSent(agent: string, account: string, credit: BankedCredit): void;
}

export const budgetService: ServiceRef<BudgetService> = {
  id: 'budget.service',
  major: 1,
  permissions: {
    hold: 'budget:read',
    plan: 'budget:read',
    resetAt: 'budget:read',
    stopFor: 'budget:read',
    windows: 'budget:read',
    view: 'budget:read',
    periods: 'budget:read',
    accounts: 'budget:read',
    readingAt: 'budget:read',
    rate: 'budget:read',
    acked: 'budget:read',
    drain: 'budget:read',
    bankedDue: 'budget:read',
    record: 'budget:write',
    ack: 'budget:write',
    bankedSent: 'budget:write',
  },
  readOnly: ['hold', 'plan', 'resetAt', 'stopFor', 'windows', 'view', 'periods', 'accounts', 'readingAt', 'rate', 'acked', 'drain', 'bankedDue'],
};

// ---------- commands, events, points, settings ----------

export const COMMANDS = {
  view: 'budget.view', // { agent } → AccountView[]  (read-only; drain/notices only with their settings on)
  hold: 'budget.hold', // { agent, account? } → Hold | null  (read-only)
  record: 'budget.record', // { agent, account, report: LimitsReport } → { past }  (a live read)
  overage: 'budget.overage', // { agent, account, kind, sessionId, turnId } → {}  (a run billed past the plan: an API key, a Console profile)
  ack: 'budget.ack', // { agent, account, window, resetsAt, line } → {}  (Ask near the limit: you said yes)
  dismissDrain: 'budget.dismissDrain', // { agent, account, window } → { ok }
  dismissNotice: 'budget.dismissNotice', // { agent, account, window } → { ok }
} as const;

export const EVENTS = {
  reset: 'budget.reset', // ResetEvent: a window of agent@account reset before its time
  drain: 'budget.drain', // DrainEvent: Drain watch on, a run ended while the account drains (once per 2 h per window)
} as const;

/** `budget.reset`. free: no window holds the account now (no stop line crossed, none full). */
export interface ResetEvent {
  agent: string;
  account: string;
  ids: string[];
  free: boolean;
}

/** `budget.drain`, also sent as a `budget.drain` notice: title and text are the phone's words. */
export interface DrainEvent {
  agent: string;
  account: string;
  drain: Drain;
  title: string;
  text: string;
}

export const POINTS = {
  reserve: 'budget.reserve', // ReserveSource (list, v1)
} as const;

/** v1 config.defaults keys, kept as they were (the importer maps them 1:1). */
export const SETTINGS = {
  autoStop: 'autoStop', // 'off' | '50' | '75' | '90'
  autoStopClaude: 'autoStopClaude', // 'same' | STOP_AT
  autoStopCodex: 'autoStopCodex',
  drainWatch: 'drainWatch', // 'on' | 'off' (off by default)
  windowNotice: 'windowNotice', // 'on' | 'off' (on unless off)
} as const;

/** The topics budget's rows are published on: every change, and one agent's. */
export const TOPIC = 'budget';
export const agentTopic = (agent: string): `budget:${string}` => `budget:${agent}`;

/** The hold kind budget puts on a turn it holds (`BeforeRunCtx.hold.kind`). */
export const HOLD_KIND = 'plan';
/** The veto code for work refused at Automations stop at (plan §6.11.3). */
export const REFUSED = 'budget_exceeded';
