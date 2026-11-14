// The rows this UI reads, in one file so switching to @wisp/protocol's generated types (ts-rs, from
// crates/wisp-router-api) is one edit. Until then the truth is v1 (server/router.js report, routes/
// auto.js, runner.js summarize's `auto` and `route`) and the TypeScript reference port
// (git show v2-ts-server-reference:plugins/router/api/src/types.ts).

export const PLUGIN = 'wisp.router';

/** Auto's state as Settings → Auto reads it: one row on the router's own topic (assumed; see the report). */
export const KIND = { view: 'router_view', session: 'session' } as const;
export const TOPIC = { view: 'plugin:wisp.router:view', list: 'list' } as const;
export const VIEW_ROW = 'view';

export const GOALS = ['balanced', 'cheap', 'best'] as const;
export type Goal = (typeof GOALS)[number];
export const SCOUTS = ['off', 'big', 'all'] as const;
export type Scout = (typeof SCOUTS)[number];

/** One harness · model (· level) on Settings → Auto. */
export interface ArmReport {
  key: string;
  agent: string;
  model: string;
  effort: string;
  canon?: string;
  label: string;
  tier: number;
  coolingUntil?: number;
  coolingWhy?: string;
  /** ready · new · untried · cooling · gone */
  state: string;
  chance: number;
  n: number;
  usd: number;
  minutes: number;
  prior: boolean;
  inherited: boolean;
  from: string[];
  picks: number;
  blocked?: boolean;
  preferred?: boolean;
  byType: Record<string, { n: number; chance: number }>;
}

export interface RecentPick {
  id: string;
  key: string;
  label?: string;
  type: string;
  goal?: string;
  chance?: number;
  /** the reward so far: null while nothing says how it went */
  r: number | null;
  explored?: boolean;
  trying?: boolean;
  why?: string;
  at: number;
}

export interface RouterSettings {
  explore: boolean;
  allowed: string[] | null;
  blocked: string[];
  prefer: string[];
  habits: boolean;
  escalate: boolean;
  best2: boolean;
  scout: Scout | (string & {});
}

export interface PriorSource {
  name: string;
  url: string;
  date: string;
}

export interface ProjectTests {
  id: string;
  name: string;
  color?: string;
  testCommand: string;
  detected?: { command?: string; skip?: string } | null;
}

/** GET /router (v1 auto.view()), kept as the `router_view` row. */
export interface RouterView {
  priors: { version?: string; source?: string; sources?: Record<string, PriorSource> };
  learned?: number;
  routed?: number;
  picks?: number;
  corrections?: number;
  arms: ArmReport[];
  recent: RecentPick[];
  goal: Goal | (string & {});
  settings: RouterSettings;
  projects: ProjectTests[];
}

/** PATCH /router. */
export interface RouterPatch {
  goal?: string;
  explore?: boolean;
  allowed?: string[] | null;
  escalate?: boolean;
  best2?: boolean;
  habits?: boolean;
  blocked?: string[];
  prefer?: string[];
  scout?: string;
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

/** POST /router/preview. */
export interface PreviewArgs {
  prompt: string;
  attachments: number;
  goal?: string;
  team?: boolean;
  machine?: string;
}

export interface PreviewPick {
  agent: string;
  model: string;
  effort: string;
  key: string;
  label: string;
}

export type PreviewResult =
  | { pick: null; why: string }
  | {
      pick: PreviewPick;
      why: string;
      goal: string;
      type: string;
      size?: string;
      chance: number;
      usd: number;
      minutes: number;
      tier?: number;
      alternatives: RouteAlt[];
      suggest: Suggest | null;
    };

/** What Auto did after a run (summarize's `auto`). */
export interface SessionAuto {
  strategy?: string;
  busy: boolean;
  stage?: string;
  escalatedTo: string | null;
  escalatedFrom: string | null;
  /** why it moved on: tests | error | limit */
  reason: string | null;
  pick: { winner?: boolean; why?: string } | null;
}

/** A task row, the fields the router UI reads. */
export interface SessionRow {
  id: string;
  title: string;
  agent: string;
  model?: string;
  pending?: boolean;
  auto?: SessionAuto | null;
  route?: { label?: string; why?: string; chance?: number; switched?: boolean } | null;
}
