// Dot: a small round mark in a tone (unread, a project's colour, a machine's state). With a label it
// is an image with that name; without one it is decoration, hidden from assistive tech.
import type { JSX } from 'solid-js';
import type { ProjectColor, Tone } from '@wisp/tokens';
import { flag, type KitProps } from '../core/props.ts';

export interface DotProps extends KitProps {
  readonly tone?: Tone;
  /** a project's colour instead of a tone */
  readonly color?: ProjectColor;
  /** pulse: something is live (stilled under reduced motion) */
  readonly live?: boolean;
  readonly label?: string;
  readonly size?: 'sm' | 'md' | 'project';
}

export function Dot(props: DotProps): JSX.Element {
  return (
    <span
      id={props.id}
      data-kit="dot"
      data-part={props.part ?? 'ui.dot'}
      data-tone={props.color ? undefined : (props.tone ?? 'neutral')}
      data-size={props.size ?? 'sm'}
      data-live={flag(props.live)}
      role={props.label ? 'img' : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : 'true'}
      title={props.label}
      style={props.color ? { '--k-tone': `var(--${props.color})` } : undefined}
    />
  );
}
