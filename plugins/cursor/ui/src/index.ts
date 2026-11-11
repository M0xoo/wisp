// @wisp-plugin/cursor-ui: Cursor as the screens name and mark it (the contract's PluginUiDef.harnesses): the agent
// picker, a task's row and head, Settings → Agents. The shell knows no agent of its own (ADR-0003).
import { definePluginUi } from '@wisp/shell';
import { LOGO } from './logo.ts';

export const HARNESS = { id: 'cursor', name: 'Cursor', logo: LOGO, order: 40 };

export default definePluginUi({ id: 'wisp.cursor', harnesses: [HARNESS] });
