// RadioGroup: native radios in a fieldset. The browser gives arrow keys, one tab stop and form
// submission for free, so no machine is needed.
import { createUniqueId, For, Show, type JSX } from 'solid-js';
import { flag, sub, type KitProps, type PartName } from '../core/props.ts';

export interface RadioOption {
  readonly value: string;
  readonly label: string;
  /** A second line under the label. */
  readonly hint?: string;
  readonly disabled?: boolean;
}

export interface RadioGroupProps extends KitProps {
  /** The group's name, read out and shown as its legend. */
  readonly label: string;
  /** Keep the legend for readers but don't show it (the row already says it). */
  readonly hideLabel?: boolean;
  readonly options: readonly RadioOption[];
  readonly value: string | undefined;
  readonly onChange: (value: string) => void;
  readonly name?: string;
  readonly orientation?: 'vertical' | 'horizontal';
  readonly disabled?: boolean;
}

export function RadioGroup(props: RadioGroupProps): JSX.Element {
  const name = props.name ?? `radio-${createUniqueId()}`;
  const part = (): PartName => props.part ?? 'ui.radio-group';
  return (
    <fieldset
      id={props.id}
      disabled={props.disabled}
      data-kit="radio-group"
      data-part={part()}
      data-orientation={props.orientation ?? 'vertical'}
    >
      <legend data-kit="radio-legend" data-hidden={flag(props.hideLabel)}>
        {props.label}
      </legend>
      <For each={props.options}>
        {(option) => (
          <label data-kit="radio" data-part={sub(part(), 'option')} data-disabled={flag(option.disabled)}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={props.value === option.value}
              disabled={option.disabled}
              onChange={() => props.onChange(option.value)}
              data-kit="radio-input"
            />
            <span data-kit="radio-text">
              <span data-kit="toggle-label">{option.label}</span>
              <Show when={option.hint}>{(hint) => <span data-kit="radio-hint">{hint()}</span>}</Show>
            </span>
          </label>
        )}
      </For>
    </fieldset>
  );
}
