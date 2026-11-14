// Gap: the space of a control that a row doesn't have, so the rows' buttons and times stay in the
// same columns whichever actions apply (v1 .it-quick-gap). Invisible, inert, and as wide as an
// icon button of that size.
import type { JSX } from 'solid-js';
import type { KitProps } from '../core/props.ts';

export interface GapProps extends KitProps {
  readonly size?: 'xs' | 'sm' | 'md';
}

export function Gap(props: GapProps): JSX.Element {
  return <span id={props.id} data-kit="gap" data-part={props.part ?? 'ui.gap'} data-size={props.size ?? 'sm'} aria-hidden="true" />;
}
