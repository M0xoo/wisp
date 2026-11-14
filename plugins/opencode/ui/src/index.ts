// @wisp-plugin/opencode-ui: opencode as the screens name and mark it (the contract's PluginUiDef.harnesses): the agent
// picker, a task's row and head, Settings → Agents. The shell knows no agent of its own (ADR-0003).
import { definePluginUi } from '@wisp/shell';
import { LOGO } from './logo.ts';

export const HARNESS = { id: 'opencode', name: 'opencode', logo: LOGO, order: 30 };

export default definePluginUi({ id: 'wisp.opencode', harnesses: [HARNESS] });
