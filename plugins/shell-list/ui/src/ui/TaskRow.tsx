// One task's row, by key: it reads its own row signal, so a token streaming into this task repaints
// this row and nothing else (plan §4.6.9). Opening, selecting or hovering it moves nothing in it
// (fixed columns, gaps for the actions it lacks). On the phone app it swipes (design/mobile.md).

import { createMemo, Show, type JSX } from 'solid-js';
import { FeedItem, ListRow, Stack, Swipe, useSignal, type SwipeDir, type SwipeSide } from '@wisp/ui';
import type { EntityKey } from '@wisp/client';
import { deleteTask, toggleArchived, toggleDone, toggleForLater } from '../actions.ts';
import { agentName, rowView } from '../model/row.ts';
import { actionFor, type SwipeKind } from '../model/swipe.ts';
import type { SessionRow } from '../types.ts';
import { useEnv } from './env.ts';
import { Actions, Mark, Pills, RunLine, SubLine, TimeCell } from './RowParts.tsx';
import { Slot, hasExtensions } from './Slot.tsx';

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

/** v1's PARTS for the task row's pieces (web/js/spell-schema.js: card, card.dot, card.title, …). */
const V1_ROW = { title: 'card.title', sub: 'card.sub', pills: 'card.side', time: 'card.time', foot: 'card.run' } as const;

function Body(props: { readonly k: EntityKey; readonly s: SessionRow; readonly nested: 'run' | 'sub' | undefined; readonly swipe: SwipeConfig }): JSX.Element {
  const env = useEnv();
  const t = env.shell.t;
  const open = (): boolean => env.open() === props.k;
  const view = createMemo(() => rowView(props.s, env.rowCtx(props.k)));
  const bottom = hasExtensions('shell.row:bottom');
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
      // v1's own name for a task row's head (v1-parts.json: card.head ↔ #feed .it-head): restyles and qa/parity.mjs find it
      part={props.nested ? `list.row.${props.nested}` : 'card.head'}
      // v1's names too, so qa/parity.mjs measures the row against #feed .item (a nested run is v1's own row)
      also={props.nested ? undefined : V1_ROW}
      title={props.s.title || t('shell-list.row.untitled')}
      lead={<Mark s={props.s} view={view()} name={name()} />}
      sub={<SubLine sub={view().sub} />}
      // the third line only when it says something (v1: no run line on wisp's own Welcome task)
      foot={
        view().run || bottom() ? (
          <Stack gap="0">
            <RunLine run={view().run} s={props.s} />
            <Slot input="shell.row:bottom" session={session} />
          </Stack>
        ) : undefined
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
      strong={view().unread || props.s.state === 'waiting'}
      onOpen={() => env.openTask(props.k)}
      onContextMenu={() => {
        if (props.nested !== 'sub') env.setMenuFor(props.k);
      }}
    />
  );
  return (
    <Show when={env.swipes && !props.nested} fallback={props.nested ? list() : <FeedItem part={'card' as `${string}.${string}`} id={props.k}>{list()}</FeedItem>}>
      <Swipe left={side(props.swipe.left)} right={side(props.swipe.right)} onSwipe={swiped} onArm={(on) => env.shell.platform.haptic(on ? 'select' : 'tap')} part="list.swipe">
        <FeedItem part={'card' as `${string}.${string}`} id={props.k}>{list()}</FeedItem>
      </Swipe>
    </Show>
  );
}
