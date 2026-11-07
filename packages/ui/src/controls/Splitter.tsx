// Splitter on Zag: panels with grips between them, dragged with the pointer or moved with the
// arrow keys. Split is the two-panel case (the list beside the open task); under
// SPLIT_MIN_WIDTH the shell passes `stacked` and it becomes one column, with no grip.
import * as splitter from '@zag-js/splitter';
import { normalizeProps, useMachine } from '@zag-js/solid';
import { createMemo, createUniqueId, For, Show, type JSX } from 'solid-js';
import { sub, styleOf, type KitProps, type PartName, type WithVars } from '../core/props.ts';
import { useT, type Translate } from '../core/i18n.tsx';

export interface SplitterPanel {
  readonly id: string;
  readonly content: JSX.Element;
  /** Percent of the width (or height). */
  readonly minSize?: number;
  readonly maxSize?: number;
  readonly defaultSize?: number;
  /** The panel's accessible name, read out on its grip. */
  readonly label?: string;
}

export interface SplitterProps extends KitProps, WithVars {
  readonly panels: readonly SplitterPanel[];
  readonly orientation?: 'horizontal' | 'vertical';
  /** Every panel's size in percent, after a drag or a key. */
  readonly onResize?: (sizes: number[]) => void;
  /** Only once the drag ends: the moment to save the widths. */
  readonly onResizeEnd?: (sizes: number[]) => void;
  readonly t?: Translate;
}

function defaultSizes(panels: readonly SplitterPanel[]): number[] {
  const fixed = panels.reduce((sum, p) => sum + (p.defaultSize ?? 0), 0);
  const free = panels.filter((p) => p.defaultSize === undefined).length;
  const share = free ? Math.max(0, 100 - fixed) / free : 0;
  return panels.map((p) => p.defaultSize ?? share);
}

export function Splitter(props: SplitterProps): JSX.Element {
  const t = useT(() => props.t);
  const id = createUniqueId();
  const service = useMachine(splitter.machine, () => ({
    id,
    orientation: props.orientation ?? 'horizontal',
    panels: props.panels.map((p) => ({
      id: p.id,
      ...(p.minSize === undefined ? {} : { minSize: p.minSize }),
      ...(p.maxSize === undefined ? {} : { maxSize: p.maxSize }),
    })),
    defaultSize: defaultSizes(props.panels),
    onResize: (d: splitter.ResizeDetails) => props.onResize?.(d.size),
    onResizeEnd: (d: splitter.ResizeEndDetails) => props.onResizeEnd?.(d.size),
  }));
  const api = createMemo(() => splitter.connect(service, normalizeProps));
  const part = (): PartName => props.part ?? 'ui.splitter';
  // A grip resizes the panel before it, so it's named after that one.
  const before = (index: number): SplitterPanel | undefined => props.panels[index - 1];
  const gripLabel = (name: string | undefined): string => (name ? `${t('resize')}: ${name}` : t('resize'));
  return (
    <div {...api().getRootProps()} data-kit="splitter" data-part={part()} style={{ ...rootStyle(api()), ...styleOf({}, props.vars) }}>
      <For each={props.panels}>
        {(panel, index) => (
          <>
            <Show when={index() > 0}>
              <Grip api={api()} part={part()} trigger={`${before(index())?.id ?? ''}:${panel.id}`} label={gripLabel(before(index())?.label)} />
            </Show>
            <div {...api().getPanelProps({ id: panel.id })} data-kit="splitter-panel" data-part={sub(part(), 'panel')}>
              {panel.content}
            </div>
          </>
        )}
      </For>
    </div>
  );
}

/** Zag's root props carry a style object; keep it and add the caller's vars on top. */
function rootStyle(api: splitter.Api): JSX.CSSProperties {
  const s: unknown = (api.getRootProps() as { style?: unknown }).style;
  return typeof s === 'object' && s !== null ? (s as JSX.CSSProperties) : {};
}

function Grip(props: { readonly api: splitter.Api; readonly part: PartName; readonly trigger: string; readonly label: string }): JSX.Element {
  // Zag types the id as `a:b`; the template string above always has that shape.
  const id = props.trigger as splitter.ResizeTriggerId;
  return (
    <div {...props.api.getResizeTriggerProps({ id })} aria-label={props.label} data-kit="splitter-grip" data-part={sub(props.part, 'grip')}>
      <span data-kit="splitter-line" />
    </div>
  );
}

export interface SplitProps extends KitProps, WithVars {
  readonly start: JSX.Element;
  readonly end: JSX.Element;
  /** The start panel's share in percent (default 32). */
  readonly defaultSize?: number;
  readonly min?: number;
  readonly max?: number;
  /** One column, no grip: the shell sets it under SPLIT_MIN_WIDTH. */
  readonly stacked?: boolean;
  readonly startLabel?: string;
  readonly onResizeEnd?: (startPercent: number) => void;
  readonly t?: Translate;
}

/** Two panels side by side with a grip between them, or stacked. */
export function Split(props: SplitProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.split';
  return (
    <Show
      when={!props.stacked}
      fallback={
        <div data-kit="split-stacked" data-part={part()}>
          <div data-kit="split-panel" data-part={sub(part(), 'start')}>{props.start}</div>
          <div data-kit="split-panel" data-part={sub(part(), 'end')}>{props.end}</div>
        </div>
      }
    >
      <Splitter
        part={part()}
        {...(props.vars ? { vars: props.vars } : {})}
        {...(props.t ? { t: props.t } : {})}
        onResizeEnd={(sizes) => props.onResizeEnd?.(sizes[0] ?? 0)}
        panels={[
          { id: 'start', content: props.start, defaultSize: props.defaultSize ?? 32, minSize: props.min ?? 15, maxSize: props.max ?? 70, ...(props.startLabel ? { label: props.startLabel } : {}) },
          { id: 'end', content: props.end },
        ]}
      />
    </Show>
  );
}
