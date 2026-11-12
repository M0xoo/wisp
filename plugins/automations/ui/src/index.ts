// wisp.automations' UI: Settings → Automations (recipes and the triggers that launch them).
import { lazy } from 'solid-js';
import { defineExtension, type PluginUiDef } from '@wisp/shell';
import { parseDraft } from './recipe.ts';
import { catalogue } from './i18n.ts';

const ui: PluginUiDef = {
  id: 'wisp.automations',
  settings: [{ id: 'automations', group: 'agents', title: 'automations.pane', icon: 'bolt', order: 40, component: lazy(() => import('./panes/Automations.tsx')) }],
  // a recipe from a task (v1 recipeForm, Save as recipe…)
  views: [
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
        select: (p) => {
          const s = p.session?.() as { id: string; title?: string; mode?: string; agent?: string; model?: string; effort?: string } | undefined;
          if (!s) return;
          const params = { session: s.id, name: (s.title ?? '').slice(0, 60), prompt: '', mode: s.mode ?? '', agent: s.agent ?? '', model: s.model ?? '', effort: s.effort ?? '' };
          p.client.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: 'automations.recipe' as never, params } });
        },
      },
    }),
  ],
  catalogue,
};
export default ui;
