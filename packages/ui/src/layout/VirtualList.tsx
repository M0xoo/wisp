// VirtualList: any list over 200 rows (plan §5). Rows sit in normal flow between two spacers, are
// keyed by `key(item)` so a reorder moves the same DOM nodes (and their entry animations never
// replay), and are measured as they render. The list keeps what you are reading in place when a
// row above it changes height or new rows arrive; in `anchor="bottom"` (a transcript) it starts
// at the end and follows new rows while you are at the tail.
import { Key } from '@zag-js/solid';
import { batch, createEffect, createMemo, createSignal, on, onCleanup, onMount, type Accessor, type JSX, For } from 'solid-js';
import type { Size } from '@wisp/tokens';
import { sizeVar } from '@wisp/tokens';
import { flag, styleOf, sub, type KitProps, type Labelled, type PartName, type WithVars } from '../core/props.ts';
import { anchorAt, atTail, computeRange, offsets, restoreAnchor, type Anchor } from './virtual-math.ts';

export interface VirtualListProps<T> extends KitProps, WithVars, Labelled {
  readonly items: readonly T[];
  /** A stable identity per row: the same key keeps the same DOM node. */
  readonly key: (item: T) => string;
  readonly children: (item: Accessor<T>, index: Accessor<number>) => JSX.Element;
  /** Height in px of a row not measured yet. */
  readonly estimate?: number;
  /** Rows rendered beyond each edge of the viewport. */
  readonly overscan?: number;
  /** `bottom`: a transcript. Starts at the end and follows new rows while at the tail. */
  readonly anchor?: 'top' | 'bottom';
  /** The viewport height in px to plan for when the box has no height yet (first paint, tests). */
  readonly viewport?: number;
  /** A fixed height from the scale; otherwise it fills its parent (`grow`) or sizes by CSS. */
  readonly height?: Size;
  readonly grow?: boolean;
  /** Called when a bottom-anchored list arrives at or leaves its tail (for a *Latest* pill). */
  readonly onTailChange?: (atTail: boolean) => void;
  readonly ref?: (el: HTMLDivElement) => void;
  /** the row at this index sits a list gap below the one before it (data-gap: v1 .f-list's 2px between two task rows). Additive (2026-11-12). */
  readonly gapBefore?: (index: number) => boolean | 'section';
  /** runs of rows that belong together (a section: its heading and rows), each drawn as one box behind them, named
   *  `part`, so it can be measured and restyled as v1's section was (#secNeeds). Item indices, inclusive. Additive. */
  readonly groups?: readonly { readonly part: string; readonly from: number; readonly to: number }[];
}

interface Measured {
  /** Bumped when any height changes, so the offsets recompute. */
  readonly version: Accessor<number>;
  readonly get: (key: string) => number | undefined;
  readonly observe: (el: HTMLElement, key: string) => void;
  readonly unobserve: (el: HTMLElement) => void;
}

/** Row heights by key, fed by one ResizeObserver per list. */
function useMeasured(beforeChange: () => void): Measured {
  const heights = new Map<string, number>();
  const keys = new WeakMap<Element, string>();
  const [version, setVersion] = createSignal(0);
  const record = (el: Element, h: number): boolean => {
    const key = keys.get(el);
    if (key === undefined || heights.get(key) === h) return false;
    heights.set(key, h);
    return true;
  };
  const ro =
    typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver((entries) => {
          beforeChange();
          let changed = false;
          for (const e of entries) changed = record(e.target, e.borderBoxSize[0]?.blockSize ?? e.contentRect.height) || changed;
          if (changed) setVersion((v) => v + 1);
        });
  onCleanup(() => ro?.disconnect());
  return {
    version,
    get: (key) => heights.get(key),
    observe: (el, key) => {
      keys.set(el, key);
      ro?.observe(el);
    },
    unobserve: (el) => ro?.unobserve(el),
  };
}

interface Scroller {
  readonly attach: (el: HTMLDivElement) => void;
  readonly scrollTop: Accessor<number>;
  readonly viewportH: Accessor<number>;
  readonly onScroll: () => void;
  /** Note the row under the viewport's top before something changes heights. */
  readonly remember: () => void;
}

