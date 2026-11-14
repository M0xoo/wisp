// Scroll: a box that scrolls on one axis, with a stable gutter so the scrollbar appearing never
// shifts the layout (v1's .stage), and overscroll kept inside it.
import type { JSX } from 'solid-js';
import type { Size } from '@wisp/tokens';
import { sizeVar } from '@wisp/tokens';
import { flag, styleOf, type KitProps, type Labelled, type WithChildren, type WithVars } from '../core/props.ts';

export interface ScrollProps extends KitProps, WithVars, WithChildren, Labelled {
  readonly axis?: 'y' | 'x' | 'both';
  /** Fill the parent's free space (flex: 1, min-height: 0) instead of sizing to content. */
  readonly grow?: boolean;
  /** Cap the height; past it the box scrolls. */
  readonly max?: Size;
  readonly ref?: (el: HTMLDivElement) => void;
  readonly onScroll?: (el: HTMLDivElement) => void;
  /** A focusable region so keyboard users can scroll it (adds tabindex=0 and needs a label). */
  readonly focusable?: boolean;
}

export function Scroll(props: ScrollProps): JSX.Element {
  return (
    <div
      ref={props.ref}
      id={props.id}
      role={props.focusable ? 'region' : undefined}
      tabIndex={props.focusable ? 0 : undefined}
      aria-label={props['aria-label']}
      aria-labelledby={props['aria-labelledby']}
      data-kit="scroll"
      data-part={props.part ?? 'ui.scroll'}
      data-axis={props.axis ?? 'y'}
      data-grow={flag(props.grow)}
      onScroll={(e) => props.onScroll?.(e.currentTarget)}
      style={styleOf({ '--k-max': props.max === undefined ? undefined : sizeVar(props.max) }, props.vars)}
    >
      {props.children}
    </div>
  );
}
