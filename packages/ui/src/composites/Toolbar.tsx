// Toolbar: a bar of controls on one line that never wraps (design/layout.md §2). Every item has an
// icon and a priority; as the bar narrows, items step down lowest priority first: icon and label,
// then the icon alone (the label moves to the tooltip and aria-label), then into a More menu.
// Widths are measured by one ResizeObserver from a hidden copy of every item in both forms, so the
// plan needs no layout reads after a write. Left/Right/Home/End move focus, as in any toolbar.
import { reorderable, type OnReorder } from '../core/reorder.ts';
import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { Key } from '@zag-js/solid';
import type { Space } from '@wisp/tokens';
import { spaceVar } from '@wisp/tokens';
import { flag, styleOf, type KitProps, type WithVars } from '../core/props.ts';
import { useT, type Translate } from '../core/i18n.tsx';
import { Button, IconButton } from '../controls/Button.tsx';
import { Menu, type MenuEntry } from '../controls/Menu.tsx';
import type { IconName } from '../content/icons.ts';
import { formsAt, nextLevel, type ItemForm, type PlanItem } from './toolbar-plan.ts';

interface ItemBase {
  readonly id: string;
  /** Shown beside the icon when there's room; the tooltip and accessible name when there isn't. */
  readonly label: string;
  readonly icon: IconName;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly tone?: 'good' | 'bad';
  readonly variant?: 'ghost' | 'secondary' | 'primary';
  /** A custom control (a mode picker). It must draw the form it is given. */
  readonly render?: (form: 'full' | 'icon') => JSX.Element;
}

/** A pinned item (Send, Stop, the mode whose menu is open) never collapses. Any other has a numeric
 * priority, lower collapses first, and an action so it can live in the More menu. */
export type ToolbarItem = (ItemBase & { readonly priority: 'pin'; readonly onSelect?: () => void }) | (ItemBase & { readonly priority: number; readonly onSelect: () => void });

export interface ToolbarProps extends KitProps, WithVars {
  /** Required: what the toolbar acts on ("Task actions"). */
  readonly 'aria-label': string;
  readonly items: readonly ToolbarItem[];
  readonly gap?: Space;
  readonly justify?: 'start' | 'end';
  /** The shorter bar height (--bar-h-compact). */
  readonly compact?: boolean;
  readonly t?: Translate;
  /** items that aren't pinned can be dragged (or Alt+←/→) into another order (v1 #772: the project chips) */
  readonly onReorder?: OnReorder;
}

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** The control a key moves to, or undefined when it isn't a toolbar key. Wraps at both ends. */
export function nextInToolbar(items: readonly HTMLElement[], current: number, key: string): HTMLElement | undefined {
  if (items.length === 0) return undefined;
  const last = items.length - 1;
  const index = key === 'ArrowRight' ? (current >= last ? 0 : current + 1) : key === 'ArrowLeft' ? (current <= 0 ? last : current - 1) : key === 'Home' ? 0 : key === 'End' ? last : -1;
  return index < 0 ? undefined : items[index];
}

function onToolbarKey(e: KeyboardEvent): void {
  // an item moved itself (Alt+←/→ on a reorderable one): the focus stays on it
  if (e.defaultPrevented) return;
  const bar = e.currentTarget;
  const target = e.target;
  if (!(bar instanceof HTMLElement) || !(target instanceof HTMLElement)) return;
  // Arrow keys inside a text field move the caret, not the focus.
  if (target.matches('input, textarea, [contenteditable]')) return;
  const items = [...bar.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[data-kit="toolbar-measure"], [hidden]'));
  const next = nextInToolbar(items, items.indexOf(target), e.key);
  if (!next) return;
  e.preventDefault();
  next.focus();
}

function ItemView(props: { readonly item: ToolbarItem; readonly form: 'full' | 'icon' }): JSX.Element {
  const common = () => ({
    size: 'sm' as const,
    variant: props.item.variant ?? ('ghost' as const),
    ...(props.item.pressed === undefined ? {} : { pressed: props.item.pressed }),
    ...(props.item.disabled === undefined ? {} : { disabled: props.item.disabled }),
    ...(props.item.tone === undefined ? {} : { tone: props.item.tone }),
    onClick: () => props.item.onSelect?.(),
  });
  return (
    <Show when={!props.item.render} fallback={props.item.render?.(props.form)}>
      <Show when={props.form === 'full'} fallback={<IconButton {...common()} icon={props.item.icon} label={props.item.label} />}>
        <Button {...common()} icon={props.item.icon}>
          {props.item.label}
        </Button>
      </Show>
    </Show>
  );
}

/** Widths measured so far, by `<id>:<form>`, and the bar's width. Read only inside the observer. */
function useMeasure(onChange: (sizes: ReadonlyMap<string, number>) => void): (el: HTMLElement) => void {
  const sizes = new Map<string, number>();
  if (typeof ResizeObserver === 'undefined') return () => {};
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const key = (entry.target as HTMLElement).dataset['measure'] ?? '';
      const box = entry.borderBoxSize[0];
      sizes.set(key, key === 'bar' ? entry.contentRect.width : (box?.inlineSize ?? entry.contentRect.width));
    }
    onChange(sizes);
  });
  onCleanup(() => ro.disconnect());
  return (el) => ro.observe(el);
}

