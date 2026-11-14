// Field: a label, the control, a hint and an error, tied together for screen readers. The control
// (Input, TextArea, Select, Combobox) reads its id and descriptions from FieldContext, so the
// caller never wires `for` / `aria-describedby` by hand.
import { createContext, createUniqueId, Show, useContext, type JSX } from 'solid-js';
import { sub, type KitProps, type PartName, type WithChildren } from '../core/props.ts';

export interface FieldState {
  /** The control's id: the label's `for`. */
  readonly id: string;
  /** Ids of the hint and the error, when they show. */
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
  readonly required: boolean;
}

const FieldContext = createContext<() => FieldState | undefined>(() => undefined);

/** The enclosing Field's wiring, if the control sits in one. */
export function useField(): () => FieldState | undefined {
  return useContext(FieldContext);
}

export interface FieldProps extends KitProps, WithChildren {
  readonly label: string;
  /** One line under the control, in the person's terms. */
  readonly hint?: string;
  /** Shown instead of nothing under the control; marks the control invalid. */
  readonly error?: string;
  readonly required?: boolean;
  /** A mark after the label for required fields, from the caller (no copy in the kit). */
  readonly requiredMark?: string;
}

export function Field(props: FieldProps): JSX.Element {
  const id = props.id ?? `field-${createUniqueId()}`;
  const part = (): PartName => props.part ?? 'ui.field';
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const state = (): FieldState => {
    const ids = [props.error ? errorId : undefined, props.hint ? hintId : undefined].filter((x): x is string => x !== undefined);
    return { id, describedBy: ids.length ? ids.join(' ') : undefined, invalid: Boolean(props.error), required: Boolean(props.required) };
  };
  return (
    <div data-kit="field" data-part={part()} data-invalid={props.error ? '' : undefined}>
      <label for={id} data-kit="field-label" data-part={sub(part(), 'label')}>
        {props.label}
        <Show when={props.required && props.requiredMark}>
          {(mark) => <span data-kit="field-required" aria-hidden="true">{mark()}</span>}
        </Show>
      </label>
      <FieldContext.Provider value={state}>{props.children}</FieldContext.Provider>
      <Show when={props.error}>
        {(error) => (
          <span id={errorId} data-kit="field-error" data-part={sub(part(), 'error')}>
            {error()}
          </span>
        )}
      </Show>
      <Show when={props.hint}>
        {(hint) => (
          <span id={hintId} data-kit="field-hint" data-part={sub(part(), 'hint')}>
            {hint()}
          </span>
        )}
      </Show>
    </div>
  );
}
