// Menu and ContextMenu on Zag's menu machine: arrow keys, typeahead, Home/End, Escape back to the
// trigger. The same entries feed both, so the right-click menu and More offer the same actions
// under the same words (design/ux.md). A submenu drills in (v1 #786 ui/submenu.js): its items take
// the menu's place under a Back row, at the same spot and width; → opens it, ← or Escape steps back.
import * as menu from '@zag-js/menu';
import { normalizeProps, useMachine } from '@zag-js/solid';
import { createMemo, createSignal, createUniqueId, For, Match, Show, Switch, type Accessor, type JSX } from 'solid-js';
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

/** A row that drills into its own items (one level: no submenu in a submenu). */
export interface MenuSubmenu {
  readonly kind: 'submenu';
  /** names the row (its `data-value`); never passed to `onSelect` */
  readonly value: string;
  readonly label: string;
  readonly icon?: IconName;
  readonly part?: PartName;
  readonly items: readonly (MenuItem | MenuSeparator | MenuGroup)[];
}

export type MenuEntry = MenuItem | MenuSeparator | MenuGroup | MenuSubmenu;

const BACK = 'menu:back';

/** A long menu in sections (v1 #786 sectionsHtml / subHtml): a line between groups, empty groups
 *  dropped, and a submenu of one item left inline (none of zero), so no drill-in holds a single row. */
export function menuSections(groups: readonly (readonly (MenuEntry | false | null | undefined)[])[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const g of groups) {
    const xs = g.flatMap((e): MenuEntry[] => {
      if (!e) return [];
      if (e.kind !== 'submenu') return [e];
      return e.items.length < 2 ? [...e.items] : [e];
    });
    if (!xs.length) continue;
    if (out.length) out.push({ kind: 'separator' });
    out.push(...xs);
  }
  return out;
}

export type Placement = 'bottom-start' | 'bottom-end' | 'bottom' | 'top-start' | 'top-end' | 'top' | 'right-start' | 'left-start';

