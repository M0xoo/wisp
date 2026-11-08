// A task's row in the sidebar, as v1 draws it (web/css/feed.css, split.css `#feed .item`): the
// project's dot, the title with the time pinned in its corner, the summary with the state, goal and
// overlap pills beside it, and the harness and machine on a third line. Save for later and Mark done
// show over the end of the title on hover and keyboard focus; the time never moves.
import { Show, type JSX } from 'solid-js';
import { flag } from '../core/props.ts';
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
  readonly done?: boolean;
  readonly status?: { readonly label: string; readonly tone: CardStatus };
  /** a goal: its round and the ring's progress (0–100) */
  readonly goal?: { readonly n: number; readonly progress: number; readonly title: string; readonly paused: boolean };
  readonly overlap?: { readonly n: number; readonly title: string };
  /** the third line: harness logo and name, and where it runs */
  readonly run?: { readonly logo?: string; readonly harness: string; readonly where: string; readonly title: string };
  readonly time: string;
  readonly timeTitle: string;
  readonly laterLabel: string;
  readonly doneLabel: string;
  readonly onOpen?: () => void;
  readonly onDone?: () => void;
  readonly onLater?: () => void;
  readonly body?: JSX.Element;
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
    <article data-kit="item" data-part="card" data-id={props.id} data-color={props.color} data-unread={flag(props.unread)} data-open={flag(props.open)} data-done={flag(props.done)}>
      <div data-kit="it-head" data-part="card.head" role="button" tabindex="0" aria-current={props.open ? 'true' : undefined} onClick={() => props.onOpen?.()} onKeyDown={key}>
        <span data-kit="q-dot" data-part="card.dot" />
        <span data-kit="it-title" data-part="card.title" data-text="control" title={props.title}>{props.title}</span>
        <span data-kit="it-sub" data-part="card.sub" data-text="control" title={props.sub}>{props.sub}</span>
        <Show when={props.run}>
          {(r) => (
            <span data-kit="it-run" data-part="card.run" title={r().title}>
              <i data-kit="ir-logo">
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
            {(g) => (
              <span data-kit="it-pill" data-part="card.goal" data-goal={g().paused ? 'paused' : 'on'} title={g().title}>
                <Ring progress={g().progress} />
                <span data-kit="gp-n">{g().n}</span>
              </span>
            )}
          </Show>
          <Show when={props.overlap}>
            {(o) => (
              <span data-kit="it-pill" data-part="card.overlap" data-overlap="" title={o().title}>
                <Icon name="merge" />
                <span data-kit="ov-n">×{o().n}</span>
              </span>
            )}
          </Show>
          <span data-kit="q-time" data-part="card.time" title={props.timeTitle}>{props.time}</span>
          <span data-kit="it-later" data-part="card.quickLater" data-a="quick-later" role="button" aria-label={props.laterLabel} title={props.laterLabel} onClick={quick(props.onLater)}>
            <Icon name="bookmark" />
          </span>
          <span data-kit="it-quick" data-part="card.quickDone" data-a="quick-done" role="button" aria-label={props.doneLabel} title={props.doneLabel} onClick={quick(props.onDone)}>
            <Icon name="done" />
          </span>
        </span>
      </div>
      {props.body}
    </article>
  );
}
