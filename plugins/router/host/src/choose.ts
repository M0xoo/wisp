// Picking an arm (v1 Router.choose, levelUp, whyOf). Each arm's chance of success is drawn
// (Thompson-style) unless the pick is a preview, important or exploring is off; your taste is added;
// the best value for the goal wins: value × chance − expected $ − a price on your waiting time. Never
// pick and Prefer rules come on top. A better arm that isn't your habit is offered, not run.
//
// A pick only reads: arms the router hasn't seen yet are judged as the next sync would mark them.

import { armKey, classify, GOALS, isGoal, splitKey } from '@wisp-plugin/router-api';
import type { AgentInfo, ChooseArgs, Goal, Pick, Route, RouteAlt, Suggest } from '@wisp-plugin/router-api';
import { estimate, formOf, picks, taste } from './estimate.ts';
import type { Estimate } from './estimate.ts';
import { baseOf, byNamedLevel, candidates, canon, effortLabel, levelOf, levelsFor, ORDER, PRIORS, round, ruleMatches, stemOf, tierOf } from './keys.ts';
import type { Candidate } from './keys.ts';
import { betaSample, mulberry32 } from './math.ts';
import type { Rng } from './math.ts';
import type { RouterState } from './state.ts';

const MINUTE_USD = 0.05; // what a minute of waiting costs you, in the utility
const TASTE = 0.25; // your habit is worth up to this much chance of success
const PREFER = 0.1; // a Prefer rule from Settings
const SUGGEST_MARGIN = 0.04; // how much better (in chance) an arm must look to be suggested
const DRAWS = 200;

/** What a pick reads of the router besides its state. */
export interface PickEnv {
  st: RouterState;
  now: number;
  /** Settings → Auto, under whatever the caller passed */
  prefs(): Partial<ChooseArgs>;
  cooling(key: string): unknown;
  /** an arm's state, or what the next sync would make it */
  armState(base: string): 'ready' | 'new' | 'gone';
}

export type Arm = Candidate & { effort: string; base: string; est: Estimate; state: string; taste: number; preferred: boolean };

interface Opts {
  prompt: string;
  attachments: number;
  agents: AgentInfo[];
  goal: Goal;
  important: boolean;
  explore: boolean;
  exclude: string[];
  needDelegate: boolean;
  allowed: string[] | null;
  blocked: string[];
  prefer: string[];
  habits: boolean;
  scouted: { type?: string; size?: string } | null;
  minTier: number;
  preview: boolean;
  pin: string | null;
}

function optsOf(env: PickEnv, o: ChooseArgs): Opts {
  const given = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as ChooseArgs;
  const p: ChooseArgs = { ...env.prefs(), ...given };
  return {
    prompt: p.prompt ?? '', attachments: p.attachments ?? 0, agents: p.agents ?? [], goal: isGoal(p.goal) ? p.goal : 'balanced',
    important: !!p.important, explore: p.explore ?? true, exclude: p.exclude ?? [], needDelegate: !!p.needDelegate,
    allowed: p.allowed ?? null, blocked: p.blocked ?? [], prefer: p.prefer ?? [], habits: p.habits ?? true,
    scouted: p.scouted ?? null, minTier: p.minTier ?? 0, preview: !!p.preview, pin: p.pin ?? null,
  };
}

/** Every arm the goal allows: installed, not taken, at the goal's levels, not ruled out. */
function armsOf(env: PickEnv, o: Opts, type: string): Arm[] {
  const out = new Set(o.exclude.map(stemOf));
  const usable = candidates(o.agents, new Set(env.st.arms.keys())).filter((c) => (!o.needDelegate || c.delegates) && (!o.allowed || o.allowed.includes(c.agent)));
  const frontierOnly = o.goal === 'best' && usable.some((c) => tierOf(c.key) >= 3);
  const levelled = byNamedLevel(usable.filter((c) => !out.has(stemOf(c.key))), o.goal)
    .filter((c) => !frontierOnly || tierOf(c.key) >= 3)
    .flatMap((c) => levelsFor(c.efforts, o.goal, PRIORS.defaults[baseOf(canon(c.key))] ?? '').map((effort) => ({ ...c, key: armKey(c.agent, c.model, effort), effort, label: `${c.label}${effort ? ` · ${effortLabel(effort)}` : ''}`, base: c.key })))
    .filter((c) => !o.blocked.some((r) => ruleMatches(r, c.key, type)));
  // One run under several names (claude: and claude:opus:medium): keep the one you launch by, else
  // the model named outright (the harness default may not be what the benchmarks assume).
  const byCanon = new Map<string, (typeof levelled)[number]>();
  const named = (x: { key: string }): number => (splitKey(x.key).model ? 1 : 0);
  for (const c of levelled) {
    const k = canon(c.key);
    const have = byCanon.get(k);
    const form = formOf(env.st, k);
    const better = !have || c.key === form || (have.key !== form && (named(c) > named(have) || (named(c) === named(have) && c.key.length < have.key.length)));
    if (better) byCanon.set(k, c);
  }
  return [...byCanon.values()].map((c) => ({ ...c, est: estimate(env.st, type, c.key, env.now), state: env.armState(c.base), taste: o.habits ? taste(env.st, type, c.key, env.now) : 0, preferred: o.prefer.some((r) => ruleMatches(r, c.key, type)) }));
}

