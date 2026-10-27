// Turns public benchmark rows (scripts/priors-sources.json) into Auto's starting estimates
// (server/router-priors.json). Run by scripts/priors.mjs; the tests check the shipped file is
// what this makes from the sources.

// Cost and time of a thinking level, against medium: Anthropic's Opus 5.5 sweep (low 0.52×,
// high 1.38×, xhigh 3.5× the cost of medium), CursorBench for max.
export const LEVEL_COST = { minimal: 0.4, low: 0.52, medium: 1, high: 1.38, xhigh: 3.5, max: 6.7 };
export const LEVEL_TIME = { minimal: 0.6, low: 0.7, medium: 1, high: 1.3, xhigh: 2, max: 3 };

const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const levelOf = (k) => k.match(/:(minimal|low|medium|high|xhigh|max)$/)?.[1] || '';
const baseOf = (k) => k.replace(/:(minimal|low|medium|high|xhigh|max)$/, '');
const strip = (o = {}) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'note'));

export function buildPriors(src) {
  const { anchor, rows, same = [], helpers = [] } = src;
  const order = new Map([[anchor.arm, 0]]);
  const known = new Map([[anchor.arm, anchor.chance]]);
  const add = (k, v) => (known.set(k, v), order.set(k, order.size));
  // Two names for one run (a model and the score it was published under) share their chance.
  const tie = () => {
    let moved = false;
    for (const s of same) {
      if (known.has(s.a) && !known.has(s.b)) (add(s.b, known.get(s.a)), (moved = true));
      if (known.has(s.b) && !known.has(s.a)) (add(s.a, known.get(s.b)), (moved = true));
    }
    return moved;
  };
  const benches = [...new Set(rows.map((r) => r.bench))];
  const rowsOf = (b) => rows.filter((r) => r.bench === b);
  // A row about a predecessor (its note names the model it stands in for) counts half.
  const weight = (r) => (r.note ? 0.5 : 1);
  // Where a benchmark places an arm: its score, scaled by the arms there whose chance is known.
  // Only arms placed before this one count as references, so two arms never prop each other up.
  const place = (known, b, arm) => {
    const before = order.has(arm) ? order.get(arm) : Infinity;
    const refs = rowsOf(b).filter((r) => r.arm !== arm && known.has(r.arm) && (order.get(r.arm) ?? -1) < before);
    const row = rowsOf(b).find((r) => r.arm === arm);
    if (!refs.length || !row) return null;
    const scale = refs.reduce((s, r) => s + known.get(r.arm) / r.score, 0) / refs.length;
    return { chance: row.score * scale, w: weight(row), source: row.source };
  };
  // 1. Spread out from the anchor until nothing more can be placed.
  for (let moved = true; moved; ) {
    moved = tie();
    for (const b of benches)
      for (const r of rowsOf(b)) {
        if (known.has(r.arm)) continue;
        const p = place(known, b, r.arm);
        if (p) (add(r.arm, p.chance), (moved = true));
      }
  }
  // 2. Each arm (but the anchor) averaged over every benchmark that can place it.
  const final = new Map();
  const from = new Map();
  const tied = new Set(same.flatMap((s) => [s.a, s.b]));
  for (const arm of known.keys()) {
    const srcs = new Set(rows.filter((r) => r.arm === arm).map((r) => r.source));
    if (arm === anchor.arm || (tied.has(arm) && !rows.some((r) => r.arm === arm))) {
      final.set(arm, known.get(arm));
    } else {
      const ps = benches.map((b) => place(known, b, arm)).filter(Boolean);
      const w = ps.reduce((s, p) => s + p.w, 0);
      final.set(arm, w ? ps.reduce((s, p) => s + p.chance * p.w, 0) / w : known.get(arm));
    }
    for (const s of same) if (s.a === arm || s.b === arm) srcs.add(s.source);
    from.set(arm, [...srcs]);
  }
  // Cost: measured next to the anchor on the same benchmark where possible, else from prices.
  const priceOf = (base) => src.prices[base] || null;
  const blend = ([i, o]) => (i + o) / 2;
  const anchorPrice = blend(priceOf(baseOf(anchor.arm)));
  const tiers = strip(src.tiers);
  const tierOf = (base) => tiers[base] ?? Object.entries(tiers).find(([k]) => base.startsWith(k))?.[1] ?? 2;
  const defaults = strip(src.defaults);
  const usdOf = (arm) => {
    const measured = benches
      .map((b) => {
        const mine = rowsOf(b).find((r) => r.arm === arm && typeof r.usd === 'number');
        const ref = rowsOf(b).find((r) => r.arm === anchor.arm && typeof r.usd === 'number');
        return mine && ref ? (anchor.usd * mine.usd) / ref.usd : null;
      })
      .filter((x) => x !== null);
    if (measured.length) return measured.reduce((a, b) => a + b) / measured.length;
    const base = baseOf(arm);
    const level = levelOf(arm) || defaults[base] || 'medium';
    const rel = LEVEL_COST[level] / LEVEL_COST[defaults[base] || 'medium'];
    const p = priceOf(base);
    const per = p ? (anchor.usd * blend(p)) / anchorPrice : anchor.usd * { 1: 0.2, 2: 0.5, 3: 1 }[tierOf(base)];
    return per * rel;
  };
  const minutesOf = (arm) => {
    const base = baseOf(arm);
    const m = strip(src.minutes);
    const at = m[base] ?? Object.entries(m).find(([k]) => base.startsWith(k))?.[1] ?? 3;
    const level = levelOf(arm) || defaults[base] || 'medium';
    return at * (LEVEL_TIME[level] / LEVEL_TIME[defaults[base] || 'medium']);
  };
  const n = src.strength;
  const arms = {};
  for (const [arm, c] of [...final].sort(([a], [b]) => a.localeCompare(b))) {
    if (helpers.includes(arm)) continue;
    const chance = Math.min(0.95, Math.max(0.05, c));
    // A guess that rests only on predecessors counts half.
    const onlyKin = rows.filter((r) => r.arm === arm).every((r) => r.note);
    const s = onlyKin ? n / 2 : n;
    arms[arm] = { a: round(chance * s), b: round((1 - chance) * s), usd: round(usdOf(arm)), min: round(minutesOf(arm), 1), from: from.get(arm) };
  }
  const dates = Object.values(src.sources).map((s) => s.date).sort();
  return {
    version: `bench-${dates.at(-1)}`,
    source: `Public benchmarks (${Object.keys(src.sources).length} sources, ${dates[0]} to ${dates.at(-1)}), placed against Claude Code's default (Opus 5.5 at medium). See scripts/priors-sources.json.`,
    sources: src.sources,
    aliases: strip(src.aliases),
    defaults,
    tiers,
    arms,
  };
}
