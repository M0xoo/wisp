// Asking an agent for a change, in Settings (v1 spell-ui.js spellsPane, Settings → Spells, now Plugins): the prompt
// box with its pin ("Writes a plugin, not your code") and send, then example asks to start from (.sp-prompt,
// .sp-examples). SettingsEmpty: a box's "nothing yet" with its mark (.sp-none). SettingsFieldRow: a field and its
// button under a row, inside the box (.sp-castrow).
import { For, Show, type JSX } from 'solid-js';
import { sub, type KitProps, type PartName, type WithChildren } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';

export interface SettingsCastProps extends KitProps {
  readonly value: string;
  readonly placeholder: string;
  readonly label: string;
  readonly pin: string;
  readonly send: { readonly label: string; readonly busy?: boolean };
  readonly onInput: (v: string) => void;
  /** Enter (Shift+Enter is a new line), or the send button */
  readonly onSend: () => void;
  readonly examples: readonly string[];
  /** an example fills the box (it doesn't send) */
  readonly onExample: (text: string) => void;
}

export function SettingsCast(props: SettingsCastProps): JSX.Element {
  const part = (): PartName => props.part ?? 'settings.cast';
  let box: HTMLTextAreaElement | undefined;
  return (
    <div id={props.id} data-kit="settings-cast" data-part={part()}>
      <div data-kit="cast-prompt" onClick={() => box?.focus()}>
        <textarea
          ref={(el) => (box = el)}
          rows={2}
          value={props.value}
          placeholder={props.placeholder}
          aria-label={props.label}
          spellcheck={false}
          onInput={(e) => props.onInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              props.onSend();
            }
          }}
        />
        <div data-kit="cast-bar">
          <span data-kit="cast-pin">
            <Icon name="wizard" size="sm" />
            {props.pin}
          </span>
          <button type="button" data-kit="cast-send" title={props.send.label} aria-label={props.send.label} disabled={props.send.busy === true} onClick={() => props.onSend()}>
            <Icon name="enter" size="sm" />
          </button>
        </div>
      </div>
      <div data-kit="cast-examples" data-layout="wrap" data-part={sub(part(), 'examples')}>
        <For each={props.examples}>
          {(x) => (
            <button type="button" data-kit="cast-example" onClick={() => props.onExample(x)}>
              {x}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

export interface SettingsEmptyProps extends KitProps {
  readonly icon: IconName;
  readonly title: string;
  readonly description?: string;
}

export function SettingsEmpty(props: SettingsEmptyProps): JSX.Element {
  return (
    <div id={props.id} data-kit="settings-empty" data-part={props.part ?? 'settings.empty'}>
      <Icon name={props.icon} />
      <div>
        <b>{props.title}</b>
        <Show when={props.description}>
          <p>{props.description}</p>
        </Show>
      </div>
    </div>
  );
}

export type SettingsFieldRowProps = KitProps & WithChildren;

export function SettingsFieldRow(props: SettingsFieldRowProps): JSX.Element {
  return (
    <div id={props.id} data-kit="settings-field-row" data-part={props.part ?? 'settings.field-row'}>
      {props.children}
    </div>
  );
}

export type SettingsInputRowProps = KitProps & WithChildren;

/** A field and its button that share a line while they fit (v1 .cg-row: the grid's address and Sign in): the field
 * grows from 12.5rem; when the two don't fit, the button goes under it and the field takes the line. */
export function SettingsInputRow(props: SettingsInputRowProps): JSX.Element {
  return (
    <div id={props.id} data-kit="settings-input-row" data-layout="wrap" data-part={props.part ?? 'settings.input-row'}>
      {props.children}
    </div>
  );
}
