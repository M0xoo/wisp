// Switch (v1's button role=switch) and Checkbox (on Zag: a real hidden input for forms, the right roles and keyboard).
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

/** An on/off setting that applies at once (Settings rows). v1's element: a `<button role="switch">` (Space and Enter
 * toggle it, it takes focus like any button), so a page reads and counts it as v1's did; a hidden input carries it in a
 * form when it has a `name`. */
export function Switch(props: SwitchProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.switch';
  const state = (): string => (props.checked ? 'checked' : 'unchecked');
  // the button is the track (v1 .switch: 34 × 20), its knob inside; a label sits beside it, outside the button
  const track = (): JSX.Element => (
    <button
      type="button"
      id={props.id}
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label ? undefined : props['aria-label']}
      disabled={props.disabled === true}
      data-kit="switch"
      data-part={part()}
      data-state={state()}
      data-disabled={props.disabled ? '' : undefined}
      onClick={() => props.onChange(!props.checked)}
    >
      <Show when={props.name}>{(n) => <input type="hidden" name={n()} value={props.checked ? (props.value ?? 'on') : ''} />}</Show>
      <span data-kit="switch-control" data-part={sub(part(), 'control')} data-state={state()}>
        <span data-kit="switch-thumb" data-state={state()} />
      </span>
    </button>
  );
  return (
    <Show when={props.label} fallback={track()}>
      {(label) => (
        <label data-kit="switch-field">
          {track()}
          <span data-kit="toggle-label">{label()}</span>
        </label>
      )}
    </Show>
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
