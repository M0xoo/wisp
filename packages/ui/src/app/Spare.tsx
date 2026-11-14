// Home's notes on plans (v1 split.js .sh-spare): a long usage window resetting soon with a good share left
// ("38% of Codex's weekly window left · resets Thu 21:00", Use Codex, ×), and a window that changed (its line and
// ×). Advice only: Use puts that harness in the prompt box, nothing switches by itself.
import { For, Show, type JSX } from 'solid-js';
import type { KitProps } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';

export interface SpareCard {
  readonly key: string;
  /** the harness's mark (an image URL) */
  readonly logo?: string | undefined;
  /** bold first: "38%" */
  readonly bold?: string;
  readonly text: string;
  /** what hovering the text says: when it resets, when it was last reported */
  readonly tip?: string;
  /** the screen reader's sentence */
  readonly label: string;
  readonly use?: { readonly label: string; readonly title: string; readonly onClick: () => void } | undefined;
  readonly hide: { readonly label: string; readonly onClick: () => void };
}

export interface SpareCardsProps extends KitProps {
  readonly cards: readonly SpareCard[];
}

export function SpareCards(props: SpareCardsProps): JSX.Element {
  return (
    <Show when={props.cards.length > 0}>
      <div id={props.id} data-kit="sh-spare" data-part={props.part ?? 'home.spare'}>
        <For each={props.cards}>
          {(c) => (
            <div data-kit="spr-card" role="status" aria-label={c.label}>
              <span data-kit="spr-logo">
                <Show when={c.logo} fallback={<Icon name="clock" size="sm" />}>
                  {(src) => <img src={src()} alt="" />}
                </Show>
              </span>
              <span data-kit="spr-text" title={c.tip}>
                <Show when={c.bold}>
                  <b>{c.bold}</b>
                </Show>
                {c.text}
              </span>
              <Show when={c.use} fallback={<span />}>
                {(u) => (
                  <button type="button" data-kit="spr-use" title={u().title} onClick={() => u().onClick()}>
                    {u().label}
                  </button>
                )}
              </Show>
              <button type="button" data-kit="icon-button" data-variant="ghost" data-size="xs" title={c.hide.label} aria-label={c.hide.label} onClick={() => c.hide.onClick()}>
                <Icon name="x" size="sm" />
              </button>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
