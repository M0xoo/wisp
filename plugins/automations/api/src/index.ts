// @wisp-plugin/automations-api: the contract of wisp.automations (v1 server/triggers.js, recipes.js,
// hooks.js, services/webhooks.js, routes/automations.js, routes/hooks.js). Triggers start tasks without
// you (a schedule, a CI failure, a labelled issue, a task finishing or marked done, an outside call to a
// secret URL); recipes are saved prompts with {params}. The schedule helpers are pure and exported here
// because crew check-ins and scheduled triggers both read schedules. No I/O, no node: imports.

import type { Json } from '@wisp/kernel';

export { ScheduleError, CRON_ALIASES, parseCron, cronMatches, nextRun, readSchedule } from './cron.ts';
export type { Cron } from './cron.ts';
export { toCron, compact, DAY_NAMES } from './words.ts';
export { cronWords, clock24, midSentence } from './says.ts';

/** Triggers that start when an outside service calls their secret URL. */
export const HOOK_KINDS: ReadonlySet<string> = new Set(['webhook', 'slack', 'linear']);
/** Triggers that fire from a task's events. */
export const TASK_KINDS: ReadonlySet<string> = new Set(['finished', 'done']);
/** Triggers that poll GitHub through `gh`. */
export const GH_KINDS: ReadonlySet<string> = new Set(['ci', 'issues']);
/** What the crew editor's "Also starts when" offers. */
export const MEMBER_KINDS: ReadonlySet<string> = new Set(['finished', 'done', 'ci']);
/** Every trigger kind. */
export const TRIGGER_KINDS: ReadonlySet<string> = new Set(['schedule', 'ci', 'issues', 'finished', 'done', ...HOOK_KINDS]);

export type TriggerKind = 'schedule' | 'ci' | 'issues' | 'finished' | 'done' | 'webhook' | 'slack' | 'linear';
export type Mode = 'plan' | 'edits' | 'auto';

/** Where a task came from (v1 `session.origin`): kept in the task's ext slot `wisp.automations`. */
export interface Origin {
  kind: 'trigger' | 'recipe';
  id: string;
  name: string;
}

/** A trigger held back by Automations stop at (budget): the row says it skipped, and why. */
export interface Held {
  at: number;
  why: string;
  until?: number;
  agent: string;
  load?: boolean;
}

/** One call at a hook's URL, the newest five kept. */
export interface Delivery {
  at: number;
  result: 'started' | 'skipped' | 'rejected';
  why: string;
  session?: string | null;
}

/** A trigger as the HTTP API and the UI see it (v1 triggerView): no secret, no bookkeeping. */
export interface TriggerView {
  id: string;
  name: string;
  kind: TriggerKind;
  enabled: boolean;
  cwd: string;
  /** a crew member's id: the work goes to them instead of a new task */
  crew: string;
  prompt: string;
  recipeId: string;
  params: Record<string, Json>;
  agent: string;
  model: string;
  effort: string;
  mode: Mode;
  cron: string;
  branch: string;
  label: string;
  /** minutes between GitHub polls */
  every: number;
  createdAt: number;
  lastRunAt: number | null;
  lastSessionId: string | null;
  lastPolledAt: number | null;
  lastError: string;
  runs: number;
  held?: Held;
  lastMinute?: number;
  // hooks only
  token?: string;
  header?: string;
  channel?: string;
  keyword?: string;
  users?: string[];
  deliveries?: Delivery[];
  lastHookAt?: number | null;
  hasSecret?: boolean;
  /** a Slack trigger saved before people had to be named: anyone in the channel can start it */
  open?: boolean;
  /** what it has seen (CI runs, issues, tasks), counted */
  watching: number;
  nextAt: number | null;
}

export interface Recipe {
  id: string;
  name: string;
  prompt: string;
  /** '' = whichever project it's run in */
  cwd: string;
  agent: string;
  model: string;
  effort: string;
  mode: Mode | '';
  createdAt: number;
  updatedAt: number;
  runs: number;
  lastRunAt: number | null;
}

export interface RecipeView extends Recipe {
  params: string[];
  /** a recipe another plugin contributes (`automations.recipes` point): read-only here */
  plugin?: { id: string; name: string };
}

/** `automations.recipes@1`: a recipe a plugin brings (v1 spells' recipes). Read-only to the user. */
export interface PluginRecipe {
  id: string;
  name: string;
  prompt: string;
  cwd?: string;
  agent?: string;
  model?: string;
  effort?: string;
  mode?: Mode;
  plugin?: { id: string; name: string };
}

/** What `automations.syncMember` needs of a crew member (sent by the crew, so nothing calls back). */
export interface MemberRef {
  id: string;
  name: string;
  cwd: string;
  /** the member works on another machine: its folder isn't one here */
  machine?: string;
}

export interface RecipeRunArgs {
  key: string;
  params?: Record<string, Json>;
  /** positional words (`wisp run release 0.8.0`), filled into the params in order */
  words?: string[];
  cwd?: string;
  agent?: string;
  model?: string;
  effort?: string;
  mode?: Mode;
}

// ---------- commands (permission `automations:<verb>` unless noted) ----------

export const COMMANDS = {
  triggers: 'automations.triggers', // { crew? } → TriggerView[]   (read-only)
  createTrigger: 'automations.trigger.create', // body → TriggerView
  updateTrigger: 'automations.trigger.update', // { id, ...body } → TriggerView
  removeTrigger: 'automations.trigger.remove', // { id } → { ok }
  runNow: 'automations.runNow', // { id } → { started: Json[], trigger: TriggerView }
  recipes: 'automations.recipes', // {} → RecipeView[]   (read-only)
  recipe: 'automations.recipe', // { key } → RecipeView   (read-only; by id, else loosely by name)
  createRecipe: 'automations.recipe.create', // body → RecipeView
  updateRecipe: 'automations.recipe.update', // { key, ...body } → RecipeView
  removeRecipe: 'automations.recipe.remove', // { key } → { ok }
  runRecipe: 'automations.recipe.run', // RecipeRunArgs → { id, agent, mode, origin, … }
  deliver: 'automations.deliver', // { token, raw (base64), headers } → { status, body }   (permission automations:hook)
  release: 'automations.release', // { agent } → { n }   (a window reset early: rows held for it stop saying so)
  nextWake: 'automations.nextWake', // {} → { at: number | null }   (read-only; GET /status's nextWakeAt)
  // for the crew (permission crew:write / crew:read)
  syncMember: 'automations.syncMember', // { crewId, on, prevCwd?, member? } → {}
  memberKinds: 'automations.memberKinds', // { crewId } → string[]   (read-only: the member's `on`)
  memberLeft: 'automations.memberLeft', // { crewId, name } → { n }   (its triggers go off, unassigned)
  forgetMember: 'automations.forgetMember', // { crewId } → { n }   (its triggers go, as if never made)
} as const;

export const POINTS = {
  recipes: 'automations.recipes',
} as const;

/** The ext slot on tasks a trigger or recipe started: `{ origin }`. */
export const EXT = 'wisp.automations';
