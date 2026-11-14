// Orb: live work, as v1 draws it (.orb.live): a 3×3 grid of dots with a ripple running out from
// its centre. The one "busy" signal (design/ui.md: don't invent another). Still under reduced motion.
import { For, type JSX } from 'solid-js';
import { flag, type KitProps } from '../core/props.ts';

export interface OrbProps extends KitProps {
  readonly live?: boolean;
  /** waiting on you: the amber pulse instead of the ripple */
  readonly waiting?: boolean;
  readonly label?: string;
}

const CELLS = [0, 1, 2, 1, 2, 3, 2, 3, 4]; // ring distance from the centre cell, for the ripple delay

export function Orb(props: OrbProps): JSX.Element {
  return (
    <span
      id={props.id}
      data-kit="orb"
      data-part={props.part ?? 'ui.orb'}
      data-live={flag(props.live)}
      data-waiting={flag(props.waiting)}
      role={props.label ? 'img' : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : 'true'}
    >
      <For each={CELLS}>{(ring) => <i data-kit="orb-dot" data-ring={Math.abs(ring - 2)} />}</For>
    </span>
  );
}
