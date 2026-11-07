// What Auto believes about an arm (v1 Router #prior, #counts, #levels, estimate, taste, picks): a
// Beta posterior stacked from the benchmarks, your history on every kind of task and on this kind,
// and the same model at its other levels; and your taste, the share of your own picks.

import { splitKey } from '@wisp-plugin/router-api';
import { canon, effortOf, family, levelOf, ORDER, PRIORS, round, stemKey } from './keys.ts';
import type { PriorArm } from './keys.ts';
import type { RouterState } from './state.ts';

const PRIOR_CAP = 8; // benchmarks count as at most this many tasks, so your own soon outweigh them
const ALL_WEIGHT = 0.5; // your history on other kinds of task counts half
const LEVEL_WEIGHT = 0.5; // the same model's record at its other thinking levels counts half
export const HALF_LIFE_MS = 30 * 864e5; // models change: older outcomes fade
export const TASTE_HALF_LIFE_MS = 60 * 864e5; // habits change slower than models do

export interface Prior {
  a: number;
  b: number;
  usd: number;
  min: number;
  from: string[];
  inherited?: boolean;
}

export interface Estimate {
  a: number;
  b: number;
  mean: number;
  n: number;
  nAll: number;
  usd: number;
  minutes: number;
  prior: boolean;
  inherited: boolean;
  from: string[];
}

const priorCache = new Map<string, Prior | null>();

/** The same model measured at another level, shifted by how hard this one thinks. */
function shift(p: PriorArm, from: string, lvl: string, inherited: boolean): Prior {
  const n = p.a + p.b;
  const s = inherited ? Math.min(1, 4 / n) : 1;
  const mean = Math.min(0.95, Math.max(0.05, p.a / n + effortOf(lvl).chance - effortOf(from).chance));
  return { a: mean * n * s, b: (1 - mean) * n * s, usd: p.usd * (effortOf(lvl).usd / effortOf(from).usd), min: p.min * (effortOf(lvl).min / effortOf(from).min), ...(inherited && { inherited: true }), from: p.from };
}

/**
 * What the benchmarks say about an arm: its own row, else the same model at another level shifted
 * by how hard it thinks, else its family's (a new version) at less weight. Pure on the shipped file.
 */
export function priorOf(k: string): Prior | null {
  const hit = priorCache.get(k);
  if (hit !== undefined) return hit;
  const c = canon(k);
  const own = PRIORS.arms[c];
  let out: Prior | null = own ?? null;
  if (!own) {
    const stem = stemKey(k);
    const lvl = levelOf(k);
    const dist = (x: string): number => Math.abs(ORDER.indexOf(levelOf(x)) - ORDER.indexOf(lvl));
    const closest = (list: [string, PriorArm][]): [string, PriorArm] | undefined => list.sort(([x], [y]) => dist(x) - dist(y))[0];
    const kin = closest(Object.entries(PRIORS.arms).filter(([x]) => stemKey(x) === stem));
    if (kin) out = shift(kin[1], levelOf(kin[0]), lvl, false);
    else {
      // A new version inherits its family's record, with less weight.
      const fam = closest(Object.entries(PRIORS.arms).filter(([x]) => splitKey(x).agent === splitKey(c).agent && family(stemKey(x)) === family(stem)));
      out = fam ? shift(fam[1], levelOf(fam[0]), lvl, true) : null;
    }
  }
  // keys come from installed harnesses and the record: bounded in practice, capped anyway
  if (priorCache.size < 50_000) priorCache.set(k, out);
  return out;
}

export interface Counts {
  a: number;
  b: number;
  n: number;
  usd: number | null;
  ms: number | null;
}

/** Decayed counts for (kind, arm) from this user's routes; every name of the run counts. */
export function counts(st: RouterState, type: string, key: string, now: number): Counts {
  let a = 0;
  let b = 0;
  let n = 0;
  let usd = 0;
  let usdN = 0;
  let ms = 0;
  for (const s of st.statsOf(type, canon(key))?.values() ?? []) {
    const f = Math.pow(0.5, (now - (s.at || now)) / HALF_LIFE_MS);
    a += s.a * f;
    b += s.b * f;
    n += s.n;
    usd += s.usd;
    usdN += s.usdN;
    ms += s.ms;
  }
  return { a, b, n, usd: usdN ? usd / usdN : null, ms: n ? ms / n : null };
}

