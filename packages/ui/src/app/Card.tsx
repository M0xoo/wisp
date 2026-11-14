// A task's row in the sidebar, as v1 draws it (web/css/feed.css, split.css `#feed .item`): the
// project's dot, the title with the time pinned in its corner, the summary with the state, goal and
// overlap pills beside it, and the harness and machine on a third line. Save for later and Mark done
// show over the end of the title on hover and keyboard focus; the time never moves.
import { Show, type JSX } from 'solid-js';
import { flag, type PartName } from '../core/props.ts';
import { Icon } from '../content/Icon.tsx';

export type CardStatus = 'done' | 'info' | 'warn' | 'bad' | 'live';

export interface TaskCardProps {
  readonly id: string;
  readonly title: string;
  readonly sub: string;
  /** the project's colour (v1 c-<colour>) */
  readonly color: string;
  readonly unread?: boolean;
  readonly open?: boolean;
  /** the row the keyboard is on */
  readonly selected?: boolean;
  readonly done?: boolean;
  readonly status?: { readonly label: string; readonly tone: CardStatus };
  /** a goal: its round and the ring's progress (0–100) */
  readonly goal?: { readonly n: number; readonly progress: number; readonly title: string; readonly paused: boolean };
  readonly overlap?: { readonly n: number; readonly title: string };
  /** the third line: harness logo and name, and where it runs */
  /** `routed`: Auto picked this run (v1's accent dot on the logo; the title says why) */
  readonly run?: { readonly logo?: string; readonly harness: string; readonly where: string; readonly title: string; readonly routed?: boolean };
  readonly time: string;
  readonly timeTitle: string;
  readonly laterLabel: string;
  /** saved for later: the bookmark filled */
  readonly laterOn?: boolean;
  readonly doneLabel: string;
  readonly onOpen?: () => void;
  readonly onDone?: () => void;
  readonly onLater?: () => void;
  readonly body?: JSX.Element;
  /** what plugins put on the row (v1 SLOTS card.top, card.head, card.hover, card.bottom): above the
   * row, among its pills, beside its quick buttons, under it */
  readonly slots?: { readonly top?: JSX.Element; readonly head?: JSX.Element; readonly hover?: JSX.Element; readonly bottom?: JSX.Element };
}

/** v1 goal.js ring(): a track, the progress arc and a centre dot, 14 px. */
function Ring(props: { readonly progress: number }): JSX.Element {
  const r = 7 - 1.6;
  const c = 2 * Math.PI * r;
  return (
    <svg data-kit="g-ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r={r} data-kit="g-ring-bg" />
      <circle cx="7" cy="7" r={r} data-kit="g-ring-fg" stroke-dasharray={c.toFixed(2)} stroke-dashoffset={(c * (1 - Math.min(props.progress, 99) / 100)).toFixed(2)} transform="rotate(-90 7 7)" />
      <circle cx="7" cy="7" r="2" data-kit="g-ring-dot" />
    </svg>
  );
}

/** v1 feed.css .pill in a feed row (split.css #feed .it-side .pill): the state's dot and word, 19px, no fill. */
export function RowPill(props: { readonly tone?: CardStatus | 'neutral'; readonly label: string; readonly title?: string; readonly part?: PartName; readonly dot?: boolean }): JSX.Element {
  return (
    <span data-kit="it-pill" data-part={props.part ?? 'card.status'} data-tone={props.tone} title={props.title}>
      <Show when={props.dot !== false}>
        <i />
      </Show>
      {props.label}
    </span>
  );
}

/** v1 goal.js goalPill(): the ring filling with the last check's progress, and the round. */
export function GoalPill(props: { readonly n: number; readonly progress: number; readonly title: string; readonly paused: boolean; readonly part?: PartName }): JSX.Element {
  return (
    <span data-kit="it-pill" data-part={props.part ?? 'card.goal'} data-goal={props.paused ? 'paused' : 'on'} title={props.title}>
      <Ring progress={props.progress} />
      <span data-kit="gp-n">{props.n}</span>
    </span>
  );
}

/** v1 overlaps.js overlapPill() in the sidebar: the merge mark and how many other tasks touch the same files. */
export function OverlapPill(props: { readonly n: number; readonly title: string; readonly part?: PartName }): JSX.Element {
  return (
    <span data-kit="it-pill" data-part={props.part ?? 'card.overlap'} data-overlap="" title={props.title}>
      <Icon name="merge" />
      <Show when={props.n > 1}>
        <span data-kit="ov-n">×{props.n}</span>
      </Show>
    </span>
  );
}

export function TaskCard(props: TaskCardProps): JSX.Element {
  const key = (e: KeyboardEvent): void => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    props.onOpen?.();
  };
  const quick = (fn: (() => void) | undefined) => (e: MouseEvent): void => {
    e.stopPropagation();
    fn?.();
  };
  return (
    <article data-kit="item" data-part="card" data-id={props.id} data-color={props.color} data-unread={flag(props.unread)} data-open={flag(props.open)} data-selected={flag(props.selected && !props.open)} data-done={flag(props.done)}>
      {props.slots?.top}
      <div data-kit="it-head" data-part="card.head" role="button" tabindex="0" aria-current={props.open ? 'true' : undefined} onClick={() => props.onOpen?.()} onKeyDown={key}>
        <span data-kit="q-dot" data-part="card.dot" />
        <span data-kit="it-title" data-part="card.title" data-text="control" title={props.title}>{props.title}</span>
        <span data-kit="it-sub" data-part="card.sub" data-text="control" title={props.sub}>{props.sub}</span>
        <Show when={props.run}>
          {(r) => (
            <span data-kit="it-run" data-part="card.run" title={r().title}>
              <i data-kit="ir-logo" data-routed={r().routed ? '' : undefined}>
                <Show when={r().logo}>{(src) => <img src={src()} alt="" />}</Show>
              </i>
              <span data-kit="ir-h">{r().harness}</span>
              <span data-kit="ir-w">
                <Icon name="laptop" />
                <span>{r().where}</span>
              </span>
            </span>
          )}
        </Show>
        <span data-kit="it-side" data-part="card.side">
          <Show when={props.status}>
            {(s) => (
              <span data-kit="it-pill" data-part="card.status" data-tone={s().tone}>
                <i />
                {s().label}
              </span>
            )}
          </Show>
          <Show when={props.goal}>
            {(g) => <GoalPill n={g().n} progress={g().progress} title={g().title} paused={g().paused} />}
          </Show>
          <Show when={props.overlap}>
            {(o) => <OverlapPill n={o().n} title={o().title} />}
          </Show>
          {props.slots?.head}
          <span data-kit="q-time" data-part="card.time" title={props.timeTitle}>{props.time}</span>
          <span data-kit="it-later" data-part="card.quickLater" data-a="quick-later" data-on={flag(props.laterOn)} aria-pressed={props.laterOn === true} role="button" aria-label={props.laterLabel} title={props.laterLabel} onClick={quick(props.onLater)}>
            <Icon name="bookmark" />
          </span>
          <span data-kit="it-quick" data-part="card.quickDone" data-a="quick-done" role="button" aria-label={props.doneLabel} title={props.doneLabel} onClick={quick(props.onDone)}>
            <Icon name="done" />
          </span>
          {props.slots?.hover}
        </span>
      </div>
      {props.slots?.bottom}
      {props.body}
    </article>
  );
}
