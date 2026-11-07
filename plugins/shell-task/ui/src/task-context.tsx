// The open task, as every part of the task view reads it: its key and peer, its row and turns as
// Solid accessors, and `send` (run a command; a refusal is already a toast through the client's
// onError, so callers only roll back their own local state). One provider per open task: switching
// tasks remounts the view, so nothing of one task's state leaks into the next.
import { createContext, createMemo, onCleanup, useContext, type Accessor, type JSX } from 'solid-js';
import { byKeys, filterBy, ownerOf, sortBy, type CommandDef, type EntityKey, type PeerId, type PluginClient, type Scope } from '@wisp/client';
import { useSignal } from '@wisp/ui';
import { KIND, type TaskRow, type TurnRow } from './types.ts';

export interface TaskContext {
  readonly key: EntityKey;
  /** the bare session id (the part after `<peer>:`) */
  readonly id: string;
  readonly peer: PeerId;
  readonly client: PluginClient;
  /** the view's scope: its timers, subscriptions and requests end when the task closes */
  readonly scope: Scope;
  readonly task: Accessor<TaskRow | undefined>;
  /** the task's turns, oldest first */
  readonly turns: Accessor<readonly TurnRow[]>;
  /** runs a command; resolves undefined when the peer refused it (the toast already showed) */
  send<A, R>(cmd: CommandDef<A, R>, args: A): Promise<R | undefined>;
}

const Ctx = createContext<TaskContext>();

export function bareId(key: string): string {
  const i = key.indexOf(':');
  return i < 0 ? key : key.slice(i + 1);
}

/** The turns of one session, oldest first, from the `turn` collection. */
export function turnsOf(client: PluginClient, id: string): Accessor<readonly TurnRow[]> {
  const mine = filterBy(client.entities.list<TurnRow>(KIND.turn), (t) => t.sessionId === id);
  return useSignal(sortBy(mine, byKeys<TurnRow>({ of: (t) => t.idx }, { of: (t) => t.startedAt })));
}

export function createTaskContext(client: PluginClient, key: EntityKey): TaskContext {
  const id = bareId(key);
  const scope = client.scope.child(`task:${id}`);
  onCleanup(() => scope.dispose());
  const row = useSignal(client.entities.row<TaskRow>(KIND.session, key));
  const task = createMemo(() => row());
  return {
    key,
    id,
    peer: ownerOf(key),
    client,
    scope,
    task,
    turns: turnsOf(client, id),
    send: (cmd, args) => client.run(cmd, args).catch(() => undefined),
  };
}

export function TaskProvider(props: { readonly value: TaskContext; readonly children?: JSX.Element }): JSX.Element {
  return <Ctx.Provider value={props.value}>{props.children}</Ctx.Provider>;
}

export function useTask(): TaskContext {
  const c = useContext(Ctx);
  if (!c) throw new Error('a task view part rendered outside TaskProvider');
  return c;
}
