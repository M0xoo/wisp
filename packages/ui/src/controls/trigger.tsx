// The button that opens a popover or a dialog: the kit's button look carrying the machine's
// trigger props (aria-expanded, aria-controls, the click and key handlers).
import { Show, type JSX } from 'solid-js';
import type { PartName } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import type { MenuTrigger } from './Menu.tsx';

export type { MenuTrigger as TriggerLook };

/** The trigger's accessible name when it shows only an icon. */
export const triggerName = (t: MenuTrigger): string | undefined => ('aria-label' in t ? t['aria-label'] : undefined);

export function TriggerButton(props: {
  readonly look: MenuTrigger;
  readonly bind: JSX.ButtonHTMLAttributes<HTMLButtonElement>;
  readonly part: PartName;
}): JSX.Element {
  const labelled = (): boolean => props.look.label !== undefined;
  return (
    <button
      {...props.bind}
      type="button"
      aria-label={triggerName(props.look)}
      title={triggerName(props.look)}
      data-kit={labelled() ? 'button' : 'icon-button'}
      data-part={props.part}
      data-variant={props.look.variant ?? (labelled() ? 'secondary' : 'ghost')}
      data-size={props.look.size ?? 'md'}
    >
      <span data-kit="button-content">
        <Show when={props.look.icon}>{(name) => <Icon name={name()} size={labelled() ? 'md' : 'base'} />}</Show>
        <Show when={props.look.label}>{(label) => <span data-kit="button-label">{label()}</span>}</Show>
      </span>
    </button>
  );
}
