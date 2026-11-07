// Icon: one of the set in icons.ts, drawn in currentColor at a size from the scale.
import type { JSX } from 'solid-js';
import { ICONS, type IconName } from './icons.ts';
import type { KitProps } from '../core/props.ts';
import type { TextTone } from './Text.tsx';

export type IconSize = 'xs' | 'sm' | 'md' | 'base' | 'lg';

export interface IconProps extends KitProps {
  readonly name: IconName;
  /** xs 11, sm 12, md 14, base 16 (the default), lg 18. */
  readonly size?: IconSize;
  readonly tone?: TextTone;
  /** An icon that means something on its own gets a name; a decorative one is hidden from readers. */
  readonly label?: string;
}

export function Icon(props: IconProps): JSX.Element {
  const icon = () => ICONS[props.name];
  return (
    <svg
      id={props.id}
      viewBox={icon()[0]}
      role={props.label ? 'img' : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : 'true'}
      data-kit="icon"
      data-part={props.part ?? 'ui.icon'}
      data-size={props.size ?? 'base'}
      data-tone={props.tone}
      data-icon={props.name}
      // The markup is the kit's own constant (icons.ts), never user data.
      innerHTML={icon()[1]}
    />
  );
}
