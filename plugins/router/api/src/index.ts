// @wisp-plugin/router-api: the contract of wisp.router, Auto (v1 server/router.js, services/auto.js,
// routes/auto.js). When a task is created with agent 'auto', wisp.router picks the harness, model and
// thinking level through a `before:create` interceptor and stores how it picked (the route) in the
// session's ext slot `wisp.router`. It learns from what you pick yourself and from how runs went.
//
// The pure helpers below (keys, the task classifier, the limit reader, the reward) are what other
// plugins need without the router's state: the runtime reads usage limits with `infraError`, the
// pipeline reads `autoSettings` and `limitOf`. Anything that needs the benchmarks or the record goes
// through `routerService`.

import type { Json, ServiceRef } from '@wisp/kernel';
import type { StartArgs } from '@wisp-plugin/runtime-api';
import type { AgentInfo, ChooseArgs, CoolArgs, ObserveArgs, OverrideArgs, Pick, Route, Signals, StoredRoute, SummaryLike } from './types.ts';

export type * from './types.ts';

export const PLUGIN = 'wisp.router';
/** The session's ext slot: the Route Auto picked (and, before the pick, what the caller asked of it). */
export const EXT = 'wisp.router';
/** v1 `config.defaults.router`: Settings → Auto (explore, allowed, blocked, prefer, habits, escalate, best2, scout). */
export const SETTING = 'router';
/** v1 `config.defaults.models`: `models.auto` is Auto's goal. */
export const MODELS_SETTING = 'models';

export const GOALS = {
  cheap: { label: 'Cheap', value: 1, hint: 'Lowest cost that still gets it done' },
  balanced: { label: 'Balanced', value: 5, hint: 'Frontier models as their makers ship them, a level up where it pays' },
  best: { label: 'Best', value: 50, hint: 'Frontier models at high thinking; cost only breaks ties' },
} as const;
export type Goal = keyof typeof GOALS;
export const isGoal = (g: unknown): g is Goal => typeof g === 'string' && Object.hasOwn(GOALS, g);

export const TYPES = ['bug', 'feature', 'ui', 'test', 'refactor', 'docs', 'release', 'question'] as const;
export type TaskType = (typeof TYPES)[number];
export type Size = 'S' | 'M' | 'L';

/** Thinking levels wisp knows, weakest first. */
export const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Level = (typeof LEVELS)[number];
export const isLevel = (e: string): e is Level => (LEVELS as readonly string[]).includes(e);

// ---------- arm keys ----------

/** `agent:model[:effort]`: one harness × model × thinking level ('' is the default). */
export const armKey = (agent: string, model = '', effort = ''): string => `${agent}:${model || ''}${effort ? `:${effort}` : ''}`;

/** A trailing segment is a level only if wisp knows it, so a model id with a colon (llama3:8b) stays whole. */
export function splitKey(k: string): { agent: string; model: string; effort: string } {
  const i = k.indexOf(':');
  const rest = k.slice(i + 1);
  const j = rest.lastIndexOf(':');
  const tail = j >= 0 ? rest.slice(j + 1) : '';
  const effort = tail && isLevel(tail) ? tail : '';
  return { agent: k.slice(0, i), model: effort ? rest.slice(0, j) : rest, effort };
}

// ---------- task features ----------

