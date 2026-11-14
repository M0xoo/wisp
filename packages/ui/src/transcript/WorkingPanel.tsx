// WorkingPanel: a turn at work (v1 .w-panel): the orb, a status line (who is working, how long,
// how many steps; one line that never wraps), what it needs from you, a ticker of its last steps,
// and its actions (Stop last, at the end).
import { For, Show, type JSX } from 'solid-js';
import { flag, sub, type KitProps, type PartName } from '../core/props.ts';
import { Orb } from './Orb.tsx';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';

export interface WorkingPanelProps extends KitProps {
  readonly status: string;
  readonly elapsed?: string;
  readonly count?: string;
  /** a line after the count (No output for 12 min) */
  readonly note?: string;
  /** waiting on you: the amber state */
  readonly waiting?: boolean;
  readonly children?: JSX.Element;
  /** its last steps, newest first (v1 .ticker: five, fading). Additive (2026-11-12). */
  readonly ticker?: readonly { readonly icon: IconName; readonly text: string }[];
  readonly actions?: JSX.Element;
}

export function WorkingPanel(props: WorkingPanelProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.working';
  return (
    <div id={props.id} data-kit="working" data-part={part()} data-waiting={flag(props.waiting)} role="status" aria-live="polite">
      <span data-kit="working-orb">
        <Orb live waiting={props.waiting ?? false} />
      </span>
      <div data-kit="working-body">
        <div data-kit="working-status" data-part={sub(part(), 'status')}>
          <b data-kit="working-title" data-text="control" title={props.status}>
            {props.status}
          </b>
          <Show when={props.elapsed}>
            <span data-kit="working-elapsed" data-text="control">
              {props.elapsed}
            </span>
          </Show>
          <Show when={props.count}>
            <span data-kit="working-count" data-text="control">
              {props.count}
            </span>
          </Show>
          <Show when={props.note}>
            <span data-kit="working-note" data-text="control" title={props.note}>
              {props.note}
            </span>
          </Show>
        </div>
        {props.children}
        <Show when={props.ticker?.length}>
          <ul data-kit="working-ticker" data-part={sub(part(), 'ticker')}>
            <For each={props.ticker?.slice(0, 5)}>
              {(a) => (
                <li data-kit="working-act">
                  <Icon name={a.icon} size="sm" />
                  <span data-text="control" title={a.text}>
                    {a.text}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={props.actions}>
          <div data-kit="working-actions" data-part={sub(part(), 'actions')}>
            {props.actions}
          </div>
        </Show>
      </div>
    </div>
  );
}
