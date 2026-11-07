// Automations stop at (budget) held a trigger back: not a failure. The row says it skipped, and why.

import type { Hold } from '@wisp-plugin/budget-api';

export class HeldError extends Error {
  readonly held: Hold;
  constructor(h: Hold) {
    super(h.why);
    this.held = h;
  }
}
