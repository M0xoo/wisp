// RowLogo: a harness's mark on a task row's run line (v1 feed.js runBadge .ir-logo), with Auto's accent dot on
// its corner when the router picked the run.
import type { JSX } from 'solid-js';
import { flag, type KitProps } from '../core/props.ts';

export interface RowLogoProps extends KitProps {
  /** an image URL (the harness plugin's data: URL) */
  readonly src: string;
  /** Auto picked this run: the accent dot on the logo's corner */
  readonly routed?: boolean;
}

export function RowLogo(props: RowLogoProps): JSX.Element {
  return (
    <span data-kit="ir-logo" data-part={props.part ?? 'ui.row-logo'} data-routed={flag(props.routed)} aria-hidden="true">
      <img src={props.src} alt="" />
    </span>
  );
}
