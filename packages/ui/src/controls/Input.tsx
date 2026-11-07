// Input and TextArea: v1's form kit (.input, .textarea, .field) as two components. One look for
// every standalone field; prompt boxes are the Composer's own borderless pattern.
import { createEffect, on, Show, type JSX } from 'solid-js';
import { flag, type KitProps, type Labelled } from '../core/props.ts';
import { fitTextarea } from '../core/autosize.ts';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';
import { useField } from './Field.tsx';

export type FieldSize = 'sm' | 'md' | 'lg';

interface TextControlProps extends KitProps, Labelled {
  readonly value?: string;
  /** Every keystroke, with the new text. */
  readonly onInput?: (value: string) => void;
  /** On commit (blur after a change). */
  readonly onChange?: (value: string) => void;
  readonly onKeyDown?: (e: KeyboardEvent) => void;
  readonly onFocus?: (e: FocusEvent) => void;
  readonly onBlur?: (e: FocusEvent) => void;
  readonly placeholder?: string;
  readonly name?: string;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly required?: boolean;
  readonly invalid?: boolean;
  /** Code-ish values: paths, cron, tokens, commands. */
  readonly mono?: boolean;
  readonly autofocus?: boolean;
  readonly maxLength?: number;
  readonly autocomplete?: string;
  readonly spellcheck?: boolean;
}

export interface InputProps extends TextControlProps {
  readonly type?: 'text' | 'search' | 'email' | 'url' | 'password' | 'number' | 'tel';
  readonly inputMode?: 'text' | 'search' | 'email' | 'url' | 'numeric' | 'decimal' | 'tel';
  /** 30px rows in dense panels (sm), 32 (md), 38 (lg). */
  readonly size?: FieldSize;
  /** A leading icon inside the box (v1's .field). */
  readonly icon?: IconName;
  /** Leading text inside the box: `https://`, `$`. */
  readonly prefix?: string;
  readonly ref?: (el: HTMLInputElement) => void;
}

/** The control's id and ARIA, from its own props or the enclosing Field. */
function useControlAria(props: TextControlProps): {
  id: () => string | undefined;
  describedBy: () => string | undefined;
  invalid: () => boolean;
  required: () => boolean;
} {
  const field = useField();
  return {
    id: () => props.id ?? field()?.id,
    describedBy: () => props['aria-describedby'] ?? field()?.describedBy,
    invalid: () => Boolean(props.invalid ?? field()?.invalid),
    required: () => Boolean(props.required ?? field()?.required),
  };
}

export function Input(props: InputProps): JSX.Element {
  const aria = useControlAria(props);
  const boxed = (): boolean => props.icon !== undefined || props.prefix !== undefined;
  const input = (bare: boolean): JSX.Element => (
    <input
      ref={props.ref}
      id={aria.id()}
      type={props.type ?? 'text'}
      inputMode={props.inputMode}
      value={props.value ?? ''}
      name={props.name}
      placeholder={props.placeholder}
      disabled={props.disabled}
      readOnly={props.readOnly}
      required={aria.required()}
      autofocus={props.autofocus}
      maxLength={props.maxLength}
      autocomplete={props.autocomplete}
      spellcheck={props.spellcheck}
      aria-label={props['aria-label']}
      aria-labelledby={props['aria-labelledby']}
      aria-describedby={aria.describedBy()}
      aria-invalid={aria.invalid() ? 'true' : undefined}
      onInput={(e) => props.onInput?.(e.currentTarget.value)}
      onChange={(e) => props.onChange?.(e.currentTarget.value)}
      onKeyDown={(e) => props.onKeyDown?.(e)}
      onFocus={(e) => props.onFocus?.(e)}
      onBlur={(e) => props.onBlur?.(e)}
      data-kit={bare ? 'field-input' : 'input'}
      data-part={bare ? undefined : (props.part ?? 'ui.input')}
      data-size={bare ? undefined : (props.size ?? 'md')}
      data-mono={flag(props.mono)}
    />
  );
  return (
    <Show when={boxed()} fallback={input(false)}>
      <label
        data-kit="field-box"
        data-part={props.part ?? 'ui.input'}
        data-size={props.size ?? 'md'}
        data-mono={flag(props.mono)}
        data-invalid={flag(aria.invalid())}
        data-disabled={flag(props.disabled)}
      >
        <Show when={props.icon}>{(name) => <Icon name={name()} size="md" />}</Show>
        <Show when={props.prefix}>{(text) => <span data-kit="field-prefix">{text()}</span>}</Show>
        {input(true)}
      </label>
    </Show>
  );
}

export interface TextAreaProps extends TextControlProps {
  /** Grow with the text, between minRows and maxRows (default true). */
  readonly autosize?: boolean;
  readonly minRows?: number;
  readonly maxRows?: number;
  readonly ref?: (el: HTMLTextAreaElement) => void;
}

export function TextArea(props: TextAreaProps): JSX.Element {
  const aria = useControlAria(props);
  let el: HTMLTextAreaElement | undefined;
  const fit = (): void => {
    if (el && props.autosize !== false) fitTextarea(el, props.minRows ?? 3, props.maxRows ?? 12);
  };
  // A value set from outside (a draft restored, the box cleared on send) refits too.
  createEffect(on(() => props.value, () => queueMicrotask(fit)));
  return (
    <textarea
      ref={(node) => {
        el = node;
        props.ref?.(node);
      }}
      id={aria.id()}
      value={props.value ?? ''}
      rows={props.minRows ?? 3}
      name={props.name}
      placeholder={props.placeholder}
      disabled={props.disabled}
      readOnly={props.readOnly}
      required={aria.required()}
      autofocus={props.autofocus}
      maxLength={props.maxLength}
      spellcheck={props.spellcheck}
      aria-label={props['aria-label']}
      aria-labelledby={props['aria-labelledby']}
      aria-describedby={aria.describedBy()}
      aria-invalid={aria.invalid() ? 'true' : undefined}
      onInput={(e) => {
        fit();
        props.onInput?.(e.currentTarget.value);
      }}
      onChange={(e) => props.onChange?.(e.currentTarget.value)}
      onKeyDown={(e) => props.onKeyDown?.(e)}
      onFocus={(e) => props.onFocus?.(e)}
      onBlur={(e) => props.onBlur?.(e)}
      data-kit="textarea"
      data-part={props.part ?? 'ui.textarea'}
      data-autosize={flag(props.autosize !== false)}
      data-mono={flag(props.mono)}
    />
  );
}
