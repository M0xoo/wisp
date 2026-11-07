// Divider: a 1px neutral line. Separators use --line, a firmer one --line-2.
import type { JSX } from 'solid-js';
import type { KitProps } from '../core/props.ts';

export interface DividerProps extends KitProps {
  readonly orientation?: 'horizontal' | 'vertical';
  readonly strength?: 'soft' | 'strong';
}

export function Divider(props: DividerProps): JSX.Element {
  const orientation = (): 'horizontal' | 'vertical' => props.orientation ?? 'horizontal';
  return (
    <hr
      id={props.id}
      aria-orientation={orientation()}
      data-kit="divider"
      data-part={props.part ?? 'ui.divider'}
      data-orientation={orientation()}
      data-strength={props.strength ?? 'soft'}
    />
  );
}
