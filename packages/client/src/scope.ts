// The client-side scope (plan §4.6.5, §6.4): a component, a machine, a plugin. It owns an
// AbortSignal, its children and its timers; dispose aborts the signal, clears the timers, disposes
// the children and runs the cleanups, newest first. Same shape as the kernel's `Scope`.

import { realTimers, type Timers } from './clock.ts';
import type { Disposable } from './types.ts';

export interface Scope {
  readonly name: string;
  readonly signal: AbortSignal;
  readonly alive: boolean;
  readonly timers: Timers;
  add(d: Disposable | (() => void)): void;
  child(name: string): Scope;
  /** runs `fn` after `ms` unless the scope ends first; the returned function cancels it */
  timeout(ms: number, fn: () => void): () => void;
  interval(ms: number, fn: () => void): () => void;
  dispose(): void;
}

// size-ok: a factory; its body is small closures over shared private state, each under the cap
export function createScope(name = 'root', timers: Timers = realTimers): Scope {
  const ctl = new AbortController();
  const cleanups: (() => void)[] = [];
  let alive = true;

  const add = (d: Disposable | (() => void)): void => {
    const fn = typeof d === 'function' ? d : () => d.dispose();
    if (!alive) return fn(); // registering on a dead scope frees at once instead of leaking
    cleanups.push(fn);
  };
  const forget = (fn: () => void): void => {
    const i = cleanups.indexOf(fn);
    if (i >= 0) cleanups.splice(i, 1);
  };

  const scope: Scope = {
    name,
    signal: ctl.signal,
    timers,
    get alive() {
      return alive;
    },
    add,
    child(childName) {
      const c = createScope(`${name}/${childName}`, timers);
      const drop = (): void => c.dispose();
      add(drop);
      c.add(() => forget(drop)); // a child disposed on its own leaves its parent's list
      return c;
    },
    timeout(ms, fn) {
      if (!alive) return () => {};
      const cancel = (): void => {
        timers.clearTimeout(h);
        forget(cancel);
      };
      const h = timers.setTimeout(() => {
        forget(cancel);
        if (alive) fn();
      }, ms);
      cleanups.push(cancel);
      return cancel;
    },
    interval(ms, fn) {
      let stop = (): void => {};
      const tick = (): void => {
        stop = scope.timeout(ms, tick);
        fn();
      };
      stop = scope.timeout(ms, tick);
      return () => stop();
    },
    dispose() {
      if (!alive) return;
      alive = false;
      ctl.abort(new Error(`scope ${name} ended`));
      while (cleanups.length > 0) {
        const fn = cleanups.pop();
        try {
          fn?.();
        } catch {
          // one failing cleanup must not keep the others from running
        }
      }
    },
  };
  return scope;
}
