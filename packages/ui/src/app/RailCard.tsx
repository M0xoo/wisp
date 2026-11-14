// A face's card beside the crew rail (v1 crew.js showCard/hoverFace/leaveCard/crossing, crew.css .cl-card): who it is,
// then the tasks it's on, each one click away. Same place as a tooltip, but you can go into it: the 8px to it are
// bridged, and leaving the face or the card gives a grace to arrive. Once a card is up, switching to another face waits
// a beat, so the pointer crossing one face on its way to a row doesn't swap the card under it. Keys: → from a face goes
// into its rows, ←/Tab back to the face, ↑↓ Home End move, Escape takes back what the card has (focus to the face, then
// closed). A click on anything in the card closes it first. The rail owns the behaviour here; what's in the card is the
// owner's (`content`), drawn with `RailCardBody`.
import { createSignal, Index, onCleanup, onMount, Show, type Accessor, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { flag, styleOf } from '../core/props.ts';
import { useTimeout } from '../blocks/rich-scope.ts';

/** v1 CARD_WAIT, CARD_GRACE, CARD_SWITCH, RAIL_GAP; a tip or card closed this recently keeps the rail warm. */
const WAIT = 160;
const GRACE = 180;
const SWITCH = 90;
const GAP = 8;
const WARM = 400;

/** Still crossing the rail toward the card (v1 crew-jobs.js headingForCard): mostly outward, not along the rail. */
export const headingForCard = (out: number, down: number): boolean => out >= 2 && out * 6 >= Math.abs(down);

/** ↑↓ Home End among `n` stops (v1 stepRow); null for any other key. */
export function stepRow(key: string, at: number, n: number): number | null {
  const to = key === 'ArrowDown' ? at + 1 : key === 'ArrowUp' ? at - 1 : key === 'Home' ? 0 : key === 'End' ? n - 1 : undefined;
  return to === undefined ? null : Math.max(0, Math.min(to, n - 1));
}

export interface RailCardControl {
  readonly at: Accessor<string | undefined>;
  readonly onFaceEnter: (id: string, e: PointerEvent) => void;
  readonly onFaceLeave: (e: PointerEvent) => void;
  readonly onFaceFocus: (id: string, e: FocusEvent) => void;
  readonly onFaceKey: (id: string, e: KeyboardEvent) => void;
  readonly onRailMove: (e: PointerEvent) => void;
  readonly onRailBlur: () => void;
  readonly hide: () => void;
  /** the card itself, beside the rail */
  readonly Card: (props: { readonly label: (id: string) => string; readonly content: (id: string) => JSX.Element }) => JSX.Element;
}

/** The card's behaviour for a rail whose faces carry `data-id`. */
export function useRailCard(rail: () => HTMLElement | undefined): RailCardControl {
  const [at, setAt] = createSignal<string | undefined>();
  const [pos, setPos] = createSignal({ x: 0, y: 0, max: 0 });
  const wait = useTimeout();
  const grace = useTimeout();
  let card: HTMLElement | undefined;
  let next: string | undefined;
  let closing = false;
  let left = 0;
  const ptr = { x: 0, y: 0 };
  const from = { x: 0, y: 0 };
  const face = (id: string | undefined): HTMLElement | null => (id ? (rail()?.querySelector<HTMLElement>(`[data-kit="cl-face"][data-id="${CSS.escape(id)}"]`) ?? null) : null);
  const inCard = (): boolean => !!card && (card.matches(':hover') || card.contains(document.activeElement));
  const place = (): void => {
    const f = face(at());
    const r = rail()?.getBoundingClientRect();
    if (!f || !r || !card) return;
    const top = Math.max(GAP, Math.min(f.getBoundingClientRect().top - 1, innerHeight - card.offsetHeight - GAP));
    setPos({ x: Math.max(GAP, Math.min(r.right + GAP, innerWidth - card.offsetWidth - GAP)), y: top, max: innerHeight - top - GAP });
  };
  const keep = (): void => {
    wait.stop();
    grace.stop();
    closing = false;
    next = undefined;
  };
  const show = (id: string): void => {
    keep();
    if (at() === id) return;
    setAt(id);
    requestAnimationFrame(place);
  };
  const hide = (): void => {
    keep();
    if (!at()) return;
    left = Date.now();
    setAt(undefined);
  };
  const warm = (): boolean => !!at() || Date.now() - left < WARM;
  const armClose = (): void =>
    grace.start(GRACE, () => {
      closing = false;
      const f = face(at());
      if (!inCard() && !f?.matches(':hover') && document.activeElement !== f) hide();
    });
  const leave = (): void => {
    const moving = !!next || closing;
    keep();
    if (!at()) return;
    if (!moving) Object.assign(from, ptr); // where it left the card's face
    closing = true;
    armClose();
  };
  const stops = (): HTMLElement[] => [...(card?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])];
  const onEscape = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !at()) return;
    e.preventDefault();
    e.stopPropagation();
    if (card?.contains(document.activeElement)) face(at())?.focus();
    else hide();
  };
  onMount(() => {
    addEventListener('keydown', onEscape, true);
    addEventListener('resize', hide);
  });
  onCleanup(() => {
    removeEventListener('keydown', onEscape, true);
    removeEventListener('resize', hide);
  });
  return {
    at,
    hide,
    onFaceEnter: (id, e) => {
      if (e.pointerType !== 'mouse') return;
      const moving = !!next || closing;
      keep();
      if (id === at()) return;
      if (at()) {
        if (!moving) Object.assign(from, ptr);
        next = id;
        wait.start(SWITCH, () => show(id));
      } else if (warm()) show(id);
      else wait.start(WAIT, () => show(id));
    },
    onFaceLeave: (e) => {
      const to = (e.relatedTarget as Element | null)?.closest?.('[data-kit="cl-face"]');
      if (!to) leave();
    },
    onFaceFocus: (id, e) => {
      if ((e.currentTarget as HTMLElement).matches(':focus-visible')) show(id);
    },
    onFaceKey: (id, e) => {
      if (e.key !== 'ArrowRight') return;
      e.preventDefault();
      show(id);
      requestAnimationFrame(() => (stops()[1] ?? stops()[0])?.focus()); // the first row, or the head when there are none
    },
    onRailMove: (e) => {
      ptr.x = e.clientX;
      ptr.y = e.clientY;
      if (!next && !closing) return;
      if (!headingForCard(e.clientX - from.x, e.clientY - from.y)) return;
      if (closing) return armClose();
      const id = next;
      if (id) wait.start(SWITCH, () => show(id));
    },
    onRailBlur: leave,
    Card: (p) => (
      <Show when={at()} keyed>
        {(id) => (
          // on the page itself: a fixed box inside the rail would be placed (and clipped) by the frame around it
          <Portal>
            <div
              ref={(el) => {
                card = el;
                requestAnimationFrame(place);
              }}
              data-kit="cl-card"
              data-part="crew.card"
              role="group"
              aria-label={p.label(id)}
              style={styleOf({ '--k-x': `${pos().x}px`, '--k-y': `${pos().y}px`, '--k-max': `${pos().max}px` })}
              onPointerEnter={keep}
              onPointerLeave={leave}
              onFocusIn={keep}
              onFocusOut={(e) => !card?.contains(e.relatedTarget as Node | null) && leave()}
              // opening something from the card: it closes first, so it's gone before the pane changes
              onClick={(e) => (e.target as Element).closest('button') && hide()}
              onKeyDown={(e) => {
                const f = face(id);
                if (e.key === 'ArrowLeft' || e.key === 'Tab') {
                  if (e.key === 'ArrowLeft') e.preventDefault();
                  e.stopPropagation();
                  f?.focus();
                  return;
                }
                const list = stops();
                const to = stepRow(e.key, list.indexOf(e.target as HTMLElement), list.length);
                if (to === null) return;
                e.preventDefault();
                e.stopPropagation();
                list[to]?.focus();
              }}
            >
              {p.content(id)}
            </div>
          </Portal>
        )}
      </Show>
    ),
  };
}

