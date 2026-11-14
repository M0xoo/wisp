// The count-up shown frame by frame (tests counts, stats numbers): a whole target never shows a fraction,
// a decimal target keeps its own decimals, the last frame is exactly the target, and reduced motion skips it.
import { describe, expect, it } from 'vitest';
import { countAt, countDuration, countsUp, decimalsOfNumber } from '../src/blocks/count-math.ts';

/** Every value a count to `to` shows at 60 fps, until it lands (as useCountUp's frame loop stops). */
function frames(to: number, fps = 60): number[] {
  const shown: number[] = [];
  for (let elapsed = 0; ; elapsed += 1000 / fps) {
    const v = countAt(to, elapsed);
    shown.push(v);
    if (v === to) return shown;
    if (shown.length > 10_000) throw new Error('never landed');
  }
}

describe('count-up frames', () => {
  it('shows only whole numbers for a whole target and lands on it', () => {
    for (const to of [1, 2, 3, 7, 48, 49, 100, 1234, 98_765, -12]) {
      const shown = frames(to);
      expect(shown.every(Number.isInteger), `fractions counting to ${to}: ${shown.filter((v) => !Number.isInteger(v)).join(', ')}`).toBe(true);
      expect(shown.at(-1)).toBe(to);
      expect(shown.length).toBeGreaterThan(1); // it does animate (it stops once the rounded value lands)
    }
  });

  it('the screenshot case: 48 passed and 2 skipped never show 47.92… or 1.99…', () => {
    for (const to of [48, 2]) for (let ms = 0; ms <= countDuration(to); ms += 7.3) expect(Number.isInteger(countAt(to, ms))).toBe(true);
  });

  it('a decimal target keeps its own decimals each frame and lands exactly', () => {
    for (const to of [4.1, 0.3, 12.75, 99.999]) {
      const d = decimalsOfNumber(to);
      const shown = frames(to);
      for (const v of shown) expect(decimalsOfNumber(v)).toBeLessThanOrEqual(d);
      expect(shown.at(-1)).toBe(to);
    }
  });

  it('a negative target never shows -0', () => {
    for (const v of frames(-5)) expect(Object.is(v, -0)).toBe(false);
  });

  it('rises without going back down', () => {
    const shown = frames(250);
    for (let i = 1; i < shown.length; i += 1) expect(shown[i]).toBeGreaterThanOrEqual(shown[i - 1] ?? 0);
  });

  it('a frame loop without rAF (elapsed +∞) shows the target', () => {
    expect(countAt(48, Number.POSITIVE_INFINITY)).toBe(48);
    expect(countAt(4.1, Number.POSITIVE_INFINITY)).toBe(4.1);
  });
});

describe('when a number counts up', () => {
  it('under prefers-reduced-motion it shows the target at once', () => {
    expect(countsUp(48, true, true)).toBe(false);
    expect(countsUp(4.1, true, true)).toBe(false);
  });
  it('only on first show, and never to 0 or a missing value', () => {
    expect(countsUp(48, true, false)).toBe(true);
    expect(countsUp(48, false, false)).toBe(false);
    expect(countsUp(0, true, false)).toBe(false);
    expect(countsUp(undefined, true, false)).toBe(false);
  });
});