interface TriggerLook {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

/** What the menu's own button looks like: a label (and maybe an icon), or an icon with a name. */
export type MenuTrigger = (TriggerLook & { readonly label: string; readonly icon?: IconName }) | (TriggerLook & { readonly icon: IconName; readonly 'aria-label': string; readonly label?: undefined });

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

interface MenuState {
  readonly api: Accessor<menu.Api>;
  /** the submenu drilled into (its value), or none */
  readonly pane: Accessor<string | undefined>;
  readonly drill: (value: string | undefined) => void;
  /** the menu's width as it drilled in: it keeps it in and out of the submenu (v1) */
  readonly width: Accessor<string | undefined>;
  readonly setBox: (el: HTMLElement) => void;
  /** back to the top level at its own width (a right-click on another row re-anchors the open menu) */
  readonly reset: () => void;
}

const firstItem = (items: readonly MenuEntry[]): string | undefined => {
  for (const e of items) {
    if (e.kind === 'separator') continue;
    if (e.kind === 'group') {
      const x = e.items.find((i) => !i.disabled);
      if (x) return x.value;
    } else if (!(e.kind !== 'submenu' && e.disabled)) return e.value;
  }
  return undefined;
};

function useMenu(props: MenuBaseProps & { readonly placement?: Placement }, at?: 'pointer'): MenuState {
  const id = createUniqueId();
  const [chosen, setPane] = createSignal<string | undefined>();
  const [width, setWidth] = createSignal<string | undefined>();
  // the submenu drilled into, while the items still have it (a task's More can drop a row and fold it inline)
  const pane = (): string | undefined => {
    const v = chosen();
    return v !== undefined && props.items.some((e) => e.kind === 'submenu' && e.value === v) ? v : undefined;
  };
  const reset = (): void => {
    setPane(undefined);
    setWidth(undefined);
  };
  let box: HTMLElement | undefined;
  const subs = createMemo(() => new Set(props.items.flatMap((e) => (e.kind === 'submenu' ? [e.value] : []))));
  let api: Accessor<menu.Api> = () => {
    throw new Error('menu: not connected');
  };
  // in or out of a submenu: the first of its items lit (or, coming back, the row that opened it)
  const drill = (value: string | undefined): void => {
    const was = pane();
    if (value !== undefined && was === undefined && box) setWidth(`${box.offsetWidth}px`);
    setPane(value);
    const sub = props.items.find((e): e is MenuSubmenu => e.kind === 'submenu' && e.value === value);
    const lit = sub ? firstItem(sub.items) : was;
    if (lit) queueMicrotask(() => api().setHighlightedValue(lit));
  };
  const service = useMachine(menu.machine, () => ({
    id,
    onSelect: (d: menu.SelectionDetails) => {
      if (d.value === BACK) drill(undefined);
      else if (subs().has(d.value)) drill(d.value);
      else props.onSelect(d.value);
    },
    // Escape inside a submenu steps back to the menu rather than closing it (v1 wireSubmenus)
    onEscapeKeyDown: (e: KeyboardEvent) => {
      if (pane() === undefined) return;
      e.preventDefault();
      drill(undefined);
    },
    ...(props.open === undefined ? {} : { open: props.open }),
    onOpenChange: (d: menu.OpenChangeDetails) => {
      if (!d.open) reset();
      props.onOpenChange?.(d.open);
    },
    // at the pointer (a right-click): v1 clampToViewport, opened beside it and slid up or in to fit, never flipped
    positioning: at === 'pointer' ? { placement: 'bottom-start' as const, gutter: 0, flip: false, overlap: true, overflowPadding: 8 } : { placement: props.placement ?? 'bottom-start', gutter: 4, overlap: true, overflowPadding: 8 },
  }));
  api = createMemo(() => menu.connect(service, normalizeProps));
  return { api, pane, drill, width, setBox: (el) => (box = el), reset };
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
        <span data-kit="menu-item-label" data-text="control">
          {props.item.label}
        </span>
        <Show when={props.item.hint}>{(hint) => <span data-kit="menu-item-hint">{hint()}</span>}</Show>
      </span>
      <Show when={props.item.checked}>
        <Icon name="check" size="sm" tone="accent-ink" />
      </Show>
      <Show when={props.item.keys}>{(keys) => <kbd data-kit="kbd">{keys()}</kbd>}</Show>
    </div>
  );
}

/** A submenu's row: its icon, its name and a chevron; choosing it (or →) drills in. */
function SubRow(props: { readonly api: menu.Api; readonly entry: MenuSubmenu; readonly part: PartName }): JSX.Element {
  return (
    <div
      {...props.api.getItemProps({ value: props.entry.value, closeOnSelect: false, valueText: props.entry.label })}
      data-kit="menu-item"
      data-part={props.entry.part ?? sub(props.part, 'sub')}
      data-value={props.entry.value}
      data-sub=""
      aria-haspopup="menu"
      aria-expanded="false"
    >
      <Show when={props.entry.icon}>{(name) => <Icon name={name()} size="md" />}</Show>
      <span data-kit="menu-item-text">
        <span data-kit="menu-item-label" data-text="control">
          {props.entry.label}
        </span>
      </span>
      <Icon name="chevron" size="sm" tone="faint" />
    </div>
  );
}

/** A submenu's Back row: names the submenu it's in. */
function BackRow(props: { readonly api: menu.Api; readonly label: string; readonly part: PartName }): JSX.Element {
  return (
    <div {...props.api.getItemProps({ value: BACK, closeOnSelect: false, valueText: props.label })} data-kit="menu-item" data-part={sub(props.part, 'back')} data-back="">
      <Icon name="back" size="md" />
      <span data-kit="menu-item-text">
        <span data-kit="menu-item-label" data-text="control">
          {props.label}
        </span>
      </span>
    </div>
  );
}

