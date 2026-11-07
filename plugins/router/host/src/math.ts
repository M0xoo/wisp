// The dice of a pick: Thompson sampling from Beta(wins, losses), and a small seeded generator for the
// propensity estimate (and for tests and benches).

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gamma(k, 1) by Marsaglia–Tsang. */
function gammaSample(k: number, r: Rng): number {
  if (k < 1) return gammaSample(k + 1, r) * Math.pow(r() || 1e-12, 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      const u1 = r() || 1e-12;
      const u2 = r();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = r() || 1e-12;
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

/** Beta(a, b) from two Gamma draws. */
export function betaSample(a: number, b: number, r: Rng = Math.random): number {
  const x = gammaSample(a, r);
  const y = gammaSample(b, r);
  return x / (x + y);
}
