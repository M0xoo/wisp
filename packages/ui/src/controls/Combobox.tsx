// Combobox on Zag: a text box that filters a list as you type. ArrowDown highlights, Enter
// picks, Escape closes. The filter is local UI state; the picked value is the caller's.
import * as combobox from '@zag-js/combobox';
import { normalizeProps, useMachine } from '@zag-js/solid';
import { createMemo, createSignal, createUniqueId, For, Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { flag, sub, type KitProps, type Labelled, type PartName } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import { useField } from './Field.tsx';
import type { FieldSize } from './Input.tsx';
import type { SelectOption } from './Select.tsx';

export interface ComboboxProps extends KitProps, Labelled {
  readonly items: readonly SelectOption[];
  readonly value: string | undefined;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  /** Shown in the list when nothing matches what was typed. */
  readonly emptyText: string;
  readonly size?: FieldSize;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly name?: string;
  readonly mono?: boolean;
  /** Match on more than the label (default: case-insensitive substring of the label). */
  readonly match?: (item: SelectOption, query: string) => boolean;
}

const defaultMatch = (item: SelectOption, query: string): boolean => item.label.toLowerCase().includes(query.toLowerCase());

export function Combobox(props: ComboboxProps): JSX.Element {
  const field = useField();
  const id = createUniqueId();
  const [query, setQuery] = createSignal('');
  const shown = createMemo(() => {
    const q = query().trim();
    return q === '' ? [...props.items] : props.items.filter((i) => (props.match ?? defaultMatch)(i, q));
  });
  const service = useMachine(combobox.machine, () => ({
    id,
    collection: combobox.collection<SelectOption>({
      items: shown(),
      itemToValue: (i) => i.value,
      itemToString: (i) => i.label,
      isItemDisabled: (i) => Boolean(i.disabled),
    }),
    value: props.value === undefined ? [] : [props.value],
    onValueChange: (d: combobox.ValueChangeDetails<SelectOption>) => {
      const next = d.value[0];
      if (next !== undefined) props.onChange(next);
    },
    // Only typing filters; picking an item (which fills the box with its label) shows every item next time.
    onInputValueChange: (d: combobox.InputValueChangeDetails) => setQuery(d.reason === 'input-change' ? d.inputValue : ''),
    inputBehavior: 'autohighlight' as const,
    openOnClick: true,
    positioning: { placement: 'bottom-start' as const, gutter: 4, sameWidth: true },
    invalid: Boolean(props.invalid ?? field()?.invalid),
    ...(props.placeholder === undefined ? {} : { placeholder: props.placeholder }),
    ...(props.disabled === undefined ? {} : { disabled: props.disabled }),
    ...(props.name === undefined ? {} : { name: props.name }),
    ...(field() ? { ids: { input: field()?.id } } : props.id ? { ids: { input: props.id } } : {}),
  }));
  const api = createMemo(() => combobox.connect(service, normalizeProps));
  const part = (): PartName => props.part ?? 'ui.combobox';
  return (
    <div {...api().getRootProps()} data-kit="combobox" data-part={part()}>
      <div {...api().getControlProps()} data-kit="field-box" data-size={props.size ?? 'md'} data-mono={flag(props.mono)}>
        <input
          {...api().getInputProps()}
          aria-label={props['aria-label']}
          aria-labelledby={props['aria-labelledby']}
          aria-describedby={props['aria-describedby'] ?? field()?.describedBy}
          data-kit="field-input"
          data-part={sub(part(), 'input')}
        />
        <button {...api().getTriggerProps()} tabIndex={-1} data-kit="combobox-trigger">
          <Icon name="chevron" size="sm" />
        </button>
      </div>
      <OptionList api={api()} items={shown()} part={part()} emptyText={props.emptyText} />
    </div>
  );
}

function OptionList(props: {
  readonly api: combobox.Api;
  readonly items: readonly SelectOption[];
  readonly part: PartName;
  readonly emptyText: string;
}): JSX.Element {
  return (
    <Portal>
      <div {...props.api.getPositionerProps()} data-kit="positioner">
        <ul {...props.api.getContentProps()} data-kit="listbox" data-part={sub(props.part, 'list')}>
          <For each={props.items} fallback={<li data-kit="listbox-empty">{props.emptyText}</li>}>
            {(item) => (
              <li {...props.api.getItemProps({ item })} data-kit="option" data-part={sub(props.part, 'option')}>
                <span {...props.api.getItemTextProps({ item })} data-kit="option-label">
                  {item.label}
                </span>
                <Show when={props.api.getItemState({ item }).selected}>
                  <Icon name="check" size="sm" tone="accent-ink" />
                </Show>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Portal>
  );
}
