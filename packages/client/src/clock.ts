// Time is injected so machines, debounces and reconnect backoff run on a fake clock in tests.
// Only `realTimers` touches the global timers, and only scopes call it (plan §4.6.8: no setTimeout
// without the scope's signal).

export type TimerHandle = unknown;

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as Parameters<typeof globalThis.clearTimeout>[0]),
};
