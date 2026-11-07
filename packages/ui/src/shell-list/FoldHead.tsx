// FoldHead: a list section's heading that folds it (v1 feed's h4.sec-toggle): a chevron, the title,
// its count and an optional badge ("2 new"). One line of control text; the count is tabular and
// never truncated, the title ends in … first. Enter and Space toggle it like any button.
import { Show, type JSX } from 'solid-js';
import { flag, sub, type KitProps, type PartName } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';

export interface FoldHeadProps extends KitProps {
  readonly title: string;
  readonly open: boolean;
  readonly onToggle: () => void;
  /** how many rows the section holds; hidden at 0 */
  readonly count?: number;
  /** a short word beside the count, in the accent ("2 new") */
  readonly badge?: string;
  /** the id of the rows it folds */
  readonly controls?: string;
}

export function FoldHead(props: FoldHeadProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.fold-head';
  return (
    <button
      type="button"
      id={props.id}
      data-kit="fold-head"
      data-part={part()}
      data-open={flag(props.open)}
      aria-expanded={props.open}
      aria-controls={props.controls}
      onClick={() => props.onToggle()}
    >
      <Icon name="chevron" size="sm" />
      <span data-kit="fold-head-title" data-text="control" data-part={sub(part(), 'title')}>{props.title}</span>
      <Show when={props.count}>{(n) => <span data-kit="fold-head-count" data-text="control" data-part={sub(part(), 'count')}>{n()}</span>}</Show>
      <Show when={props.badge}>{(b) => <span data-kit="fold-head-badge" data-text="control" data-part={sub(part(), 'badge')}>{b()}</span>}</Show>
    </button>
  );
}
