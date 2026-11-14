// @wisp-plugin/claude-ui: Claude Code as the screens name and mark it (the contract's PluginUiDef.harnesses):
// the agent picker, a task's row and head, the reply box. The shell knows no agent of its own (ADR-0003).
import { definePluginUi } from '@wisp/shell';
import { LOGO } from './logo.ts';

// variants: Try it two ways' What's different (its backend runs both: plugins/claude/host launch.rs)
export const HARNESS = { id: 'claude', name: 'Claude Code', logo: LOGO, order: 10, default: true, variants: ['subagentModel', 'skills'] };

export default definePluginUi({ id: 'wisp.claude', harnesses: [HARNESS] });
