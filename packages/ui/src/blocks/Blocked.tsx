// The `blocked` block (v1 R.blocked): Blocked by permissions, each refused tool call (the tool, what it tried,
// why), and on the latest answer Allow & retry / Deny. The card settles at once and comes back if the host's
// answer is a refusal (design/feedback.md).
import { For, Show, createSignal, type JSX } from 'solid-js';
import { Icon } from '../content/Icon.tsx';
import { Wrap } from '../layout/Stack.tsx';
import { InlineMd } from './content-parts.tsx';
import { useBlockT, useBlocks } from './context.tsx';
import { items, opt, str } from './read.ts';
import type { BlockedItem, BlockProps } from './types.ts';

export function BlockedBlock(props: BlockProps): JSX.Element {
  const ctx = useBlocks();
  const t = useBlockT();
  const [state, setState] = createSignal<'allowed' | 'denied' | undefined>();
  const list = (): BlockedItem[] =>
    items<BlockedItem>(props.block['items'], (o) => {
      const why = opt(o['why']);
      return {
        tool: str(o['tool']) || t('block.blocked.tool'),
        detail: str(o['detail']),
        ...(why !== undefined && { why }),
      };
    });
  const open = (): boolean => ctx.latest === true && !!ctx.allow && state() === undefined;
  const decide = (allow: boolean): void => {
    setState(allow ? 'allowed' : 'denied');
    const p = allow ? ctx.allow?.(undefined) : ctx.deny?.();
    if (p && typeof (p as Promise<unknown>).catch === 'function') (p as Promise<unknown>).catch(() => setState(undefined));
  };
  return (
    <div data-kit="rb-blocked" data-part="block.blocked" data-resolved={open() ? undefined : ''}>
      <div data-kit="rb-q-head">
        <Icon name="lock" size="sm" />
        <span>{t('block.blocked.head')}</span>
        <Show when={state()}>
          {(s) => (
            <span data-kit="rb-bl-state">
              <Icon name={s() === 'allowed' ? 'check' : 'x'} size="sm" />
              {t(s() === 'allowed' ? 'block.blocked.allowed' : 'block.blocked.denied')}
            </span>
          )}
        </Show>
      </div>
      <ul data-kit="rb-bl-items">
        <For each={list()}>
          {(i) => (
            <li>
              <Wrap gap="4" align="baseline" part="block.blocked.item">
                <span data-kit="rb-bl-tool">{i.tool}</span>
                <Show when={i.detail}>
                  <code>{i.detail}</code>
                </Show>
                <Show when={i.why}>
                  {(w) => (
                    <small>
                      <InlineMd source={w()} part="block.blocked.why" />
                    </small>
                  )}
                </Show>
              </Wrap>
            </li>
          )}
        </For>
      </ul>
      <Show when={open()}>
        <div data-kit="rb-bl-foot">
          <Wrap gap="5" align="center" part="block.blocked.foot">
            <button type="button" data-kit="rb-btn" data-primary="" onClick={() => decide(true)}>
              <Icon name="check" size="sm" />
              {t('block.blocked.allow')}
            </button>
            <Show when={ctx.deny}>
              <button type="button" data-kit="rb-btn" onClick={() => decide(false)}>
                {t('block.blocked.deny')}
              </button>
            </Show>
            <span data-kit="rb-bl-note">{t('block.blocked.note')}</span>
          </Wrap>
        </div>
      </Show>
    </div>
  );
}
