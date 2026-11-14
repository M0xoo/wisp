// @wisp-plugin/copilot-ui: Copilot as the screens name and mark it (the contract's PluginUiDef.harnesses): the agent
// picker, a task's row and head, Settings → Agents. The shell knows no agent of its own (ADR-0003).
import { definePluginUi } from '@wisp/shell';
import { LOGO } from './logo.ts';

export const HARNESS = { id: 'copilot', name: 'Copilot', logo: LOGO, order: 70 };

export default definePluginUi({ id: 'wisp.copilot', harnesses: [HARNESS] });
