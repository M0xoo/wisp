// Timeline: everything the agent said and did in a turn, oldest first (v1 .tx): a head with the
// counts, steps (one line each, opening to their detail), messages (content), folds over long runs,
// and where it ended. Step labels are control text: one line, ellipsis, the whole label in the title.
import { Show, type JSX } from 'solid-js';
import { Icon } from '../content/Icon.tsx';
import type { IconName } from '../content/icons.ts';
import { flag, sub, type KitProps, type PartName } from '../core/props.ts';

export interface TimelineProps extends KitProps {
  /** the head: title and counts on one line */
  readonly head?: JSX.Element;
  readonly live?: boolean;
  readonly children?: JSX.Element;
  readonly 'aria-label'?: string;
}

export function Timeline(props: TimelineProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.timeline';
  return (
    <div id={props.id} data-kit="timeline" data-part={part()} data-live={flag(props.live)}>
      <Show when={props.head}>
        <div data-kit="timeline-head" data-part={sub(part(), 'head')}>
          {props.head}
        </div>
      </Show>
      <ol data-kit="timeline-list" data-part={sub(part(), 'list')} aria-label={props['aria-label']}>
        {props.children}
      </ol>
    </div>
  );
}

export type StepTone = 'neutral' | 'bad' | 'warn' | 'quiet';

export interface TimelineStepProps extends KitProps {
  readonly icon: IconName;
  readonly label: string;
  /** the command a run step ran, in mono, after the label */
  readonly command?: string;
  /** lines added / removed by an edit */
  readonly nums?: { readonly add: number; readonly del: number };
  /** how far into the turn it came ("1m 04s"), shown on hover */
  readonly time?: string;
  readonly timeTitle?: string;
  readonly tone?: StepTone;
  /** what opening shows; without it the step is a plain row */
  readonly detail?: () => JSX.Element;
  readonly expanded?: boolean;
  readonly onToggle?: () => void;
  /** a control at the row's end (Open in editor, Allow & retry) */
  readonly end?: JSX.Element;
  /** the step's kind, for plugins' restyling (`data-kind`) */
  readonly kind?: string;
}

function StepRow(props: TimelineStepProps & { readonly part: PartName }): JSX.Element {
  return (
    <>
      <span data-kit="timeline-icon">
        <Icon name={props.icon} size="sm" />
      </span>
      <span data-kit="timeline-label" data-part={sub(props.part, 'label')} data-text="control" title={props.label}>
        {props.label}
      </span>
      <Show when={props.command}>
        <code data-kit="timeline-cmd" data-text="control" title={props.command}>
          {props.command}
        </code>
      </Show>
      <Show when={props.nums}>
        {(n) => (
          <span data-kit="timeline-nums" data-text="control">
            <span data-kit="timeline-add">+{n().add}</span>
            <span data-kit="timeline-del">−{n().del}</span>
          </span>
        )}
      </Show>
      <Show when={props.time}>
        <time data-kit="timeline-time" data-text="control" title={props.timeTitle}>
          {props.time}
        </time>
      </Show>
      <Show when={props.detail}>
        <span data-kit="timeline-chev" data-open={flag(props.expanded)}>
          <Icon name="chevron" size="sm" />
        </span>
      </Show>
    </>
  );
}

export function TimelineStep(props: TimelineStepProps): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.timeline.step';
  return (
    <li data-kit="timeline-step" data-part={part()} data-kind={props.kind} data-tone={props.tone ?? 'neutral'} data-open={flag(props.expanded)}>
      <Show
        when={props.detail && props.onToggle}
        fallback={
          <div data-kit="timeline-row">
            <StepRow {...props} part={part()} />
          </div>
        }
      >
        <button type="button" data-kit="timeline-row" aria-expanded={props.expanded ? 'true' : 'false'} onClick={() => props.onToggle?.()}>
          <StepRow {...props} part={part()} />
        </button>
      </Show>
      <Show when={props.end}>
        <span data-kit="timeline-end-slot">{props.end}</span>
      </Show>
      <Show when={props.expanded && props.detail}>
        {(d) => (
          <div data-kit="timeline-detail" data-part={sub(part(), 'detail')}>
            {d()()}
          </div>
        )}
      </Show>
    </li>
  );
}

export function TimelineMessage(props: KitProps & { readonly children?: JSX.Element; readonly time?: string; readonly timeTitle?: string }): JSX.Element {
  const part = (): PartName => props.part ?? 'ui.timeline.message';
  return (
    <li data-kit="timeline-msg" data-part={part()}>
      <span data-kit="timeline-dot" />
      <div data-kit="timeline-msg-body">{props.children}</div>
      <Show when={props.time}>
        <time data-kit="timeline-time" data-text="control" title={props.timeTitle}>
          {props.time}
        </time>
      </Show>
    </li>
  );
}

export function TimelineFold(props: KitProps & { readonly label: string; readonly onOpen: () => void }): JSX.Element {
  return (
    <li data-kit="timeline-step" data-part={props.part ?? 'ui.timeline.fold'} data-tone="quiet">
      <button type="button" data-kit="timeline-row" onClick={() => props.onOpen()}>
        <span data-kit="timeline-icon">
          <Icon name="dots" size="sm" />
        </span>
        <span data-kit="timeline-label" data-text="control">
          {props.label}
        </span>
      </button>
    </li>
  );
}

export function TimelineEnd(props: KitProps & { readonly icon: IconName; readonly label: string; readonly tone?: 'good' | 'bad' | 'neutral' }): JSX.Element {
  return (
    <li data-kit="timeline-step" data-part={props.part ?? 'ui.timeline.end'} data-tone={props.tone === 'bad' ? 'bad' : 'quiet'} data-end={props.tone ?? 'neutral'}>
      <div data-kit="timeline-row">
        <span data-kit="timeline-icon">
          <Icon name={props.icon} size="sm" />
        </span>
        <span data-kit="timeline-label" data-text="control">
          {props.label}
        </span>
      </div>
    </li>
  );
}
