// The `stuff` block (v1 R.stuff, features/stuff.js stuffBlock): something the agent saved in My Stuff, as a card
// with its kind, title and line; Launch for an app, Open for the rest (BlockContext.openStuff). Gone from My
// Stuff: it says so, inert. Live through BlockContext.stuff.
import { Show, type JSX } from 'solid-js';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';
import { InlineMd } from './content-parts.tsx';
import { useBlockT, useBlocks } from './context.tsx';
import { opt, str } from './read.ts';
import type { BlockProps, StuffRef } from './types.ts';

const KIND_ICON: Readonly<Record<string, IconName>> = { app: 'spark', doc: 'text', image: 'image', link: 'external' };

export function StuffBlock(props: BlockProps): JSX.Element {
  const ctx = useBlocks();
  const t = useBlockT();
  const id = (): string => str(props.block['id']).trim();
  const live = ctx.stuff && id() ? ctx.stuff(id()) : undefined;
  const it = (): StuffRef | undefined => live?.();
  const known = (): boolean => !ctx.stuff || !!it();
  return (
    <button
      type="button"
      data-kit="rb-task"
      data-card=""
      data-part="block.stuff"
      data-missing={known() ? undefined : ''}
      disabled={!known() || !ctx.openStuff || !id()}
      onClick={() => ctx.openStuff?.(id())}
    >
      <span data-kit="rb-task-ic">
        <Icon name={KIND_ICON[it()?.kind ?? str(props.block['kind'])] ?? 'stuff'} />
      </span>
      <span data-kit="rb-task-main">
        <b>{it()?.title || opt(props.block['title']) || t('block.stuff.name')}</b>
        <span data-kit="rb-task-meta">{known() ? (it()?.sub ?? '') : t('block.stuff.gone')}</span>
        <Show when={opt(props.block['note'])}>
          {(n) => (
            <span data-kit="rb-task-note">
              <InlineMd source={n()} part="block.stuff.note" />
            </span>
          )}
        </Show>
      </span>
      <Show when={known() && ctx.openStuff && id()}>
        <span data-kit="rb-task-open">
          {(it()?.kind ?? str(props.block['kind'])) === 'app' ? t('block.stuff.launch') : t('block.stuff.open')}
          <Icon name="arrow" size="sm" />
        </span>
      </Show>
    </button>
  );
}
