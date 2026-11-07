// "Spins at once, stops when the answer is in" (v1 refreshPr, askToFix): a busy flag around one
// command run. A refusal is the shell's toast; the caller only stops waiting.

import { createSignal, type Accessor } from 'solid-js';
import { CommandError } from '@wisp/client';

export interface Busy {
  readonly busy: Accessor<boolean>;
  run<R>(p: Promise<R>): Promise<R | undefined>;
}

export function useBusy(): Busy {
  const [busy, setBusy] = createSignal(false);
  return {
    busy,
    async run(p) {
      setBusy(true);
      try {
        return await p;
      } catch (err) {
        if (err instanceof CommandError) return undefined;
        throw err;
      } finally {
        setBusy(false);
      }
    },
  };
}