/** Scroll position, the tail rule and the anchor row, for one list. */
function useScroller<T>(props: VirtualListProps<T>, offs: Accessor<readonly number[]>): Scroller {
  const box: { el: HTMLDivElement | undefined } = { el: undefined };
  const bottom = (): boolean => props.anchor === 'bottom';
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportH, setViewportH] = createSignal(props.viewport ?? 600);
  const [following, setFollowing] = createSignal(bottom());
  // What the reader is looking at, by key: survives inserts above it as well as height changes.
  const anchor: { at: { key: string; delta: number } | undefined } = { at: undefined };

  const remember = (): void => {
    if (!box.el) return;
    const a: Anchor = anchorAt(offs(), box.el.scrollTop);
    const item = props.items[a.index];
    anchor.at = item === undefined ? undefined : { key: props.key(item), delta: a.delta };
  };
  const scrollTo = (el: HTMLDivElement, y: number): void => {
    el.scrollTop = y;
    setScrollTop(el.scrollTop);
  };
  const onScroll = (): void => {
    const el = box.el;
    if (!el) return;
    batch(() => {
      setScrollTop(el.scrollTop);
      if (el.clientHeight > 0) setViewportH(el.clientHeight);
      if (!bottom()) return;
      const tail = atTail(el.scrollTop, el.clientHeight || viewportH(), el.scrollHeight);
      if (tail === following()) return;
      setFollowing(tail);
      props.onTailChange?.(tail);
    });
    remember();
  };

  // After the rows or their heights change: follow the tail, or put the anchor row back.
  createEffect(
    on(
      offs,
      (o) => {
        const el = box.el;
        if (!el) return;
        if (bottom() && following()) return scrollTo(el, el.scrollHeight);
        const a = anchor.at;
        const index = a ? props.items.findIndex((item) => props.key(item) === a.key) : -1;
        if (!a || index < 0) return;
        const want = restoreAnchor(o, { index, delta: a.delta });
        if (Math.abs(el.scrollTop - want) > 0.5) scrollTo(el, want);
      },
      { defer: true },
    ),
  );

  onMount(() => {
    const el = box.el;
    if (!el) return;
    if (el.clientHeight > 0) setViewportH(el.clientHeight);
    if (bottom()) scrollTo(el, el.scrollHeight);
  });

  return { attach: (el) => (box.el = el), scrollTop, viewportH, onScroll, remember };
}

export function VirtualList<T>(props: VirtualListProps<T>): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.virtual-list';
  // The observer calls back only after mount, by which time `scroller` exists.
  const measured = useMeasured(() => scroller.remember());
  const offs = createMemo(() => {
    measured.version();
    const est = props.estimate ?? 36;
    return offsets(props.items.map((item) => measured.get(props.key(item)) ?? est));
  });
  const scroller = useScroller(props, offs);
  const range = createMemo(() => computeRange(offs(), scroller.scrollTop(), scroller.viewportH(), props.overscan ?? 6));
  const visible = createMemo(() => props.items.slice(range().start, range().end));

  const row = (item: Accessor<T>, i: Accessor<number>): JSX.Element => (
    <div
      role="listitem"
      data-kit="virtual-row"
      data-part={sub(part(), 'row')}
      data-gap={((g) => (g === 'section' ? 'section' : g ? '' : undefined))(props.gapBefore?.(range().start + i()))}
      ref={(el) => {
        measured.observe(el, props.key(item()));
        onCleanup(() => measured.unobserve(el));
      }}
    >
      {props.children(item, () => range().start + i())}
    </div>
  );

  return (
    <div
      ref={(el) => {
        scroller.attach(el);
        props.ref?.(el);
      }}
      id={props.id}
      role="list"
      aria-label={props['aria-label']}
      aria-labelledby={props['aria-labelledby']}
      data-kit="virtual-list"
      data-part={part()}
      data-anchor={props.anchor ?? 'top'}
      data-grow={flag(props.grow)}
      onScroll={() => scroller.onScroll()}
      style={styleOf({ '--k-vl-h': props.height === undefined ? undefined : sizeVar(props.height) }, props.vars)}
    >
      <div data-kit="virtual-spacer" aria-hidden="true" style={{ height: `${range().padTop}px` }} />
      <Key each={visible()} by={(item: T) => props.key(item)}>
        {row}
      </Key>
      <div data-kit="virtual-spacer" aria-hidden="true" style={{ height: `${range().padBottom}px` }} />
      <For each={props.groups ?? []}>
        {(g) => (
          <div
            data-kit="virtual-group"
            data-part={g.part}
            aria-hidden="true"
            style={{ top: `${offs()[g.from] ?? 0}px`, height: `${Math.max(0, (offs()[g.to + 1] ?? 0) - (offs()[g.from] ?? 0))}px` }}
          />
        )}
      </For>
    </div>
  );
}

export interface EachProps<T> {
  readonly items: readonly T[];
  readonly key: (item: T) => string;
  readonly children: (item: Accessor<T>, index: Accessor<number>) => JSX.Element;
  readonly fallback?: JSX.Element;
}

/**
 * A keyed list without virtualization, for lists under 200 rows: renders no element of its own.
 * Rows are kept by key, so a reorder or an updated item never re-creates a node.
 */
export function Each<T>(props: EachProps<T>): JSX.Element {
  return (
    <Key each={props.items} by={(item: T) => props.key(item)} fallback={props.fallback}>
      {(item, i) => props.children(item, i)}
    </Key>
  );
}
