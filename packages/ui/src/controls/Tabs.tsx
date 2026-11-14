// Tabs on Zag: arrow keys move between tabs, Home/End jump, one tab stop. Every panel stays
// mounted (hidden when not selected), so switching back keeps scroll and input.
import * as tabs from '@zag-js/tabs';
import { normalizeProps, useMachine } from '@zag-js/solid';
import { createMemo, createUniqueId, For, Show, type JSX } from 'solid-js';
import { flag, sub, type KitProps, type PartName } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';

export interface TabItem {
  readonly value: string;
  readonly label: string;
  readonly icon?: IconName;
  /** A count beside the label (tabular, so it doesn't wiggle). */
  readonly count?: number;
  readonly disabled?: boolean;
  /** its tooltip */
  readonly title?: string;
  /** The panel. Omit it to use the tabs as a segmented switch above content you render yourself. */
  readonly content?: JSX.Element;
}

export interface TabsProps extends KitProps {
  readonly items: readonly TabItem[];
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onChange?: (value: string) => void;
  /** `line` (an underline, the default) or `pill` (a segmented control). */
  /** seg: v1 .pk-seg, a bordered strip of small choices, the picked one in the accent (Settings → Worktrees' filter) */
  readonly variant?: 'line' | 'pill' | 'seg';
  /** The tab list's accessible name. */
  readonly 'aria-label'?: string;
  /** Select on focus (automatic, the default) or on Enter/Space (manual). */
  readonly activation?: 'automatic' | 'manual';
  /** Stretch the tabs across the width (phone segments). */
  readonly fill?: boolean;
  /** seg only: v1 drew some strips as a `<fieldset class="pk-seg">` (Theme, Automations stop at; Worktrees' filter sets its own margin),
   * which keeps the browser's 2px side margin; its `<span class="pk-seg">` ones (Auto's Goal, Scout first) have none. */
  readonly fieldset?: boolean;
}

export function Tabs(props: TabsProps): JSX.Element {
  const id = createUniqueId();
  const service = useMachine(tabs.machine, () => ({
    id,
    ...(props.value === undefined ? {} : { value: props.value }),
    defaultValue: props.defaultValue ?? props.items[0]?.value ?? null,
    onValueChange: (d: tabs.ValueChangeDetails) => props.onChange?.(d.value),
    activationMode: props.activation ?? 'automatic',
    loopFocus: true,
  }));
  const api = createMemo(() => tabs.connect(service, normalizeProps));
  const part = (): PartName => props.part ?? 'ui.tabs';
  return (
    <div {...api().getRootProps()} data-kit="tabs" data-part={part()} data-variant={props.variant ?? 'line'}>
      <div {...api().getListProps()} aria-label={props['aria-label']} data-kit="tab-list" data-part={sub(part(), 'list')} data-fill={flag(props.fill)} data-fieldset={flag(props.fieldset)}>
        <For each={props.items}>
          {(item) => (
            <button {...api().getTriggerProps({ value: item.value, disabled: item.disabled })} data-kit="tab" data-part={sub(part(), 'tab')} data-value={item.value} data-icon={flag(item.icon !== undefined)} title={item.title}>
              <Show when={item.icon}>{(name) => <Icon name={name()} size="md" />}</Show>
              <span data-kit="tab-label" data-text="control">
                {item.label}
              </span>
              <Show when={item.count !== undefined}>
                <span data-kit="tab-count" data-text="control">
                  {item.count}
                </span>
              </Show>
            </button>
          )}
        </For>
      </div>
      <For each={props.items}>
        {(item) => (
          <Show when={item.content !== undefined}>
            <div {...api().getContentProps({ value: item.value })} data-kit="tab-panel" data-part={sub(part(), 'panel')}>
              {item.content}
            </div>
          </Show>
        )}
      </For>
    </div>
  );
}
