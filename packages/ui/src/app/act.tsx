// What pressing one of the frame's controls does (design/feedback.md): a press, or a menu it opens
// (the kit's menu, on the control as v1 draws it). While its command is in flight the control is
// pending: a spinner in place of its icon, the same width, and pressing it again does nothing.
import { Show, type JSX } from 'solid-js';
import { MenuOn, type MenuEntry } from '../controls/Menu.tsx';

export interface Act {
  readonly onClick?: () => void;
  readonly menu?: { readonly items: readonly MenuEntry[]; readonly onSelect: (value: string) => void };
  /** its command is in flight */
  readonly pending?: boolean;
}

/** The attributes a control gets for its act: pending (aria-busy, data-pending) and no second press. */
export function actAttrs(act: Act | undefined): Record<string, unknown> {
  return act?.pending ? { 'aria-busy': 'true', 'data-pending': '' } : {};
}

/** Draws `render(trigger)`: with a menu, `trigger()` holds the menu's trigger props to spread on the
 * control; without one, its press. */
export function WithAct(props: { readonly act?: Act | undefined; readonly render: (trigger: () => Record<string, unknown>) => JSX.Element }): JSX.Element {
  const press = (): Record<string, unknown> => ({
    onClick: (e: MouseEvent) => {
      e.stopPropagation();
      if (!props.act?.pending) props.act?.onClick?.();
    },
    ...actAttrs(props.act),
  });
  return (
    <Show when={props.act?.menu} fallback={props.render(press)}>
      {(m) => (
        <MenuOn items={m().items} onSelect={(v) => m().onSelect(v)} part="ui.menu">
          {(trigger) => props.render(() => ({ ...trigger(), ...actAttrs(props.act) }))}
        </MenuOn>
      )}
    </Show>
  );
}

/** The icon, or the spinner that takes its place while pending (the same box). */
export function ActIcon(props: { readonly act?: Act | undefined; readonly children: JSX.Element }): JSX.Element {
  return (
    <Show when={props.act?.pending} fallback={props.children}>
      <span data-kit="spinner" data-in="act" role="status" />
    </Show>
  );
}
