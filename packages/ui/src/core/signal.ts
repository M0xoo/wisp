// Bridges @wisp/client's signals (alien-signals) into Solid. The client store stays framework
// independent; a component reads it through `useSignal(selector)` and re-renders when it changes.
import { effect } from 'alien-signals';
import { createSignal, getOwner, onCleanup, type Accessor } from 'solid-js';

/** Something with a current value that says when it changes. */
export interface Subscribable<T> {
  get(): T;
  subscribe(listener: (value: T) => void): () => void;
}

/** An alien-signals signal or computed (a getter that tracks), or a subscribable store. */
export type Readable<T> = (() => T) | Subscribable<T>;

const isSubscribable = <T>(r: Readable<T>): r is Subscribable<T> => typeof r !== 'function';

/** A writable alien-signals signal. Its own overload, because TS infers from an overloaded
 * function type's last signature (the setter) and would make T `void`. */
export type WritableSignal<T> = { (): T; (value: T): void };

/** A Solid accessor that follows `readable`. Stops following when the owning component unmounts. */
export function useSignal<T>(readable: WritableSignal<T>): Accessor<T>;
export function useSignal<T>(readable: Readable<T>): Accessor<T>;
export function useSignal<T>(readable: Readable<T>): Accessor<T> {
  const first = isSubscribable(readable) ? readable.get() : undefined;
  // `() => v`: a function value must not be taken for an updater.
  const [value, setValue] = createSignal<T>(first as T, { equals: Object.is });
  // alien's effect runs once at once, so the accessor holds the current value before first paint.
  const stop = isSubscribable(readable)
    ? readable.subscribe((v) => setValue(() => v))
    : effect(() => {
        const v = readable();
        setValue(() => v);
      });
  if (getOwner()) onCleanup(stop);
  return value;
}
