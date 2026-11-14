// The crew rail's pieces (v1 crew.css .crew-rail, design/crew.md "The rail"): a slim column on the
// sunk surface, the top and foot tiles fixed and the faces between them scrolling; a tile is 44px,
// never changes size, and the picked one is raised with a long pip on the window's edge; the card
// sits beside the rail, its top on the face's. The plugin owns the behaviour; this is how it looks.
import { Show, splitProps, type JSX } from 'solid-js';
import { styleOf, type KitProps, type WithChildren } from '../core/props.ts';

export interface RailProps extends KitProps, WithChildren {
  readonly 'aria-label': string;
  /** fixed above the faces (All) */
  readonly head?: JSX.Element;
  /** fixed below the faces (Org, +) */
  readonly foot?: JSX.Element;
  /** the list is on the right: the rail is on the outer edge, the pip on its other side */
  readonly side?: 'left' | 'right';
  readonly onKeyDown?: (e: KeyboardEvent) => void;
  readonly onPointerMove?: (e: PointerEvent) => void;
  readonly onPointerLeave?: (e: PointerEvent) => void;
  readonly onFocusOut?: (e: FocusEvent) => void;
  readonly onScroll?: () => void;
}

export function Rail(props: RailProps): JSX.Element {
  return (
    <nav
      id={props.id}
      data-kit="crew-rail"
      data-part={props.part ?? 'crew.rail'}
      data-side={props.side ?? 'left'}
      aria-label={props['aria-label']}
      onKeyDown={(e) => props.onKeyDown?.(e)}
      onPointerMove={(e) => props.onPointerMove?.(e)}
      onPointerLeave={(e) => props.onPointerLeave?.(e)}
      onFocusOut={(e) => props.onFocusOut?.(e)}
    >
      <div data-kit="crew-rail-head">{props.head}</div>
      <div data-kit="crew-rail-faces" onScroll={() => props.onScroll?.()}>
        {props.children}
      </div>
      <div data-kit="crew-rail-foot">{props.foot}</div>
    </nav>
  );
}

export interface RailTileProps extends KitProps, WithChildren {
  readonly label: string;
  /** what the list beside the rail shows (raised, the pip) */
  readonly selected?: boolean;
  /** the empty crew's +: dashed */
  readonly dashed?: boolean;
  readonly dim?: boolean;
  /** on its corner: amber while it asks you, the accent for an unread report */
  readonly dot?: 'asks' | 'unread';
  /** jobs running: a live chip, with the count past one */
  readonly live?: number;
  /** its place in the rail's order (CSS order: the tile stays in the DOM when it moves) */
  readonly order?: number;
  readonly tabIndex?: number;
  readonly keyshortcuts?: string;
  readonly ref?: (el: HTMLButtonElement) => void;
  readonly onClick?: (e: MouseEvent) => void;
  readonly onContextMenu?: (e: MouseEvent) => void;
  readonly onPointerEnter?: (e: PointerEvent) => void;
  readonly onPointerLeave?: (e: PointerEvent) => void;
  readonly onFocus?: (e: FocusEvent) => void;
  readonly dataId?: string;
}

export function RailTile(props: RailTileProps): JSX.Element {
  const [own] = splitProps(props, ['children']);
  return (
    <button
      type="button"
      id={props.id}
      ref={(el) => props.ref?.(el)}
      data-kit="crew-tile"
      data-part={props.part ?? 'crew.tile'}
      data-id={props.dataId}
      data-dashed={props.dashed ? '' : undefined}
      data-dim={props.dim ? '' : undefined}
      aria-current={props.selected ? 'true' : undefined}
      aria-label={props.label}
      aria-keyshortcuts={props.keyshortcuts}
      tabIndex={props.tabIndex ?? -1}
      style={styleOf({ '--k-order': props.order })}
      onClick={(e) => props.onClick?.(e)}
      onContextMenu={(e) => props.onContextMenu?.(e)}
      onPointerEnter={(e) => props.onPointerEnter?.(e)}
      onPointerLeave={(e) => props.onPointerLeave?.(e)}
      onFocus={(e) => props.onFocus?.(e)}
    >
      <span data-kit="crew-tile-pip" aria-hidden="true" />
      {own.children}
      <Show when={props.dot}>{(d) => <span data-kit="crew-tile-dot" data-tone={d()} aria-hidden="true" />}</Show>
      <Show when={(props.live ?? 0) > 0}>
        <span data-kit="crew-tile-live" aria-hidden="true">
          <span data-kit="crew-tile-orb" />
          <Show when={(props.live ?? 0) > 1}><b data-kit="crew-tile-n">{props.live}</b></Show>
        </span>
      </Show>
    </button>
  );
}

export interface RailCardProps extends KitProps, WithChildren {
  readonly 'aria-label': string;
  /** where it sits, in px from the viewport's top-left (the plugin measures the face) */
  readonly x: number;
  readonly y: number;
  readonly ref?: (el: HTMLElement) => void;
  readonly onPointerEnter?: (e: PointerEvent) => void;
  readonly onPointerLeave?: (e: PointerEvent) => void;
  readonly onKeyDown?: (e: KeyboardEvent) => void;
  readonly onFocusIn?: (e: FocusEvent) => void;
  readonly onFocusOut?: (e: FocusEvent) => void;
}

/** The hover card beside the rail: a group of buttons, not a tooltip (design/crew.md). */
export function RailCard(props: RailCardProps): JSX.Element {
  return (
    <div
      id={props.id}
      ref={(el) => props.ref?.(el)}
      role="group"
      data-kit="crew-card"
      data-part={props.part ?? 'crew.card'}
      aria-label={props['aria-label']}
      style={styleOf({ '--k-x': `${Math.round(props.x)}px`, '--k-y': `${Math.round(props.y)}px` })}
      onPointerEnter={(e) => props.onPointerEnter?.(e)}
      onPointerLeave={(e) => props.onPointerLeave?.(e)}
      onKeyDown={(e) => props.onKeyDown?.(e)}
      onFocusIn={(e) => props.onFocusIn?.(e)}
      onFocusOut={(e) => props.onFocusOut?.(e)}
    >
      {props.children}
    </div>
  );
}
