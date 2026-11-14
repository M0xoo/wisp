import { expect, test } from 'vitest';
import { effect, signal } from 'alien-signals';
import { createRoot, type Accessor } from 'solid-js';
import { useSignal } from '../src/core/signal.ts';

// F-page-10 (round 139): an answer's comment marks stopped following the comments store once the task view re-rendered
// from another signal's change: the bridge's effect was made inside the running effect and died with its next run.
test('a_use_signal_made_while_another_effect_runs_keeps_following_after_that_effect_runs_again', () => {
  const outer = signal(0);
  const store = signal<readonly string[]>([]);
  let seen: Accessor<readonly string[]> | undefined;
  let dispose: (() => void) | undefined;
  const stopOuter = effect(() => {
    if (outer() === 1 && !seen)
      createRoot((d) => {
        dispose = d;
        seen = useSignal(() => store());
      });
  });
  outer(1);
  outer(2); // the outer effect runs again
  store(['a comment']);
  expect(seen?.()).toEqual(['a comment']);
  dispose?.();
  store(['after']);
  expect(seen?.()).toEqual(['a comment']); // freed with its Solid owner
  stopOuter();
});
