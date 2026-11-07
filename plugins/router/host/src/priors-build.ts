// Turns public benchmark rows (tools/priors-sources.json) into Auto's starting estimates
// (src/priors.json). Run by tools/priors.ts; the tests check the shipped file is what this makes from
// the sources. The port of v1 server/priors-build.js, number for number.

/** Cost and time of a thinking level, against medium: Anthropic's Opus 5.5 sweep, CursorBench for max. */
export const LEVEL_COST = { minimal: 0.4, low: 0.52, medium: 1, high: 1.38, xhigh: 3.5, max: 6.7 } as const;
export const LEVEL_TIME = { minimal: 0.6, low: 0.7, medium: 1, high: 1.3, xhigh: 2, max: 3 } as const;
type LevelName = keyof typeof LEVEL_COST;

export interface SourceRow {
  arm: string;
  bench: string;
  score: number;
  source: string;
  usd?: number;
  note?: string;
}

export interface PriorSources {
  anchor: { arm: string; chance: number; usd: number };
  rows: SourceRow[];
  same?: { a: string; b: string; source: string }[];
  helpers?: string[];
  sources: Record<string, { name: string; url: string; date: string }>;
  prices: Record<string, [number, number]>;
  tiers: Record<string, number | string>;
  defaults: Record<string, string>;
  aliases: Record<string, string>;
  minutes: Record<string, number | string>;
  strength: number;
}

export interface PriorArm {
  a: number;
  b: number;
  usd: number;
  min: number;
  from: string[];
}

export interface Priors {
  version: string;
  source: string;
  sources: Record<string, { name: string; url: string; date: string }>;
  aliases: Record<string, string>;
  defaults: Record<string, string>;
  tiers: Record<string, number>;
  arms: Record<string, PriorArm>;
}

const round = (x: number, d = 3): number => Math.round(x * 10 ** d) / 10 ** d;
const LEVEL = /:(minimal|low|medium|high|xhigh|max)$/;
const levelOf = (k: string): string => k.match(LEVEL)?.[1] ?? '';
const baseOf = (k: string): string => k.replace(LEVEL, '');
/** a source's object without its `note` (prose for whoever edits the file) */
function strip<V>(o: Record<string, V | string> = {}): Record<string, V> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'note')) as Record<string, V>;
}
const level = (l: string): LevelName => (l in LEVEL_COST ? (l as LevelName) : 'medium');

interface Placed {
  chance: number;
  w: number;
}

/** Where every arm lands: spread out from the anchor until nothing more can be placed. */
function spread(src: PriorSources): { known: Map<string, number>; order: Map<string, number>; place: (b: string, arm: string) => Placed | null } {
  const { anchor, rows, same = [] } = src;
  const order = new Map([[anchor.arm, 0]]);
  const known = new Map([[anchor.arm, anchor.chance]]);
  const add = (k: string, v: number): void => void (known.set(k, v), order.set(k, order.size));
  const rowsOf = (b: string): SourceRow[] => rows.filter((r) => r.bench === b);
  // Only arms placed before this one count as references, so two arms never prop each other up.
  const place = (b: string, arm: string): Placed | null => {
    const before = order.get(arm) ?? Infinity;
    const refs = rowsOf(b).filter((r) => r.arm !== arm && known.has(r.arm) && (order.get(r.arm) ?? -1) < before);
    const row = rowsOf(b).find((r) => r.arm === arm);
    if (!refs.length || !row) return null;
    const scale = refs.reduce((s, r) => s + (known.get(r.arm) ?? 0) / r.score, 0) / refs.length;
    // A row about a predecessor (its note names the model it stands in for) counts half.
    return { chance: row.score * scale, w: row.note ? 0.5 : 1 };
  };
  const tie = (): boolean => {
    let moved = false;
    for (const s of same) {
      const a = known.get(s.a);
      const b = known.get(s.b);
      if (a !== undefined && b === undefined) (add(s.b, a), (moved = true));
      if (b !== undefined && a === undefined) (add(s.a, b), (moved = true));
    }
    return moved;
  };
  const benches = [...new Set(rows.map((r) => r.bench))];
  for (let moved = true; moved; ) {
    moved = tie();
    for (const b of benches)
      for (const r of rowsOf(b)) {
        if (known.has(r.arm)) continue;
        const p = place(b, r.arm);
        if (p) (add(r.arm, p.chance), (moved = true));
      }
  }
  return { known, order, place };
}

