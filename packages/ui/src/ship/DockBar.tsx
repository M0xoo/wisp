// DockBar: the phone's merge bar, docked where the reply box sits (css/ship.css). One line: an
// icon in its tone, the text (ellipsised), one action.
import type { JSX } from 'solid-js';
import type { Tone } from '@wisp/tokens';
import type { KitProps } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';

export interface DockBarProps extends KitProps {
  readonly text: string;
  readonly tone?: Tone;
  readonly icon?: IconName;
  readonly action?: JSX.Element;
}

export function DockBar(props: DockBarProps): JSX.Element {
  return (
    <div id={props.id} role="status" data-kit="dock-bar" data-part={props.part ?? 'ui.dock-bar'} data-tone={props.tone ?? 'neutral'}>
      <span data-kit="dock-bar-icon"><Icon name={props.icon ?? 'merge'} size="md" /></span>
      <span data-kit="dock-bar-text">{props.text}</span>
      <span data-kit="dock-bar-action">{props.action}</span>
    </div>
  );
}