const RULES: readonly (readonly [TaskType, RegExp])[] = [
  ['release', /\b(release|bump(ed)? (the )?version|publish|changelog for|tag v?\d)/i],
  ['docs', /\b(readme|docs?|documentation|typos?|comment(s)? in|jsdoc|docstring)\b/i],
  ['test', /\b(tests?|coverage|flaky|spec(s)?|e2e|unit test)\b/i],
  ['bug', /\b(fix|bug|broken|crash(es|ing)?|error|exception|fails?|failing|regression|doesn'?t work|not working|wrong|issue)\b/i],
  ['ui', /\b(ui|ux|button|css|layout|style|styling|color|colour|dark mode|dialog|modal|popup|screen|page|responsive|icon|animation|card|sidebar|toolbar)\b/i],
  ['refactor', /\b(refactor|clean ?up|rename|simplif(y|ies)|extract|reorgani[sz]e|dedupe|split)\b/i],
  ['question', /^(how|why|what|where|when|which|can|could|should|is|are|does|do)\b.*\?\s*$|\b(explain|investigate|look into|research|compare)\b/i],
];
const FILES = /[\w./-]+\.(js|ts|tsx|jsx|py|go|rs|rb|java|css|html|md|json|ya?ml)\b/g;

/** A coarse kind of task (the router learns per kind) and a size bucket. */
export function classify(prompt = '', o: { attachments?: number } = {}): { type: TaskType; size: Size } {
  const text = String(prompt);
  const type = RULES.find(([, re]) => re.test(text))?.[0] ?? 'feature';
  const files = (text.match(FILES) ?? []).length;
  const score = text.length / 400 + files + (o.attachments ?? 0);
  return { type, size: score < 1 ? 'S' : score < 4 ? 'M' : 'L' };
}

// ---------- limits ----------

export interface Limit {
  /** 'agent': the whole harness (a usage window); 'arm': one model (a rate limit) */
  scope: 'agent' | 'arm';
  ms: number;
  kind?: 'device' | 'capacity';
  /** a Codex 429 while its plan has room: a short pause */
  blip?: true;
}

const DEVICE_LIMIT = /\b(?:devices?|device[- ]session) limit|too many (?:devices|active sessions|concurrent sessions|sessions (?:are )?(?:active|open|signed in))|(?:maximum|max) (?:number of )?(?:devices|active sessions|concurrent sessions)|signed in on too many|concurrent session limit/i;
const USAGE = /session limit|usage limit|limit reached|resets \d|quota|exceeded your|insufficient (credit|balance|quota)|balance exhausted|payment required|\b402\b|billing/i;
const CAPACITY = /model is at capacity|capacity unavailable/i;
const RATE = /rate[- ]?limit|too many requests|\b429\b|overloaded|\b529\b|try again in a few minutes/i;

/** "resets 9pm" / "resets at 21:00" → ms until then (today, else tomorrow), capped at 6 h. */
function resetIn(t: string, now: number | undefined): number | null {
  const m = t.match(/resets?(?: at)? (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m || now === undefined) return null;
  const hour = Number(m[1]);
  const h = m[3] ? (hour % 12) + (/pm/i.test(m[3]) ? 12 : 0) : hour;
  const at = new Date(now);
  at.setHours(h, Number(m[2] ?? 0), 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return Math.min(6 * 3600_000, at.getTime() - now + 60_000);
}

/**
 * An error that says the harness can't run right now (a usage limit, a rate limit, no credit), not
 * that the model got the task wrong; null otherwise. `now` (the caller's clock) reads "resets 9pm".
 */
export function infraError(text = '', now?: number): Limit | null {
  const t = String(text);
  // Too many devices signed in (Codex): nothing to wait for. Before "session limit", Claude's window.
  if (DEVICE_LIMIT.test(t)) return { scope: 'agent', ms: 15 * 60_000, kind: 'device' };
  if (/usage_limit_reached/i.test(t) || USAGE.test(t)) return { scope: 'agent', ms: resetIn(t, now) ?? 60 * 60_000 };
  // A model OpenAI has no room for right now (openai/codex#59045): that model rests, others run.
  if (CAPACITY.test(t)) return { scope: 'arm', ms: 10 * 60_000, kind: 'capacity' };
  if (RATE.test(t)) return { scope: 'arm', ms: 10 * 60_000 };
  return null;
}

export const BLIP_MS = 60_000;

/**
 * A 429 says "too many requests", which Codex also answers while the plan still has room
 * (openai/codex#57084, #58530). With the account's windows known and none full, it's a one-minute
 * pause, not the 10 minutes a real rate limit rests the arm. Never another account's windows.
 */
export function limitOf(text = '', o: { agent?: string; windows?: readonly { used?: number }[] | null; now?: number } = {}): Limit | null {
  const limit = infraError(text, o.now);
  if (!limit || limit.scope !== 'arm' || limit.kind || o.agent !== 'codex') return limit;
  const known = (o.windows ?? []).filter((w) => Number.isFinite(w?.used));
  if (!known.length || known.some((w) => (w.used ?? 0) >= 0.995)) return limit;
  return { ...limit, ms: BLIP_MS, blip: true };
}

// ---------- outcomes ----------

const round = (x: number, d = 2): number => Math.round(x * 10 ** d) / 10 ** d;
const HERO = { done: 0.6, partial: 0.3, blocked: 0.1, info: 0.5 } as const;

/** The reward of a run, strongest signal first; null while nothing says how it went. */
export function reward(sig: Signals): number | null {
  // Moved to another harness or model in a follow-up: whatever happens next isn't this arm's.
  if (sig.switched) return 0.1;
  if (sig.merged) return 1;
  if (sig.feedback === 'up') return 1;
  if (sig.feedback === 'down') return 0;
  if (sig.closed) return 0.2;
  if (sig.rolledBack) return 0.1;
  if (sig.error || sig.check === 'error') return 0;
  // wisp's own test run beats the agent's word; a repair round and losing a best-of-2 cost some credit.
  if (sig.check === 'fail') return 0.1;
  if (sig.check === 'pass') return round(Math.max(0.3, (sig.repaired ? 0.6 : 0.8) - (sig.picked === false ? 0.15 : 0) - 0.1 * (sig.followups ?? 0)));
  const base = sig.hero ? HERO[sig.hero] : undefined;
  if (base === undefined) return null;
  return round(Math.max(0.05, base - 0.1 * (sig.followups ?? 0)));
}

// ---------- settings ----------

/** Settings → Auto, as v1 kept it in `config.defaults.router`. */
export interface RouterSetting {
  explore?: 'on' | 'off';
  allowed?: string[] | null;
  blocked?: string[];
  prefer?: string[];
  habits?: 'on' | 'off';
  escalate?: 'on' | 'off';
  best2?: 'on' | 'off';
  scout?: 'off' | 'big' | 'all';
}

export interface RouterOpts {
  explore: boolean;
  allowed: string[] | null;
  blocked: string[];
  prefer: string[];
  habits: boolean;
}

const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []);
const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The rules every pick reads (v1 services/auto.js opts). */
export function routerOpts(setting: unknown): RouterOpts {
  const r = rec(setting);
  const allowed = strings(r['allowed']);
  return { explore: r['explore'] !== 'off', allowed: Array.isArray(r['allowed']) && allowed.length ? allowed : null, blocked: strings(r['blocked']), prefer: strings(r['prefer']), habits: r['habits'] !== 'off' };
}

export const AUTO_DEFAULTS = { escalate: 'on', best2: 'off', scout: 'big' } as const;

/** Auto's steps after a run (v1 pipeline.js autoSettings): the pipeline reads them. */
export function autoSettings(setting: unknown): { escalate: boolean; best2: boolean; scout: 'off' | 'big' | 'all' } {
  const r = rec(setting);
  const scout = r['scout'];
  return { escalate: r['escalate'] !== 'off', best2: r['best2'] === 'on', scout: scout === 'off' || scout === 'big' || scout === 'all' ? scout : AUTO_DEFAULTS.scout };
}


// ---------- commands (permission `router:<read|write>`) ----------

export const COMMANDS = {
  decide: 'router.decide', // DecideArgs → Decision   (read-only: what Auto would run, and why)
  view: 'router.view', // {} → RouterView   (read-only: GET /router)
  preview: 'router.preview', // PreviewArgs → PreviewResult   (POST /router/preview)
  set: 'router.set', // RouterPatch → RouterView   (PATCH /router)
  reset: 'router.reset', // {} → RouterView   (forget outcomes and picks)
  signal: 'router.signal', // { id, patch: Signals } → StoredRoute | null   (feedback, rollback, a judge)
  signals: 'router.signals', // SummaryLike → {}   (a task's summary changed: its outcome so far)
  record: 'router.record', // { id, route } → {}   (a launch on a machine went out with this route)
  override: 'router.override', // OverrideArgs → {}   (a harness picked by hand after a preview)
  agents: 'router.agents', // { fresh?: boolean | string } → AgentInfo[]   (this computer's harnesses)
} as const;

/** `router.decide`: a create's arguments, plus what a launch knows that StartArgs doesn't. */
export type DecideArgs = StartArgs & {
  /** arm keys already taken (compare, hand-overs) */
  exclude?: string[];
  /** the lead of a team: a harness that can delegate */
  team?: boolean;
  important?: boolean;
  /** the preview you saw (v1 autoPin) */
  pin?: string;
  /** a machine's handle or name: route from its harnesses */
  machine?: string;
  /** false: the dice of a real launch; default true (the same answer every time) */
  preview?: boolean;
};

/**
 * What a caller may ask of Auto before it picks, in `StartArgs.ext['wisp.router']` (replaced by the
 * Route once picked): the preview pin, arms taken, a team lead, the scout's verdict.
 */
export interface RouterRequest {
  pin?: string;
  exclude?: string[];
  important?: boolean;
  team?: boolean;
  scouted?: { type?: string; size?: string };
  /** a harness picked by hand after Auto's preview showed `key` (v1 autoOverride) */
  override?: { key: string; type?: string };
}

export const EVENTS = {
  /** new harnesses or models showed up (they start on probation) */
  added: 'router.added', // { added: { key, label, state }[] }
} as const;

/** every router row (arms, stats, routes, taste, corrections, cooling): Settings → Auto watches it */
export const TOPIC = 'plugin:wisp.router:router' as const;

// ---------- service: router.service@1 ----------

/** The router for other plugins: the runtime's pipeline (hand-overs, limits), goal (agents here). */
export interface RouterService {
  /** pick an arm; null when nothing allowed can run now (no writes: sync happens on detection) */
  choose(o: ChooseArgs): Pick | null;
  /** the same model, thinking harder; null when there's no level up */
  levelUp(route: Route, agents?: AgentInfo[]): Pick | null;
  /** this computer's harnesses, as last detected ([] before the first detection) */
  here(): AgentInfo[];
  /** this computer's harnesses: the last ones detected, else detected now */
  agents(): Promise<AgentInfo[]>;
  /** detect again (`fresh`: one harness id, or all) */
  detect(o?: { fresh?: boolean | string }): Promise<AgentInfo[]>;
  route(id: string): StoredRoute | null;
  cooling(key: string): { until: number; why: string } | null;
  /** 1 small or free, 2 everyday, 3 frontier */
  tier(key: string): number;
  /** Auto's goal: `model` when it names one, else Settings */
  goal(model?: string): Goal;
  record(id: string, route: Route | (Partial<Route> & { key: string; type: string; manual?: boolean })): void;
  signal(id: string, patch: Signals): StoredRoute | null;
  signals(summary: SummaryLike): void;
  observe(o: ObserveArgs): { key: string; canon: string; type: string } | null;
  override(o: OverrideArgs): void;
  /** a harness (scope 'agent') or a model at every level hit a limit: skip it until it resets */
  cool(key: string, o?: CoolArgs): string;
  /** the run never got to work: forget it counted */
  void(id: string): void;
}

export const routerService: ServiceRef<RouterService> = {
  id: 'router.service',
  major: 1,
  permissions: {
    choose: 'router:read',
    levelUp: 'router:read',
    here: 'router:read',
    agents: 'router:read',
    detect: 'router:write',
    route: 'router:read',
    cooling: 'router:read',
    tier: 'router:read',
    goal: 'router:read',
    record: 'router:write',
    signal: 'router:write',
    signals: 'router:write',
    observe: 'router:write',
    override: 'router:write',
    cool: 'router:write',
    void: 'router:write',
  },
  readOnly: ['choose', 'levelUp', 'here', 'route', 'cooling', 'tier', 'goal'],
};

/** A Route is plain JSON by construction: this is the one place it meets `Json`'s index signature. */
export const routeJson = (r: Route): Json => r as unknown as Json;