/** Each arm (but the anchor) averaged over every benchmark that can place it, and its sources. */
function settle(src: PriorSources, known: Map<string, number>, place: (b: string, arm: string) => Placed | null): { final: Map<string, number>; from: Map<string, string[]> } {
  const { anchor, rows, same = [] } = src;
  const benches = [...new Set(rows.map((r) => r.bench))];
  const final = new Map<string, number>();
  const from = new Map<string, string[]>();
  const tied = new Set(same.flatMap((s) => [s.a, s.b]));
  for (const [arm, chance] of known) {
    const srcs = new Set(rows.filter((r) => r.arm === arm).map((r) => r.source));
    if (arm === anchor.arm || (tied.has(arm) && !rows.some((r) => r.arm === arm))) final.set(arm, chance);
    else {
      const ps = benches.map((b) => place(b, arm)).filter((p): p is Placed => p !== null);
      const w = ps.reduce((s, p) => s + p.w, 0);
      final.set(arm, w ? ps.reduce((s, p) => s + p.chance * p.w, 0) / w : chance);
    }
    for (const s of same) if (s.a === arm || s.b === arm) srcs.add(s.source);
    from.set(arm, [...srcs]);
  }
  return { final, from };
}

/** Cost: measured next to the anchor on the same benchmark where possible, else from prices. */
function costs(src: PriorSources): { usdOf(arm: string): number; minutesOf(arm: string): number } {
  const { anchor, rows } = src;
  const benches = [...new Set(rows.map((r) => r.bench))];
  const rowsOf = (b: string): SourceRow[] => rows.filter((r) => r.bench === b);
  const blend = ([i, o]: [number, number]): number => (i + o) / 2;
  const anchorPrice = blend(src.prices[baseOf(anchor.arm)] ?? [1, 1]);
  const tiers = strip<number>(src.tiers);
  const tierOf = (base: string): number => tiers[base] ?? Object.entries(tiers).find(([k]) => base.startsWith(k))?.[1] ?? 2;
  const defaults = strip<string>(src.defaults);
  const levelFor = (arm: string): { at: LevelName; def: LevelName } => ({ at: level(levelOf(arm) || defaults[baseOf(arm)] || 'medium'), def: level(defaults[baseOf(arm)] || 'medium') });
  const usdOf = (arm: string): number => {
    const measured = benches
      .map((b) => {
        const mine = rowsOf(b).find((r) => r.arm === arm && typeof r.usd === 'number');
        const ref = rowsOf(b).find((r) => r.arm === anchor.arm && typeof r.usd === 'number');
        return mine?.usd !== undefined && ref?.usd !== undefined ? (anchor.usd * mine.usd) / ref.usd : null;
      })
      .filter((x): x is number => x !== null);
    if (measured.length) return measured.reduce((a, b) => a + b) / measured.length;
    const { at, def } = levelFor(arm);
    const p = src.prices[baseOf(arm)];
    const per = p ? (anchor.usd * blend(p)) / anchorPrice : anchor.usd * ({ 1: 0.2, 2: 0.5, 3: 1 }[tierOf(baseOf(arm))] ?? 0.5);
    return per * (LEVEL_COST[at] / LEVEL_COST[def]);
  };
  const minutesOf = (arm: string): number => {
    const base = baseOf(arm);
    const m = strip<number>(src.minutes);
    const at = m[base] ?? Object.entries(m).find(([k]) => base.startsWith(k))?.[1] ?? 3;
    const l = levelFor(arm);
    return at * (LEVEL_TIME[l.at] / LEVEL_TIME[l.def]);
  };
  return { usdOf, minutesOf };
}

export function buildPriors(src: PriorSources): Priors {
  const { known, place } = spread(src);
  const { final, from } = settle(src, known, place);
  const { usdOf, minutesOf } = costs(src);
  const n = src.strength;
  const arms: Record<string, PriorArm> = {};
  for (const [arm, c] of [...final].sort(([a], [b]) => a.localeCompare(b))) {
    if ((src.helpers ?? []).includes(arm)) continue;
    const chance = Math.min(0.95, Math.max(0.05, c));
    // A guess that rests only on predecessors counts half.
    const onlyKin = src.rows.filter((r) => r.arm === arm).every((r) => r.note);
    const s = onlyKin ? n / 2 : n;
    arms[arm] = { a: round(chance * s), b: round((1 - chance) * s), usd: round(usdOf(arm)), min: round(minutesOf(arm), 1), from: from.get(arm) ?? [] };
  }
  const dates = Object.values(src.sources).map((s) => s.date).sort();
  return {
    version: `bench-${dates.at(-1) ?? ''}`,
    source: `Public benchmarks (${Object.keys(src.sources).length} sources, ${dates[0] ?? ''} to ${dates.at(-1) ?? ''}), placed against Claude Code's default (Opus 5.5 at medium). See scripts/priors-sources.json.`,
    sources: src.sources,
    aliases: strip<string>(src.aliases),
    defaults: strip<string>(src.defaults),
    tiers: strip<number>(src.tiers),
    arms,
  };
}
