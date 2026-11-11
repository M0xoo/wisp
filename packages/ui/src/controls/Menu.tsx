// Menu and ContextMenu on Zag's menu machine: arrow keys, typeahead, Home/End, Escape back to the
// trigger. The same entries feed both, so the right-click menu and More offer the same actions
// under the same words (design/ux.md).
import * as menu from '@zag-js/menu';
import { normalizeProps, useMachine } from '@zag-js/solid';
import { createMemo, createUniqueId, For, Match, Show, Switch, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { flag, sub, type KitProps, type PartName, type WithChildren } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';
import type { ButtonSize, ButtonVariant } from './Button.tsx';

export interface MenuItem {
  readonly kind?: 'item';
  readonly value: string;
  /** its own part name (a v1 part such as `topbar.settings`), instead of the menu's `<part>.item` */
  readonly part?: PartName;
  readonly label: string;
  readonly icon?: IconName;
  /** A second line under the label. */
  readonly hint?: string;
  /** The shortcut, shown at the end (hidden on touch). */
  readonly keys?: string;
  /** Red on hover: a destructive action. */
  readonly danger?: boolean;
  readonly disabled?: boolean;
  /** A toggle that is on shows a check at the end. */
  readonly checked?: boolean;
}

export interface MenuSeparator {
  readonly kind: 'separator';
}

export interface MenuGroup {
  readonly kind: 'group';
  readonly id: string;
  readonly label: string;
  readonly items: readonly MenuItem[];
}

export type MenuEntry = MenuItem | MenuSeparator | MenuGroup;

export type Placement = 'bottom-start' | 'bottom-end' | 'bottom' | 'top-start' | 'top-end' | 'top' | 'right-start' | 'left-start';

interface TriggerLook {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

/** What the menu's own button looks like: a label (and maybe an icon), or an icon with a name. */
export type MenuTrigger =
  | (TriggerLook & { readonly label: string; readonly icon?: IconName })
  | (TriggerLook & { readonly icon: IconName; readonly 'aria-label': string; readonly label?: undefined });

interface MenuBaseProps extends KitProps {
  readonly items: readonly MenuEntry[];
  readonly onSelect: (value: string) => void;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

export interface MenuProps extends MenuBaseProps {
  readonly trigger: MenuTrigger;
  readonly placement?: Placement;
}

function useMenu(props: MenuBaseProps & { readonly placement?: Placement }): () => menu.Api {
  const id = createUniqueId();
  const service = useMachine(menu.machine, () => ({
    id,
    onSelect: (d: menu.SelectionDetails) => props.onSelect(d.value),
    ...(props.open === undefined ? {} : { open: props.open }),
    onOpenChange: (d: menu.OpenChangeDetails) => props.onOpenChange?.(d.open),
    positioning: { placement: props.placement ?? 'bottom-start', gutter: 4 },
  }));
  return createMemo(() => menu.connect(service, normalizeProps));
}

function Item(props: { readonly api: menu.Api; readonly item: MenuItem; readonly part: PartName }): JSX.Element {
  return (
    <div
      {...props.api.getItemProps({ value: props.item.value, disabled: props.item.disabled, valueText: props.item.label })}
      data-kit="menu-item"
      data-part={props.item.part ?? sub(props.part, 'item')}
      data-danger={flag(props.item.danger)}
      data-value={props.item.value}
    >
      <Show when={props.item.icon}>{(name) => <Icon name={name()} size="md" />}</Show>
      <span data-kit="menu-item-text">
        <span data-kit="menu-item-label" data-text="control">{props.item.label}</span>
        <Show when={props.item.hint}>{(hint) => <span data-kit="menu-item-hint">{hint()}</span>}</Show>
      </span>
      <Show when={props.item.checked}>
        <Icon name="check" size="sm" tone="accent-ink" />
      </Show>
      <Show when={props.item.keys}>{(keys) => <kbd data-kit="kbd">{keys()}</kbd>}</Show>
    </div>
  );
}

/** The floating list both menus share. */
function MenuContent(props: { readonly api: menu.Api; readonly items: readonly MenuEntry[]; readonly part: PartName }): JSX.Element {
  return (
    <Portal>
      <div {...props.api.getPositionerProps()} data-kit="positioner">
        <div {...props.api.getContentProps()} data-kit="menu" data-part={props.part}>
          <For each={props.items}>
            {(entry) => (
              <Switch fallback={<Item api={props.api} item={entry as MenuItem} part={props.part} />}>
                <Match when={entry.kind === 'separator'}>
                  <div {...props.api.getSeparatorProps()} data-kit="menu-separator" data-part={sub(props.part, 'separator')} />
                </Match>
                <Match when={entry.kind === 'group' && entry}>
                  {(group) => (
                    <div {...props.api.getItemGroupProps({ id: group().id })} data-kit="menu-group" data-part={sub(props.part, 'group')}>
                      <div {...props.api.getItemGroupLabelProps({ htmlFor: group().id })} data-kit="menu-group-label">
                        {group().label}
                      </div>
                      <For each={group().items}>{(item) => <Item api={props.api} item={item} part={props.part} />}</For>
                    </div>
                  )}
                </Match>
              </Switch>
            )}
          </For>
        </div>
      </div>
    </Portal>
  );
}

const labelOf = (t: MenuTrigger): string | undefined => ('aria-label' in t ? t['aria-label'] : undefined);

/** A button that opens a list of actions. */
export function Menu(props: MenuProps): JSX.Element {
  const api = useMenu(props);
  const part = (): PartName => props.part ?? 'ui.menu';
  const t = (): MenuTrigger => props.trigger;
  return (
    <>
      <button
        {...api().getTriggerProps()}
        aria-label={labelOf(t())}
        title={labelOf(t())}
        data-kit={t().label ? 'button' : 'icon-button'}
        data-part={sub(part(), 'trigger')}
        data-variant={t().variant ?? (t().label ? 'secondary' : 'ghost')}
        data-size={t().size ?? 'md'}
      >
        <span data-kit="button-content">
          <Show when={t().icon}>{(name) => <Icon name={name()} size={t().label ? 'md' : 'base'} />}</Show>
          <Show when={t().label}>{(label) => <span data-kit="button-label" data-text="control">{label()}</span>}</Show>
        </span>
      </button>
      <MenuContent api={api()} items={props.items} part={part()} />
    </>
  );
}

export interface ContextMenuProps extends MenuBaseProps, WithChildren {}

/** Right-click (or long-press) on its children opens the menu at the pointer. */
export function ContextMenu(props: ContextMenuProps): JSX.Element {
  const api = useMenu(props);
  const part = (): PartName => props.part ?? 'ui.context-menu';
  return (
    <>
      <div {...api().getContextTriggerProps()} data-kit="context-area" data-part={sub(part(), 'area')}>
        {props.children}
      </div>
      <MenuContent api={api()} items={props.items} part={part()} />
    </>
  );
}

export interface MenuOnProps extends MenuBaseProps {
  readonly placement?: Placement;
  /** draws the control that opens the menu: spread `trigger()` on it (Zag's trigger props: its press,
   * aria-expanded, the id the menu points back at) */
  readonly children: (trigger: () => Record<string, unknown>) => JSX.Element;
}

/** A menu opened by a control drawn by its caller (the app frame's v1 pickers), not by the kit's button. */
export function MenuOn(props: MenuOnProps): JSX.Element {
  const api = useMenu(props);
  const part = (): PartName => props.part ?? 'ui.menu';
  return (
    <>
      {props.children(() => api().getTriggerProps() as Record<string, unknown>)}
      <MenuContent api={api()} items={props.items} part={part()} />
    </>
  );
}
