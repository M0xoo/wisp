// Count-up (v1 countUp): a number rises from 0 to its value the first time its answer is shown,
// easing out over ~1–1.6 s (longer for bigger numbers), after the block's own entry delay. Shown
// again, or under reduced motion, it is simply the value. A value that changes later jumps.
import { createEffect, createSignal, on, type Accessor } from 'solid-js';
import { createTimer, reducedMotion } from './content-scope.ts';
import { countAt, countsUp } from './count-math.ts';

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
  const run = countsUp(to, opts.animate, reducedMotion());
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