/** The same model at its other thinking levels, on this kind of task. */
function levels(st: RouterState, type: string, key: string, now: number): { a: number; b: number } {
  const c = canon(key);
  const stem = stemKey(key);
  const out = { a: 0, b: 0 };
  for (const k of st.canonsOf(type)) {
    if (k === c || stemKey(k) !== stem) continue;
    const x = counts(st, type, k, now);
    out.a += x.a;
    out.b += x.b;
  }
  return out;
}

/** Beta posterior for an arm on a kind of task, plus what it usually costs. */
export function estimate(st: RouterState, type: string, key: string, now: number): Estimate {
  const p = priorOf(key);
  const prior = p ?? { a: 1, b: 1, usd: undefined, min: undefined };
  const scale = Math.min(1, PRIOR_CAP / Math.max(1, prior.a + prior.b));
  const mine = counts(st, type, key, now);
  const all = counts(st, '*', key, now);
  const kin = levels(st, type, key, now);
  // A flat Beta(1, 1) underneath only when the benchmarks say nothing: it would pull every
  // measured chance toward a coin flip.
  const flat = p ? 0 : 1;
  const a = flat + prior.a * scale + (all.a - mine.a) * ALL_WEIGHT + kin.a * LEVEL_WEIGHT + mine.a;
  const b = flat + prior.b * scale + (all.b - mine.b) * ALL_WEIGHT + kin.b * LEVEL_WEIGHT + mine.b;
  // Cost and time: the benchmarks' guess, pulled toward what this user's runs actually cost.
  const blend = (own: number | null, n: number, guess: number): number => (own === null ? guess : (guess * 3 + own * n) / (3 + n));
  const usd = blend(all.usd, all.n, prior.usd ?? 0.3);
  const minutes = blend(all.ms === null ? null : all.ms / 60_000, all.n, prior.min ?? 5);
  return { a, b, mean: a / (a + b), n: mine.n, nAll: all.n, usd: round(usd, 4), minutes, prior: !!p && !p.inherited, inherited: !!p?.inherited, from: p?.from ?? [] };
}

const decayed = (n: number, at: number, now: number): number => n * Math.pow(0.5, Math.max(0, now - at) / TASTE_HALF_LIFE_MS);

/**
 * Your share of picks for this run on this kind of task (other kinds count half, and the same model
 * at another level half again). 0 when you've never picked it.
 */
export function taste(st: RouterState, type: string, key: string, now: number): number {
  const c = canon(key);
  const stem = stemKey(key);
  const share = (t: string): { share: number; all: number } => {
    let same = 0;
    let near = 0;
    let all = 0;
    for (const [k, x] of st.tasteOf(t)) {
      const v = decayed(x.n, x.at, now);
      all += v;
      if (k === c) same += v;
      else if (stemKey(k) === stem) near += v;
    }
    return { share: all ? (same + 0.5 * near) / all : 0, all };
  };
  const here = share(type);
  // Few picks on this kind yet: lean on your picks overall.
  const w = Math.min(1, here.all / 5);
  return round(w * here.share + (1 - w) * share('*').share, 3);
}

/** How many times you picked this run yourself, on this kind and overall. */
export function picks(st: RouterState, type: string, key: string): { here: number; all: number } {
  const c = canon(key);
  return { here: Math.round(st.taste.get(`${type}|${c}`)?.n ?? 0), all: Math.round(st.taste.get(`*|${c}`)?.n ?? 0) };
}

/** The name you launch this run by (claude: rather than claude:opus:medium). */
export function formOf(st: RouterState, c: string): string | null {
  const raw = st.taste.get(`*|${c}`)?.raw;
  if (!raw) return null;
  let best: string | null = null;
  let n = -Infinity;
  for (const [k, v] of Object.entries(raw)) if (v > n) (best = k), (n = v);
  return best;
}
