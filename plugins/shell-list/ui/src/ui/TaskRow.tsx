// One task's row, by key: it reads its own row signal, so a token streaming into this task repaints
// this row and nothing else (plan §4.6.9). Opening, selecting or hovering it moves nothing in it
// (fixed columns, gaps for the actions it lacks). On the phone app it swipes (design/mobile.md).

import { createMemo, Show, type JSX } from 'solid-js';
import { ListRow, Stack, Swipe, useSignal, type SwipeDir, type SwipeSide } from '@wisp/ui';
import type { EntityKey } from '@wisp/client';
import { deleteTask, toggleArchived, toggleDone, toggleForLater } from '../actions.ts';
import { agentName, rowView } from '../model/row.ts';
import { actionFor, type SwipeKind } from '../model/swipe.ts';
import type { SessionRow } from '../types.ts';
import { useEnv } from './env.ts';
import { Actions, Mark, Pills, RunLine, SubLine, TimeCell } from './RowParts.tsx';
import { Slot } from './Slot.tsx';

export interface SwipeConfig {
  readonly left: SwipeKind;
  readonly right: SwipeKind;
}

export interface TaskRowProps {
  readonly k: EntityKey;
  /** a run of a compare task, or a subagent under its lead: no swipe; a subagent has no quick actions */
  readonly nested?: 'run' | 'sub';
  /** the swipe's actions (a plugin may pick archive or delete) */
  readonly swipe?: SwipeConfig;
}

const DEFAULT_SWIPE: SwipeConfig = { left: 'later', right: 'done' };

export function TaskRow(props: TaskRowProps): JSX.Element {
  const env = useEnv();
  const row = useSignal(env.model.row(props.k));
  return (
    <Show when={row()}>
      {(s) => <Body k={props.k} s={s()} nested={props.nested} swipe={props.swipe ?? DEFAULT_SWIPE} />}
    </Show>
  );
}

function Body(props: { readonly k: EntityKey; readonly s: SessionRow; readonly nested: 'run' | 'sub' | undefined; readonly swipe: SwipeConfig }): JSX.Element {
  const env = useEnv();
  const t = env.shell.t;
  const open = (): boolean => env.open() === props.k;
  const view = createMemo(() => rowView(props.s, env.rowCtx(props.k)));
  const name = (): string => agentName(props.s.agent, env.agents());
  const session = (): { id: string; agent: string } => ({ ...props.s, id: props.k, agent: props.s.agent });
  const side = (kind: SwipeKind): SwipeSide | undefined => {
    const a = actionFor(kind, props.s);
    return a ? { label: t(a.label), icon: a.icon, tone: a.tone } : undefined;
  };
  const swiped = (dir: SwipeDir): void => {
    const kind = dir === 'left' ? props.swipe.left : props.swipe.right;
    if (kind === 'done') toggleDone(env.actions, props.k);
    else if (kind === 'later') toggleForLater(env.actions, props.k);
    else if (kind === 'archive') toggleArchived(env.actions, props.k);
    else deleteTask(env.actions, props.k);
  };
  const list = (): JSX.Element => (
    <ListRow
      layout="feed"
      part={props.nested ? `list.row.${props.nested}` : 'list.row'}
      title={props.s.title || t('shell-list.row.untitled')}
      lead={<Mark s={props.s} view={view()} name={name()} />}
      sub={
        <Stack gap="0">
          <SubLine sub={view().sub} />
          <RunLine run={view().run} s={props.s} />
          <Slot input="shell.row:bottom" session={session} />
        </Stack>
      }
      pills={
        <>
          <Pills view={view()} />
          <Slot input="shell.row:head" session={session} layout="contents" />
        </>
      }
      time={<TimeCell view={view()} />}
      actions={props.nested === 'sub' ? undefined : <Actions k={props.k} view={view()} hover={<Slot input="shell.row:hover" session={session} layout="contents" />} />}
      current={open()}
      selected={env.selected() === props.k && !open()}
      quiet={view().quiet}
      onOpen={() => env.openTask(props.k)}
      onContextMenu={() => {
        if (props.nested !== 'sub') env.setMenuFor(props.k);
      }}
    />
  );
  return (
    <Show when={env.swipes && !props.nested} fallback={list()}>
      <Swipe left={side(props.swipe.left)} right={side(props.swipe.right)} onSwipe={swiped} onArm={(on) => env.shell.platform.haptic(on ? 'select' : 'tap')} part="list.swipe">
        {list()}
      </Swipe>
    </Show>
  );
}
