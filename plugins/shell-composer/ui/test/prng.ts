// A seeded PRNG (mulberry32) for property tests: a failure names its seed and replays exactly.
export function prng(seed: number): { int(n: number): number; pick<T>(xs: readonly T[]): T; seed: number } {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    seed,
    int: (n) => Math.floor(next() * n),
    pick<T>(xs: readonly T[]): T {
      const x = xs[Math.floor(next() * xs.length)];
      if (x === undefined) throw new Error('pick from an empty list');
      return x;
    },
  };
}
