// @wisp-plugin/sandbox-ui: wisp.sandbox's UI (ADR-0047). `/sandbox …` in New task opens a placeholder for the task at
// once (the Sandbox pill from the first frame) while its sandbox comes up, then the task itself; Settings →
// Computers → Sandboxes: the Claude sign-in for every sandbox, env vars, and each sandbox with its owner.
import { lazy } from 'solid-js';
import { uuidv7, type Json } from '@wisp/client';
import { defineView, definePluginUi } from '@wisp/shell';
import { catalogue, t } from './i18n.ts';
import { sandboxPrompt } from './model.ts';
import { LAUNCHING, parseLaunching } from './views.ts';

export default definePluginUi({
  id: 'wisp.sandbox',
  catalogue,
  settings: [{ id: 'sandboxes', group: 'computers', title: 'sandbox.pane', icon: 'box', order: 25, component: lazy(() => import('./Sandboxes.tsx')) }],
  views: [defineView({ kind: LAUNCHING, slot: 'main', parse: parseLaunching, title: () => t('sandbox.pill'), component: lazy(() => import('./Launching.tsx')) })],
  prompt: [
    {
      id: 'sandbox.slash',
      trigger: '/',
      where: ['home'],
      order: 95,
      items: () => [],
      send: (text, ctx) => {
        const prompt = sandboxPrompt(text);
        if (prompt === null || !prompt) return false;
        ctx.client.navigate({ t: 'openView', id: LAUNCHING as never, params: { id: uuidv7(), prompt, launch: (ctx.launch ?? {}) as Json } as Json });
        return true;
      },
    },
  ],
});
