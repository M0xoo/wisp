// The count-up's arithmetic (v1 countUp), pure so a test can step it frame by frame: how long a count
// runs, its ease, and the value each frame shows. Every frame shows the target's own precision (a whole
// target shows whole numbers, 4.1 shows one decimal, as v1 rounded each frame) and the last is the target.

/** How long a count to `n` runs, in ms (v1: 900 + up to 700 by magnitude). */
export const countDuration = (n: number): number => 900 + Math.min(700, Math.log10(Math.abs(n) + 1) * 220);

/** v1's ease: fast, then settling (1 − (1 − p)⁴). */
export const easeOut = (p: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, p)), 4);

/** The decimals `n` is written with (0 for a whole number), at most 6. */
export function decimalsOfNumber(n: number): number {
  if (!Number.isFinite(n) || Number.isInteger(n)) return 0;
  const frac = String(n).split('.')[1];
  return frac && /^\d+$/.test(frac) ? Math.min(frac.length, 6) : 6;
}

/** `v` rounded to `decimals` places, without float tails (0.30000000000000004 → 0.3) or -0 (a count to -5 starts at 0). */
export const roundTo = (v: number, decimals: number): number => Number(v.toFixed(decimals)) || 0;

/** The value shown at `elapsed` ms into a count to `to`: the target's precision, exactly `to` once done. */
export function countAt(to: number, elapsed: number): number {
  const dur = countDuration(to);
  return elapsed >= dur ? to : roundTo(to * easeOut(elapsed / dur), decimalsOfNumber(to));
}

/** Whether a number counts up at all: on the answer's first show, not to 0, and not under reduced motion. */
export const countsUp = (to: number | undefined, animate: boolean, reduced: boolean): to is number =>
  animate && to !== undefined && to !== 0 && !reduced;
