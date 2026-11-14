// @wisp-plugin/grok-ui: Grok as the screens name and mark it (the contract's PluginUiDef.harnesses): the agent
// picker, a task's row and head, Settings → Agents. The shell knows no agent of its own (ADR-0003).
import { definePluginUi } from '@wisp/shell';
import { LOGO } from './logo.ts';

export const HARNESS = { id: 'grok', name: 'Grok', logo: LOGO, order: 60 };

export default definePluginUi({ id: 'wisp.grok', harnesses: [HARNESS] });
