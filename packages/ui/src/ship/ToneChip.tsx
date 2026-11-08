// ToneChip: v1's PR pill as a button (css/ship.css): a dot in its tone, a one-line label.
import type { JSX } from 'solid-js';
import type { Tone } from '@wisp/tokens';
import { flag, type KitProps } from '../core/props.ts';

export interface ToneChipProps extends KitProps {
  readonly label: string;
  readonly tone?: Tone;
  /** pulse the dot: checks are still running */
  readonly live?: boolean;
  readonly pressed?: boolean;
  readonly title?: string;
  readonly onClick?: () => void;
}

export function ToneChip(props: ToneChipProps): JSX.Element {
  return (
    <button
      type="button"
      id={props.id}
      title={props.title}
      data-kit="tone-chip"
      data-part={props.part ?? 'ui.tone-chip'}
      data-tone={props.tone ?? 'neutral'}
      data-pressed={flag(props.pressed)}
      aria-pressed={props.pressed === undefined ? undefined : props.pressed}
      onClick={(e) => {
        e.stopPropagation(); // a chip on a row opens its pane, not the row
        props.onClick?.();
      }}
    >
      <span data-kit="tone-chip-dot" data-live={flag(props.live)} />
      <span data-kit="tone-chip-label" data-text="control">{props.label}</span>
    </button>
  );
}