export function Toolbar(props: ToolbarProps): JSX.Element {
  const t = useT(() => props.t);
  const [level, setLevel] = createSignal(0);
  const forms = createMemo(() =>
    formsAt(
      props.items.map((i) => ({ id: i.id, priority: i.priority, full: 0, icon: 0 })),
      level(),
    ),
  );
  const formOf = (id: string): ItemForm => forms().get(id) ?? 'full';
  const gapPx = (): number => [0, 2, 4, 6, 8, 10, 12, 16, 24, 32][Number(props.gap ?? '2')] ?? 4;
  const observe = useMeasure((sizes) => {
    const items: PlanItem[] = props.items.map((i) => ({ id: i.id, priority: i.priority, full: sizes.get(`${i.id}:full`) ?? 0, icon: sizes.get(`${i.id}:icon`) ?? 0 }));
    const input = { items, available: sizes.get('bar') ?? Infinity, gap: gapPx(), more: sizes.get('more') ?? 0 };
    // Hysteresis of one item's width: the widest icon form.
    setLevel((prev) => nextLevel(input, prev, Math.max(0, ...items.map((i) => i.icon))));
  });
  const overflowed = (): MenuEntry[] =>
    props.items
      .filter((i) => formOf(i.id) === 'overflow')
      .map((i) => ({ value: i.id, label: i.label, icon: i.icon, ...(i.pressed ? { checked: true } : {}), ...(i.disabled ? { disabled: true } : {}) }));
  const select = (id: string): void => props.items.find((i) => i.id === id)?.onSelect?.();
  // More sits right after the last item that can fold into it, so pins after it (Send) stay last.
  // Placed with CSS order, so no node moves when it appears.
  const moreOrder = (): number => 2 * props.items.reduce((last, item, i) => (item.priority === 'pin' ? last : i), -1) + 1;
  const movable = (): string[] => props.items.filter((i) => i.priority !== 'pin').map((i) => i.id);
  let bar: HTMLDivElement | undefined;
  onMount(() => bar && observe(bar));
  return (
    <div
      ref={bar}
      role="toolbar"
      aria-orientation="horizontal"
      id={props.id}
      aria-label={props['aria-label']}
      data-kit="toolbar"
      data-measure="bar"
      data-part={props.part ?? 'ui.toolbar'}
      data-justify={props.justify}
      data-compact={flag(props.compact)}
      onKeyDown={onToolbarKey}
      style={styleOf({ '--k-gap': spaceVar(props.gap ?? '2') }, props.vars)}
    >
      <Key each={props.items} by={(i) => i.id}>
        {(item, index) => (
          <div
            {...reorderable(`toolbar:${props['aria-label']}`, item().id, movable, item().priority === 'pin' ? undefined : props.onReorder)}
            style={{ order: 2 * index() }}
            data-kit="toolbar-item"
            data-item={item().id}
            data-form={formOf(item().id)}
            data-pinned={flag(item().priority === 'pin')}
            hidden={formOf(item().id) === 'overflow'}
          >
            <ItemView item={item()} form={formOf(item().id) === 'full' ? 'full' : 'icon'} />
          </div>
        )}
      </Key>
      <Show when={overflowed().length > 0}>
        <div style={{ order: moreOrder() }} data-kit="toolbar-item" data-item="more">
          <Menu items={overflowed()} onSelect={select} trigger={{ icon: 'dots', 'aria-label': t('more'), size: 'sm' }} placement="bottom-end" part={`${props.part ?? 'ui.toolbar'}.more`} />
        </div>
      </Show>
      <div data-kit="toolbar-measure" aria-hidden="true" inert>
        <For each={props.items}>
          {(item) => (
            <>
              <span data-measure={`${item.id}:full`} ref={(el) => observe(el)}>
                <ItemView item={item} form="full" />
              </span>
              <span data-measure={`${item.id}:icon`} ref={(el) => observe(el)}>
                <ItemView item={item} form="icon" />
              </span>
            </>
          )}
        </For>
        <span data-measure="more" ref={(el) => observe(el)}>
          <IconButton icon="dots" label={t('more')} size="sm" />
        </span>
      </div>
    </div>
  );
}
