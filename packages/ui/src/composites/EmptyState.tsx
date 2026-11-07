// EmptyState: useful or absent (design/ux.md: no "Nothing needs you" filler). An icon, what's
// missing, and the one step that fills it.
import { Show, type JSX } from 'solid-js';
import { sub, type KitProps, type PartName, type WithChildren } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';

export interface EmptyStateProps extends KitProps, WithChildren {
  readonly title: string;
  readonly icon?: IconName;
  /** The next step: usually one Button. */
  readonly action?: JSX.Element;
  /** Tight: for a pane or a menu, not a whole page. */
  readonly compact?: boolean;
}

export function EmptyState(props: EmptyStateProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.empty-state';
  return (
    <div id={props.id} data-kit="empty-state" data-part={part()} data-compact={props.compact ? '' : undefined}>
      <Show when={props.icon}>
        {(name) => (
          <span data-kit="empty-state-icon" data-part={sub(part(), 'icon')}>
            <Icon name={name()} size="lg" />
          </span>
        )}
      </Show>
      <p data-kit="empty-state-title" data-part={sub(part(), 'title')}>{props.title}</p>
      <Show when={props.children}>
        <div data-kit="empty-state-body" data-part={sub(part(), 'body')}>{props.children}</div>
      </Show>
      <Show when={props.action}>
        <div data-kit="empty-state-action" data-part={sub(part(), 'action')}>{props.action}</div>
      </Show>
    </div>
  );
}
