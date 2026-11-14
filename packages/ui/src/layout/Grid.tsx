// Grid: equal columns, or as many columns of at least `min` as fit (auto-fit).
import type { JSX } from 'solid-js';
import type { Size, Space } from '@wisp/tokens';
import { sizeVar, spaceVar } from '@wisp/tokens';
import { styleOf, type KitProps, type Labelled, type WithChildren, type WithVars } from '../core/props.ts';
import { surfaceAttrs, surfaceVars, type SurfaceProps } from './Box.tsx';
import type { Align } from './Stack.tsx';

export type GridColumns = 1 | 2 | 3 | 4 | 5 | 6 | 12;

export interface GridProps extends KitProps, WithVars, WithChildren, Labelled, SurfaceProps {
  /** A fixed number of equal columns. */
  readonly columns?: GridColumns;
  /** Or: as many columns as fit, each at least this wide. Wins over `columns`. */
  readonly min?: Size;
  readonly gap?: Space;
  readonly rowGap?: Space;
  readonly align?: Align;
  readonly as?: 'div' | 'ul' | 'ol' | 'section';
}

export function Grid(props: GridProps): JSX.Element {
  const template = (): string =>
    props.min !== undefined
      ? `repeat(auto-fit, minmax(min(${sizeVar(props.min)}, 100%), 1fr))`
      : `repeat(${props.columns ?? 1}, minmax(0, 1fr))`;
  const gap = (): string => spaceVar(props.gap ?? '0');
  return (
    <div
      id={props.id}
      aria-label={props['aria-label']}
      aria-labelledby={props['aria-labelledby']}
      data-kit="grid"
      data-part={props.part ?? 'ui.grid'}
      data-align={props.align}
      {...surfaceAttrs(props)}
      style={styleOf({ '--k-cols': template(), '--k-gap': gap(), '--k-row-gap': props.rowGap === undefined ? gap() : spaceVar(props.rowGap), ...surfaceVars(props) }, props.vars)}
    >
      {props.children}
    </div>
  );
}
