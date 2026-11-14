// `/goal …` in an open task's reply box (v1 composer.js, slash-text.js goalAsk/isGoalDrop): `/goal <condition>` sets
// the task's goal and, the task idle, has it checked at once; `/goal drop` drops it; `/goal` alone opens Set goal….
// Nothing goes to the agent. Pure: the prompt source (index.ts) does what this reads. New task's `/goal …` is the
// server's (plugins/goal/host slash.rs), so the CLI, the phone and channels start a goal the same way.
import type { EntityKey, PluginClient } from '@wisp/client';
import { dropGoal, setGoal } from './commands.ts';
import { openEdit } from './actions.ts';
import { bareId } from './task.ts';
import { KIND, type SessionRow } from './types.ts';

import { typedGoal } from './slash-text.ts';

/** Takes a reply that is a `/goal`: true when it did (the box clears). A refusal says why and puts the text back. */
export function sendGoal(text: string, ctx: { client: PluginClient; task: string; restore?: (text: string) => void }, now: number): boolean {
  const typed = typedGoal(text);
  if (!typed) return false;
  const session = ctx.task as EntityKey;
  const back = (): void => ctx.restore?.(text);
  if (typed.t === 'bare') openEdit(ctx.client, session);
  else if (typed.t === 'drop') void ctx.client.run(dropGoal, { session, sessionId: bareId(session) }).catch(back);
  else {
    const row = ctx.client.entities.peek<SessionRow>(KIND.session, session) as SessionRow | undefined;
    // the task idle: checked on its last answer now (it may already hold); running: after this turn
    void ctx.client.run(setGoal, { session, sessionId: bareId(session), goal: { text: typed.text }, kick: row?.state !== 'running', now }).catch(back);
  }
  return true;
}
