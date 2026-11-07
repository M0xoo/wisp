// Arms and what the benchmarks say about their names (v1 server/router.js, the top half). Every
// harness × model × thinking level is an arm (claude:opus:high; no level is the model's default).
// claude:, claude:opus and claude:opus:medium are one run under three names (canon()).

import { armKey, LEVELS, splitKey } from '@wisp-plugin/router-api';
import type { AgentInfo } from '@wisp-plugin/router-api';
import { LEVEL_COST, LEVEL_TIME } from './priors-build.ts';
import type { PriorArm, Priors } from './priors-build.ts';
import shipped from './priors.json' with { type: 'json' };

export const PRIORS: Priors = shipped;
export const PRIOR_INFO = { version: PRIORS.version, source: PRIORS.source, sources: PRIORS.sources };
export type { PriorArm };

/**
 * Thinking levels against medium: a shift in the chance of success and multipliers on cost and time,
 * from Anthropic's Opus 5.5 sweep; only for models the benchmarks don't cover, and outcomes take over.
 */
export const EFFORTS: Record<string, { chance: number; usd: number; min: number }> = {
  minimal: { chance: -0.08, usd: LEVEL_COST.minimal, min: LEVEL_TIME.minimal },
  low: { chance: -0.05, usd: LEVEL_COST.low, min: LEVEL_TIME.low },
  medium: { chance: 0, usd: 1, min: 1 },
  high: { chance: 0.03, usd: LEVEL_COST.high, min: LEVEL_TIME.high },
  xhigh: { chance: 0.04, usd: LEVEL_COST.xhigh, min: LEVEL_TIME.xhigh },
  max: { chance: 0.06, usd: LEVEL_COST.max, min: LEVEL_TIME.max },
};
export const ORDER: readonly string[] = LEVELS;
export const effortOf = (x: string): { chance: number; usd: number; min: number } => EFFORTS[x || 'medium'] ?? { chance: 0, usd: 1, min: 1 };

/**
 * The levels each goal may run at, where the harness has them ('' is the model's own default). Cheap
 * thinks low. Balanced runs the model as its makers ship it, or one step up (Sonnet scores 15 points
 * more at high). Best thinks hard; xhigh costs 2.5× high for a point or two, so it has to earn it.
 */
export function levelsFor(efforts: readonly string[] = [], goal = 'balanced', def = ''): string[] {
  const has = (e: string): boolean => efforts.includes(e);
  let band: string[];
  if (goal === 'cheap') band = ['minimal', 'low'].filter(has);
  else if (goal === 'best') band = ['high', 'xhigh'].filter(has);
  else {
    const up = ORDER.slice(ORDER.indexOf(def || 'medium') + 1).find(has);
    band = ['', ...(up && up !== 'xhigh' && up !== 'max' ? [up] : [])];
  }
  // The default named outright is the same run as '': keep one.
  if (def && band.includes('') && band.includes(def)) band = band.filter((e) => e !== def);
  return band.length ? band : [''];
}

/** Some harnesses bake the level into the model id (gemini-4-argon-high). */
export const SUFFIX = /-(minimal|low|medium|high|xhigh|max)$/;
const NAMED: Record<string, readonly string[]> = { cheap: ['minimal', 'low'], balanced: ['medium'], best: ['high', 'xhigh', 'max'] };

export const effortLabel = (e: string): string => (e === 'xhigh' ? 'X-High' : e.charAt(0).toUpperCase() + e.slice(1));

/** The harness · model an arm runs on, whatever its level: probation, cooling and compare go by it. */
export const baseOf = (k: string): string => {
  const { agent, model } = splitKey(k);
  return armKey(agent, model);
};

/** Versions stripped, and a level in the id: claude-sonnet-5-5 and -5-6 are one family. */
export const family = (k: string): string => k.replace(SUFFIX, '').replace(/[-.]?\d+([.-]\d+)*/g, '');

const canonCache = new Map<string, string>();
/** What an arm really runs: the harness's default model named and the model's default level named. */
export function canon(key: string): string {
  const hit = canonCache.get(key);
  if (hit !== undefined) return hit;
  const { agent, model, effort } = splitKey(key);
  const m = model || PRIORS.aliases[agent] || '';
  const e = effort || PRIORS.defaults[armKey(agent, m)] || '';
  const out = armKey(agent, m, e);
  // keys come from the harnesses installed and the record: a few hundred at most, kept for the process
  if (canonCache.size < 50_000) canonCache.set(key, out);
  return out;
}

