// Scoped timers for the content blocks (copy feedback, count-up): every timeout and frame loop is
// made inside the calling component's owner and freed by onCleanup, so an unmounted block leaves
// nothing running.
import { onCleanup } from 'solid-js';

export interface ScopedTimer {
  /** Run `fn` once after `ms`; replaces a pending one. */
  readonly after: (ms: number, fn: () => void) => void;
  /** Run `step(now)` every animation frame while it returns true. Without rAF it runs once with +∞. */
  readonly frames: (step: (now: number) => boolean) => void;
  /** Stop whatever is pending. */
  readonly clear: () => void;
}

export function createTimer(): ScopedTimer {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let frame: number | undefined;
  const clear = (): void => {
    if (timeout !== undefined) clearTimeout(timeout);
    if (frame !== undefined) cancelAnimationFrame(frame);
    timeout = undefined;
    frame = undefined;
  };
  onCleanup(clear);
  const frames = (step: (now: number) => boolean): void => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    if (typeof requestAnimationFrame !== 'function') {
      step(Number.POSITIVE_INFINITY);
      return;
    }
    const tick = (now: number): void => {
      frame = step(now) ? requestAnimationFrame(tick) : undefined;
    };
    frame = requestAnimationFrame(tick);
  };
  const after = (ms: number, fn: () => void): void => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = setTimeout(() => {
      timeout = undefined;
      fn();
    }, ms);
  };
  return { after, frames, clear };
}

/** The user asked for less motion: counts and transitions show their end state at once. */
export const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