function Entries(props: { readonly api: menu.Api; readonly items: readonly MenuEntry[]; readonly part: PartName }): JSX.Element {
  return (
    <For each={props.items}>
      {(entry) => (
        <Switch fallback={<Item api={props.api} item={entry as MenuItem} part={props.part} />}>
          <Match when={entry.kind === 'separator'}>
            <div {...props.api.getSeparatorProps()} data-kit="menu-separator" data-part={sub(props.part, 'separator')} />
          </Match>
          <Match when={entry.kind === 'submenu' && entry}>{(e) => <SubRow api={props.api} entry={e()} part={props.part} />}</Match>
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
  );
}

/** The floating list both menus share. */
function MenuContent(props: { readonly state: MenuState; readonly items: readonly MenuEntry[]; readonly part: PartName; readonly at?: 'pointer' }): JSX.Element {
  const api = (): menu.Api => props.state.api();
  const open = createMemo(() => {
    const v = props.state.pane();
    return v === undefined ? undefined : props.items.find((e): e is MenuSubmenu => e.kind === 'submenu' && e.value === v);
  });
  const drill = (v: string | undefined): void => props.state.drill(v);
  // → on a submenu's row opens it, ← in one steps back (before Zag's own keys)
  const keys = (e: KeyboardEvent): void => {
    const lit = api().highlightedValue;
    if (e.key === 'ArrowRight' && !open() && lit && props.items.some((x) => x.kind === 'submenu' && x.value === lit)) drill(lit);
    else if (e.key === 'ArrowLeft' && open()) drill(undefined);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <Portal>
      <div {...api().getPositionerProps()} data-kit="positioner" ref={(el) => el.addEventListener('keydown', keys, true)}>
        <div
          {...api().getContentProps()}
          ref={(el) => props.state.setBox(el)}
          data-kit="menu"
          data-part={props.part}
          data-at={props.at}
          data-drilled={flag(!!open())}
          style={props.state.width() ? { '--menu-w': props.state.width() } : undefined}
        >
          <Show when={open()} fallback={<Entries api={api()} items={props.items} part={props.part} />}>
            {(s) => (
              <div role="group" aria-label={s().label} data-kit="menu-pane" data-part={sub(props.part, 'pane')}>
                <BackRow api={api()} label={s().label} part={props.part} />
                <Entries api={api()} items={s().items} part={props.part} />
              </div>
            )}
          </Show>
        </div>
      </div>
    </Portal>
  );
}

const labelOf = (t: MenuTrigger): string | undefined => ('aria-label' in t ? t['aria-label'] : undefined);

/** A button that opens a list of actions. */
export function Menu(props: MenuProps): JSX.Element {
  const state = useMenu(props);
  const api = state.api;
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
          <Show when={t().label}>
            {(label) => (
              <span data-kit="button-label" data-text="control">
                {label()}
              </span>
            )}
          </Show>
        </span>
      </button>
      <MenuContent state={state} items={props.items} part={part()} />
    </>
  );
}

export interface ContextMenuProps extends MenuBaseProps, WithChildren {}

/** Right-click (or long-press) on its children opens the menu at the pointer. */
export function ContextMenu(props: ContextMenuProps): JSX.Element {
  const state = useMenu(props, 'pointer');
  const part = (): PartName => props.part ?? 'ui.context-menu';
  return (
    <>
      <div
        {...state.api().getContextTriggerProps()}
        ref={(el) => el.addEventListener('contextmenu', state.reset, true)}
        data-kit="context-area"
        data-part={sub(part(), 'area')}
      >
        {props.children}
      </div>
      <MenuContent state={state} items={props.items} part={part()} at="pointer" />
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
  const state = useMenu(props);
  const part = (): PartName => props.part ?? 'ui.menu';
  return (
    <>
      {props.children(() => state.api().getTriggerProps() as Record<string, unknown>)}
      <MenuContent state={state} items={props.items} part={part()} />
    </>
  );
}
