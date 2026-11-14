// Stack (a column), Inline (one row that never wraps) and Wrap (a group that may run onto more
// lines): flex layouts whose gaps come from the scale only. Wrapping is a layout decision made by
// picking Wrap; Inline has no wrap prop, so a bar can't wrap by accident (design/layout.md §5).
import { Dynamic } from 'solid-js/web';
import type { JSX } from 'solid-js';
import type { Space } from '@wisp/tokens';
import { spaceVar } from '@wisp/tokens';
import { styleOf, type KitProps, type Labelled, type WithChildren, type WithVars } from '../core/props.ts';
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

export type InlineProps = FlexProps;

export interface WrapProps extends FlexProps {
  /** The gap between lines; defaults to `gap`. */
  readonly rowGap?: Space;
}

function Flex(props: WrapProps & { readonly kit: 'stack' | 'inline' | 'wrap'; readonly fallbackPart: `${string}.${string}` }): JSX.Element {
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
      {...surfaceAttrs(props)}
      style={styleOf(
        { '--k-gap': spaceVar(props.gap ?? '0'), '--k-row-gap': spaceVar(props.rowGap ?? props.gap ?? '0'), ...surfaceVars(props) },
        props.vars,
      )}
    >
      {props.children}
    </Dynamic>
  );
}

/** Children in a column, `gap` apart. */
export function Stack(props: FlexProps): JSX.Element {
  return <Flex {...props} kit="stack" fallbackPart="ui.stack" />;
}

/** Children in one row, `gap` apart, centred on the cross axis. Never wraps: what doesn't fit shrinks
 * (control text ends in `…`). A row of controls that must survive narrow widths is a Toolbar. */
export function Inline(props: InlineProps): JSX.Element {
  return <Flex {...props} kit="inline" fallbackPart="ui.inline" />;
}

/** A group that may wrap onto more lines on purpose: tags, attachment chips, a question's answers. */
export function Wrap(props: WrapProps): JSX.Element {
  return <Flex {...props} kit="wrap" fallbackPart="ui.wrap" />;
}
