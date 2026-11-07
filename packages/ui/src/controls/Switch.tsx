// Switch and Checkbox on Zag: a real (hidden) input for forms, the right roles and keyboard.
import * as zagSwitch from '@zag-js/switch';
import * as checkbox from '@zag-js/checkbox';
import { normalizeProps, useMachine } from '@zag-js/solid';
import { createMemo, createUniqueId, Show, type JSX } from 'solid-js';
import { sub, type KitProps, type PartName } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';

interface ToggleBase extends KitProps {
  /** Visible label beside the control. Without one, pass `aria-label`. */
  readonly label?: string;
  readonly 'aria-label'?: string;
  readonly disabled?: boolean;
  readonly name?: string;
  readonly value?: string;
}

export interface SwitchProps extends ToggleBase {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}

/** An on/off setting that applies at once (Settings rows). */
export function Switch(props: SwitchProps): JSX.Element {
  const id = props.id ?? createUniqueId();
  const service = useMachine(zagSwitch.machine, () => ({
    id,
    checked: props.checked,
    onCheckedChange: (d: zagSwitch.CheckedChangeDetails) => props.onChange(d.checked),
    ...(props.disabled === undefined ? {} : { disabled: props.disabled }),
    ...(props.name === undefined ? {} : { name: props.name }),
    ...(props.value === undefined ? {} : { value: props.value }),
    ...(props['aria-label'] === undefined ? {} : { label: props['aria-label'] }),
  }));
  const api = createMemo(() => zagSwitch.connect(service, normalizeProps));
  const part = (): PartName => props.part ?? 'ui.switch';
  return (
    <label {...api().getRootProps()} data-kit="switch" data-part={part()}>
      <input {...api().getHiddenInputProps()} aria-label={props.label ? undefined : props['aria-label']} />
      <span {...api().getControlProps()} data-kit="switch-control" data-part={sub(part(), 'control')}>
        <span {...api().getThumbProps()} data-kit="switch-thumb" />
      </span>
      <Show when={props.label}>
        {(label) => (
          <span {...api().getLabelProps()} data-kit="toggle-label">
            {label()}
          </span>
        )}
      </Show>
    </label>
  );
}

export interface CheckboxProps extends ToggleBase {
  readonly checked: boolean | 'indeterminate';
  readonly onChange: (checked: boolean) => void;
  readonly invalid?: boolean;
}

export function Checkbox(props: CheckboxProps): JSX.Element {
  const id = props.id ?? createUniqueId();
  const service = useMachine(checkbox.machine, () => ({
    id,
    checked: props.checked,
    // An indeterminate box becomes checked when clicked; callers only ever see a boolean.
    onCheckedChange: (d: checkbox.CheckedChangeDetails) => props.onChange(d.checked === true),
    ...(props.disabled === undefined ? {} : { disabled: props.disabled }),
    ...(props.invalid === undefined ? {} : { invalid: props.invalid }),
    ...(props.name === undefined ? {} : { name: props.name }),
    ...(props.value === undefined ? {} : { value: props.value }),
  }));
  const api = createMemo(() => checkbox.connect(service, normalizeProps));
  const part = (): PartName => props.part ?? 'ui.checkbox';
  return (
    <label {...api().getRootProps()} data-kit="checkbox" data-part={part()}>
      <input {...api().getHiddenInputProps()} aria-label={props.label ? undefined : props['aria-label']} />
      <span {...api().getControlProps()} data-kit="checkbox-control" data-part={sub(part(), 'control')}>
        <Show when={api().indeterminate} fallback={<Show when={api().checked}><Icon name="check" size="xs" /></Show>}>
          <Icon name="minus" size="xs" />
        </Show>
      </span>
      <Show when={props.label}>
        {(label) => (
          <span {...api().getLabelProps()} data-kit="toggle-label">
            {label()}
          </span>
        )}
      </Show>
    </label>
  );
}
