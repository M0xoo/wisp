// @wisp-plugin/later-ui: wisp.later's UI (docs/v2-ui-brief.md). Each extension's component loads with
// import() on first show, so the plugin costs nothing until it's on screen.

import { lazy } from 'solid-js';
import { definePluginUi, defineView } from './define.ts';
import { uuidv7, type EntityKey } from '@wisp/client';
import { catalogue } from './i18n.ts';
import { addPlan } from './commands.ts';
import { launchPlan } from './launch.ts';

export default definePluginUi({
  id: 'wisp.later',
  extensions: [],
  views: [
    // a scheduled task or reminder, or a /draft, opened from its row (shell-list's Scheduled and Drafts)
    defineView<{ id?: string }>({
      kind: 'later.plan',
      slot: 'main',
      parse: (p) => (p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string' ? { id: (p as { id: string }).id } : {}),
      component: lazy(() => import('./ui/PlanPage.tsx')),
    }),
  ],
  // New task's Send, when it means later: a time on the clock or at the start of the prompt, /draft, /after <task>
  prompt: [
    {
      id: 'later.launch',
      trigger: '/',
      where: ['home'],
      order: 90,
      items: () => [],
      send: (text, ctx) => {
        const l = (ctx.launch ?? {}) as { cwd?: string; agent?: string; model?: string; effort?: string; mode?: string; at?: number };
        const home = ctx.client.home;
        const key = (id: string): EntityKey => (id.includes(':') ? id : `${home}:${id}`) as EntityKey;
        const p = launchPlan(text, {
          now: new Date(),
          at: l.at,
          title: (id) => ctx.client.entities.peek<{ title?: string }>('session', key(id))?.title,
        });
        if (!p) return false;
        const body = {
          prompt: p.rest,
          ...(l.cwd && { cwd: l.cwd }),
          ...(l.agent && { agent: l.agent }),
          ...(l.model && { model: l.model }),
          ...(l.effort && { effort: l.effort }),
          ...(l.mode && { mode: l.mode }),
        };
        const base = { peer: home, tmp: uuidv7(), setAt: Date.now() };
        const args =
          'draft' in p
            ? { ...base, kind: 'task' as const, draft: true as const, body }
            : 'after' in p
              ? { ...base, kind: 'task' as const, after: { id: key(p.after.id), title: p.after.title }, body }
              : p.kind === 'reminder'
                ? { ...base, kind: 'reminder' as const, at: p.at, text: p.rest }
                : { ...base, kind: 'task' as const, at: p.at, body };
        void ctx.client.run(addPlan, args).catch(() => undefined);
        return true;
      },
    },
  ],
  commands: [],
  catalogue,
});
