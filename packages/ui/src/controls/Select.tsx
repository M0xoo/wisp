// Select on Zag: a button the same box as an input, its options in a menu-like list (v1's
// .kit-sel). Typeahead, arrow keys, Home/End; a hidden native select carries it in forms.
import * as select from '@zag-js/select';
import { normalizeProps, useMachine } from '@zag-js/solid';
import { createMemo, createUniqueId, For, Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { flag, sub, type KitProps, type Labelled, type PartName } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import { useField } from './Field.tsx';
import type { FieldSize } from './Input.tsx';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
  /** A heading drawn over the first option of each run with the same group (the "When" picker's sources by plugin). */
  readonly group?: string;
}

export interface SelectProps extends KitProps, Labelled {
  readonly items: readonly SelectOption[];
  readonly value: string | undefined;
  readonly onChange: (value: string) => void;
  /** Shown while nothing is picked. */
  readonly placeholder?: string;
  readonly size?: FieldSize;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly name?: string;
  /** Code-ish values. */
  readonly mono?: boolean;
}

export const optionCollection = (items: readonly SelectOption[]) =>
  select.collection<SelectOption>({
    items: [...items],
    itemToValue: (i) => i.value,
    itemToString: (i) => i.label,
    isItemDisabled: (i) => Boolean(i.disabled),
  });

export function Select(props: SelectProps): JSX.Element {
  const field = useField();
  const id = createUniqueId();
  const service = useMachine(select.machine, () => ({
    id,
    collection: optionCollection(props.items),
    value: props.value === undefined ? [] : [props.value],
    onValueChange: (d: select.ValueChangeDetails<SelectOption>) => {
      const next = d.value[0];
      if (next !== undefined) props.onChange(next);
    },
    positioning: { placement: 'bottom-start' as const, gutter: 4, sameWidth: true },
    invalid: Boolean(props.invalid ?? field()?.invalid),
    ...(props.disabled === undefined ? {} : { disabled: props.disabled }),
    ...(props.name === undefined ? {} : { name: props.name }),
    // The Field's label points at the button, so the trigger takes the Field's id.
    ...(field() ? { ids: { trigger: field()?.id } } : props.id ? { ids: { trigger: props.id } } : {}),
  }));
  const api = createMemo(() => select.connect(service, normalizeProps));
  const part = (): PartName => props.part ?? 'ui.select';
  return (
    <div {...api().getRootProps()} data-kit="select" data-part={part()}>
      <button
        {...api().getTriggerProps()}
        aria-label={props['aria-label']}
        aria-labelledby={props['aria-labelledby']}
        aria-describedby={props['aria-describedby'] ?? field()?.describedBy}
        data-kit="select-trigger"
        data-part={sub(part(), 'trigger')}
        data-size={props.size ?? 'md'}
        data-mono={flag(props.mono)}
        data-placeholder={flag(!api().hasSelectedItems)}
      >
        <span data-kit="select-value" data-text="control">{api().hasSelectedItems ? api().valueAsString : (props.placeholder ?? '')}</span>
        <Icon name="chevron" size="sm" />
      </button>
      <select {...api().getHiddenSelectProps()}>
        <For each={props.items}>{(item) => <option value={item.value}>{item.label}</option>}</For>
      </select>
      <Portal>
        <div {...api().getPositionerProps()} data-kit="positioner">
          <ul {...api().getContentProps()} data-kit="listbox" data-part={sub(part(), 'list')}>
            <For each={props.items}>
              {(item, i) => (
                <>
                <Show when={item.group && props.items[i() - 1]?.group !== item.group}>
                  <li role="presentation" data-kit="option-group" data-part={sub(part(), 'group')}>
                    {item.group}
                  </li>
                </Show>
                <li {...api().getItemProps({ item })} data-kit="option" data-part={sub(part(), 'option')}>
                  <span {...api().getItemTextProps({ item })} data-kit="option-label">
                    {item.label}
                  </span>
                  <Show when={api().getItemState({ item }).selected}>
                    <Icon name="check" size="sm" tone="accent-ink" />
                  </Show>
                </li>
                </>
              )}
            </For>
          </ul>
        </div>
      </Portal>
    </div>
  );
}
