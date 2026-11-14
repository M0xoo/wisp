// Pick several projects (owner, 2026-11-13; docs/v2-queue.md GUI item 7): a slim strip over the list while more than
// one project is picked. Each project a removable chip (its dot and name, × on hover and always on touch), then
// "Only <first>" and "All projects", so leaving the multi-pick is one click. One line that never wraps: the chips
// scroll sideways (a phone's chip row), the two links keep their place at the end.
import { For, type JSX } from 'solid-js';
import { Icon } from '../content/Icon.tsx';

export interface PickStripChip {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  /** the tip (its folder) */
  readonly title: string;
  /** "Leave api out" */
  readonly removeLabel: string;
}

export interface PickStripProps {
  /** the strip's name (Projects shown) */
  readonly label: string;
  readonly chips: readonly PickStripChip[];
  readonly onRemove: (id: string) => void;
  /** "Only api": the first picked alone */
  readonly only: { readonly label: string; readonly onClick: () => void };
  /** "All projects": the pick cleared */
  readonly all: { readonly label: string; readonly onClick: () => void };
}

export function PickStrip(props: PickStripProps): JSX.Element {
  return (
    <div data-kit="pick-strip" data-part="list.pick" role="group" aria-label={props.label}>
      <div data-kit="pick-chips">
        <For each={props.chips}>
          {(c) => (
            <span data-kit="pick-chip" data-part="list.pick.chip" data-color={c.color} title={c.title}>
              <i data-kit="p-dot" />
              <span data-text="control">{c.name}</span>
              <button type="button" data-kit="pick-x" data-part="list.pick.remove" title={c.removeLabel} aria-label={c.removeLabel} onClick={() => props.onRemove(c.id)}>
                <Icon name="x" size="sm" />
              </button>
            </span>
          )}
        </For>
      </div>
      <button type="button" data-kit="pick-link" data-part="list.pick.only" onClick={() => props.only.onClick()}>
        <span data-text="control">{props.only.label}</span>
      </button>
      <button type="button" data-kit="pick-link" data-part="list.pick.all" onClick={() => props.all.onClick()}>
        <span data-text="control">{props.all.label}</span>
      </button>
    </div>
  );
}
