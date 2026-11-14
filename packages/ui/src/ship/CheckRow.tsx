// A PR's checks in fixed columns (css/ship.css): icon · name · note · duration · actions. The
// columns hold whatever a row shows, so a selected or failing row never shifts the others.
import { Show, type JSX } from 'solid-js';
import type { KitProps, WithChildren } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';

export type CheckState = 'pass' | 'fail' | 'pending' | 'skipped';

const ICON = { pass: 'check', fail: 'x', pending: 'clock', skipped: 'minus' } as const;

export interface CheckListProps extends KitProps, WithChildren {
  readonly label?: string;
}

export function CheckList(props: CheckListProps): JSX.Element {
  return (
    <ul id={props.id} data-kit="check-list" data-part={props.part ?? 'ui.check-list'} aria-label={props.label}>
      {props.children}
    </ul>
  );
}

export interface CheckRowProps extends KitProps {
  readonly name: string;
  readonly state: CheckState;
  readonly note?: string;
  /** already formatted ("1m 12s") */
  readonly duration?: string;
  readonly actions?: JSX.Element;
}

export function CheckRow(props: CheckRowProps): JSX.Element {
  return (
    <li id={props.id} data-kit="check-row" data-part={props.part ?? 'ui.check-row'} data-state={props.state}>
      <span data-kit="check-row-icon"><Icon name={ICON[props.state]} size="sm" /></span>
      <span data-kit="check-row-name" title={props.name}>{props.name}</span>
      <span data-kit="check-row-note">{props.note ?? ''}</span>
      <span data-kit="check-row-dur">{props.duration ?? ''}</span>
      <Show when={props.actions}><span data-kit="check-row-actions">{props.actions}</span></Show>
    </li>
  );
}
