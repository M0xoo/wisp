// @wisp-plugin/codex-ui: Codex as the screens name and mark it (the contract's PluginUiDef.harnesses):
// the agent picker, a task's row and head, the reply box. The shell knows no agent of its own (ADR-0003).
import { definePluginUi } from '@wisp/shell';
import { LOGO } from './logo.ts';

export const HARNESS = { id: 'codex', name: 'Codex', logo: LOGO, order: 20 };

export default definePluginUi({ id: 'wisp.codex', harnesses: [HARNESS] });
