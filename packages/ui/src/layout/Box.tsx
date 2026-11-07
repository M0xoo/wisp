// Box: the one plain element. It picks a semantic element and takes token-typed surface props; it
// has no styling knobs beyond the tokens.
import { Dynamic } from 'solid-js/web';
import type { JSX } from 'solid-js';
import type { LineColor, Radius, Shadow, Space, SurfaceColor } from '@wisp/tokens';
import { radiusVar, shadowVar, spaceVar } from '@wisp/tokens';
import { flag, styleOf, type KitProps, type Labelled, type WithChildren, type WithVars } from '../core/props.ts';

export type BoxElement =
  | 'div' | 'span' | 'section' | 'article' | 'aside' | 'header' | 'footer' | 'main' | 'nav'
  | 'ul' | 'ol' | 'li' | 'p' | 'figure' | 'form' | 'fieldset' | 'label';

/** Padding and surface props shared by Box, Stack, Inline and Grid. */
export interface SurfaceProps {
  readonly pad?: Space;
  readonly padX?: Space;
  readonly padY?: Space;
  readonly surface?: SurfaceColor;
  readonly border?: LineColor;
  readonly radius?: Radius;
  readonly shadow?: Shadow;
  /** Takes the free space in a flex parent (flex: 1, min-width: 0). */
  readonly grow?: boolean;
}

export interface BoxProps extends KitProps, WithVars, WithChildren, Labelled, SurfaceProps {
  readonly as?: BoxElement;
  readonly role?: JSX.HTMLAttributes<HTMLElement>['role'];
  readonly ref?: (el: HTMLElement) => void;
}

/** The `--k-*` knobs the surface props set; the kit's CSS reads them. */
export function surfaceVars(p: SurfaceProps): Record<`--${string}`, string | undefined> {
  // Custom properties inherit: once any padding is set, both axes are set, so an unset axis
  // reads 0 here instead of an ancestor's value.
  const padded = p.pad !== undefined || p.padX !== undefined || p.padY !== undefined;
  const axis = (side: Space | undefined): string | undefined => (padded ? spaceVar(side ?? p.pad ?? '0') : undefined);
  return {
    '--k-pad-x': axis(p.padX),
    '--k-pad-y': axis(p.padY),
    '--k-surface': p.surface === undefined ? undefined : `var(--${p.surface})`,
    '--k-border': p.border === undefined ? undefined : `var(--${p.border})`,
    '--k-radius': p.radius === undefined ? undefined : radiusVar(p.radius),
    '--k-shadow': p.shadow === undefined ? undefined : shadowVar(p.shadow),
  };
}

/** Data attributes that switch the surface rules on only where they're used. */
export function surfaceAttrs(p: SurfaceProps): Record<string, '' | undefined> {
  return {
    'data-pad': flag(p.pad !== undefined || p.padX !== undefined || p.padY !== undefined),
    'data-surface': flag(p.surface !== undefined),
    'data-border': flag(p.border !== undefined),
    'data-radius': flag(p.radius !== undefined),
    'data-shadow': flag(p.shadow !== undefined),
    'data-grow': flag(p.grow),
  };
}

export function Box(props: BoxProps): JSX.Element {
  return (
    <Dynamic
      component={props.as ?? 'div'}
      ref={props.ref}
      id={props.id}
      role={props.role}
      aria-label={props['aria-label']}
      aria-labelledby={props['aria-labelledby']}
      aria-describedby={props['aria-describedby']}
      data-kit="box"
      data-part={props.part ?? 'ui.box'}
      {...surfaceAttrs(props)}
      style={styleOf(surfaceVars(props), props.vars)}
    >
      {props.children}
    </Dynamic>
  );
}
