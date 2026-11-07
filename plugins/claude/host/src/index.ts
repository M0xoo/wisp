// wisp.claude: a module of wisp.runtime (ADR-0003). It contributes Claude Code to the runtime's
// harness point and owns nothing else: no tables, no routes. Everything Claude-specific lives here.

import type { PluginContext, PluginDef, ProcService } from '@wisp/kernel';
import { POINTS, type Harness, type HarnessRun } from '@wisp-plugin/runtime-api';
import { createClaude } from './harness.ts';
import { folders } from './folders.ts';
import { accounts, login } from './login.ts';
import { SUBAGENT_MODELS } from './usage.ts';

// The kernel's definePlugin isn't exported yet: the same identity.
const definePlugin = <T extends PluginDef>(d: T): T => d;

/** Longer than this and a failed run is quoting the words, not saying them (v1 agent-login.js). */
const AUTH_FAILED_MAX = 1200;
export const signedOut = (text: string): boolean => text.length <= AUTH_FAILED_MAX && login.authFailed.test(text);

export default definePlugin({
  id: 'wisp.claude',
  setup(ctx: PluginContext) {
    const harness = createClaude({ proc: ctx.service<ProcService>('proc'), env: () => process.env, now: () => ctx.clock.now(), signedOut });
    // Subagents on Haiku (Settings → Usage): the turn's own choice, else the setting. A lead with a
    // team delegates through wisp and has no subagents of its own.
    const subagentModel = (o: HarnessRun): string => {
      if (o.subagentModel !== undefined || o.delegating) return o.subagentModel ?? '';
      const v = ctx.settings.get<string>('claude.subagentModel') ?? '';
      return (SUBAGENT_MODELS as readonly string[]).includes(v) ? v : '';
    };
    const contributed: Harness = { ...harness, login, accounts, folders, run: (o) => harness.run({ ...o, subagentModel: subagentModel(o) }) };
    ctx.contribute(POINTS.harness, contributed);
  },
});

export { createClaude } from './harness.ts';
export { claudeParser } from './parser.ts';
export { claudeLimits } from './limits.ts';