/** Balanced and Best run on the strongest tier that can run now; an arm that keeps failing is out. */
function narrow(arms: Arm[], o: Opts): Arm[] {
  const top = Math.max(...arms.map((x) => tierOf(x.key)));
  const floorTier = Math.max(o.minTier, o.goal === 'cheap' ? 0 : top);
  let out = arms;
  for (let t = floorTier; t > 0; t--) {
    const strong = out.filter((x) => tierOf(x.key) >= t);
    if (strong.length) {
      out = strong;
      break;
    }
  }
  const floor = out.filter((x) => !(x.est.n >= 5 && x.est.mean < 0.35));
  return floor.length ? floor : out;
}

type Utility = (x: Arm, theta: number, own?: boolean) => number;

const utilityFor = (V: number): Utility => (x, theta, own = true) => V * (theta + (own ? TASTE * x.taste + (x.preferred ? PREFER : 0) : 0)) - x.est.usd - MINUTE_USD * x.est.minutes;

function drawer(arms: Arm[], utility: Utility, fixed: boolean): (r: Rng) => Arm {
  // New arms on probation aren't run behind your back: they're suggested.
  const pool = arms.filter((x) => x.state !== 'new' || x.taste > 0);
  const list = pool.length ? pool : arms;
  return (r) => {
    let best = list[0] as Arm; // list is never empty: arms has one at least
    let bu = -Infinity;
    for (const x of list) {
      const u = utility(x, fixed ? x.est.mean : betaSample(x.est.a, x.est.b, r));
      if (u > bu) (best = x), (bu = u);
    }
    return best;
  };
}

const alt = (x: Arm): RouteAlt => ({ key: x.key, agent: x.agent, model: x.model, effort: x.effort, label: x.label, chance: round(x.est.mean), usd: round(x.est.usd) });

/** Pick an arm for a task, or null when nothing allowed can run now. */
export function choose(env: PickEnv, args: ChooseArgs, rng: Rng = Math.random): Pick | null {
  const o = optsOf(env, args);
  const guess = classify(o.prompt, { attachments: o.attachments });
  const type = o.scouted?.type || guess.type;
  const size = o.scouted?.size || guess.size;
  let arms = armsOf(env, o, type);
  if (!arms.length) return null;
  arms = arms.filter((x) => !env.cooling(x.key));
  if (!arms.length) return null; // everything allowed is at its limit: nothing to route to now
  arms = narrow(arms, o);
  const utility = utilityFor(GOALS[o.goal].value);
  const fixed = o.preview || o.important || !o.explore;
  const draw = drawer(arms, utility, fixed);
  const pinned = o.pin ? arms.find((x) => x.key === o.pin || canon(x.key) === canon(o.pin ?? '')) : undefined;
  const pick = pinned ?? draw(rng);
  // How likely this pick was: logged so the router's own choices can be corrected for later.
  let hits = 0;
  const sim = mulberry32(Math.floor(rng() * 2 ** 31));
  if (fixed || pinned) hits = DRAWS;
  else for (let i = 0; i < DRAWS; i++) if (draw(sim).key === pick.key) hits++;
  const byMean = [...arms].sort((p, q) => utility(q, q.est.mean) - utility(p, p.est.mean));
  const explored = !pinned && byMean[0]?.key !== pick.key;
  const suggest = o.explore ? suggestion(env, arms, pick, utility, type, o.goal) : null;
  const route: Route = {
    goal: o.goal, type, size, key: pick.key, effort: pick.effort, label: pick.label, chance: round(pick.est.mean), n: pick.est.n, usd: round(pick.est.usd), minutes: round(pick.est.minutes, 1),
    explored, trying: pick.state === 'new', tier: tierOf(pick.key), taste: pick.taste, ...(pinned && { pinned: true }),
    why: whyOf(pick, type, picks(env.st, type, pick.key), o.goal, { pinned: !!pinned, explored }),
    propensity: round(hits / DRAWS), alternatives: byMean.filter((x) => x.key !== pick.key).slice(0, 4).map(alt), ...(suggest && { suggest }), at: env.now,
  };
  return { agent: pick.agent, model: pick.model, effort: pick.effort, key: pick.key, label: pick.label, route };
}

