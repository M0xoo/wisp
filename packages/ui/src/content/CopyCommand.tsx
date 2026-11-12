// CopyCommand: a command to copy and run elsewhere (v1 setup.js .setup-cmd): `$`, the command in mono, the copy
// mark; a click hands it to onCopy. In a settings row's line it sits on a line of its own, 6px under the text.
import { Show, type JSX } from 'solid-js';
import type { KitProps } from '../core/props.ts';
import { Icon } from './Icon.tsx';

export interface CopyCommandProps extends KitProps {
  readonly command: string;
  /** the button's tooltip and name (Copy) */
  readonly label: string;
  /** no `$` before it: an address, not a command */
  readonly bare?: boolean;
  readonly onCopy: (command: string) => void;
}

export function CopyCommand(props: CopyCommandProps): JSX.Element {
  return (
    <button
      type="button"
      id={props.id}
      data-kit="copy-command"
      data-part={props.part ?? 'ui.copy-command'}
      title={props.label}
      aria-label={`${props.label}: ${props.command}`}
      onClick={() => props.onCopy(props.command)}
    >
      <Show when={!props.bare}>
        <span data-kit="copy-command-p">$</span>
      </Show>
      <code>{props.command}</code>
      <Icon name="copy" size="sm" />
    </button>
  );
}
