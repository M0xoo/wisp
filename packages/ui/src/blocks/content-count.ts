// Count-up (v1 countUp): a number rises from 0 to its value the first time its answer is shown,
// easing out over ~1–1.6 s (longer for bigger numbers), after the block's own entry delay. Shown
// again, or under reduced motion, it is simply the value. A value that changes later jumps.
import { createEffect, createSignal, on, type Accessor } from 'solid-js';
import { createTimer, reducedMotion } from './content-scope.ts';

/** How long a count to `n` runs, in ms (v1: 900 + up to 700 by magnitude). */
export const countDuration = (n: number): number => 900 + Math.min(700, Math.log10(Math.abs(n) + 1) * 220);

/** v1's ease: fast, then settling (1 − (1 − p)⁴). */
export const easeOut = (p: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, p)), 4);

/** The value at `elapsed` ms into a count to `to`. */
export function countAt(to: number, elapsed: number): number {
  const dur = countDuration(to);
  return elapsed >= dur ? to : to * easeOut(elapsed / dur);
}

export interface CountUpOptions {
  /** count up at all: the answer's first show (BlockContext.reveal !== false) */
  readonly animate: boolean;
  /** ms before it starts: the block's place in the answer */
  readonly delay: number;
}

/** The number to show now: `target` once settled, rising to it on first show. */
export function useCountUp(target: Accessor<number | undefined>, opts: CountUpOptions): Accessor<number | undefined> {
  const timer = createTimer();
  const to = target();
  const run = opts.animate && to !== undefined && to !== 0 && !reducedMotion();
  const [shown, setShown] = createSignal<number | undefined>(run ? 0 : to);
  let settled = !run;
  if (run) {
    timer.after(opts.delay, () => {
      let t0: number | undefined;
      timer.frames((now) => {
        t0 ??= now;
        const elapsed = Number.isFinite(now) ? now - t0 : Number.POSITIVE_INFINITY;
        const v = countAt(to, elapsed);
        setShown(v);
        if (v === to) settled = true;
        return v !== to;
      });
    });
  }
  createEffect(
    on(target, (v) => {
      if (settled || v !== to) {
        settled = true;
        timer.clear();
        setShown(v);
      }
    }, { defer: true }),
  );
  return shown;
}

/** A locale formatter with a fixed number of decimals, made once per count (not per frame). */
export function numberFormat(decimals: number): (n: number) => string {
  const nf = new Intl.NumberFormat(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return (n) => nf.format(n);
}
