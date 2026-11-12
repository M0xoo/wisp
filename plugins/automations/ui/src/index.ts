// wisp.automations' UI: Settings → Automations (recipes and the triggers that launch them).
import { lazy } from 'solid-js';
import { defineExtension, definePalette, type PluginUiDef } from '@wisp/shell';
import { parseDraft } from './recipe.ts';
import { catalogue } from './i18n.ts';

const parsePage = (p: unknown): { tab: 'recipes' | 'triggers' } => ({ tab: (p as { tab?: unknown } | null)?.tab === 'recipes' ? 'recipes' : 'triggers' });

const ui: PluginUiDef = {
  id: 'wisp.automations',
  settings: [{ id: 'automations', group: 'agents', title: 'automations.pane', icon: 'bolt', order: 40, component: lazy(() => import('./panes/Automations.tsx')) }],
  // a recipe from a task (v1 recipeForm, Save as recipe…)
  views: [
    // Automations from ⌘K (v1 openAutomations): Recipes and Triggers, with v1's trigger form
    {
      kind: 'automations.page',
      slot: 'overlay',
      overlay: 'dialog',
      part: 'automations.modal',
      parse: parsePage,
      component: lazy(() => import('./AutomationsPage.tsx')) as never,
      title: () => catalogue['automations.pane'] ?? 'Automations',
    },
    {
      kind: 'automations.recipe',
      slot: 'overlay',
      overlay: 'dialog',
      parse: parseDraft,
      component: lazy(() => import('./RecipeEditor.tsx')) as never,
      title: () => catalogue['automations.recipe.title'] ?? 'New recipe',
    },
  ],
  // Save as recipe… in a task's row menu (v1 taskMenu): its title and first prompt, its mode and runner
  extensions: [
    defineExtension({
      id: 'wisp.automations.rowRecipe',
      attachTo: { id: 'shell.row:menu' },
      component: () => null,
      order: 90,
      if: (p) => !(p.session?.() as { pending?: boolean } | undefined)?.pending,
      bar: {
        icon: 'bolt',
        label: 'automations.recipe.menu',
        priority: 90,
        section: 'keep',
        select: (p) => {
          const s = p.session?.() as { id: string; title?: string; mode?: string; agent?: string; model?: string; effort?: string } | undefined;
          if (!s) return;
          const params = { session: s.id, name: (s.title ?? '').slice(0, 60), prompt: '', mode: s.mode ?? '', agent: s.agent ?? '', model: s.model ?? '', effort: s.effort ?? '' };
          p.client.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: 'automations.recipe' as never, params } });
        },
      },
    }),
  ],
  // ⌘K: Recipes and Triggers (v1 commands.js), each opening Automations (v1's dialog) on its tab
  palette: [
    definePalette({
      id: 'automations.palette',
      order: 55,
      items: (ctx) =>
        (['recipes', 'triggers'] as const).map((tab) => ({
          id: `automations.${tab}`,
          group: 'shell.palette.group.actions',
          label: ctx.client.t(`automations.palette.${tab}`),
          icon: tab === 'recipes' ? 'bolt' : 'replay',
          keywords: tab === 'recipes' ? 'automations saved prompts templates' : 'automations schedule cron ci issues github',
          run: () => ctx.client.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: 'automations.page' as never, params: { tab } } }),
        })),
    }),
  ],
  catalogue,
};
export default ui;