/** Something that looks clearly better on the record than your habit: offered, not run. */
function suggestion(env: PickEnv, arms: Arm[], pick: Arm, utility: Utility, type: string, goal: Goal): Suggest | null {
  const plain = [...arms].sort((p, q) => utility(q, q.est.mean, false) - utility(p, p.est.mean, false));
  const rival = plain.find((x) => canon(x.key) !== canon(pick.key) && !x.preferred);
  if (!rival) return null;
  const better = rival.est.mean >= pick.est.mean + SUGGEST_MARGIN && utility(rival, rival.est.mean, false) > utility(pick, pick.est.mean, false);
  return better ? { ...alt(rival), trying: rival.state === 'new', why: whyOf(rival, type, picks(env.st, type, rival.key), goal, { suggest: true }) } : null;
}

/** Why this pick, in a few words: your habit, your record, the benchmarks, or the goal. */
export function whyOf(x: Arm, type: string, p: { here: number; all: number }, goal: Goal, o: { pinned?: boolean; explored?: boolean; suggest?: boolean } = {}): string {
  const pct = `${Math.round(x.est.mean * 100)}%`;
  const parts: string[] = [];
  if (o.suggest) parts.push(x.est.n >= 3 ? `${pct} on your ${type} tasks (${x.est.n})` : `${pct} expected from public benchmarks`);
  else if (o.explored) parts.push('trying an alternative to learn');
  else if (x.taste >= 0.2 && p.here >= 3) parts.push(`your usual for ${type} tasks (${p.here} of yours)`);
  else if (x.taste >= 0.2 && p.all >= 3) parts.push(`your usual pick (${p.all} of yours)`);
  else if (x.taste >= 0.2) parts.push('the model you usually run');
  else if (x.est.n >= 3) parts.push(`${pct} on your ${type} tasks (${x.est.n})`);
  else if (x.est.prior) parts.push(`${pct} expected from public benchmarks`);
  else if (x.est.inherited) parts.push(`${pct} expected from its family's benchmarks`);
  else parts.push(`${pct} expected`);
  if (x.preferred) parts.push('you prefer it');
  if (x.effort && !o.suggest) parts.push(`${effortLabel(x.effort)} thinking for ${GOALS[goal].label}`);
  if (o.pinned) parts.push('as previewed');
  return parts.join(' · ');
}

/**
 * A hand-over that keeps the model and thinks harder: a run at low or medium that failed goes again
 * at high (low, then failures at high, solves more than high everywhere, for less), one at high goes
 * to x-high. null when there's no level up.
 */
export function levelUp(env: PickEnv, route: Partial<Route> & { key?: string }, agents: readonly AgentInfo[]): Pick | null {
  if (!route.key) return null;
  const { agent, model } = splitKey(route.key);
  const lvl = levelOf(route.key);
  const a = agents.find((x) => x.id === agent && x.available);
  const m = a?.models?.find((x) => x.id === model);
  const efforts = m?.efforts ?? a?.efforts ?? [];
  const to = !lvl ? null : ORDER.indexOf(lvl) < ORDER.indexOf('high') ? 'high' : lvl === 'high' ? 'xhigh' : null;
  if (!to || !efforts.includes(to)) return null;
  const key = armKey(agent, model, to);
  if (env.cooling(key)) return null;
  const est = estimate(env.st, route.type || '*', key, env.now);
  const label = `${route.label?.replace(/ · (Minimal|Low|Medium|High)$/, '') || key} · ${effortLabel(to)}`;
  const base: Route = { goal: 'balanced', type: '*', size: 'S', effort: '', label: '', chance: 0, n: 0, usd: 0, minutes: 0, explored: false, trying: false, tier: tierOf(key), taste: 0, why: '', propensity: 1, alternatives: [], at: env.now, key };
  return { agent, model, effort: to, key, label, route: { ...base, ...route, key, effort: to, label, chance: round(est.mean), usd: round(est.usd), why: 'The same model, thinking harder', at: env.now } };
}
