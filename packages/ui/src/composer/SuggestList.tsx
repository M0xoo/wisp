// SuggestList: what a half-typed `/b` or `@fi` could be, floating over the prompt (v1's slash menu,
// task and crew pickers). Focus never leaves the text box: the box drives it with ↑/↓, Enter and
// Tab (`suggestKey`), and points at the active row with aria-activedescendant. Mousedown on a row
// is prevented so the click doesn't blur the box. Looks like a Menu (it is one, without the focus).
import { IconButton } from '../controls/Button.tsx';
import { For, Show, type JSX } from 'solid-js';
import { flag, sub, type KitProps, type PartName } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import { optionId, type SuggestItem } from './suggest-keys.ts';

export interface SuggestListProps extends KitProps {
  readonly id: string;
  readonly 'aria-label': string;
  /** A one-line title over the rows ("After which task? ↵ to pick"). */
  readonly title?: string;
  readonly items: readonly SuggestItem[];
  readonly active: number;
  readonly onPick: (value: string) => void;
  readonly onActive?: (index: number) => void;
  /** Shown instead of rows when there are none. */
  readonly empty?: string;
}

export function SuggestList(props: SuggestListProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.suggest';
  return (
    <div id={props.id} role="listbox" aria-label={props['aria-label']} data-kit="menu" data-part={part()} data-suggest="" onMouseDown={(e) => e.preventDefault()}>
      <Show when={props.title}>
        <div data-kit="menu-group-label" data-text="control">
          {props.title}
        </div>
      </Show>
      <Show
        when={props.items.length > 0}
        fallback={
          <Show when={props.empty}>
            <div data-kit="menu-item" aria-disabled="true" data-disabled="">
              {props.empty}
            </div>
          </Show>
        }
      >
        <For each={props.items}>
          {(item, i) => (
            <div
              id={optionId(props.id, i())}
              role="option"
              aria-selected={i() === props.active}
              data-kit="menu-item"
              data-part={sub(part(), 'item')}
              data-value={item.value}
              data-highlighted={flag(i() === props.active)}
              onPointerMove={() => i() !== props.active && props.onActive?.(i())}
              onClick={() => props.onPick(item.value)}
            >
              <Show when={item.icon}>{(name) => <Icon name={name()} size="md" />}</Show>
              <span data-kit="menu-item-text">
                <span data-kit="menu-item-label" data-text="control">
                  {item.label}
                  <Show when={item.detail}>
                    {(d) => (
                      <>
                        {' '}
                        <span data-kit="suggest-detail">{d()}</span>
                      </>
                    )}
                  </Show>
                </span>
                <Show when={item.hint}>
                  {(hint) => (
                    <span data-kit="menu-item-hint" data-text="control">
                      {hint()}
                    </span>
                  )}
                </Show>
              </span>
              <Show when={item.onOpen}>
                {(open) => (
                  <IconButton
                    icon="expand"
                    size="sm"
                    variant="ghost"
                    label={item.openLabel ?? ''}
                    onClick={(e) => {
                      e.stopPropagation();
                      open()();
                    }}
                    part={sub(part(), 'open')}
                  />
                )}
              </Show>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}
