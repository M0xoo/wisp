// The goal's actions under one name everywhere (the band's menu, ⌘K): Set goal… / Edit goal…,
// Goal checks…, Pause goal, Resume goal, Drop goal. The views they open are overlays over the task,
// so the task stays open underneath and Back finds it where it was.

import type { EntityKey, ExtensionId, Json, PluginClient } from '@wisp/client';
import type { IconName } from '@wisp/ui';
import { dropGoal, pauseGoal, resumeGoal } from './commands.ts';
import { t, type Key } from './i18n.ts';
import type { GoalAction } from './rules.ts';
import { bareId } from './task.ts';
import type { RunHint, SessionRow } from './types.ts';

export const VIEW = {
  /** overlay: Set goal… / Edit goal…; params { task } */
  edit: 'goal.edit',
  /** overlay: each judge's vote and the rounds before; params { task } */
  checks: 'goal.checks',
  /** overlay: one check, read like a task (v1 goal-run.js); params RunHint */
  run: 'goal.run',
} as const;

export const ACTION_LABEL: Readonly<Record<GoalAction, Key>> = {
  set: 'wisp.goal.action.set',
  checks: 'wisp.goal.action.checks',
  pause: 'wisp.goal.action.pause',
  resume: 'wisp.goal.action.resume',
  drop: 'wisp.goal.action.drop',
};

export const ACTION_ICON: Readonly<Record<GoalAction, IconName>> = { set: 'target', checks: 'judge', pause: 'pause', resume: 'play', drop: 'x' };

/** Set goal… reads Edit goal… once there is one. */
export const actionLabel = (a: GoalAction, row: SessionRow | undefined): Key => (a === 'set' && row?.goal ? 'wisp.goal.action.edit' : ACTION_LABEL[a]);

const overlay = (id: string, params: Json, kind: 'dialog' | 'viewer' = 'dialog') => ({ t: 'openOverlay' as const, overlay: { kind, id: id as ExtensionId, params } });

export function openEdit(client: PluginClient, task: EntityKey): void {
  client.navigate(overlay(VIEW.edit, { task }));
}

export function openChecks(client: PluginClient, task: EntityKey): void {
  client.navigate(overlay(VIEW.checks, { task }));
}

export function openRun(client: PluginClient, hint: RunHint): void {
  client.navigate(overlay(VIEW.run, { ...hint } as unknown as Json, 'viewer'));
}

/** Runs one of the goal's actions; writes are optimistic and roll back with the shell's toast. */
export function runGoalAction(client: PluginClient, a: GoalAction, task: EntityKey): void {
  const args = { session: task, sessionId: bareId(task) };
  if (a === 'set') openEdit(client, task);
  if (a === 'checks') openChecks(client, task);
  if (a === 'pause') void client.run(pauseGoal, { ...args, why: t('wisp.goal.pausedByYou') }).catch(() => {});
  if (a === 'resume') void client.run(resumeGoal, args).catch(() => {});
  if (a === 'drop') void client.run(dropGoal, args).catch(() => {});
}
