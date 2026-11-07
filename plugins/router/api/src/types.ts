// The shapes of wisp.router's contract, v1's names kept (server/router.js, services/auto.js): the
// page, older clients and the importer of v1's router.json read them as they were.

/** A harness as Auto sees it (v1 listAgents()): this computer's, or a machine's. */
export interface AgentInfo {
  id: string;
  name: string;
  available: boolean;
  models?: { id: string; label?: string; efforts?: string[] }[];
  efforts?: string[];
  /** can lead a team of subagents (it takes wisp's MCP server) */
  delegates?: boolean;
  signedIn?: boolean;
  version?: string;
}

export interface RouteAlt {
  key: string;
  agent: string;
  model: string;
  effort: string;
  label: string;
  chance: number;
  usd: number;
}

export type Suggest = RouteAlt & { trying: boolean; why: string };

/** How Auto picked a run: what the task's card shows and what the router learns from. */
export interface Route {
  goal: string;
  type: string;
  size: string;
  key: string;
  effort: string;
  label: string;
  chance: number;
  n: number;
  usd: number;
  minutes: number;
  explored: boolean;
  trying: boolean;
  tier: number;
  taste: number;
  pinned?: boolean;
  why: string;
  /** how likely this pick was (the router's own choices can be corrected for later) */
  propensity: number;
  alternatives: RouteAlt[];
  suggest?: Suggest;
  at: number;
  /** the user moved the task to another harness or model in a follow-up */
  switched?: boolean;
  /** the pipeline handed it over (true) or moved it at a limit */
  escalated?: boolean;
  moved?: boolean;
}

/** A route as the router keeps it per session: the pick, what happened since, and its reward. */
export interface StoredRoute {
  key: string;
  type: string;
  label?: string;
  goal?: string;
  chance?: number;
  explored?: boolean;
  trying?: boolean;
  why?: string;
  /** a run you picked yourself: it teaches the record at half weight */
  manual?: boolean;
  at: number;
  signals: Signals;
  r: number | null;
  /** the run never got to work (the harness was at its limit) */
  void?: boolean;
  [k: string]: unknown;
}

export interface Pick {
  agent: string;
  model: string;
  effort: string;
  key: string;
  label: string;
  route: Route;
}

/** What happened to a routed task. A later, stronger signal replaces an earlier one. */
export interface Signals {
  hero?: 'done' | 'partial' | 'blocked' | 'info';
  error?: boolean;
  followups?: number;
  feedback?: 'up' | 'down' | null;
  merged?: boolean;
  closed?: boolean;
  /** null clears it (a rollback restored) */
  rolledBack?: boolean | null;
  switched?: boolean;
  switchedTo?: string;
  check?: 'pass' | 'fail' | 'error';
  repaired?: boolean;
  /** best-of-2: whether the judge picked this run */
  picked?: boolean;
  costUsd?: number;
  ms?: number;
}

/** `choose()`: v1 Router.choose's options, by the same names (`seed` instead of a function rng). */
export interface ChooseArgs {
  prompt?: string;
  attachments?: number;
  /** the harnesses of the place it runs; default: this computer's */
  agents?: AgentInfo[];
  goal?: string;
  /** no exploring: the best on the record */
  important?: boolean;
  explore?: boolean;
  /** arm keys already taken: every level of that harness · model is out */
  exclude?: string[];
  needDelegate?: boolean;
  allowed?: string[] | null;
  blocked?: string[];
  prefer?: string[];
  habits?: boolean;
  /** the scout's { type, size }, which beats the keyword guess */
  scouted?: { type?: string; size?: string } | null;
  /** only arms at least this strong (a hand-over steps up) */
  minTier?: number;
  /** the pick to show before sending: no dice */
  preview?: boolean;
  /** the preview you saw, kept if it can still run */
  pin?: string | null;
  /** a seed for the draw (tests, benches); default: Math.random */
  seed?: number;
}

export interface CoolArgs {
  scope?: 'agent' | 'arm';
  ms?: number;
  why?: string;
}

export interface ObserveArgs {
  agent: string;
  model?: string;
  effort?: string;
  prompt?: string;
  attachments?: number;
  type?: string | null;
  at?: number;
  weight?: number;
}

export interface OverrideArgs {
  type: string;
  /** the key Auto's preview showed */
  auto: string;
  /** the key you launched */
  chose: string;
  prompt?: string;
}

/** The fields of a task's list row the router reads (v2 Summary, or a peer's mirrored row). */
export interface SummaryLike {
  id: string;
  status?: string;
  state?: string;
  turnCount?: number;
  followups?: number;
  agent?: string;
  model?: string;
  effort?: string;
  pr?: { state?: string } | null;
  route?: { switched?: boolean } | null;
}

/** `router.decide`: what Auto would run, and why. */
export interface Decision {
  agent: string;
  model: string;
  effort: string;
  key: string;
  label: string;
  goal: string;
  type: string;
  size: string;
  chance: number;
  usd: number;
  minutes: number;
  tier: number;
  why: string;
  alternatives: RouteAlt[];
  suggest: Suggest | null;
  route: Route;
}

/** POST /router/preview (v1 shape). */
export interface PreviewArgs {
  prompt?: string;
  attachments?: number;
  goal?: string;
  team?: boolean;
  machine?: string;
}
export type PreviewResult =
  | { pick: null; why: string }
  | ({ pick: { agent: string; model: string; effort: string; key: string; label: string } } & Omit<Decision, 'agent' | 'model' | 'effort' | 'key' | 'label' | 'route'>);

/** PATCH /router (v1 shape). */
export interface RouterPatch {
  goal?: string;
  explore?: boolean;
  allowed?: string[] | null;
  escalate?: boolean;
  best2?: boolean;
  habits?: boolean;
  blocked?: string[];
  prefer?: string[];
  scout?: 'off' | 'big' | 'all';
}

/** One harness · model (· level) on Settings → Auto. */
export interface ArmReport {
  key: string;
  agent: string;
  model: string;
  effort: string;
  canon: string;
  label: string;
  tier: number;
  coolingUntil?: number;
  coolingWhy?: string;
  state: string;
  chance: number;
  n: number;
  usd: number;
  minutes: number;
  prior: boolean;
  inherited: boolean;
  from: string[];
  picks: number;
  blocked: boolean;
  preferred: boolean;
  byType: Record<string, { n: number; chance: number }>;
}

export interface RouterReport {
  priors: { version: string; source: string; sources: Record<string, unknown> };
  learned: number;
  routed: number;
  picks: number;
  corrections: number;
  arms: ArmReport[];
  recent: { id: string; key: string; label?: string; type: string; goal?: string; chance?: number; r: number | null; explored?: boolean; trying?: boolean; why?: string; at: number; signals: Signals }[];
}

/** GET /router (v1 auto.view()). */
export type RouterView = RouterReport & {
  goals: Record<string, { label: string; value: number; hint: string }>;
  goal: string;
  settings: { explore: boolean; allowed: string[] | null; blocked: string[]; prefer: string[]; habits: boolean; escalate: boolean; best2: boolean; scout: string };
  projects: { id: string; name: string; color?: string; testCommand: string; detected: unknown }[];
};
