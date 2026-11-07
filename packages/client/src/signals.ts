// The signals core (plan §4.6.7): alien-signals, re-exported so no other package names the library.
// A view adapter (Solid, React's useSignal) binds through `subscribe`.

import { computed, effect, effectScope, endBatch, setActiveSub, signal as alienSignal, startBatch } from 'alien-signals';

export { computed, effect, effectScope };

/** Anything that reads like a signal: call it to get the value (and track it). */
export type Readable<T> = () => T;
/** The read overload is last so `() => T` infers T from a signal, not void. */
export type WritableSignal<T> = { (value: T): void; (): T };

export function signal<T>(initial: T): WritableSignal<T> {
  return alienSignal(initial);
}

/** Calls `fn` with each new value of `source` (not the current one). Returns the unsubscribe. */
export function subscribe<T>(source: Readable<T>, fn: (value: T) => void): () => void {
  let first = true;
  return effect(() => {
    const v = source();
    if (first) {
      first = false;
      return;
    }
    untracked(() => fn(v));
  });
}

/** Runs `fn` with every signal write inside it flushed once at the end. */
export function batch<T>(fn: () => T): T {
  startBatch();
  try {
    return fn();
  } finally {
    endBatch();
  }
}

/** Reads signals inside `fn` without making the caller depend on them. */
export function untracked<T>(fn: () => T): T {
  const prev = setActiveSub(undefined);
  try {
    return fn();
  } finally {
    setActiveSub(prev);
  }
}

/** A read-only view of a writable signal: the type has no setter, so callers can't write. */
export function readonly<T>(s: WritableSignal<T>): Readable<T> {
  return () => s();
}
