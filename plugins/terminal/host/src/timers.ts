// Cancellable timers owned by a scope (AGENTS.md: timers only through ctx.scope). The kernel's
// scope.timeout can't be cancelled, so each timer gets a child scope: disposing it cancels the timer,
// and the plugin's scope ending disposes every one still pending.

import type { Scope } from '@wisp/kernel';
import type { Later } from './order.ts';

export function laterIn(scope: Scope): Later {
  return (ms, fn) => {
    const s = scope.child('timer');
    s.timeout(ms, () => {
      s.dispose();
      fn();
    });
    return () => s.dispose();
  };
}
