// @wisp-plugin/goal-ui: wisp.goal's UI (docs/v2-ui-brief.md). Each extension's component loads with
// import() on first show, so the plugin costs nothing until it's on screen.

import { lazy } from 'solid-js';
import type { EntityKey } from '@wisp/client';
import { defineExtension, definePluginUi, defineView } from './define.ts';
import { catalogue, t } from './i18n.ts';
import { ACTION_ICON, VIEW, actionLabel, runGoalAction } from './actions.ts';
import { goalActions, type GoalAction } from './rules.ts';
import type { SessionRow } from './types.ts';

// a view's params, checked here so the index never loads the dialog's code
const taskParams =
  (what: string) =>
  (p: unknown): { task: string } => {
    const o = p as { task?: unknown } | null;
    if (!o || typeof o.task !== 'string' || !o.task.includes(':')) throw new Error(`${what}: task key`);
    return { task: o.task };
  };
const runParams = (p: unknown): never => {
  const o = p as { task?: unknown; run?: unknown; name?: unknown; round?: unknown } | null;
  if (!o || typeof o.task !== 'string' || typeof o.run !== 'string' || typeof o.name !== 'string' || typeof o.round !== 'number') throw new Error('goal run: params');
  return o as never;
};

// the goal's entries in a task's row menu (v1 goal.js goalMenuHtml): Set goal… (Edit goal… once there is one),
// Goal checks…, Pause or Resume goal, Drop goal, each only where it applies
const rowOf = (p: { session?: () => unknown }): SessionRow | undefined => p.session?.() as SessionRow | undefined;
const rowItem = (a: GoalAction, order: number, id: string) =>
  defineExtension({
    id,
    attachTo: { id: 'shell.row:menu' },
    component: () => null,
    order,
    if: (p) => goalActions(rowOf(p)).includes(a),
    bar: {
      icon: ACTION_ICON[a],
      label: actionLabel(a, undefined),
      priority: order,
      sub: 'goal',
      text: (p) => t(actionLabel(a, rowOf(p))),
      select: (p) => {
        const s = rowOf(p);
        if (s) runGoalAction(p.client, a, s.id as EntityKey);
      },
    },
  });

export default definePluginUi({
  id: 'wisp.goal',
  // the band over an open task's turns (design/goals.md): where its goal stands, its judges, its round
  extensions: [
    defineExtension({ id: 'wisp.goal.band', attachTo: { id: 'shell.task:band' }, component: lazy(() => import('./Band.tsx')) }),
    rowItem('set', 110, 'wisp.goal.rowSet'),
    rowItem('checks', 111, 'wisp.goal.rowChecks'),
    rowItem('pause', 112, 'wisp.goal.rowPause'),
    rowItem('resume', 112, 'wisp.goal.rowResume'),
    rowItem('drop', 113, 'wisp.goal.rowDrop'),
  ],
  // Set goal… / Edit goal…, Goal checks…, one check read like a task: overlays over the task
  views: [
    defineView({
      kind: VIEW.edit,
      slot: 'overlay',
      overlay: 'dialog',
      parse: taskParams('edit goal'),
      component: lazy(() => import('./EditGoal.tsx')) as never,
      title: () => t('wisp.goal.action.set'),
    }),
    defineView({
      kind: VIEW.checks,
      slot: 'overlay',
      overlay: 'dialog',
      parse: taskParams('goal checks'),
      component: lazy(() => import('./Checks.tsx')) as never,
      title: () => t('wisp.goal.action.checks'),
    }),
    defineView({ kind: VIEW.run, slot: 'overlay', overlay: 'viewer', parse: runParams, component: lazy(() => import('./RunView.tsx')) as never, title: () => t('wisp.goal.action.checks') }),
  ],
  commands: [],
  catalogue,
});