export interface RailCardRow {
  readonly id: string;
  readonly title: string;
  /** its marker: asking you, working, an unread report */
  readonly mark: 'asks' | 'live' | 'unread' | '';
  /** what it's doing, or when it finished */
  readonly side: string;
  /** the Starting up placeholder, or gone while the card is up */
  readonly disabled?: boolean;
  /** open in the pane */
  readonly on?: boolean;
}

export interface RailCardBodyProps {
  readonly name: string;
  readonly role?: string | undefined;
  readonly line: { readonly text: string; readonly tone?: 'live' | 'asks' | 'report' | undefined };
  readonly headTitle: string;
  readonly rows: readonly RailCardRow[];
  /** no rows: "Next check-in tomorrow at 9:00", or "Nothing going on" */
  readonly none?: string | undefined;
  /** more than the card shows: "All 9 in the thread" */
  readonly more?: string | undefined;
  readonly onHead: () => void;
  readonly onRow: (id: string) => void;
}

/** What's in a face's card (v1 .cl-head, .cl-none, .cl-rows, .cl-more): rows by place (the owner holds their order
 *  while the card is up), so a job changing never rebuilds its row. */
export function RailCardBody(props: RailCardBodyProps): JSX.Element {
  return (
    <>
      <button type="button" data-kit="cl-head" tabIndex={-1} title={props.headTitle} onClick={() => props.onHead()}>
        <span data-kit="cl-tname">
          <b>{props.name}</b>
          <Show when={props.role}>{(r) => <span data-kit="cr-role">{r()}</span>}</Show>
        </span>
        <span data-kit="cl-sub" data-tone={props.line.tone}>
          {props.line.text}
        </span>
      </button>
      <Show when={props.rows.length === 0 && props.none}>
        <p data-kit="cl-none">{props.none}</p>
      </Show>
      <Show when={props.rows.length > 0}>
        <div data-kit="cl-rows">
          <Index each={props.rows}>
            {(row) => (
              <button type="button" data-kit="cl-row" data-job={row().id} data-on={flag(row().on)} tabIndex={-1} disabled={row().disabled} title={row().title} onClick={() => props.onRow(row().id)}>
                <span data-kit="cl-mark" data-m={row().mark}>
                  <Show when={row().mark === 'live'}>
                    <span data-kit="crew-tile-orb" />
                  </Show>
                </span>
                <span data-kit="cl-title">{row().title}</span>
                <span data-kit="cl-time">{row().side}</span>
              </button>
            )}
          </Index>
        </div>
      </Show>
      <Show when={props.more}>
        <button type="button" data-kit="cl-more" tabIndex={-1} onClick={() => props.onHead()}>
          {props.more}
        </button>
      </Show>
    </>
  );
}
