// The goal's writes (reference api COMMANDS: goal.set, goal.pause, goal.resume, goal.drop,
// goal.check). Each runs on the peer that owns the task and shows at once through an optimistic
// patch on the session row's `goal`; a refusal rolls it back and the shell shows the toast.
// `session` is the task's entity key (`<peer>:<id>`); `sessionId` is what the peer reads.

import { defineCommand, type EntityKey, type EntityOps, type EntityReader } from '@wisp/client';
import { optimisticGoal } from './rules.ts';
import { KIND, type GoalView, type Judge, type SessionRow, type Vote } from './types.ts';

export interface TaskArgs {
  readonly session: EntityKey;
  readonly sessionId: string;
}

export interface SetArgs extends TaskArgs {
  readonly goal: { readonly text: string; readonly judges?: readonly Judge[]; readonly vote?: Vote };
  /** check it at once when the task is idle (it may already hold) */
  readonly kick?: boolean;
  /** a follow-up goes with it: the goal waits for that turn instead of a check now */
  readonly sending?: boolean;
  /** the page's clock, for setAt on a new goal */
  readonly now: number;
}

const rowOf = (base: EntityReader, key: EntityKey): SessionRow | undefined => base.peek<SessionRow>(KIND.session, key) as SessionRow | undefined;

const putGoal = (key: EntityKey, goal: GoalView): EntityOps => [{ e: KIND.session, id: key, op: 'patch', ops: [{ op: 'add', path: '/goal', value: goal }] }];

export const setGoal = defineCommand<SetArgs, GoalView>({
  id: 'goal.set',
  owner: (a) => a.session,
  wire: (a) => ({ id: a.session.slice(a.session.indexOf(':') + 1), text: a.goal.text }),
  optimistic: (base, a) => {
    const row = rowOf(base, a.session);
    if (!row) return [];
    const next = optimisticGoal(row.goal, a.goal.text, {
      sending: a.sending === true,
      running: row.state === 'running',
      now: a.now,
      ...(a.goal.judges && { judges: a.goal.judges }),
      ...(a.goal.vote && { vote: a.goal.vote }),
    });
    return putGoal(a.session, next);
  },
  dedupe: (a) => `goal.set:${a.session}:${a.goal.text}`,
});

/** Pause and Resume: a round that waited for the plan leaves Scheduled with it (v1 goalAction). */
function moved(base: EntityReader, a: TaskArgs, status: 'paused' | 'working', why?: string): EntityOps {
  const row = rowOf(base, a.session);
  if (!row?.goal) return [];
  const { held: _held, why: _why, ...rest } = row.goal;
  return putGoal(a.session, { ...rest, status, ...(why && { why }) });
}

export const pauseGoal = defineCommand<TaskArgs & { readonly why?: string }, GoalView>({
  id: 'goal.pause',
  owner: (a) => a.session,
  wire: (a) => ({ id: a.session.slice(a.session.indexOf(':') + 1), ...('why' in a && a.why !== undefined && { why: a.why }) }),
  optimistic: (base, a) => moved(base, a, 'paused', a.why),
});

export const resumeGoal = defineCommand<TaskArgs, GoalView>({
  id: 'goal.resume',
  owner: (a) => a.session,
  wire: (a) => ({ id: a.session.slice(a.session.indexOf(':') + 1) }),
  optimistic: (base, a) => moved(base, a, 'working'),
});

export const dropGoal = defineCommand<TaskArgs, { dropped: boolean }>({
  id: 'goal.drop',
  owner: (a) => a.session,
  wire: (a) => ({ id: a.session.slice(a.session.indexOf(':') + 1) }),
  optimistic: (base, a) => (rowOf(base, a.session)?.goal ? [{ e: KIND.session, id: a.session, op: 'patch', ops: [{ op: 'remove', path: '/goal' }] }] : []),
});

/** Check now: a task whose turn ended, if its goal is working. The server's patch says checking. */
export const checkGoal = defineCommand<TaskArgs, Record<string, never>>({
  id: 'goal.check',
  owner: (a) => a.session,
  wire: (a) => ({ id: a.session.slice(a.session.indexOf(':') + 1) }),
  optimistic: 'none', pending: 'the goal.check control',
});

export const COMMANDS = [setGoal, pauseGoal, resumeGoal, dropGoal, checkGoal] as const;
