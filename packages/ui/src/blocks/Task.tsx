// The `task` block (v1 R.task): another wisp task, as a card that opens it: its title, where and on what it
// ran, when it was last updated, the agent's note, its state as a pill, and Open →. A task this computer
// doesn't have reads "Deleted, or on another computer", greyed and inert. Live through BlockContext.task.
import { Show, type JSX } from 'solid-js';
import { Icon } from '../content/Icon.tsx';
import { InlineMd } from './content-parts.tsx';
import { useBlockT, useBlocks } from './context.tsx';
import { opt, str } from './read.ts';
import type { BlockProps, TaskRef } from './types.ts';

const STATE: Readonly<Record<string, 'running' | 'waiting' | 'review' | 'error' | 'archived' | 'done'>> = { running: 'running', waiting: 'waiting', review: 'review', error: 'error', archived: 'archived' };

export function TaskBlock(props: BlockProps): JSX.Element {
  const ctx = useBlocks();
  const t = useBlockT();
  const id = (): string => str(props.block['id']).trim();
  const live = ctx.task && id() ? ctx.task(id()) : undefined;
  const task = (): TaskRef | undefined => live?.();
  const state = (): string => STATE[task()?.state ?? ''] ?? 'done';
  const meta = (): string[] => {
    const k = task();
    return k ? [k.agent ?? ''].filter(Boolean) : [t('block.task.gone')];
  };
  return (
    <button
      type="button"
      data-kit="rb-task"
      data-card=""
      data-part="block.task"
      data-missing={task() ? undefined : ''}
      disabled={!task() || !ctx.openTask}
      title={task() ? t('block.task.openTip') : t('block.task.goneTip')}
      onClick={() => ctx.openTask?.(id())}
    >
      <span data-kit="rb-task-ic">
        <Icon name={task() ? 'agent' : 'warn'} />
      </span>
      <span data-kit="rb-task-main">
        <b>{task()?.title || opt(props.block['title']) || t('block.task.name')}</b>
        <span data-kit="rb-task-meta">{meta().join(' · ')}</span>
        <Show when={opt(props.block['note'])}>
          {(n) => (
            <span data-kit="rb-task-note">
              <InlineMd source={n()} part="block.task.note" />
            </span>
          )}
        </Show>
      </span>
      <Show when={task()}>
        <span data-kit="rb-task-pill" data-state={state()}>
          <i />
          {t(`block.task.${state()}` as 'block.task.done')}
        </span>
        <span data-kit="rb-task-open">
          {t('block.task.open')}
          <Icon name="arrow" size="sm" />
        </span>
      </Show>
    </button>
  );
}