/** The level an arm thinks at ('' when nobody knows), and the arm without it. */
export const levelOf = (k: string): string => splitKey(canon(k)).effort || splitKey(k).model.match(SUFFIX)?.[1] || '';
export const stemKey = (k: string): string => {
  const { agent, model } = splitKey(canon(k));
  return armKey(agent, model.replace(SUFFIX, ''));
};
export const stemOf = (k: string): string => baseOf(canon(k)).replace(SUFFIX, '');

const SMALL = ['haiku', 'flash', 'mini', 'nano', 'lite', 'small', 'free', 'fast', 'low'];
const STRONG = ['opus', 'argon', 'ultra', 'pro', 'xhigh', 'high', 'max'];

/**
 * How strong a model is: 1 small or free, 2 everyday, 3 frontier. From the benchmarks' tiers where
 * they cover it, else from its name (whole segments only: "gemini" is not "mini"), else its family's.
 */
export function tierOf(key: string): number {
  const c = baseOf(canon(key));
  const stem = c.replace(SUFFIX, '');
  const tiers = PRIORS.tiers;
  const known = tiers[c] ?? tiers[stem];
  if (known) return known;
  const { agent, model } = splitKey(c);
  const seg = model.toLowerCase().split(/[-/.:_]/);
  const named = (list: readonly string[]): boolean => seg.some((x) => list.includes(x));
  if (named(SMALL)) return 1;
  const fam = Object.entries(tiers).find(([k]) => splitKey(k).agent === agent && family(k) === family(stem))?.[1];
  if (fam) return fam;
  if (named(STRONG)) return 3;
  return 2;
}

/** The harness · models the benchmarks know, whatever level they were measured at. */
export const PRIOR_BASES = new Set(Object.keys(PRIORS.arms).map((k) => baseOf(k).replace(SUFFIX, '')));
const knownToPriors = (k: string): boolean => PRIOR_BASES.has(baseOf(canon(k)).replace(SUFFIX, '')) || PRIOR_BASES.has(k.replace(SUFFIX, ''));
const PRIOR_FAMILIES = [...PRIOR_BASES].map(family);

export interface Candidate {
  key: string;
  agent: string;
  model: string;
  label: string;
  efforts: string[];
  delegates: boolean;
}

/**
 * The arms wisp may route to: each harness's default model, the models the priors know, models with
 * history here, and new models in a known family (on probation).
 */
export function candidates(agents: readonly AgentInfo[], known: ReadonlySet<string>): Candidate[] {
  const out: Candidate[] = [];
  const fams = new Set([...[...known].map(family), ...PRIOR_FAMILIES]);
  for (const a of agents) {
    if (!a.available) continue;
    const ids = new Set(['', ...(a.models ?? []).map((m) => m.id)]);
    for (const id of ids) {
      const k = armKey(a.id, id);
      if (id !== '' && !knownToPriors(k) && !known.has(k) && !fams.has(family(k))) continue;
      const m = (a.models ?? []).find((x) => x.id === id);
      out.push({ key: k, agent: a.id, model: id, label: `${a.name}${id ? ` · ${m?.label || id}` : ''}`, efforts: m?.efforts ?? a.efforts ?? [], delegates: a.delegates !== false });
    }
  }
  return out;
}

/** Among a model's variants with the level in its id, the goal picks the ones at its levels. */
export function byNamedLevel<C extends { key: string; model: string; efforts: string[] }>(cands: C[], goal: string): C[] {
  const want = NAMED[goal] ?? NAMED['balanced'] ?? [];
  const named = (c: C): string | undefined => (!c.efforts.length ? c.model.match(SUFFIX)?.[1] : undefined);
  const fits = new Set(cands.filter((c) => want.includes(named(c) ?? '')).map((c) => stemOf(c.key)));
  return cands.filter((c) => {
    const n = named(c);
    return !n || want.includes(n) || !fits.has(stemOf(c.key));
  });
}

/**
 * A rule from Settings → Auto (never pick, prefer): 'claude' (the harness), 'claude:sonnet' (that
 * model at every level) or 'claude:sonnet:high', optionally only for one kind of task ('…@ui').
 */
export function ruleMatches(rule: string, key: string, type?: string): boolean {
  const [what = '', only] = String(rule).split('@');
  if (only && only !== type) return false;
  if (!what.includes(':')) return splitKey(key).agent === what;
  const r = splitKey(what);
  const k = splitKey(key);
  const c = splitKey(canon(key));
  if (r.agent !== k.agent) return false;
  const sameModel = r.model === k.model || r.model === c.model || canon(armKey(r.agent, r.model)) === canon(armKey(k.agent, k.model));
  if (!sameModel) return false;
  return !r.effort || r.effort === (k.effort || c.effort);
}

export const round = (x: number, d = 2): number => Math.round(x * 10 ** d) / 10 ** d;
