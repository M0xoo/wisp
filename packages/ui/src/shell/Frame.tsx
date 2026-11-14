// Frame: the app's body-level layout (plan §4.6.4): a top bar over the list, the main pane and the
// side pane. `layout` comes from navigation only (split ≥ 900 px, stack under it); features never
// set it. Split: the list, main and (when open) side sit side by side; the list folds away with
// `list="closed"`. Stack: one page at a time (`page`), the others stay mounted and hidden, so going
// back to the list keeps its scroll and nothing re-renders. The list's width is a measured value
// (`--sb-w`), dragged on its grip and reported once the drag ends.
import { Show, type JSX } from 'solid-js';
import { flag, styleOf, type KitProps, type WithVars } from '../core/props.ts';
import { useT, type Translate } from '../core/i18n.tsx';

export type FramePage = 'list' | 'main' | 'side';

export interface FrameProps extends KitProps, WithVars {
  readonly layout: 'split' | 'stack';
  /** stack only: the page on screen */
  readonly page: FramePage;
  readonly top: JSX.Element;
  readonly list: JSX.Element;
  readonly main: JSX.Element;
  readonly side?: JSX.Element;
  /** split only: the list beside the task, or folded away */
  readonly listOpen?: boolean;
  readonly sideOpen?: boolean;
  /** the list's width in px while dragging, and once at the end */
  readonly onListResize?: (px: number, done: boolean) => void;
  readonly listLabel?: string;
  readonly mainLabel?: string;
  readonly sideLabel?: string;
  readonly t?: Translate;
  /** inside a box of its own (the gallery), not over the whole viewport */
  readonly contained?: boolean;
}

function Grip(props: { readonly onResize: (px: number, done: boolean) => void; readonly label: string }): JSX.Element {
  let from = 0;
  let start = 0;
  const move = (e: PointerEvent): void => props.onResize(Math.round(start + e.clientX - from), false);
  const up = (e: PointerEvent): void => {
    const el = e.currentTarget as HTMLElement;
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    props.onResize(Math.round(start + e.clientX - from), true);
  };
  const down = (e: PointerEvent): void => {
    const el = e.currentTarget as HTMLElement;
    const pane = el.parentElement;
    if (!pane) return;
    e.preventDefault();
    from = e.clientX;
    start = pane.getBoundingClientRect().width;
    el.setPointerCapture(e.pointerId);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return <div data-kit="frame-grip" role="separator" aria-orientation="vertical" aria-label={props.label} onPointerDown={down} />;
}

export function Frame(props: FrameProps): JSX.Element {
  const t = useT(() => props.t);
  const active = (p: FramePage): '' | undefined => flag(props.layout === 'split' || props.page === p);
  return (
    <div
      id={props.id}
      data-kit="frame"
      data-part={props.part ?? 'shell.app'}
      data-layout={props.layout}
      data-page={props.page}
      data-list={props.listOpen === false ? 'closed' : 'open'}
      data-side={flag(props.sideOpen)}
      data-contained={flag(props.contained)}
      style={styleOf({}, props.vars)}
    >
      <header data-kit="frame-top" data-part="shell.topbar">{props.top}</header>
      <div data-kit="frame-body">
        <section data-kit="frame-pane" data-pane="list" data-part="shell.sidebar" data-active={active('list')} aria-label={props.listLabel}>
          {props.list}
          <Show when={props.layout === 'split' && props.onListResize}>
            {(fn) => <Grip onResize={fn()} label={t('resize')} />}
          </Show>
        </section>
        <main data-kit="frame-pane" data-pane="main" data-part="shell.main" data-active={active('main')} aria-label={props.mainLabel}>
          {props.main}
        </main>
        <Show when={props.sideOpen}>
          <aside data-kit="frame-pane" data-pane="side" data-part="shell.side" data-active={active('side')} aria-label={props.sideLabel}>
            {props.side}
          </aside>
        </Show>
      </div>
    </div>
  );
}
