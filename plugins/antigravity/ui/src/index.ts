// @wisp-plugin/antigravity-ui: Antigravity as the screens name and mark it (the contract's PluginUiDef.harnesses): the agent
// picker, a task's row and head, Settings → Agents. The shell knows no agent of its own (ADR-0003).
import { definePluginUi } from '@wisp/shell';
import { LOGO } from './logo.ts';

export const HARNESS = { id: 'antigravity', name: 'Antigravity', logo: LOGO, order: 50 };

export default definePluginUi({ id: 'wisp.antigravity', harnesses: [HARNESS] });
