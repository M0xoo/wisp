// A Solid accessor over an alien-signals readable that itself changes (a compare task's runs). The
// kit's useSignal follows one readable for the component's life; this one re-follows when `source`
// returns another, and stops with the owner.

import { createComputed, createSignal, onCleanup, type Accessor } from 'solid-js';
import { subscribe, untracked, type Readable } from '@wisp/client';

export function follow<T>(source: () => Readable<T>): Accessor<T> {
  const [value, setValue] = createSignal<T>(undefined as T, { equals: Object.is });
  createComputed(() => {
    const r = source();
    setValue(() => untracked(r));
    onCleanup(subscribe(r, (v) => setValue(() => v)));
  });
  return value;
}
