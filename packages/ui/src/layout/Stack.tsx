// Stack (a column) and Inline (a row that wraps): flex layouts whose gaps come from the scale only.
import { Dynamic } from 'solid-js/web';
import type { JSX } from 'solid-js';
import type { Space } from '@wisp/tokens';
import { spaceVar } from '@wisp/tokens';
import { flag, styleOf, type KitProps, type Labelled, type WithChildren, type WithVars } from '../core/props.ts';
import { surfaceAttrs, surfaceVars, type BoxElement, type SurfaceProps } from './Box.tsx';

export type Align = 'start' | 'center' | 'end' | 'stretch' | 'baseline';
export type Justify = 'start' | 'center' | 'end' | 'between';

export interface FlexProps extends KitProps, WithVars, WithChildren, Labelled, SurfaceProps {
  readonly as?: BoxElement;
  readonly gap?: Space;
  readonly align?: Align;
  readonly justify?: Justify;
  readonly role?: JSX.HTMLAttributes<HTMLElement>['role'];
  readonly ref?: (el: HTMLElement) => void;
}

export interface InlineProps extends FlexProps {
  /** Wrap onto more lines when the row runs out of room (default true). */
  readonly wrap?: boolean;
}

function Flex(props: InlineProps & { readonly kit: 'stack' | 'inline'; readonly fallbackPart: `${string}.${string}` }): JSX.Element {
  return (
    <Dynamic
      component={props.as ?? 'div'}
      ref={props.ref}
      id={props.id}
      role={props.role}
      aria-label={props['aria-label']}
      aria-labelledby={props['aria-labelledby']}
      aria-describedby={props['aria-describedby']}
      data-kit={props.kit}
      data-part={props.part ?? props.fallbackPart}
      data-align={props.align}
      data-justify={props.justify}
      data-nowrap={flag(props.wrap === false)}
      {...surfaceAttrs(props)}
      style={styleOf({ '--k-gap': spaceVar(props.gap ?? '0'), ...surfaceVars(props) }, props.vars)}
    >
      {props.children}
    </Dynamic>
  );
}

/** Children in a column, `gap` apart. */
export function Stack(props: FlexProps): JSX.Element {
  return <Flex {...props} kit="stack" fallbackPart="ui.stack" />;
}

/** Children in a row, `gap` apart, wrapping unless `wrap={false}`. Centred on the cross axis by default. */
export function Inline(props: InlineProps): JSX.Element {
  return <Flex {...props} kit="inline" fallbackPart="ui.inline" />;
}
